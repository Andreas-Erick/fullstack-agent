// `electron . --smoke`: the launch check for Electron upgrades and releases (release.yml runs it before
// publishing). Starts the app on a throwaway data folder, opens the window, waits until the renderer
// says it booted (app:ready), lets it run a few seconds more, and quits with 0, or 1 if the window
// crashed, logged a console error, the main process threw, or nothing booted in time. Prints one line:
// "SMOKE OK …" or "SMOKE FAIL …". Nothing here runs without the flag.
const fs = require('fs');
const os = require('os');
const path = require('path');

const active = process.argv.includes('--smoke');
const TIMEOUT_MS = Number(process.env.NEXUS_SMOKE_TIMEOUT_MS) || 90000;
const SETTLE_MS = 4000; // after app:ready: late errors (lazy imports, first timers) still count

const problems = [];
let app = null;
let readyAt = 0;
let finished = false;

/** Before anything reads the data folder: a fresh one, so the check never touches the user's data. */
function prepare() {
  if (!active) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siren-smoke-'));
  process.env.NEXUS_USER_DATA ||= path.join(dir, 'data');
  process.env.NEXUS_DOCUMENTS ||= path.join(dir, 'documents');
}

function finish(ok, why) {
  if (finished) return;
  finished = true;
  const line = ok ? `SMOKE OK booted in ${readyAt} ms` : `SMOKE FAIL ${why}${problems.length ? `\n  ${problems.slice(0, 20).join('\n  ')}` : ''}`;
  (ok ? process.stdout : process.stderr).write(`${line}\n`);
  app.exit(ok ? 0 : 1);
}

/** Watches the main window; call right after it is created. */
function watch(electronApp, win) {
  if (!active) return;
  app = electronApp;
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') problems.push(`console: ${String(e.message).slice(0, 300)} (${String(e.sourceId || '').replace(/^.*\/renderer\//, 'renderer/')}:${e.lineNumber})`);
  });
  win.webContents.on('preload-error', (_e, p, err) => problems.push(`preload ${p}: ${err?.message || err}`));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => problems.push(`load failed: ${desc} (${code}) ${url}`));
  win.webContents.on('render-process-gone', (_e, d) => finish(false, `the window crashed (${d.reason})`));
  setTimeout(() => finish(false, `no app:ready within ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS).unref?.();
}

/** The renderer booted (ipc app:ready, with its boot time in ms). */
function ready(ms) {
  if (!active || readyAt) return;
  readyAt = Math.round(Number(ms) || 0);
  setTimeout(() => (problems.length ? finish(false, `${problems.length} problem${problems.length > 1 ? 's' : ''} after boot`) : finish(true)), SETTLE_MS);
}

/** An error in the main process (main.js's last-resort handlers). */
function noteError(err) {
  if (active) problems.push(`main: ${String(err?.stack || err).split('\n').slice(0, 3).join(' | ')}`);
}

module.exports = { active, prepare, watch, ready, noteError };
