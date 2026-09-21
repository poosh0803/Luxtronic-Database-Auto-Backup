// npm run check - verifies .env without taking any backups: dump tool, schedule,
// and for every target whether it connects and which databases it would back up.

import dotenv from 'dotenv';
import fs from 'fs/promises';
import cronParser from 'cron-parser';

dotenv.config();

import { loadConfig } from '../src/config.js';
import { discoverDatabases } from '../src/discovery.js';
import { resolveRunner } from '../src/dump.js';

const cfg = loadConfig();
let problems = 0;
const ok = (msg) => console.log(`  OK    ${msg}`);
const bad = (msg) => { problems++; console.log(`  FAIL  ${msg}`); };

console.log('Dump tool');
try {
  const runner = await resolveRunner(cfg);
  ok(runner.mode === 'local' ? `local pg_dump (${cfg.dumpPath})` : `Docker (${cfg.dockerImage})`);
} catch (err) {
  bad(err.message);
}

console.log('Schedule');
try {
  const next = cronParser.parseExpression(cfg.cron, { tz: cfg.timezone }).next().toDate();
  ok(`"${cfg.cron}" (${cfg.timezone}) - next run ${next.toLocaleString()}`);
} catch (err) {
  bad(`BACKUP_CRON / BACKUP_TIMEZONE invalid: ${err.message}`);
}

console.log('Backup folder');
try {
  await fs.mkdir(cfg.backupDir, { recursive: true });
  await fs.access(cfg.backupDir, fs.constants.W_OK);
  ok(`${cfg.backupDir} is writable`);
} catch (err) {
  bad(`${cfg.backupDir}: ${err.message}`);
}

console.log('Database servers');
if (!cfg.targets.length) bad('DB_TARGETS is empty');
for (const target of cfg.targets) {
  const where = `${target.name} (${target.host}:${target.port})`;
  if (target.configError) { bad(`${where} - ${target.configError}`); continue; }
  const { databases, error } = await discoverDatabases(target);
  if (error) bad(`${where} - ${error}`);
  else ok(`${where} - ${databases.length ? databases.join(', ') : 'no databases found'}`);
}

console.log(problems ? `\n${problems} problem(s) found.` : '\nAll good.');
process.exit(problems ? 1 : 0);
