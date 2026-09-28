// settings.js - retention settings editable from the web page, saved to DATA_DIR/settings.json.
//
// The .env values (BACKUP_MAX_KEEP, BACKUP_RETENTION_DAYS) are the defaults;
// anything saved from the page overrides them and survives restarts.
//
//   maxKeep        newest N backups kept per database, older ones deleted (0 = no limit)
//   retentionDays  backups older than this are deleted (0 = never delete by age)
//   perDatabase    { "<target>/<database>": maxKeep } overrides for single databases

import fs from 'fs/promises';
import path from 'path';
import { safeName } from './storage.js';

const MAX_COUNT = 1000;
const MAX_DAYS = 3650;

const file = (cfg) => path.join(cfg.dataDir, 'settings.json');

export const settingsKey = (targetId, database) => `${targetId}/${safeName(database)}`;

const isCount = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;

export async function loadSettings(cfg) {
  const settings = { maxKeep: cfg.maxKeep, retentionDays: cfg.retentionDays, perDatabase: {} };
  try {
    const saved = JSON.parse(await fs.readFile(file(cfg), 'utf8'));
    if (isCount(saved.maxKeep, MAX_COUNT)) settings.maxKeep = saved.maxKeep;
    if (isCount(saved.retentionDays, MAX_DAYS)) settings.retentionDays = saved.retentionDays;
    for (const [key, n] of Object.entries(saved.perDatabase || {})) {
      if (isCount(n, MAX_COUNT)) settings.perDatabase[key] = n;
    }
  } catch {
    /* no saved settings yet - .env defaults */
  }
  return settings;
}

export async function saveSettings(cfg, settings) {
  await fs.mkdir(cfg.dataDir, { recursive: true });
  const tmp = `${file(cfg)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2));
  await fs.rename(tmp, file(cfg));
}

// Merges a change from the page onto the current settings. Returns { settings } or { error }.
//   { maxKeep, retentionDays }                    global values
//   { target, database, maxKeep: n | null }       one database's override (null removes it)
export function applyChange(cfg, current, change) {
  const next = { ...current, perDatabase: { ...current.perDatabase } };

  if (change.target !== undefined || change.database !== undefined) {
    if (!cfg.targets.some((t) => t.id === change.target) || typeof change.database !== 'string' || !change.database) {
      return { error: 'Unknown database' };
    }
    const key = settingsKey(change.target, change.database);
    if (change.maxKeep === null) delete next.perDatabase[key];
    else if (isCount(change.maxKeep, MAX_COUNT)) next.perDatabase[key] = change.maxKeep;
    else return { error: `Max backups must be a whole number from 0 to ${MAX_COUNT}` };
    return { settings: next };
  }

  if (change.maxKeep !== undefined) {
    if (!isCount(change.maxKeep, MAX_COUNT)) return { error: `Max backups must be a whole number from 0 to ${MAX_COUNT}` };
    next.maxKeep = change.maxKeep;
  }
  if (change.retentionDays !== undefined) {
    if (!isCount(change.retentionDays, MAX_DAYS)) return { error: `Days must be a whole number from 0 to ${MAX_DAYS}` };
    next.retentionDays = change.retentionDays;
  }
  return { settings: next };
}

// The pruning rules for one database.
export function policyFor(cfg, settings, targetId, database) {
  const override = settings.perDatabase[settingsKey(targetId, database)];
  return {
    maxKeep: override !== undefined ? override : settings.maxKeep,
    overridden: override !== undefined,
    retentionDays: settings.retentionDays,
    keepMin: cfg.keepMin,
  };
}
