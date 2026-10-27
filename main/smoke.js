// `electron . --smoke`: the launch check for Electron upgrades and releases (release.yml runs it before
// publishing). Starts the app on a throwaway data folder, opens the window, waits until the renderer
// says it booted (app:ready), opens every view in the rail once, lets it run a few seconds more, and
// quits with 0, or 1 if the window crashed, logged a console error, the main process threw, or nothing
// booted in time. Prints one line:
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
  // The clock starts now, not when the window opens: a main module that fails to load (Electron then
  // shows its error box and waits) still ends the check.
  app = require('electron').app;
  setTimeout(() => finish(false, `no app:ready within ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS).unref?.();
}

function finish(ok, why) {
  if (finished) return;
  finished = true;
  const line = ok ? `SMOKE OK booted in ${readyAt} ms, opened ${toured.length} views` : `SMOKE FAIL ${why}${problems.length ? `\n  ${problems.slice(0, 20).join('\n  ')}` : ''}`;
  (ok ? process.stdout : process.stderr).write(`${line}\n`);
  app.exit(ok ? 0 : 1);
}

/** Watches the main window; call right after it is created. */
function watch(electronApp, w) {
  if (!active) return;
  app = electronApp;
  win = w;
  w.webContents.on('console-message', (e) => {
    if (e.level === 'error') problems.push(`console: ${String(e.message).slice(0, 300)} (${String(e.sourceId || '').replace(/^.*\/renderer\//, 'renderer/')}:${e.lineNumber})`);
  });
  w.webContents.on('preload-error', (_e, p, err) => problems.push(`preload ${p}: ${err?.message || err}`));
  w.webContents.on('did-fail-load', (_e, code, desc, url) => problems.push(`load failed: ${desc} (${code}) ${url}`));
  w.webContents.on('render-process-gone', (_e, d) => finish(false, `the window crashed (${d.reason})`));
}

// After booting, every view in the rail is opened once (a view that throws when it opens fails too).
const TOUR = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const opened = [];
  for (const b of document.querySelectorAll('.rail-btn')) {
    b.click();
    opened.push(b.dataset.view);
    await wait(700);
  }
  document.querySelector('.rail-btn[data-view="chat"]')?.click();
  return opened;
})()`;

let win = null;
/** The renderer booted (ipc app:ready, with its boot time in ms). */
function ready(ms) {
  if (!active || readyAt) return;
  readyAt = Math.round(Number(ms) || 0);
  const done = () => setTimeout(() => (problems.length ? finish(false, `${problems.length} problem${problems.length > 1 ? 's' : ''} after boot`) : finish(true)), SETTLE_MS);
  if (!win || win.isDestroyed()) return done();
  win.webContents
    .executeJavaScript(TOUR, true)
    .then((views) => ((toured = views), done()))
    .catch((err) => (problems.push(`tour: ${err.message}`), done()));
}
let toured = [];

/** An error in the main process (main.js's last-resort handlers). */
function noteError(err) {
  if (active) problems.push(`main: ${String(err?.stack || err).split('\n').slice(0, 3).join(' | ')}`);
}

module.exports = { active, prepare, watch, ready, noteError };
