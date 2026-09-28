// downloads.js - routes that list and serve the backup files.
//
// Dumps hold real customer data and the page has no login (LAN-only trust, see
// LUXTRONIC-PRIVACY-DATA-GUIDELINES.md). Every path is built from validated
// names and checked to stay inside BACKUP_DIR.

import express from 'express';
import path from 'path';
import archiver from 'archiver';
import { backedUpDatabases, databaseDir, listBackups, safeName, timestamp } from './storage.js';

const SAFE = /^[A-Za-z0-9._-]+$/;

export function downloadRoutes(cfg) {
  const router = express.Router();
  const root = path.resolve(cfg.backupDir) + path.sep;

  // Returns the backup directory for a target/database pair, or null if either name is bad.
  function resolveDir(targetId, database) {
    if (!cfg.targets.some((t) => t.id === targetId)) return null;
    if (typeof database !== 'string' || !database || !SAFE.test(safeName(database))) return null;
    const dir = path.resolve(databaseDir(cfg, targetId, database));
    return dir.startsWith(root) ? dir : null;
  }

  const toJson = (f) => ({ name: f.name, size: f.size, createdAt: new Date(f.mtimeMs).toISOString() });

  // Every kept backup of one database, newest first.
  router.get('/backups/:target/:database', async (req, res) => {
    const dir = resolveDir(req.params.target, req.params.database);
    if (!dir) return res.status(404).json({ error: 'Unknown database' });
    res.json({ files: (await listBackups(dir)).map(toJson) });
  });

  // One backup file.
  router.get('/download/:target/:database/:file', async (req, res) => {
    const dir = resolveDir(req.params.target, req.params.database);
    const { file } = req.params;
    if (!dir || !SAFE.test(file) || !file.endsWith('.dump')) return res.status(404).json({ error: 'Not found' });
    const files = await listBackups(dir);
    if (!files.some((f) => f.name === file)) return res.status(404).json({ error: 'Not found' });
    console.log(`[download] ${req.params.target}/${file} to ${req.ip}`);
    res.download(path.join(dir, file), file, (err) => {
      if (err && !res.headersSent) res.status(500).json({ error: 'Download failed' });
    });
  });

  // Several backups as one zip:
  //   ?target=x&database=y  -> every kept backup of that database
  //   ?target=x             -> newest backup of each database on that server
  //   (nothing)             -> newest backup of every database
  router.get('/download-zip', async (req, res) => {
    const { target, database } = req.query;
    const entries = []; // { full, name }

    if (database) {
      const dir = resolveDir(target, database);
      if (!dir) return res.status(404).json({ error: 'Unknown database' });
      for (const f of await listBackups(dir)) entries.push({ full: path.join(dir, f.name), name: f.name });
    } else {
      if (target && !cfg.targets.some((t) => t.id === target)) return res.status(404).json({ error: 'Unknown target' });
      const targets = target ? [target] : cfg.targets.map((t) => t.id);
      for (const id of targets) {
        for (const db of await backedUpDatabases(cfg, id)) {
          const dir = resolveDir(id, db);
          const [latest] = dir ? await listBackups(dir) : [];
          if (latest) entries.push({ full: path.join(dir, latest.name), name: `${id}/${latest.name}` });
        }
      }
    }

    if (!entries.length) return res.status(404).json({ error: 'No backups to download' });

    const label = database ? `${target}_${safeName(database)}_all` : target ? `${target}_latest` : 'all_latest';
    const zipName = `luxtronic-backup_${label}_${timestamp()}.zip`;
    console.log(`[download] ${zipName} (${entries.length} files) to ${req.ip}`);

    res.attachment(zipName);
    // Dumps are already compressed, so store them as-is rather than burning CPU recompressing.
    const zip = archiver('zip', { store: true });
    zip.on('error', (err) => {
      console.error('[download] zip failed:', err.message);
      res.destroy(err);
    });
    zip.pipe(res);
    for (const e of entries) zip.file(e.full, { name: e.name });
    zip.finalize();
  });

  return router;
}
