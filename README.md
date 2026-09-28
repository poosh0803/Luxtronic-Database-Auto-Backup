# Luxtronic Database Auto Backup

Runs under pm2, backs up every Postgres database used by the LAN portal services on a schedule
(`pg_dump`, compressed custom format), prunes old copies, and serves a small status page
listing each database by name with its last backup, size and health.

## Setup

```bash
npm install
cp .env.example .env      # then fill in DB_DEFAULT_PASSWORD (one login shared by every server)
npm run check             # verifies the dump tool, schedule, folder and every DB connection
pm2 start ecosystem.config.cjs
pm2 save
```

Status page: `http://<this-machine>:7999` (set by `PORT`; registered in `LUXTRONIC-INFRA-GUIDELINES.md`).
On the LAN server: `http://192.168.68.255:7999`.

### The dump tool

`pg_dump` has to be the same version as the servers or newer (they run Postgres 17). The app uses,
in order (`PG_DUMP_MODE=auto`):

1. a local `pg_dump` on `PATH` (or `PG_DUMP_PATH`), else
2. a throwaway `postgres:17` Docker container that runs `pg_dump` (needs the Docker engine running).

On the LAN server (Ubuntu 24.04, whose stock `pg_dump` is version 16) the 17 client is installed from the
official PostgreSQL apt repo - client tools only, no server:

```bash
apt-get install -y postgresql-common
/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
apt-get install -y postgresql-client-17
```

If neither exists the status page shows a red banner and backups fail with a clear message.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_DIR` | `./backups` | Where dumps go. **Should be off the server the DBs live on** (NAS share, second disk). |
| `BACKUP_CRON` / `BACKUP_TIMEZONE` | `0 2 * * *` / `Australia/Sydney` | Schedule. |
| `BACKUP_RETENTION_DAYS` | `14` | Older backups are deleted... |
| `BACKUP_KEEP_MIN` | `3` | ...but the newest N per database are always kept. |
| `BACKUP_STALE_HOURS` | `36` | Newest backup older than this shows "Stale". |
| `DB_DEFAULT_HOST/USER/PASSWORD` | - | Shared by every target unless overridden. |
| `DB_TARGETS` | - | Comma list of server names, one per Postgres instance (host:port). |

Every database found on a server is backed up automatically (system DBs `postgres`/`template*` are skipped),
so a new database on an existing server needs **no** config change.

### Adding another database server later

1. Add its name to `DB_TARGETS`, e.g. `DB_TARGETS=quotation,...,warranty`
2. Add its settings (name upper-cased, `-` becomes `_`):
   ```
   DB_WARRANTY_PORT=5437
   DB_WARRANTY_LABEL=Warranty Lookup
   # only if they differ from the DB_DEFAULT_* values:
   # DB_WARRANTY_HOST=...  DB_WARRANTY_USER=...  DB_WARRANTY_PASSWORD=...
   # only if you want a subset:
   # DB_WARRANTY_DATABASES=luxtronic_warranty_db
   ```
3. `pm2 restart luxtronic-db-backup`

## Where backups go

```
<BACKUP_DIR>/<target>/<database>/<database>_<YYYYMMDD-HHmmss>.dump
```

Restore with `pg_restore` (client version >= server), e.g. into a fresh database:

```bash
createdb -h HOST -p PORT -U USER restored_db
pg_restore -h HOST -p PORT -U USER -d restored_db --no-owner path/to/file.dump
```

## Privacy

Dumps contain real customer data. They are git-ignored and their contents are never logged. The page has no login
(LAN-only trust, like the other apps - see `LUXTRONIC-PRIVACY-DATA-GUIDELINES.md`), and it can **download backups**, so
anyone on the LAN can download the full customer data of every database. Every download is logged with the requester's
IP in `logs/out.log` (`[download] ...`). Add authentication before this service is ever reachable from outside the LAN.

## Downloading backups

From the status page:

- **Latest**: the newest backup of one database.
- **History**: every kept backup of that database, each downloadable, plus **Download all (zip)**.
- **Download latest (zip)** on a server's panel: the newest backup of each database on that server.
- **Download all latest** in the nav bar: the newest backup of every database, as one zip.

The same is available directly: `GET /api/download/<target>/<database>/<file>`,
`GET /api/download-zip[?target=<target>[&database=<database>]]`, and `GET /api/backups/<target>/<database>` to list files.

## Notes

- Backups run one at a time, whether scheduled or started from the page.
- A dump is written to a `.part` file and renamed only when `pg_dump` succeeds, so a failed or interrupted run
  never leaves something that looks like a good backup. Leftovers are cleaned at startup.
- Backups of a database that is later dropped from the server are left on disk (only age-pruned when new
  backups of that database run, which they won't) - delete the folder by hand when you're sure.
- Windows: pm2 doesn't start on boot by itself; use `pm2-windows-startup`/Task Scheduler if this runs on a PC.
