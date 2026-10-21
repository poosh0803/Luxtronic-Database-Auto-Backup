// config.js - turns process.env into a plain config object.
//
// Database servers ("targets") are declared in DB_TARGETS as a comma-separated
// list of names. Each name gets its own optional settings DB_<NAME>_HOST/PORT/
// USER/PASSWORD/DATABASES/LABEL, falling back to the DB_DEFAULT_* values, so
// adding another Postgres server later is one name in the list + one PORT line.

import path from 'path';

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const envKey = (name) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function loadTargets(env) {
  const targets = [];
  const seen = new Set();

  for (const raw of (env.DB_TARGETS || '').split(',')) {
    const name = raw.trim();
    if (!name) continue;

    const key = envKey(name);
    const get = (field) => env[`DB_${key}_${field}`] || undefined;
    const explicit = (get('DATABASES') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const target = {
      id: slug(name),
      name,
      label: get('LABEL') || name,
      host: get('HOST') || env.DB_DEFAULT_HOST || '',
      port: toInt(get('PORT'), 5432),
      user: get('USER') || env.DB_DEFAULT_USER || '',
      password: get('PASSWORD') || env.DB_DEFAULT_PASSWORD || '',
      // Empty = back up every database found on the server.
      databases: explicit.length && !explicit.includes('*') ? explicit : null,
      configError: null,
    };

    if (!target.id) target.configError = `"${name}" is not a usable target name`;
    else if (seen.has(target.id)) target.configError = `Duplicate target name "${name}"`;
    else if (!target.host) target.configError = `No host: set DB_${key}_HOST or DB_DEFAULT_HOST`;
    else if (!target.user) target.configError = `No user: set DB_${key}_USER or DB_DEFAULT_USER`;
    else if (!target.password) target.configError = `No password: set DB_${key}_PASSWORD or DB_DEFAULT_PASSWORD`;

    seen.add(target.id);
    targets.push(target);
  }

  return targets;
}

export function loadConfig(env = process.env) {
  const dumpMode = (env.PG_DUMP_MODE || 'auto').toLowerCase();
  if (!['auto', 'local', 'docker'].includes(dumpMode)) {
    throw new Error(`PG_DUMP_MODE must be auto, local or docker (got "${env.PG_DUMP_MODE}")`);
  }

  return {
    port: toInt(env.PORT, 7999),
    backupDir: path.resolve(env.BACKUP_DIR || './backups'),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    cron: env.BACKUP_CRON || '0 2 * * *',
    timezone: env.BACKUP_TIMEZONE || 'Australia/Sydney',
    // Defaults for the retention settings - the web page can override both (data/settings.json).
    retentionDays: toInt(env.BACKUP_RETENTION_DAYS, 14),
    maxKeep: toInt(env.BACKUP_MAX_KEEP, 0),
    // Age-based pruning never goes below this many backups per database, however old,
    // so a long outage can't age out the last good copies.
    keepMin: toInt(env.BACKUP_KEEP_MIN, 3),
    staleHours: toInt(env.BACKUP_STALE_HOURS, 36),
    timeoutMs: toInt(env.BACKUP_TIMEOUT_MINUTES, 60) * 60 * 1000,
    // Failure notifications go to the portal's bell. Empty PORTAL_URL turns them off.
    portalUrl: (env.PORTAL_URL ?? 'http://192.168.68.255').replace(/\/+$/, ''),
    statusUrl: env.STATUS_URL ?? 'http://192.168.68.255:7999',
    dumpMode,
    dumpPath: env.PG_DUMP_PATH || 'pg_dump',
    dockerImage: env.PG_DOCKER_IMAGE || 'postgres:17',
    targets: loadTargets(env),
  };
}
