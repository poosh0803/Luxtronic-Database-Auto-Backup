// notify.js - pushes backup failures to the Luxtronic Portal's notification bell.
//
// Contract: Luxtronic-Portal/API.md (POST /api/notifications, no auth, LAN only).
// Best-effort and fire-and-forget: a down portal must never affect a backup, so
// errors are logged and swallowed. Messages never include dump contents.

const SUPPRESS_MS = 60 * 60 * 1000; // same failure repeated within an hour (e.g. manual retries) is sent once

export function createNotifier(cfg, log = console.log) {
  const lastSent = new Map(); // dedupe key -> timestamp

  return async function notifyFailure({ key, title, message }) {
    if (!cfg.portalUrl) return;
    const now = Date.now();
    if (now - (lastSent.get(key) || 0) < SUPPRESS_MS) return;
    lastSent.set(key, now);

    try {
      const res = await fetch(`${cfg.portalUrl}/api/notifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'db-backup',
          level: 'error',
          title,
          message: message.slice(0, 500),
          url: cfg.statusUrl || undefined,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) log(`[notify] portal answered ${res.status}`);
    } catch (err) {
      log(`[notify] could not reach portal: ${err.message}`);
    }
  };
}
