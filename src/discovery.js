// discovery.js - asks a Postgres server which databases it holds.

import pg from 'pg';

const CONNECT_TIMEOUT_MS = 5000;

async function queryDatabases(target, maintenanceDb) {
  const client = new pg.Client({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: maintenanceDb,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  // A dropped connection emits 'error' on the client; without a listener it would crash the process.
  client.on('error', () => {});
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT datname FROM pg_database
        WHERE NOT datistemplate AND datallowconn AND datname <> 'postgres'
        ORDER BY datname`
    );
    return rows.map((r) => r.datname);
  } finally {
    await client.end().catch(() => {});
  }
}

// Resolves to { databases, error }. Never throws, so one dead server can't break the others.
export async function discoverDatabases(target) {
  try {
    const found = await queryDatabases(target, 'postgres').catch((err) => {
      // The default maintenance DB can be locked down; template1 is the usual alternative.
      if (err.code === '3D000' || err.code === '42501') return queryDatabases(target, 'template1');
      throw err;
    });
    return { databases: target.databases || found, error: null };
  } catch (err) {
    return { databases: target.databases || [], error: err.message || String(err) };
  }
}
