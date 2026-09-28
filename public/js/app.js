// app.js - status dashboard. Polls /api/status and renders each server with its databases.

const POLL_MS = 5000;
const el = (id) => document.getElementById(id);

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initDarkMode() {
  const icon = el('themeIcon');
  const apply = (dark) => {
    document.body.classList.toggle('dark-mode', dark);
    icon.classList.toggle('fa-moon', !dark);
    icon.classList.toggle('fa-sun', dark);
  };
  let dark = false;
  try { dark = localStorage.getItem('theme') === 'dark'; } catch { /* storage blocked */ }
  apply(dark);
  el('darkModeToggle').addEventListener('click', () => {
    const next = !document.body.classList.contains('dark-mode');
    try { localStorage.setItem('theme', next ? 'dark' : 'light'); } catch { /* storage blocked */ }
    apply(next);
  });
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '-';
}

function timeAgo(iso) {
  if (!iso) return '';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function formatDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const STATE_LABEL = { ok: 'Healthy', running: 'Running', queued: 'Queued', stale: 'Stale', never: 'No backup yet', failed: 'Failed' };

let toastTimer;
function toast(message) {
  const t = el('toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ---------- rendering ----------

function renderStats(data) {
  const dbs = data.targets.flatMap((t) => t.databases);
  const healthy = dbs.filter((d) => d.state === 'ok').length;
  const attention = dbs.filter((d) => ['failed', 'stale', 'never'].includes(d.state)).length
    + data.targets.filter((t) => !t.reachable).length;
  const total = dbs.reduce((sum, d) => sum + d.totalBytes, 0);
  const cards = [
    { label: 'Databases', value: dbs.length, cls: 'orange', sub: `on ${data.targets.length} server${data.targets.length === 1 ? '' : 's'}` },
    { label: 'Healthy', value: healthy, cls: 'green', sub: 'backed up recently' },
    { label: 'Need attention', value: attention, cls: attention ? 'red' : 'green', sub: 'failed, stale, never run or unreachable' },
    { label: 'Backup storage', value: formatBytes(total), cls: '', sub: retentionSummary(data.settings) },
    {
      label: 'Next scheduled run',
      value: data.schedule.nextRun ? formatDate(data.schedule.nextRun) : '-',
      cls: 'small',
      sub: `${data.schedule.cron} (${data.schedule.timezone})`,
    },
  ];
  el('stats').innerHTML = cards.map((c) => `
    <div class="stat-card">
      <div class="stat-label">${escapeHtml(c.label)}</div>
      <div class="stat-number ${c.cls}">${escapeHtml(c.value)}</div>
      <div class="stat-sub">${escapeHtml(c.sub)}</div>
    </div>`).join('');
}

function renderAlerts(data) {
  const alerts = [];
  if (data.runner.error) {
    alerts.push(`<div class="alert danger"><i class="fas fa-triangle-exclamation"></i><div><strong>Backups can't run:</strong> ${escapeHtml(data.runner.error)}</div></div>`);
  }
  el('alerts').innerHTML = alerts.join('');
}

// Expanded "History" rows: key "target/database" -> list of files (null while loading).
const history = new Map();
let lastData = null;

const enc = encodeURIComponent;
const fileUrl = (targetId, db, file) => `/api/download/${enc(targetId)}/${enc(db)}/${enc(file)}`;
const zipUrl = (params) => `/api/download-zip?${new URLSearchParams(params)}`;

function historyRow(target, db) {
  const files = history.get(`${target.id}/${db.name}`);
  let body;
  if (!files) body = '<div class="empty"><i class="fas fa-spinner spin"></i> Loading&hellip;</div>';
  else if (!files.length) body = '<div class="empty">No backups kept for this database.</div>';
  else {
    body = `
      <div class="history-head">
        <span>${files.length} backup${files.length === 1 ? '' : 's'} kept</span>
        <a class="btn" href="${zipUrl({ target: target.id, database: db.name })}"><i class="fas fa-file-zipper"></i> Download all (zip)</a>
      </div>
      <ul class="history-list">
        ${files.map((f) => `
          <li>
            <span class="file-name">${escapeHtml(f.name)}</span>
            <span class="sub">${escapeHtml(formatDate(f.createdAt))} &middot; ${escapeHtml(formatBytes(f.size))}</span>
            <a class="btn" href="${fileUrl(target.id, db.name, f.name)}" download><i class="fas fa-download"></i> Download</a>
          </li>`).join('')}
      </ul>`;
  }
  const global = lastData ? lastData.settings.maxKeep : 0;
  const limit = `
    <form class="limit-form" data-target="${escapeHtml(target.id)}" data-database="${escapeHtml(db.name)}">
      <label>Max backups kept for this database
        <input type="number" name="maxKeep" min="0" max="1000" step="1"
          value="${db.maxKeepOverridden ? db.maxKeep : ''}"
          placeholder="${global ? `default (${global})` : 'default (no limit)'}">
      </label>
      <button type="submit" class="btn"><i class="fas fa-floppy-disk"></i> Save</button>
      <span class="sub">Blank = use the default for all databases. 0 = no limit.</span>
    </form>`;
  return `<tr class="history-row"><td colspan="6"><div class="history-box">${limit}${body}</div></td></tr>`;
}

// ---------- retention settings ----------

function retentionSummary(s) {
  const parts = [];
  parts.push(s.maxKeep ? `max ${s.maxKeep} backups per database` : 'no count limit');
  parts.push(s.retentionDays ? `deleted after ${s.retentionDays} days (newest ${s.keepMin} always kept)` : 'no age limit');
  return parts.join(', ');
}

// Fills the global form from the server, unless someone is editing it right now.
function fillSettingsForm(s) {
  const form = el('settingsForm');
  if (form.contains(document.activeElement) || form.dataset.dirty) return;
  form.maxKeep.value = s.maxKeep;
  form.retentionDays.value = s.retentionDays;
  el('keepMinNote').textContent = s.keepMin;
}

// Previews how many backups a change would delete, asks before deleting any, then saves.
async function saveSettings(change) {
  const send = (dryRun) => fetch(`/api/settings${dryRun ? '?dryRun=1' : ''}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(change),
  }).then(async (res) => {
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  });
  try {
    const preview = await send(true);
    if (preview.deleted && !confirm(`This will permanently delete ${preview.deleted} existing backup file${preview.deleted === 1 ? '' : 's'} now to fit the new limit. Continue?`)) {
      return false;
    }
    const result = await send(false);
    toast(result.deleted ? `Saved - deleted ${result.deleted} old backup${result.deleted === 1 ? '' : 's'}` : 'Saved');
    return true;
  } catch (err) {
    toast(`Could not save: ${err.message}`);
    return false;
  }
}

const parseCount = (value) => (value.trim() === '' ? null : Number(value));

async function loadHistory(key) {
  const [targetId, ...rest] = key.split('/');
  try {
    const res = await fetch(`/api/backups/${enc(targetId)}/${enc(rest.join('/'))}`);
    const data = await res.json();
    if (history.has(key)) history.set(key, res.ok ? data.files : []);
  } catch {
    if (history.has(key)) history.set(key, []);
  }
}

function databaseRow(target, db) {
  const latestFile = db.lastFile;
  const busy = db.state === 'running' || db.state === 'queued';
  const icon = db.state === 'running' ? '<i class="fas fa-spinner spin"></i>' : '<i class="fas fa-rotate"></i>';
  const open = history.has(`${target.id}/${db.name}`);
  const last = db.lastBackupAt
    ? `${escapeHtml(formatDate(db.lastBackupAt))}<div class="sub">${escapeHtml(timeAgo(db.lastBackupAt))}${db.durationMs ? ` &middot; took ${escapeHtml(formatDuration(db.durationMs))}` : ''}</div>`
    : '-';
  return `
    <tr>
      <td class="dbname">${escapeHtml(db.name)}${db.lastError ? `<div class="err">${escapeHtml(db.lastError)}</div>` : ''}</td>
      <td><span class="badge ${db.state}">${STATE_LABEL[db.state] || escapeHtml(db.state)}</span></td>
      <td>${last}</td>
      <td class="num">${escapeHtml(formatBytes(db.lastSizeBytes))}</td>
      <td class="num">${db.backupCount}${db.maxKeep ? ` / ${db.maxKeep}` : ''}<div class="sub">${escapeHtml(formatBytes(db.totalBytes))} total</div></td>
      <td class="num actions">
        ${latestFile
          ? `<a class="btn" href="${fileUrl(target.id, db.name, latestFile)}" download title="Download the newest backup"><i class="fas fa-download"></i> Latest</a>`
          : '<button class="btn" disabled title="No backup yet"><i class="fas fa-download"></i> Latest</button>'}
        <button class="btn" data-history="${escapeHtml(`${target.id}/${db.name}`)}" ${db.backupCount ? '' : 'disabled'} title="All kept backups">
          <i class="fas fa-clock-rotate-left"></i> ${open ? 'Hide' : 'History'}
        </button>
        <button class="btn" data-target="${escapeHtml(target.id)}" data-database="${escapeHtml(db.name)}" ${busy || !target.reachable ? 'disabled' : ''}>
          ${icon} Back up
        </button>
      </td>
    </tr>${open ? historyRow(target, db) : ''}`;
}

function renderTargets(data) {
  el('targets').innerHTML = data.targets.map((target) => {
    const table = target.databases.length
      ? `<div class="table-scroll"><table>
          <thead><tr>
            <th>Database</th><th>Status</th><th>Last backup</th>
            <th class="num">Size</th><th class="num">Kept</th><th></th>
          </tr></thead>
          <tbody>${target.databases.map((db) => databaseRow(target, db)).join('')}</tbody>
        </table></div>`
      : `<div class="empty">${target.reachable ? 'No databases found on this server.' : 'No databases known yet.'}</div>`;
    return `
      <div class="panel">
        <div class="panel-head">
          <h2>${escapeHtml(target.label)}</h2>
          <span class="where">${escapeHtml(target.host)}:${escapeHtml(target.port)}</span>
          ${target.reachable ? '' : '<span class="badge down">Unreachable</span>'}
          <span class="spacer"></span>
          ${target.databases.some((d) => d.backupCount)
            ? `<a class="btn" href="${zipUrl({ target: target.id })}" title="Newest backup of each database on this server"><i class="fas fa-file-zipper"></i> Download latest (zip)</a>`
            : ''}
          <button class="btn" data-target="${escapeHtml(target.id)}" ${target.reachable ? '' : 'disabled'}>
            <i class="fas fa-database"></i> Back up this server
          </button>
        </div>
        ${target.error ? `<div class="panel-error"><i class="fas fa-circle-exclamation"></i> ${escapeHtml(target.error)}</div>` : ''}
        ${table}
      </div>`;
  }).join('') || '<div class="panel"><div class="empty">No database servers configured. Set DB_TARGETS in .env.</div></div>';
}

function render(data) {
  lastData = data;
  const busy = data.running ? `Backing up ${data.running.database}` + (data.queued ? ` (+${data.queued} queued)` : '') : 'Idle';
  el('pageSubtitle').textContent =
    `${busy} · saving to ${data.backupDir} · ${retentionSummary(data.settings)}`;
  fillSettingsForm(data.settings);
  el('backupAllBtn').disabled = false;
  renderAlerts(data);
  renderStats(data);
  // Don't redraw the tables under someone typing a per-database limit.
  const focused = document.activeElement;
  if (!(focused && focused.tagName === 'INPUT' && el('targets').contains(focused))) renderTargets(data);
}

// ---------- data ----------

async function load() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Keep open History lists current (new backups, pruned ones) across polls.
    await Promise.all([...history.keys()].map(loadHistory));
    render(data);
  } catch (err) {
    el('pageSubtitle').textContent = `Can't reach the backup service (${err.message}). Retrying...`;
  }
}

async function requestBackup(body, label) {
  try {
    const res = await fetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
    toast(result.queued ? `Queued ${result.queued} backup${result.queued === 1 ? '' : 's'} (${label})` : `Nothing new to queue for ${label} - already queued or unreachable`);
  } catch (err) {
    toast(`Could not start backup: ${err.message}`);
  }
  load();
}

document.addEventListener('DOMContentLoaded', () => {
  initDarkMode();

  el('backupAllBtn').addEventListener('click', () => requestBackup({}, 'all databases'));

  const settingsForm = el('settingsForm');
  settingsForm.addEventListener('input', () => { settingsForm.dataset.dirty = '1'; });
  settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const change = {
      maxKeep: parseCount(settingsForm.maxKeep.value) ?? 0,
      retentionDays: parseCount(settingsForm.retentionDays.value) ?? 0,
    };
    if (await saveSettings(change)) delete settingsForm.dataset.dirty;
    load();
  });
  el('settingsReset').addEventListener('click', () => {
    delete settingsForm.dataset.dirty;
    if (lastData) fillSettingsForm(lastData.settings);
  });

  el('targets').addEventListener('submit', async (event) => {
    const form = event.target.closest('form.limit-form');
    if (!form) return;
    event.preventDefault();
    const { target, database } = form.dataset;
    document.activeElement?.blur();
    await saveSettings({ target, database, maxKeep: parseCount(form.maxKeep.value) });
    load();
  });
  el('targets').addEventListener('click', async (event) => {
    const toggle = event.target.closest('button[data-history]');
    if (toggle && !toggle.disabled) {
      const key = toggle.dataset.history;
      if (history.has(key)) {
        history.delete(key);
      } else {
        history.set(key, null);
        if (lastData) render(lastData);
        await loadHistory(key);
      }
      if (lastData) render(lastData);
      return;
    }
    const btn = event.target.closest('button[data-target]');
    if (!btn || btn.disabled) return;
    const { target, database } = btn.dataset;
    requestBackup(database ? { target, database } : { target }, database || 'server');
  });

  load();
  setInterval(load, POLL_MS);
});
