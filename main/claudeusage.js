// How much of the Claude plan is left (the Claude account brain). The Claude Code CLI reports the plan's
// windows in a `rate_limit_event` on every turn (claudecode.js passes it here); the latest snapshot is
// kept in <userData>/claude-usage.json so the title bar can show it right after a restart.
// The pure part (parse, summary) has no Electron or file access and is tested in test/claudeusage.test.js.
const path = require('path');

const WINDOWS = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly (Opus)', seven_day_sonnet: 'weekly (Sonnet)' };

const frac = (v) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : null);
const secs = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** The CLI's rate_limit_info → { status, overage, windows: [{ id, label, used, resetsAt, status }], at }; null if unusable. */
function parse(info, at = Date.now()) {
  if (!info || typeof info !== 'object') return null;
  const windows = [];
  for (const [id, w] of Object.entries(info.unifiedWindows || {})) {
    if (!w || typeof w !== 'object' || frac(w.utilization) === null) continue;
    windows.push({ id: String(id).slice(0, 40), label: WINDOWS[id] || String(id).replace(/_/g, ' ').slice(0, 40), used: frac(w.utilization), resetsAt: secs(w.resetsAt), status: String(w.status || '').slice(0, 20) });
  }
  // Older CLIs report only the window that is closest to its limit.
  if (!windows.length && info.rateLimitType && frac(info.utilization) !== null) {
    windows.push({ id: String(info.rateLimitType).slice(0, 40), label: WINDOWS[info.rateLimitType] || String(info.rateLimitType), used: frac(info.utilization), resetsAt: secs(info.resetsAt), status: String(info.status || '') });
  }
  if (!windows.length && !info.status) return null;
  windows.sort((a, b) => Object.keys(WINDOWS).indexOf(a.id) - Object.keys(WINDOWS).indexOf(b.id));
  return { status: String(info.status || '').slice(0, 20), overage: Boolean(info.isUsingOverage), windows, at };
}

/** For display: each window's share left, with a window that has reset since counted as full again. */
function summary(snap, now = Date.now()) {
  if (!snap?.windows) return null;
  const windows = snap.windows.map((w) => {
    const reset = w.resetsAt && w.resetsAt * 1000 <= now;
    return { ...w, used: reset ? 0 : w.used, left: Math.round((1 - (reset ? 0 : w.used)) * 100), resetsAt: reset ? null : w.resetsAt };
  });
  const limited = snap.status === 'rejected' && windows.some((w) => w.resetsAt);
  const lowest = windows.reduce((m, w) => (m === null || w.left < m ? w.left : m), null);
  return { windows, lowest, limited, overage: snap.overage, at: snap.at };
}

// ------------------------------------------------------------ state (main process)
let current = null;
let loaded = false;
const listeners = new Set();

function file() {
  return path.join(require('./store').dataDir(), 'claude-usage.json');
}

async function get() {
  if (!loaded) {
    loaded = true;
    const saved = await require('./store').readJson(file(), null);
    if (!current && saved?.windows) current = saved;
  }
  return summary(current);
}

/** From claudecode.js: a rate_limit_event's info. */
function update(info) {
  const snap = parse(info);
  if (!snap) return;
  current = snap;
  loaded = true;
  require('./store').writeJsonAtomic(file(), snap).catch(() => {}); // only a cache for the next start
  const s = summary(snap);
  for (const fn of listeners) fn(s);
}

function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { parse, summary, get, update, onChange };
