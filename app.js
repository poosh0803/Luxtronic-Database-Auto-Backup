// app.js - Main application entry point

import express from 'express';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

import { loadConfig } from './src/config.js';
import { createService } from './src/service.js';

const cfg = loadConfig();
const service = await createService(cfg);
const __dirname = path.resolve();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Deliberately no endpoint serves the dump files themselves: they hold customer data
// (see LUXTRONIC-PRIVACY-DATA-GUIDELINES.md). Copy them off the disk directly when needed.

app.get('/api/status', async (req, res) => {
  try {
    res.json(await service.getStatus());
  } catch (err) {
    console.error('[api] status failed:', err.message);
    res.status(500).json({ error: 'Could not build status' });
  }
});

// Body: {} = everything, { target } = one server, { target, database } = one database.
app.post('/api/backup', async (req, res) => {
  const { target, database } = req.body || {};
  if ((target !== undefined && typeof target !== 'string') || (database !== undefined && typeof database !== 'string')) {
    return res.status(400).json({ error: 'target and database must be strings' });
  }
  if (database && !target) return res.status(400).json({ error: 'database needs a target' });
  try {
    const result = await service.requestBackup({ target, database });
    if (result.error) return res.status(404).json(result);
    res.status(202).json(result);
  } catch (err) {
    console.error('[api] backup request failed:', err.message);
    res.status(500).json({ error: 'Could not queue backup' });
  }
});

const server = app.listen(cfg.port, () => {
  const usable = cfg.targets.filter((t) => !t.configError).length;
  console.log(`Luxtronic Database Auto Backup on http://localhost:${cfg.port}`);
  console.log(`Targets: ${usable}/${cfg.targets.length} configured | schedule "${cfg.cron}" (${cfg.timezone}) | keep ${cfg.retentionDays} days`);
  console.log(`Backup folder: ${cfg.backupDir}`);
  for (const t of cfg.targets) if (t.configError) console.warn(`Target "${t.name}" not usable: ${t.configError}`);
});

// pm2 sends SIGINT on stop/restart. A dump cut short is cleaned up as a .part file on next start.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    service.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
