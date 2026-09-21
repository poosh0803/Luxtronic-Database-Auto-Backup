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
    { label: 'Backup storage', value: formatBytes(total), cls: '', sub: `keeping ${data.retentionDays} days` },
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

function databaseRow(target, db) {
  const busy = db.state === 'running' || db.state === 'queued';
  const icon = db.state === 'running' ? '<i class="fas fa-spinner spin"></i>' : '<i class="fas fa-download"></i>';
  const last = db.lastBackupAt
    ? `${escapeHtml(formatDate(db.lastBackupAt))}<div class="sub">${escapeHtml(timeAgo(db.lastBackupAt))}${db.durationMs ? ` &middot; took ${escapeHtml(formatDuration(db.durationMs))}` : ''}</div>`
    : '-';
  return `
    <tr>
      <td class="dbname">${escapeHtml(db.name)}${db.lastError ? `<div class="err">${escapeHtml(db.lastError)}</div>` : ''}</td>
      <td><span class="badge ${db.state}">${STATE_LABEL[db.state] || escapeHtml(db.state)}</span></td>
      <td>${last}</td>
      <td class="num">${escapeHtml(formatBytes(db.lastSizeBytes))}</td>
      <td class="num">${db.backupCount}<div class="sub">${escapeHtml(formatBytes(db.totalBytes))} total</div></td>
      <td class="num">
        <button class="btn" data-target="${escapeHtml(target.id)}" data-database="${escapeHtml(db.name)}" ${busy || !target.reachable ? 'disabled' : ''}>
          ${icon} Back up
        </button>
      </td>
    </tr>`;
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
  const busy = data.running ? `Backing up ${data.running.database}` + (data.queued ? ` (+${data.queued} queued)` : '') : 'Idle';
  el('pageSubtitle').textContent =
    `${busy} · saving to ${data.backupDir} · keeping ${data.retentionDays} days (min ${data.keepMin} per database)`;
  el('backupAllBtn').disabled = false;
  renderAlerts(data);
  renderStats(data);
  renderTargets(data);
}

// ---------- data ----------

async function load() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
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
  el('targets').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-target]');
    if (!btn || btn.disabled) return;
    const { target, database } = btn.dataset;
    requestBackup(database ? { target, database } : { target }, database || 'server');
  });

  load();
  setInterval(load, POLL_MS);
});
