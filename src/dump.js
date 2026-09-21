// dump.js - runs pg_dump for one database and streams the result to a file.
//
// Uses a local pg_dump binary when there is one, otherwise runs pg_dump inside a
// throwaway `postgres` Docker container (the servers are Postgres 17, and pg_dump
// must be at least as new as the server it talks to).

import { spawn } from 'child_process';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import crypto from 'crypto';

let cachedRunner = null;

function probe(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

// Throws if neither pg_dump nor Docker is usable. Only successes are cached, so
// installing pg_dump / starting Docker later is picked up without a restart.
export async function resolveRunner(cfg) {
  if (cachedRunner) return cachedRunner;
  if (cfg.dumpMode !== 'docker' && (await probe(cfg.dumpPath, ['--version']))) {
    return (cachedRunner = { mode: 'local' });
  }
  if (
    cfg.dumpMode !== 'local' &&
    (await probe('docker', ['version', '--format', '{{.Server.Version}}']))
  ) {
    return (cachedRunner = { mode: 'docker' });
  }
  throw new Error(
    cfg.dumpMode === 'local'
      ? `pg_dump not found at "${cfg.dumpPath}" - install PostgreSQL client tools or set PG_DUMP_PATH`
      : cfg.dumpMode === 'docker'
        ? 'Docker is not installed or its engine is not running'
        : 'Neither pg_dump nor a running Docker engine was found - install one of them (see README)'
  );
}

const lastLines = (text, n = 4) =>
  text.trim().split(/\r?\n/).slice(-n).join(' | ').slice(0, 500);

// Dumps `database` to `outPath` in pg_dump's compressed custom format (restore with pg_restore).
// Rejects with a short, readable message on any failure; the caller removes the partial file.
export async function dumpToFile(cfg, target, database, outPath) {
  const runner = await resolveRunner(cfg);

  // A container can't reach the host's 127.0.0.1, but Docker Desktop maps this name to it.
  const host =
    runner.mode === 'docker' && /^(localhost|127\.0\.0\.1)$/.test(target.host)
      ? 'host.docker.internal'
      : target.host;
  const pgArgs = ['-h', host, '-p', String(target.port), '-U', target.user, '-Fc', '--no-password', '-d', database];

  const containerName = `luxtronic-backup-${crypto.randomBytes(4).toString('hex')}`;
  const [cmd, args] =
    runner.mode === 'docker'
      // "-e PGPASSWORD" with no value forwards it from our environment, keeping it off the command line.
      ? ['docker', ['run', '--rm', '--name', containerName, '-e', 'PGPASSWORD', cfg.dockerImage, 'pg_dump', ...pgArgs]]
      : [cfg.dumpPath, pgArgs];

  const child = spawn(cmd, args, {
    env: { ...process.env, PGPASSWORD: target.password },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    // Killing the docker CLI doesn't stop the container it started.
    if (runner.mode === 'docker') spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore', windowsHide: true });
  }, cfg.timeoutMs);

  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });

  try {
    const [code] = await Promise.all([exited, pipeline(child.stdout, fs.createWriteStream(outPath))]);
    if (timedOut) throw new Error(`Timed out after ${Math.round(cfg.timeoutMs / 60000)} minutes`);
    if (code !== 0) throw new Error(lastLines(stderr) || `pg_dump exited with code ${code}`);
  } catch (err) {
    child.kill();
    throw timedOut ? new Error(`Timed out after ${Math.round(cfg.timeoutMs / 60000)} minutes`) : err;
  } finally {
    clearTimeout(timer);
  }
}
