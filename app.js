// app.js - Main application entry point

import express from 'express';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

import { loadConfig } from './src/config.js';
import { createService } from './src/service.js';
import { downloadRoutes } from './src/downloads.js';

const cfg = loadConfig();
const service = await createService(cfg);
const __dirname = path.resolve();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Backup listing + file/zip downloads. Dumps hold customer data - see src/downloads.js.
app.use('/api', downloadRoutes(cfg));

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

// Retention settings. Body: { maxKeep?, retentionDays? } or { target, database, maxKeep: n | null }.
// Saving prunes to the new limits immediately; ?dryRun=1 only reports how many backups would be deleted.
app.put('/api/settings', async (req, res) => {
  try {
    const result = await service.updateSettings(req.body, { dryRun: req.query.dryRun === '1' });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[api] settings failed:', err.message);
    res.status(500).json({ error: 'Could not save settings' });
  }
});

const server = app.listen(cfg.port, () => {
  const usable = cfg.targets.filter((t) => !t.configError).length;
  console.log(`Luxtronic Database Auto Backup on http://localhost:${cfg.port}`);
  console.log(`Targets: ${usable}/${cfg.targets.length} configured | schedule "${cfg.cron}" (${cfg.timezone})`);
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
