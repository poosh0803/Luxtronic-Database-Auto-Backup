// storage.js - backup files on disk, retention, and the small status.json history.
//
// Layout:  <BACKUP_DIR>/<target-id>/<database>/<database>_<YYYYMMDD-HHmmss>.dump

import fs from 'fs/promises';
import path from 'path';

export const safeName = (name) => name.replace(/[^A-Za-z0-9._-]+/g, '_');

export const databaseDir = (cfg, targetId, database) =>
  path.join(cfg.backupDir, targetId, safeName(database));

const pad = (n) => String(n).padStart(2, '0');

export function timestamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// Finished backups for one database directory, newest first.
export async function listBackups(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!name.endsWith('.dump')) continue;
    try {
      const stat = await fs.stat(path.join(dir, name));
      files.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      /* removed between readdir and stat */
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Deletes backups older than retentionDays, but never the newest keepMin.
export async function pruneBackups(cfg, dir) {
  const files = await listBackups(dir);
  const cutoff = Date.now() - cfg.retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const file of files.slice(cfg.keepMin)) {
    if (file.mtimeMs >= cutoff) continue;
    await fs.rm(path.join(dir, file.name), { force: true });
    removed++;
  }
  return removed;
}

// Directory names of databases we already hold backups for (used when a server is unreachable).
export async function backedUpDatabases(cfg, targetId) {
  try {
    const entries = await fs.readdir(path.join(cfg.backupDir, targetId), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// A crash or restart mid-dump leaves a .part file behind; nothing else ever writes them.
export async function removeStalePartials(cfg) {
  let count = 0;
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 2) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.part')) {
        await fs.rm(full, { force: true });
        count++;
      }
    }
  };
  await walk(cfg.backupDir, 0);
  return count;
}

const statusFile = (cfg) => path.join(cfg.dataDir, 'status.json');

export async function loadStatus(cfg) {
  try {
    const parsed = JSON.parse(await fs.readFile(statusFile(cfg), 'utf8'));
    return { databases: parsed.databases || {}, targets: parsed.targets || {} };
  } catch {
    return { databases: {}, targets: {} };
  }
}

export async function saveStatus(cfg, status) {
  await fs.mkdir(cfg.dataDir, { recursive: true });
  const tmp = `${statusFile(cfg)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(status, null, 2));
  await fs.rename(tmp, statusFile(cfg));
}
