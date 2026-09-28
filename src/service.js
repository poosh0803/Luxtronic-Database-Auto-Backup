// service.js - the backup engine: job queue, schedule, and the status shown on the web page.
//
// Jobs run strictly one at a time so backups never pile load onto the DB servers
// or the disk, whether they came from the schedule or the "Back up now" buttons.

import fs from 'fs/promises';
import path from 'path';
import cronParser from 'cron-parser';
import { discoverDatabases } from './discovery.js';
import { dumpToFile, resolveRunner } from './dump.js';
import {
  backedUpDatabases,
  databaseDir,
  listBackups,
  loadStatus,
  pruneBackups,
  removeStalePartials,
  saveStatus,
  safeName,
  timestamp,
} from './storage.js';

const DISCOVERY_TTL_MS = 60 * 1000;
const jobKey = (targetId, database) => `${targetId}/${database}`;
const log = (msg) => console.log(msg);

export async function createService(cfg) {
  const status = await loadStatus(cfg);
  const queue = [];
  const discovery = new Map(); // target id -> { at, databases, error }
  const inflight = new Map(); // target id -> pending discovery promise
  let current = null;
  let working = false;
  let runner = { mode: null, error: null };
  let nextRun = null;
  let timer = null;

  const findTarget = (id) => cfg.targets.find((t) => t.id === id);

  // ---- server discovery (stale-while-revalidate so the status page never blocks on a dead host) ----

  function refreshDiscovery(target) {
    if (!inflight.has(target.id)) {
      const promise = discoverDatabases(target)
        .then((result) => {
          discovery.set(target.id, { at: Date.now(), ...result });
          return discovery.get(target.id);
        })
        .finally(() => inflight.delete(target.id));
      inflight.set(target.id, promise);
    }
    return inflight.get(target.id);
  }

  async function getDiscovery(target, { force = false } = {}) {
    if (target.configError) return { databases: [], error: target.configError };
    const cached = discovery.get(target.id);
    if (!cached || force) return refreshDiscovery(target);
    if (Date.now() - cached.at > DISCOVERY_TTL_MS) refreshDiscovery(target);
    return cached;
  }

  // ---- queue ----

  function enqueue(targetId, database) {
    const key = jobKey(targetId, database);
    if ((current && current.key === key) || queue.some((j) => j.key === key)) return false;
    queue.push({ key, targetId, database });
    pump();
    return true;
  }

  async function pump() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        current = { ...queue.shift(), startedAt: Date.now() };
        await runJob(current);
      }
    } finally {
      current = null;
      working = false;
    }
  }

  async function runJob(job) {
    const target = findTarget(job.targetId);
    const started = Date.now();
    const dir = databaseDir(cfg, job.targetId, job.database);
    const finalPath = path.join(dir, `${safeName(job.database)}_${timestamp()}.dump`);
    const partPath = `${finalPath}.part`;

    const record = { lastAttemptAt: new Date().toISOString(), lastError: null };
    try {
      runner = { mode: (await resolveRunner(cfg)).mode, error: null };
      await fs.mkdir(dir, { recursive: true });
      log(`[backup] ${job.key} starting`);
      await dumpToFile(cfg, target, job.database, partPath);
      const { size } = await fs.stat(partPath);
      if (size === 0) throw new Error('pg_dump produced an empty file');
      await fs.rename(partPath, finalPath);
      const pruned = await pruneBackups(cfg, dir);
      record.lastResult = 'ok';
      log(`[backup] ${job.key} ok (${(size / 1048576).toFixed(1)} MB, ${Math.round((Date.now() - started) / 1000)}s${pruned ? `, pruned ${pruned}` : ''})`);
    } catch (err) {
      await fs.rm(partPath, { force: true }).catch(() => {});
      await fs.rmdir(dir).catch(() => {}); // only succeeds if empty, so existing backups are never touched
      record.lastResult = 'failed';
      record.lastError = err.message || String(err);
      if (!runner.mode) runner = { mode: null, error: record.lastError };
      log(`[backup] ${job.key} FAILED: ${record.lastError}`);
    }
    record.durationMs = Date.now() - started;
    status.databases[job.key] = record;
    await saveStatus(cfg, status).catch((err) => log(`[status] could not save: ${err.message}`));
  }

  // ---- public actions ----

  // Queues a backup of one database, every database on one target, or (no args) everything.
  async function requestBackup({ target: targetId, database } = {}) {
    const targets = targetId ? [findTarget(targetId)] : cfg.targets;
    if (targetId && !targets[0]) return { error: 'Unknown target', queued: 0 };

    let queued = 0;
    for (const target of targets) {
      const info = await getDiscovery(target, { force: true });
      if (target.configError || info.error) {
        status.targets[target.id] = { lastAttemptAt: new Date().toISOString(), lastError: target.configError || info.error };
        log(`[backup] ${target.id} skipped: ${target.configError || info.error}`);
        continue;
      }
      delete status.targets[target.id];
      const wanted = database ? info.databases.filter((d) => d === database) : info.databases;
      if (database && !wanted.length) return { error: 'Unknown database', queued };
      for (const db of wanted) if (enqueue(target.id, db)) queued++;
    }
    await saveStatus(cfg, status).catch(() => {});
    return { queued };
  }

  // ---- schedule ----

  function scheduleNext() {
    const next = cronParser.parseExpression(cfg.cron, { tz: cfg.timezone }).next().toDate();
    nextRun = next;
    // Re-check at least hourly so a long sleep can't drift or overflow setTimeout.
    const delay = Math.min(Math.max(next.getTime() - Date.now(), 250), 60 * 60 * 1000);
    timer = setTimeout(() => {
      if (Date.now() >= next.getTime()) {
        log('[schedule] starting scheduled backup run');
        requestBackup().catch((err) => log(`[schedule] failed to start run: ${err.message}`));
      }
      scheduleNext();
    }, delay);
    timer.unref?.();
  }

  // ---- status for the web page ----

  async function databaseRows(target, info) {
    // If the server can't be reached, fall back to the databases we already hold backups for.
    const names = info.error
      ? [...new Set([...(target.databases || []), ...(await backedUpDatabases(cfg, target.id))])]
      : info.databases;

    const rows = [];
    for (const name of names) {
      const key = jobKey(target.id, name);
      const files = await listBackups(databaseDir(cfg, target.id, name));
      const last = status.databases[key] || {};
      const latest = files[0];
      const ageHours = latest ? (Date.now() - latest.mtimeMs) / 3600000 : Infinity;

      let state = 'ok';
      if (current && current.key === key) state = 'running';
      else if (queue.some((j) => j.key === key)) state = 'queued';
      else if (last.lastResult === 'failed') state = 'failed';
      else if (!latest) state = 'never';
      else if (ageHours > cfg.staleHours) state = 'stale';

      rows.push({
        name,
        state,
        lastBackupAt: latest ? new Date(latest.mtimeMs).toISOString() : null,
        lastFile: latest ? latest.name : null,
        lastSizeBytes: latest ? latest.size : null,
        backupCount: files.length,
        totalBytes: files.reduce((sum, f) => sum + f.size, 0),
        lastAttemptAt: last.lastAttemptAt || null,
        lastError: last.lastResult === 'failed' ? last.lastError : null,
        durationMs: last.durationMs || null,
      });
    }
    return rows;
  }

  async function getStatus() {
    const targets = [];
    for (const target of cfg.targets) {
      const info = await getDiscovery(target);
      targets.push({
        id: target.id,
        label: target.label,
        host: target.host,
        port: target.port,
        reachable: !info.error,
        error: info.error || (status.targets[target.id] && status.targets[target.id].lastError) || null,
        databases: await databaseRows(target, info),
      });
    }
    return {
      serverTime: new Date().toISOString(),
      schedule: { cron: cfg.cron, timezone: cfg.timezone, nextRun: nextRun && nextRun.toISOString() },
      retentionDays: cfg.retentionDays,
      keepMin: cfg.keepMin,
      staleHours: cfg.staleHours,
      backupDir: cfg.backupDir,
      runner,
      running: current && { target: current.targetId, database: current.database, startedAt: new Date(current.startedAt).toISOString() },
      queued: queue.length,
      targets,
    };
  }

  // ---- startup ----

  const cleaned = await removeStalePartials(cfg);
  if (cleaned) log(`[startup] removed ${cleaned} unfinished .part file(s) from a previous run`);
  await resolveRunner(cfg)
    .then((r) => { runner = { mode: r.mode, error: null }; })
    .catch((err) => { runner = { mode: null, error: err.message }; });
  scheduleNext();
  for (const target of cfg.targets) if (!target.configError) refreshDiscovery(target);

  return { getStatus, requestBackup, stop: () => clearTimeout(timer) };
}
