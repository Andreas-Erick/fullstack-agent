// Electron main process: window, app:// protocol, IPC wiring.
const { app, BrowserWindow, ipcMain, protocol, shell, dialog, globalShortcut, session, systemPreferences, Menu, Notification } = require('electron');
const path = require('path');
const fsp = require('fs').promises;

// The data folder first (and the move from the app's former name), before anything reads it. The launch
// check (--smoke, smoke.js) gets a throwaway one.
const smoke = require('./smoke');
smoke.prepare();
require('./datadir').setup();
// macOS/Linux: the login shell's PATH, so claude, gh, npx, tailscale… are found when started from the Dock.
require('./shellpath').setup();

const store = require('./store');
const memory = require('./memory');
const calendar = require('./calendar');
const github = require('./github');
const obsidian = require('./obsidian');
const documents = require('./documents');
const voice = require('./voice');
const llm = require('./llm');
const codebase = require('./codebase');
const claudecode = require('./claudecode');
const selfchange = require('./selfchange');
const websearch = require('./websearch');
const persona = require('./persona');
const log = require('./logger');
const { plainIpcError } = require('./plainerror');
const approvals = require('./approvals');
const diagnostics = require('./diagnostics');
const journal = require('./journal');
const routines = require('./routines');
const handoff = require('./handoff');
const vaultgit = require('./vaultgit');
const faces = require('./faces');
const docwindows = require('./docwindows');
const agentwindow = require('./agentwindow');
const archmap = require('./archmap');
const envinfo = require('./envinfo');
const router = require('./router');
const screenshare = require('./screenshare');
const skills = require('./skills');
const pdf = require('./pdf');
const companion = require('./companion');
const helperApps = require('./helperapps');
const attachments = require('./attachments');
const { navDecision } = require('./navguard');

const ROOT = path.join(__dirname, '..');

// Last-resort safety net: an unexpected error in the main process is logged, never fatal.
// An Error goes through the logger's errorInfo: message, code and short frames, on one line.
process.on('uncaughtException', (err) => (log.error('uncaught exception', { error: err ?? String(err) }), smoke.noteError(err)));
process.on('unhandledRejection', (err) => (log.error('unhandled rejection', { error: err ?? String(err) }), smoke.noteError(err)));
const isDev = process.argv.includes('--dev');
// Laptops with integrated + dedicated graphics: run WebGPU (local Whisper) on the dedicated GPU.
app.commandLine.appendSwitch('force_high_performance_gpu');

// Only these folders are served to the renderer over app://bundle/...
const SERVED = ['renderer/', 'node_modules/marked/lib/', 'node_modules/dompurify/dist/', 'node_modules/katex/dist/', 'node_modules/@huggingface/transformers/dist/', 'node_modules/onnxruntime-web/dist/', 'node_modules/phonemizer/dist/', 'node_modules/pdfjs-dist/build/', 'node_modules/@fontsource/'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
  { scheme: 'faces', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win = null;
const redo = require('./redo');
// Chat turns (main/turns.js): the window and paired devices hear them through send; setup only through toWindow.
const turns = require('./turns').create({ send, toWindow });
const { tagFor } = require('./turns');
// What the window and paired devices see of a message or chat event (main/projections.js).
const projections = require('./projections');

// A second copy (e.g. a double click) hands over to the running one and exits at once, before it
// can open a window or touch the same files.
if (!app.requestSingleInstanceLock()) app.exit(0);
// Started again (also while the hidden window finishes its handoff note: showMain calls the close off).
app.on('second-instance', () => showMain());

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rel) rel = 'renderer/index.html';
    if (!SERVED.some((p) => rel.startsWith(p)) || rel.includes('..')) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fsp.readFile(path.join(ROOT, rel));
      return new Response(data, { headers: { 'Content-Type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ---- Custom faces are served as faces://<name>/… to a sandboxed iframe (see faces.js).
const facesDir = () => faces.dir();
const listCustomFaces = () => faces.list();

function registerFacesProtocol() {
  protocol.handle('faces', async (request) => {
    const url = new URL(request.url);
    const name = decodeURIComponent(url.hostname);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    // Inside that face's own folder only (faces.servedFile: never "." or ".." as the name).
    let file = faces.servedFile(await facesDir(), name, rel);
    if (!file) return new Response('Forbidden', { status: 403 });
    const headers = { 'Content-Security-Policy': "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-src 'none'" };
    if (rel === 'core.js' && !require('fs').existsSync(file)) file = path.join(ROOT, 'renderer', 'faces', 'core.js');
    try {
      const data = await fsp.readFile(file);
      return new Response(data, { headers: { ...headers, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    title: 'Siren Assistant',
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 15 } } : { titleBarOverlay: { color: '#0a0a0f', symbolColor: '#7df9ff', height: 44 } }), // = --titlebar in styles.css
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      autoplayPolicy: 'no-user-gesture-required', // the spoken greeting plays on launch
    },
  });
  win.once('ready-to-show', () => !smoke.active && win.show());
  smoke.watch(app, win);
  win.loadURL('app://bundle/renderer/index.html');
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  guardNavigation(win.webContents);
  // The page hides its title bar and rail only while the window really is full screen (the button,
  // F11, Esc, or the agent's set_window_state).
  win.on('enter-full-screen', () => toWindow('win:fullscreen', true));
  win.on('leave-full-screen', () => toWindow('win:fullscreen', false));
  win.on('closed', () => (win = null));
  // Closing: the window hides while the agent notes where we left off (handoff.js), then really closes.
  handoffDone = false;
  closing = false;
  win.on('close', (e) => {
    if (handoffDone) return;
    e.preventDefault();
    closeWithHandoff();
  });
  // Windows is shutting down or logging off: don't hold it up for the note.
  win.on('session-end', () => (handoffDone = true));

  // If the window's renderer crashes or is killed, reload it (a few times; then stop and say so).
  const crashes = [];
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('window crashed', details);
    if (details.reason === 'clean-exit' || !win || win.isDestroyed()) return;
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > 60000) crashes.shift();
    if (crashes.length <= 3) setTimeout(() => win && !win.isDestroyed() && win.loadURL('app://bundle/renderer/index.html'), 500);
    else dialog.showErrorBox('Siren Assistant', 'The window keeps crashing. Restart the app; if it persists, run the diagnose tool or check the log (Settings → Data).');
  });
  captureConsole(win.webContents, 'window');
  win.webContents.on('unresponsive', () => log.warn('window not responding'));
  win.webContents.on('responsive', () => log.info('window responding again'));
  // Tell the user once if their settings had to be restored from the backup, or a part of them reset (read
  // after the load is done: one still in flight would be missed).
  win.webContents.on('did-finish-load', () => {
    store.getSettings().then((s) => {
      if (win && !win.isDestroyed()) win.webContents.setZoomFactor(clampZoom(s.ui.zoom));
      const r = store.settingsRecovery();
      const reset = r?.dropped?.length && `Some of your settings (${r.dropped.join(', ')}) were damaged and went back to their defaults${r.fromPersona?.length ? ', except what belongs to your persona' : ''}.${r.kept ? ' The damaged file was kept for recovery.' : ''}`;
      if (r) send('app:notice', { kind: 'error', message: reset || (r.restored ? 'Your settings file was damaged and has been restored from the last good copy.' : 'Your settings file was damaged; defaults are used. The damaged file was kept for recovery.') });
    }).catch(() => {});
    scheduleChangeVerification(Date.now());
  });
}

// After a self-change goes live (restart or reload): give it a while to run, then check the log.
let verifyTimer = null;
function scheduleChangeVerification(loadedAt) {
  clearTimeout(verifyTimer);
  verifyTimer = setTimeout(async () => {
    const v = await selfchange.verifyAfterLoad({ processStartedAt: Date.now() - process.uptime() * 1000, loadedAt }).catch((err) => log.warn('self-change verification failed', { error: err }));
    if (!v) return;
    log.info('self-change verified', { change: v.short, state: v.state, problems: v.problems.length });
    if (v.state === 'problems') send('app:notice', { kind: 'error', message: `The last self-change (“${v.subject}”) logged ${v.problems.length} problem${v.problems.length > 1 ? 's' : ''} after it went live. Ask the assistant to look into it, or revert it in Evolution.` });
  }, 45000);
  verifyTimer.unref?.();
}

// External links open in the system browser, never inside the app; a window stays on its own page
// (navguard.js: a relative link in a reply or a document never replaces it).
function guardNavigation(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    const d = navDecision(wc.getURL(), url);
    if (d === 'allow') return;
    e.preventDefault();
    if (d === 'external') shell.openExternal(url);
    else log.info('navigation blocked', { scheme: String(url).split(':')[0].slice(0, 12) });
  });
}

const clampZoom = (z) => Math.min(2, Math.max(0.5, Number(z) || 1));
// A schedule entry from the Calendar view: only the known fields, as text (calendar.js validates them).
const scheduleInput = (v) => Object.fromEntries(['title', 'when', 'location', 'notes', 'from', 'until'].filter((k) => v?.[k] != null).map((k) => [k, String(v[k]).slice(0, 600)]));

// To the window, and (chat and approval events only) to paired devices.
function send(channel, payload) {
  toWindow(channel, payload);
  companion.publish(channel, payload);
}

// To the window only (the setup conversation never reaches paired devices).
function toWindow(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Routines (routines.js): each run is a turn in the routine's own conversation; the window shows the
// result, and Windows shows a notification while the app is in the background.
function startRoutines() {
  routines.start({
    run: ({ routine, text, limitMs, signal, onTurn }) =>
      new Promise((resolve) => {
        const requestId = `rt${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
        // The log tag its turn runs under (turns.js tags): a delete or pause from this turn's own tools
        // doesn't stop it (routines.js stopRun).
        onTurn?.(tagFor(requestId));
        let conversationId = ''; // once turns.start has it (a first run makes one): a stopped run keeps it
        // A run that takes too long (a hung tool, an approval nobody answers…) is stopped.
        const timer = setTimeout(() => {
          turns.abort(requestId);
          done({ ok: false, error: `Stopped after ${Math.round(limitMs / 60000)} minutes.` });
        }, limitMs);
        let settled = false;
        let stopRequested = false;
        const done = (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', stop);
          resolve(r);
        };
        // Stopped from outside (the chat reply that ran it, a delete, a switch-off): the turn is aborted, also
        // when it was still being set up (turns.start registers the request after a few awaits).
        const stop = () => {
          stopRequested = true;
          turns.abort(requestId);
          done({ ok: false, error: 'Stopped', stopped: true, ...(conversationId ? { conversationId } : {}) });
        };
        if (signal?.aborted) return stop();
        signal?.addEventListener('abort', stop, { once: true });
        // The user's own chat (routinecore.takenOver) isn't the routine's any more: a new conversation.
        const startIn = async () => {
          const conv = routine.conversationId ? await store.getConversation(routine.conversationId).catch(() => null) : null;
          if (!conv || !require('./routinecore').takenOver(conv, routine.id)) return routine.conversationId;
          log.info('routine gets its own conversation', { routine: routine.name, was: routine.conversationId });
          return '';
        };
        startIn()
          .then((id) => (stopRequested ? null : turns.start({ conversationId: id, text, requestId, display: `⏰ ${routine.name}`, routine: routine.id, onFinish: done })))
          .then((started) => {
            conversationId = started?.conversationId || '';
            if (stopRequested) turns.abort(requestId);
          })
          .catch((err) => done({ ok: false, error: err.message }));
      }),
    notify: (ev) => {
      toWindow('routine:event', ev);
      if (ev.type !== 'open') companion.dataChanged(['skills', 'conversations']); // the phone's routines list (last run) and the run's conversation
      if (ev.type !== 'finished' || (win && !win.isDestroyed() && win.isFocused()) || !Notification.isSupported()) return;
      const n = new Notification({ title: `${ev.ok ? '⏰' : '⚠'} ${ev.name}`, body: ev.summary || (ev.ok ? 'Done.' : 'The routine failed.'), silent: false });
      n.on('click', () => showMain(() => toWindow('routine:event', { type: 'open', conversationId: ev.conversationId })));
      n.show();
    },
  });
}

// Tasks from Todoist / TickTick (tasks.js): "Sync tasks" in the calendar is an assistant turn in its own
// conversation (it fetches with the connector and saves with tasks_save); the calendar hears about changes.
function startTasks() {
  require('./tasks').init({
    run: (text, conversationId) =>
      new Promise((resolve) => {
        const requestId = `tk${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
          turns.abort(requestId);
          resolve({ ok: false, error: 'Stopped after 5 minutes.' });
        }, 5 * 60000);
        turns.start({ conversationId: conversationId || undefined, text, requestId, display: store.TASKS_SYNC_DISPLAY, auto: 'tasks', onFinish: (r) => (clearTimeout(timer), resolve(r)) }).catch((err) => (clearTimeout(timer), resolve({ ok: false, error: err.message })));
      }),
    changed: () => toWindow('tasks:changed', {}),
  });
}

// Security events from remote access get a system notification too, so they are seen when the window
// is in the background: a device was paired, or a paired device connected from a network it never used.
function remoteAlert(ev) {
  if (!['paired', 'new-network'].includes(ev.type) || !Notification.isSupported()) return;
  if (ev.type === 'paired' && win && !win.isDestroyed() && win.isFocused()) return; // the window shows it
  const n = new Notification({
    title: ev.type === 'paired' ? `New device paired: ${ev.name}` : `${ev.name} connected from a new network`,
    body: `${ev.type === 'new-network' ? `Via ${ev.via} (${ev.ip}). ` : ''}Not you? Remove it in Settings → Remote access.`,
  });
  n.on('click', () => showMain(() => send('remote:event', { type: 'open-settings' })));
  n.show();
}

async function registerShortcut() {
  globalShortcut.unregisterAll();
  const s = await store.getSettings();
  const accel = s.stt.globalShortcut;
  if (!accel) return;
  try {
    // false: another app holds the keys (Electron doesn't throw for that).
    const ok = globalShortcut.register(accel, () => showMain(() => send('voice:toggle', {})));
    if (ok) log.info('voice shortcut registered', { accel });
    else log.warn('voice shortcut not registered', { accel, reason: 'in use by another app' });
  } catch (err) {
    // Keys Electron can't read ("Foo+Bar", a half-typed "Ctrl+Alt+"): the user's value, not a fault in the code,
    // so no Error (its stack points here and would count against a change to main.js).
    log.warn('voice shortcut not registered', { accel, reason: String(err?.message || err) });
  }
}

// --------------------------------------------------------------- IPC handlers
// Only the app's own pages may call: every window with the preload loads app://bundle/renderer/…;
// anything else in a frame (a site, a document) is refused, should it ever reach ipcRenderer.
const fromApp = (e) => /^app:\/\/bundle\/renderer\//.test(e?.senderFrame?.url || '');

function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!fromApp(e)) {
      log.warn('ipc refused', { channel, from: String(e?.senderFrame?.url || '').slice(0, 80) });
      return { ok: false, error: 'Not allowed from this page.' };
    }
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      // The UI shows the message; the log keeps where it came from.
      if (channel !== 'log:write') log.warn('ipc failed', { channel, error: err });
      return { ok: false, error: plainIpcError(err) };
    }
  });
}

// shell.openPath reports a failure as its result (an empty string is success): say it instead of nothing.
function opened(problem) {
  if (problem) throw new Error(`Couldn't open it: ${problem}`);
  return true;
}

// Errors printed in any window's console (also scripts that fail to load) end up in the log. An uncaught
// error is already logged by the page's own trap (util.js installErrorTrap) with its stack: once is enough.
function captureConsole(wc, label) {
  wc.on('console-message', (e) => {
    if (e.level !== 'error' || /^Uncaught\b/.test(String(e.message))) return;
    log.warn(`${label} console error`, { message: String(e.message).slice(0, 500), source: `${String(e.sourceId || '').replace(/^.*\/renderer\//, 'renderer/')}:${e.lineNumber}` });
  });
  // A preload that fails or a page that doesn't load leaves an empty window: say so in the log.
  wc.on('preload-error', (_e, preloadPath, error) => log.error(`${label} preload failed`, { error, preload: path.basename(String(preloadPath || '')) }));
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) log.warn(`${label} page failed to load`, { code, description, scheme: String(url || '').split(':')[0] }); // -3: aborted by a newer load
  });
  // The main window logs (and recovers from) its own crashes in createWindow; the others only say so.
  if (label !== 'window') wc.on('render-process-gone', (_e, details) => details?.reason !== 'clean-exit' && log.error(`${label} crashed`, { reason: details?.reason, exitCode: details?.exitCode }));
}

function registerIpc() {
  // Per window: the zoom of the window that asks, and its title-bar button colors (they follow the theme).
  ipcMain.handle('win:zoom', (e, factor) => {
    if (!fromApp(e)) return { ok: false, error: 'Not allowed from this page.' };
    const z = clampZoom(factor);
    e.sender.setZoomFactor(z);
    return { ok: true, data: z };
  });
  // Full screen is the window's own (like set_window_state), not the page's: the page may not ask for
  // it (the permission handler allows only the microphone and clipboard). true/false, or toggle.
  ipcMain.handle('win:fullscreen', (e, on) => {
    if (!fromApp(e)) return { ok: false, error: 'Not allowed from this page.' };
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return { ok: false, error: 'No window' };
    const next = typeof on === 'boolean' ? on : !w.isFullScreen();
    if (next && w.isMinimized()) w.restore();
    w.setFullScreen(next);
    return { ok: true, data: next };
  });
  ipcMain.handle('win:overlay', (e, colors) => {
    if (!fromApp(e)) return { ok: false, error: 'Not allowed from this page.' };
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && process.platform !== 'darwin' && colors?.color) {
      try {
        w.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor || '#ffffff' });
      } catch {
        /* a window without an overlay */
      }
    }
    return { ok: true, data: true };
  });

  // Settings
  handle('settings:get', () => store.getSettings());
  // What a save changes beyond the file (the voice shortcut, logging, remote access, helper apps, the
  // router), after Settings' saves and after a reset, which changes every section.
  async function applySaved(s, patch) {
    if (patch?.stt?.globalShortcut !== undefined) registerShortcut().catch((error) => log.warn('voice shortcut not registered', { error }));
    if (patch?.logging) log.setDebug(s.logging.debug);
    if (patch?.remote) await companion.apply(s);
    // A newly used or re-enabled helper app (VoiceStudio, FreeLLMAPI) starts now.
    if (patch?.voice || patch?.llm || patch?.routing || patch?.helperApps) helperApps.ensureAll(s, 'settings');
    if (patch?.routing || patch?.llm?.provider || ['gemini', 'deepseek', 'groq', 'perplexity', 'anthropic', 'claudeCode'].some((k) => patch?.[k])) router.reset();
  }
  // opts.persona: the persona whose Settings cards the value was typed into. A persona field is then saved
  // only while that persona is still active (persona.saveFor); dropped, the settings come back as they are.
  handle('settings:set', async (patch, opts) => {
    const r = typeof opts?.persona === 'string' && opts.persona ? await persona.saveFor(opts.persona, patch) : { settings: await store.setSettings(patch), saved: true };
    if (r.saved) await applySaved(r.settings, patch);
    return r.settings;
  });
  // Remote access, the shortcut and the rest follow the reset at once (the server stopped when it goes off).
  handle('settings:reset', async () => {
    const r = await store.resetSettings();
    await applySaved(r.settings, r.settings);
    return r;
  });
  // New versions (updates.js): the state, a check now, skipping one, and opening a GitHub download.
  handle('updates:status', () => require('./updates').status());
  handle('updates:check', () => require('./updates').check({ manual: true }));
  handle('updates:skip', async (version) => {
    await store.setSettings({ updates: { skipped: String(version || '').slice(0, 20) } });
    return require('./updates').status();
  });
  handle('updates:open', (url) => {
    if (!/^https:\/\/github\.com\//.test(String(url || ''))) throw new Error('Only GitHub release links open from here.');
    return shell.openExternal(String(url));
  });
  // The window finished booting (renderer/js/app.js): how long it took, and the launch check's signal.
  handle('app:ready', (ms) => {
    log.info('window ready', { ms: Math.round(Number(ms) || 0), sinceStartMs: Math.round(process.uptime() * 1000) }); // ms: the page's own boot
    smoke.ready(ms);
    return true;
  });
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    dataDir: store.dataDir(),
    codeRoot: ROOT,
    electron: process.versions.electron,
  }));

  // LLM
  handle('llm:models', async (override) => llm.listModels(merge(await store.getSettings(), override)));
  handle('llm:test', async (override) => llm.testConnection(merge(await store.getSettings(), override)));
  handle('llm:routerStatus', async () => router.status(await store.getSettings()));
  handle('llm:localModels', async () => require('./localmodels').detect());
  handle('llm:localSuggest', async (hw) => require('./localcore').suggest({ vramGb: Number(hw?.vramGb) || 0, ramGb: Number(hw?.ramGb) || 0 }));
  handle('llm:routerReset', (id) => router.reset(id));

  // Chat
  // attachments: one-time tokens from chat:attach (main/attachments.js), never paths.
  handle('chat:send', ({ conversationId, text, requestId, voice = false, hidden = false, attachments: tokens = [] }) =>
    turns.start({ conversationId, text, requestId, voice, hidden, attachments: Array.isArray(tokens) ? tokens.filter((t) => typeof t === 'string').slice(0, 7) : [] }),
  );
  handle('chat:attach', (item) => attachments.prepare(item));
  handle('chat:abort', (requestId) => {
    turns.abort(requestId);
    return true;
  });
  // Try again / Regenerate / Edit (main/redo.js): desktop only; the window checks first (a confirm may be needed).
  handle('chat:redoCheck', async (req) => redo.forWindow(redo.check(await store.getConversation(String(req?.conversationId || '')).catch(() => null), req, { busy: turns.busy(req?.conversationId) })));
  handle('chat:redo', (req) => {
    if (!/^[\w-]{1,64}$/.test(String(req?.requestId || ''))) throw new Error('Bad request');
    return turns.start({ conversationId: String(req?.conversationId || ''), requestId: String(req.requestId), text: '', redo: req });
  });

  // Remote access (companion server): settings and pairing stay desktop-only.
  handle('remote:status', () => companion.status());
  handle('remote:pair', () => companion.startPairing());
  handle('remote:revoke', (id) => companion.revoke(id));
  handle('remote:revokeAll', () => companion.revokeAll());
  handle('remote:setReadOnly', (id, on) => companion.setReadOnly(String(id), on === true));
  handle('handoff:get', () => handoff.read());
  handle('handoff:dismiss', () => handoff.dismiss());
  handle('remote:cancelPair', () => companion.cancelPairing());
  handle('remote:detectTailscale', async () => require('./tunnel').detectTailscale((await store.getSettings()).remote?.port || 7823));
  handle('remote:checkSecure', () => require('./tunnel').verify());
  // Only from the user's click in Settings → Remote access (never a tool).
  handle('remote:setupTailscale', async () => require('./tunnel').setupTailscaleServe((await store.getSettings()).remote?.port || 7823));
  handle('remote:transcribed', (id, text, error) => {
    const p = pendingTranscripts.get(id);
    if (!p) return false;
    pendingTranscripts.delete(id);
    clearTimeout(p.timer);
    error ? p.reject(new Error(String(error))) : p.resolve(String(text || ''));
    return true;
  });
  handle('remote:spoken', (id, wav, error) => {
    const p = pendingTranscripts.get(id);
    if (!p) return false;
    pendingTranscripts.delete(id);
    clearTimeout(p.timer);
    error || !wav ? p.reject(new Error(String(error || 'No audio'))) : p.resolve(Buffer.from(wav));
    return true;
  });

  // Conversations
  handle('conv:list', () => store.listConversations());
  handle('conv:get', async (id) => {
    const c = await store.getConversation(id);
    if (c) c.messages = projections.messagesFor('window', c.messages);
    return c;
  });
  handle('conv:new', () => store.createConversation());
  // Paired devices hear that their conversation list changed (companion.dataChanged).
  const convsChanged = (r) => (companion.dataChanged(['conversations']), r);
  const historysearch = () => require('./historysearch'); // the words inside conversations (History's search)
  // A delete stops the conversation's reply, ends its Claude session and removes its files (turns.js).
  handle('conv:delete', (id) => {
    historysearch().forget(id);
    return turns
      .deleteConversation(id)
      .then((r) => (historysearch().forget(id), r)) // a scan running meanwhile can't keep it
      .then(convsChanged);
  });
  handle('conv:rename', (id, title) => store.renameConversation(id, title).then(convsChanged));
  // History: ids, titles and snippets, never conversations (main/historysearch.js).
  handle('conv:search', (query, opts) => historysearch().search(String(query ?? ''), { cursor: opts?.cursor ?? null, limit: Number(opts?.limit) || undefined }));
  handle('conv:clear', async () => {
    historysearch().clear();
    return turns.clearConversations().then(convsChanged);
  });
  handle('conv:export', async () => {
    const all = (await store.exportConversations()).filter(Boolean).map((c) => ({ ...c, messages: projections.messagesFor('window', c.messages) }));
    return saveFile('nexus-conversations.json', JSON.stringify(all, null, 2), [{ name: 'JSON', extensions: ['json'] }]);
  });

  // Memory vault
  handle('memory:list', () => memory.list());
  handle('memory:search', (q) => memory.search(q));
  handle('memory:save', (e) => memory.save(e));
  handle('memory:update', (id, patch) => memory.update(id, patch));
  handle('memory:delete', (id) => memory.remove(id));
  handle('memory:restore', (e) => memory.restore(e));
  handle('memory:clear', () => memory.clear());
  handle('memory:dir', () => memory.vaultDir());
  handle('memory:openDir', async () => opened(await shell.openPath(await memory.vaultDir())));
  handle('memory:export', async (format) => {
    if (format === 'json') return saveFile('nexus-memory.json', JSON.stringify(await memory.list(), null, 2), [{ name: 'JSON', extensions: ['json'] }]);
    return saveFile('nexus-memory.md', await memory.exportMarkdown(), [{ name: 'Markdown', extensions: ['md'] }]);
  });
  handle('memory:import', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const text = await fsp.readFile(r.filePaths[0], 'utf8');
    let entries;
    try {
      entries = JSON.parse(text.replace(/^\uFEFF/, '')); // Notepad may save a byte-order mark
    } catch {
      throw new Error(memory.NOT_AN_EXPORT);
    }
    return memory.importEntries(entries);
  });

  // Voice
  // If nothing answers at VoiceStudio's address, start it (the window falls back to the system voice meanwhile).
  handle('tts:speak', (text, override) => voice.speak(text, override).catch((err) => (helperApps.onUnreachable('voicestudio', err), Promise.reject(err))));
  handle('helperApps:status', async () => helperApps.status(await store.getSettings()));
  handle('helperApps:start', async (id) => helperApps.start(String(id), await store.getSettings(), { reason: 'manual' }));
  handle('tts:voices', (override) => voice.voices(override));
  handle('tts:cloudVoices', () => Object.fromEntries(Object.entries(voice.CLOUD_VOICES).map(([id, p]) => [id, { name: p.name, voices: p.voices }])));
  handle('tts:ping', () => voice.ping());
  handle('stt:transcribe', (wav, opts) => voice.transcribe(wav, opts || {}));

  // Calendar
  // Schedule (Schedule.md in the vault); changes made here are the user's own.
  handle('calendar:status', () => calendar.status());
  handle('tasks:status', () => require('./tasks').status());
  handle('tasks:sync', () => require('./tasks').sync());
  handle('calendar:events', (range) => calendar.events(range || {}));
  handle('calendar:entries', () => calendar.entries());
  handle('calendar:add', (input) => calendar.add(scheduleInput(input), { source: 'user' }));
  handle('calendar:update', (id, patch) => calendar.update(String(id || ''), scheduleInput(patch), { source: 'user' }));
  handle('calendar:remove', (id, opts) => calendar.remove(String(id || ''), { onlyDate: opts?.onlyDate ? String(opts.onlyDate) : undefined, source: 'user' }));
  handle('github:status', async () => ({ ...(await github.status({ fresh: true })), workspace: await github.workspace() }));

  // Obsidian
  handle('obsidian:status', () => obsidian.status());
  handle('obsidian:list', (folder) => obsidian.listNotes(folder));
  handle('obsidian:read', (p) => obsidian.readNote(p));
  handle('obsidian:search', (q) => obsidian.search(q, 30));
  handle('obsidian:links', async (rel) => require('./linkindex').forNote(await obsidian.vaultPath(), String(rel || '')));

  // Documents
  handle('docs:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: documents.SUPPORTED.map((e) => e.slice(1)) },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return documents.load(r.filePaths[0], { fromUser: true });
  });
  handle('docs:load', (p) => documents.load(p));
  handle('docs:popup', async (p) => docwindows.open(await documents.resolveAllowed(p)));
  handle('docs:closePopup', () => docwindows.close()[0] || null);
  handle('docs:windowState', (state) => docwindows.setState('it', state));
  handle('docs:recent', () => documents.recent());
  handle('docs:clearRecent', () => documents.clearRecent());
  handle('docs:roots', () => documents.allowedRoots());
  handle('docs:showInFolder', async (p) => shell.showItemInFolder(await documents.resolveAllowed(p)));
  handle('docs:openExternal', async (p) => opened(await shell.openPath(await documents.externalPath(p))));

  // Vault (the agent's own Obsidian vault)
  handle('obsidian:write', (p, content, mode) => obsidian.writeNote(p, content, mode));
  handle('obsidian:delete', (p) => obsidian.deleteNote(p));
  handle('obsidian:openFolder', async () => opened(await shell.openPath(await obsidian.vaultPath())));
  handle('obsidian:openInObsidian', async (p) => {
    const root = await obsidian.vaultPath();
    const target = p ? (await obsidian.resolveNote(p)).full : root;
    return shell.openExternal(`obsidian://open?path=${encodeURIComponent(target)}`);
  });
  handle('obsidian:defaultPath', () => obsidian.defaultVaultPath());

  // Code + self-modification history
  handle('code:root', () => codebase.root());
  handle('self:status', () => selfchange.status());
  handle('self:ensure', () => selfchange.ensureRepo());
  handle('self:log', (n) => selfchange.log(n));
  handle('self:show', (sha) => selfchange.show(sha));
  handle('self:check', () => selfchange.check());
  handle('self:verification', () => selfchange.lastVerification());
  handle('self:commit', (summary) => selfchange.commit(summary || 'Manual changes', { source: 'user' }));
  handle('self:revert', (sha) => selfchange.revert(sha));
  handle('self:restore', (sha) => selfchange.restore(sha));
  handle('self:discard', () => selfchange.discard());
  handle('self:reload', () => win?.webContents.reloadIgnoringCache());
  // Through the normal quit, so before-quit stops the helper processes and flushes the log; no
  // "where we left off" note for a restart.
  handle('self:restart', () => {
    handoffDone = true;
    log.info('app restart');
    app.relaunch();
    app.quit();
  });

  // Claude account (Claude Code CLI)
  handle('claude:status', (opts) => claudecode.status({ fresh: Boolean(opts?.fresh) }));
  handle('claude:login', () => claudecode.openLogin('login'));
  handle('claude:logout', () => claudecode.openLogin('logout'));
  handle('claude:installHint', () => claudecode.installHint());
  handle('claude:connectors', () => claudecode.listConnectors());
  // A connector's permission level from Settings: applied to the saved lists here, never rebuilt from
  // the window's copy, which can miss an "Always allow…" given in an approval meanwhile.
  handle('claude:setConnectorLevel', async (key, level) => {
    const connectors = require('./connectors');
    if (!connectors.LEVELS.includes(level)) throw new Error(`Unknown level "${level}".`);
    const server = connectors.serverKey(key);
    if (!server || connectors.isOwnServer(server)) throw new Error('Unknown connector.');
    return store.setSettings({ claudeCode: connectors.levelPatch((await store.getSettings()).claudeCode, server, level) });
  });
  // How much of the Claude plan is left (claudeusage.js); updates arrive as `claude:usage` events.
  handle('claude:usage', () => require('./claudeusage').get());
  // The title-bar system monitor (sysmon.js): samples only while the window watches; the numbers go
  // to the window only, never to the AI or the log.
  handle('system:watch', (on) => require('./sysmon').watch(Boolean(on), (stats) => toWindow('system:stats', stats)));
  // The details panel: connected Bluetooth devices and the network adapter (while it is open), and the
  // internet speed test (netspeed.js), only on the user's click.
  handle('system:bluetooth', () => require('./sysmon').bluetooth());
  handle('system:network', () => ({ ...require('./sysmon').network(), lastSpeed: require('./netspeed').last(), measuring: require('./netspeed').running() }));
  handle('system:speedtest', () => require('./netspeed').run());
  // What Nexus itself holds, and freeing it (the panel's "Nexus" section; user clicks only).
  handle('system:usage', () => require('./resources').usage());
  handle('system:free', (what) => require('./resources').free(String(what)));
  require('./claudeusage').onChange((s) => toWindow('claude:usage', s));

  // Screen sharing (started and stopped only by the user)
  handle('screen:sources', () => screenshare.sources());
  handle('screen:start', (src) => screenshare.start(src || {}));
  handle('screen:stop', () => screenshare.stop('stopped by the user'));
  handle('screen:state', () => ({ ...screenshare.state(), permission: screenshare.permission() }));
  handle('screen:preview', () => screenshare.preview());

  // Skills
  handle('skills:list', () => skills.list());
  const skillsChanged = (r) => (companion.dataChanged(['skills']), r);
  handle('skills:save', (skill, oldSlug) => skills.save(skill || {}, { slug: oldSlug }).then(skillsChanged));
  handle('skills:delete', (slug) => skills.remove(slug).then(skillsChanged));
  handle('skills:scan', (repo) => require('./skillimport').scan(String(repo || '')).then(({ files, ...s }) => s));
  handle('skills:import', (repo, paths) => require('./skillimport').install(String(repo || ''), Array.isArray(paths) ? paths.map(String) : []).then(skillsChanged));
  handle('skills:openFolder', async () => {
    await fsp.mkdir(skills.dir(), { recursive: true });
    return opened(await shell.openPath(skills.dir()));
  });

  // PDF export and quick notes (a new PDF opens in a document window)
  const openPdf = (r) => (docwindows.open(r.path), r);
  handle('pdf:fromMarkdown', async (title, markdown) => openPdf(await pdf.create({ title, markdown })));
  handle('pdf:fromNote', async (ref) => {
    const note = await obsidian.readNote(ref);
    const title = String(note.path || ref).split('/').pop().replace(/\.md$/i, '');
    return openPdf(await pdf.create({ title, markdown: String(note.content).replace(/^---[\s\S]*?---\s*/, '') }));
  });
  handle('pdf:fromConversation', async (id) => {
    const conv = await store.getConversation(id);
    if (!conv) throw new Error('Conversation not found');
    return openPdf(await pdf.create({ title: conv.title || 'Conversation', html: await pdf.conversationHtml(conv) }));
  });
  handle('notes:quick', (text, title) => obsidian.quickNote(text, title, { source: 'user' }));
  // The Notes view (renderer/js/notes.js): the user's own notes in Notes/ and Inbox/ (main/notebook.js).
  const notebook = () => require('./notebook');
  handle('notebook:list', () => notebook().list());
  handle('notebook:read', (rel) => notebook().read(String(rel || '')));
  handle('notebook:create', (note) => notebook().create(note && typeof note === 'object' ? { title: String(note.title || ''), body: String(note.body || ''), folder: String(note.folder || '') } : {}));
  handle('notebook:save', (rel, note) => notebook().save(String(rel || ''), { ...(note?.title !== undefined ? { title: String(note.title) } : {}), ...(note?.body !== undefined ? { body: String(note.body) } : {}) }));
  handle('notebook:remove', (rel) => notebook().remove(String(rel || '')));
  handle('notebook:restore', (trashed, rel) => notebook().restore(String(trashed || ''), String(rel || '')));
  handle('notebook:pin', (rel, on) => notebook().pin(String(rel || ''), Boolean(on)));
  handle('notebook:polish', (rel) => notebook().polish(String(rel || '')));

  // Hardware scan (setup wizard)
  handle('hardware:scan', (opts) => require('./hardware').scan(opts || {}));

  // Persona look & feel
  handle('persona:generate', (payload) => persona.generate(payload));
  handle('persona:scene', (payload) => persona.generateScene(payload));
  handle('persona:summaryStatus', () => persona.summaryStatus());
  handle('persona:summarize', () => persona.ensureSummary({ force: true }));
  handle('persona:setSummary', (text, forPersona) => persona.setSummary(String(text ?? ''), typeof forPersona === 'string' ? forPersona : ''));
  // Saved personas: each returns the new settings (the live persona changed).
  handle('persona:switch', (id) => persona.activate(String(id || '')));
  handle('persona:create', (opts) => persona.create({ name: String(opts?.name || ''), copy: opts?.copy === true, template: typeof opts?.template === 'string' ? opts.template : null, activate: opts?.activate !== false }));
  handle('persona:templates', () => persona.templates());

  // Routines (scheduled agent runs)
  // The memory stream (stream.js) and the Inner World (innerworld.js); window only, never to devices.
  handle('stream:recent', async () => {
    const stream = require('./stream');
    return (await stream.enabled()) ? stream.recent() : null;
  });
  handle('stream:reflect', () => {
    const stream = require('./stream');
    return stream.reflect(stream.USER, { force: true });
  });
  handle('world:view', () => require('./innerworld').view());
  handle('world:simulate', (force) => require('./innerworld').simulate({ force: force === true }));
  handle('world:resident', (name) => require('./innerworld').resident(String(name || '')));
  // Extensions (MCP servers for the Claude account brain) and the God's Eye View globe
  handle('extensions:status', async () => require('./extensions').status(await store.getSettings()));
  handle('extensions:check', (dir) => require('./extensions').checkGodsEye(String(dir || '')));
  handle('extensions:install', async (parent) => {
    if (!parent || typeof parent !== 'string') throw new Error('Choose a folder first.');
    return require('./extensions').installGodsEye(parent, (p) => toWindow('extensions:progress', p));
  });
  handle('extensions:start', async () => require('./extensions').ensureGodsEye(await store.getSettings()));
  handle('extensions:stop', () => require('./extensions').stopGodsEye());
  handle('extensions:openGlobe', async (url) => {
    const ext = require('./extensions');
    await ext.ensureGodsEye(await store.getSettings());
    return agentwindow.open(url ? String(url) : ext.GODSEYE_ORIGIN, { byAgent: false, focus: true });
  });
  // The agent window's toolbar (renderer/agentwindow.js); the page itself has no access to the app.
  handle('agentWindow:state', () => agentwindow.toolbar.state());
  handle('agentWindow:go', (text) => agentwindow.toolbar.go(String(text || '').slice(0, 2000)));
  handle('agentWindow:back', () => agentwindow.toolbar.back());
  handle('agentWindow:forward', () => agentwindow.toolbar.forward());
  handle('agentWindow:reload', () => agentwindow.toolbar.reload());
  handle('agentWindow:stop', () => agentwindow.toolbar.stop());
  handle('agentWindow:home', () => agentwindow.toolbar.home());
  // The title-bar button: brings the window forward, or opens it at the start page.
  handle('agentWindow:open', () => (agentwindow.state().open ? (agentwindow.show({ focus: true }), agentwindow.state()) : agentwindow.toolbar.home()));
  // The Architecture view: the cached map of the app's own code, or a fresh scan (Rebuild).
  handle('arch:get', () => archmap.get(ROOT));
  handle('arch:build', () => archmap.build(ROOT));
  // History replays (main/replay.js): the app's own commits for the Architecture view, the vault's for Growth.
  handle('arch:history', () => require('./replay').appHistory(ROOT));
  handle('obsidian:growth', async () => require('./replay').vaultHistory(await obsidian.vaultPath()));
  handle('routines:list', () => routines.list());
  handle('routines:save', (r) => routines.save(r && typeof r === 'object' ? r : {}));
  handle('routines:remove', (id) => routines.remove(String(id)));
  handle('routines:run', (id) => routines.runNow(String(id)));
  handle('routines:setEnabled', (id, on) => routines.setEnabled(String(id), on));
  handle('persona:remove', (id) => persona.remove(String(id || '')));

  // Internet
  handle('web:search', (q) => websearch.search(q, 5));

  // Approvals (answered in the app by click or voice)
  handle('approval:respond', (id, allow, reason, remember) => approvals.respond(id, allow, reason, remember));

  // Mechanic: diagnostics + log
  handle('diag:run', () => diagnostics.run());
  // A window's line that names its turn (`turn`: the last 6 characters of the requestId, as turns.js tags it)
  // is written under that turn's tag, so `turn=…` finds the window's side of a turn too.
  handle('log:write', (level, event, data) => {
    const write = () => log[['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info'](`ui: ${event}`, data);
    const turn = data && typeof data === 'object' ? data.turn : null;
    return typeof turn === 'string' && /^\w{1,12}$/.test(turn) ? log.withContext({ turn }, write) : write();
  });
  handle('log:tail', (n, filter) => log.tail(n || 300, filter || ''));
  handle('log:open', () => shell.showItemInFolder(log.file()));
  handle('issues:pending', () => require('./issues').pending());
  handle('issues:open', (key) => require('./issues').open(String(key || '')));
  handle('issues:dismiss', (key) => require('./issues').dismiss(String(key || '')));
  handle('log:report', async (note) => {
    const r = await envinfo.bugReport(note || '');
    shell.showItemInFolder(r.file);
    return r;
  });

  // Warm the Claude Code session for a conversation (at launch and after a persona switch: `now`; when a
  // chat opens: after llm.PREWARM_SETTLE_MS, and a newer request replaces a waiting one, so browsing
  // History warms only the chat the user stays on).
  handle('llm:prewarm', async (convId, opts) => {
    if (smoke.active) return false; // the launch check never reaches a real model (test/smokemodel.test.js)
    if (!convId) return false;
    // Taken at the request, before the read: a message run again meanwhile (claudecode.forget) makes this copy stale.
    const epoch = claudecode.epochOf(convId);
    return llm.settlePrewarm(async () => {
      const s = await store.getSettings();
      if (s.llm.provider !== 'claude-code' || !s.claudeCode.warmOnLaunch) return false;
      const conv = await store.getConversation(convId);
      if (conv?.setup) return false;
      llm.prewarm(s, conv, { epoch }).catch((e) => log.warn('prewarm failed', { error: e }));
      return true;
    }, { now: opts?.now === true });
  });
  handle('chat:endSession', (convId) => claudecode.endSession(convId));

  // First-run setup by conversation: the agent interviews the user and configures itself.
  handle('setup:start', async () => {
    const conv = await store.createConversation('First-run setup');
    conv.setup = true;
    await store.saveConversation(conv);
    log.info('setup started', conv.id);
    return conv.id;
  });
  handle('setup:checkService', (service, url) => require('./services').check(service, { url }));
  // The feature guide (main/guide.js) for the onboarding tour: the same entries the agent explains.
  handle('guide:features', async () => {
    const { FEATURES, guide } = require('./guide');
    const now = new Map(((await guide().catch(() => null))?.features || []).map((f) => [f.id, f.status]));
    return FEATURES.map((f) => ({ id: f.id, title: f.title, what: f.what, say: f.say, where: f.where, status: now.get(f.id) || '' }));
  });
  handle('setup:skip', async () => {
    await store.setSettings({ onboarded: true });
    log.info('setup skipped');
    return true;
  });

  // Vault system
  handle('obsidian:vaults', () => obsidian.knownVaults());
  handle('obsidian:register', () => obsidian.registerVault());
  handle('obsidian:history', async (rel) => vaultgit.history(await obsidian.vaultPath(), rel));
  handle('obsidian:showVersion', async (rel, version) => vaultgit.showVersion(await obsidian.vaultPath(), rel, version));
  handle('obsidian:restoreVersion', async (rel, version) => vaultgit.restore(await obsidian.vaultPath(), rel, version));
  handle('obsidian:priorities', () => obsidian.readPriorities());

  // Faces (built-in + custom faces in <userData>/faces)
  handle('faces:list', () => listCustomFaces());
  handle('faces:openFolder', async () => opened(await shell.openPath(await facesDir())));

  // Misc
  handle('dialog:pickFolder', async (title) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:pickImage', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const ext = path.extname(r.filePaths[0]).slice(1).toLowerCase().replace('jpg', 'jpeg');
    return `data:image/${ext};base64,${(await fsp.readFile(r.filePaths[0])).toString('base64')}`;
  });
  handle('shell:openExternal', (url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened');
    return shell.openExternal(url);
  });
  handle('mic:request', async () => {
    if (process.platform === 'darwin') return systemPreferences.askForMediaAccess('microphone');
    return true;
  });
}

// Push-to-talk from a paired device: the window transcribes it with the user's speech-to-text
// (local Whisper runs there) and answers through remote:transcribed. Likewise the offline voice: the
// window speaks a reply into a WAV for the device (remote:speak → remote:spoken).
const pendingTranscripts = new Map(); // id -> { resolve, reject, timer }
function askWindow(channel, payload, what, timeoutMs = 90000) {
  if (!win || win.isDestroyed()) return Promise.reject(new Error('The assistant window is closed'));
  const id = require('crypto').randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTranscripts.delete(id);
      reject(new Error(`${what} took too long`));
    }, timeoutMs);
    pendingTranscripts.set(id, { resolve, reject, timer });
    win.webContents.send(channel, { id, ...payload });
  });
}
// A longer recording gets longer: a minute, plus a second per second of audio (16 kHz 16-bit = 32000 bytes/s).
const transcribeInWindow = (wav) => askWindow('remote:transcribe', { wav: new Uint8Array(wav) }, 'Speech-to-text', 60000 + Math.ceil(wav.length / 32000) * 1000);
const speakInWindow = (text) => askWindow('remote:speak', { text: String(text).slice(0, 4000) }, 'The offline voice');

function merge(settings, override) {
  if (!override) return settings;
  const out = JSON.parse(JSON.stringify(settings));
  for (const [k, v] of Object.entries(override)) out[k] = { ...out[k], ...v };
  return out;
}

async function saveFile(defaultName, content, filters) {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), defaultName), filters });
  if (r.canceled || !r.filePath) return null;
  await fsp.writeFile(r.filePath, content, 'utf8');
  return r.filePath;
}

app.whenReady().then(async () => {
  registerAppProtocol();
  registerFacesProtocol();
  registerIpc();
  approvals.setSender(send);
  calendar.removeLegacy();
  companion.init({
    startTurn: turns.start,
    abortTurn: (requestId) => turns.abort(requestId),
    respondApproval: (id, allow, reason) => approvals.respond(id, allow, reason),
    transcribe: transcribeInWindow,
    synthesize: speakInWindow,
    notify: (ev) => {
      send('remote:event', ev);
      remoteAlert(ev);
    },
  });
  // A persona switch or a changed look reaches paired phones (and, through them, the watch) at once.
  store.onChange((s, patch) => companion.settingsChanged(patch));
  // Connector levels also change outside the window (an approval's "Always allow…", the tool
  // connector_permission): the window gets the saved lists, so Settings shows and keeps them.
  store.onChange((s, patch) => {
    if (['connectorsAllowed', 'connectorsReadOnly', 'connectorsWrite'].some((k) => patch?.claudeCode?.[k])) {
      toWindow('claude:connectorLevels', { connectorsAllowed: s.claudeCode.connectorsAllowed, connectorsReadOnly: s.claudeCode.connectorsReadOnly, connectorsWrite: s.claudeCode.connectorsWrite });
    }
  });
  // A long master prompt gets its short version for local models (persona.ensureSummary): a little after
  // start, and after the persona, its master prompt or the brain changed (a switch, an edit). Settled
  // first: a persona being edited is not summarized on every keystroke.
  let summaryTimer = null;
  const summarizeSoon = (ms) => {
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => {
      persona.ensureSummary().then((st) => toWindow('persona:summary', st), (error) => log.warn('persona summary failed', { error }));
    }, ms);
  };
  store.onChange((s, patch) => {
    if (patch?.agent?.personality !== undefined || patch?.llm || patch?.local) summarizeSoon(20000);
  });
  summarizeSoon(60000);
  // Attachment folders whose conversation is gone (deleted while the app was down): a while after start.
  setTimeout(() => attachments.sweep().catch((error) => log.warn('attachment sweep failed', { error })), 90000).unref?.();
  require('./tunnel').setListener((st) => send('remote:event', { type: 'tunnel', tunnel: st }));
  screenshare.setListener((st) => send('screen:state', st));
  docwindows.init({ root: ROOT, preload: path.join(ROOT, 'preload.js'), mainWindow: () => win, agentWindow: () => agentwindow.window(), guard: guardNavigation, captureConsole });
  agentwindow.init({ root: ROOT, preload: path.join(ROOT, 'preload.js'), mainWindow: () => win, guard: guardNavigation, captureConsole });
  documents.setPopup(docwindows);
  obsidian.setChangeListener((rel) => send('vault:changed', rel));
  log.info('==================== app start', { version: app.getVersion(), pid: process.pid, sinceStartMs: Math.round(process.uptime() * 1000) });
  envinfo.environment().then((env) => log.info('environment', env), (err) => log.warn('environment unavailable', err));
  // Health heartbeat: memory and uptime, so leaks and slowdowns show up in the log.
  setInterval(() => {
    const m = process.memoryUsage();
    log.info('heartbeat', { uptimeMin: Math.round(process.uptime() / 60), rssMB: Math.round(m.rss / 1e6), heapMB: Math.round(m.heapUsed / 1e6), windows: BrowserWindow.getAllWindows().length });
  }, 15 * 60 * 1000).unref();

  // Allow microphone access for push-to-talk; deny everything else by default.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'audioCapture', 'clipboard-sanitized-write'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['media', 'audioCapture', 'clipboard-sanitized-write'].includes(permission));

  if (!isDev) Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  createWindow();
  registerShortcut().catch((error) => log.warn('voice shortcut not registered', { error }));

  // Make sure the change history exists before the agent can modify itself.
  const s = await store.getSettings();
  log.setDebug(s.logging?.debug);
  if (s.code.enabled && s.code.allowSelfModify) selfchange.ensureRepo().catch((e) => log.warn('change history unavailable', e));
  obsidian.vaultPath().catch(() => {});
  // The launch check starts no servers and no helper programs.
  if (!smoke.active) companion.apply(s).catch((e) => log.warn('remote server start failed', e));
  helperApps.init({ notify: (ev) => send('helperApps:event', ev) });
  if (!smoke.active) helperApps.ensureAll(s, 'launch');
  journal.start();
  startRoutines();
  startTasks();
  // Live work ('work') reaches devices with the tool's own event; a new day or a level-up is news for their world screen.
  require('./innerworld').start({ notify: (ev) => (toWindow('world:event', ev), ev?.type !== 'work' && companion.dataChanged(['world'])) });
  // A check's answer goes to the title bar, and to paired phones (they offer the newest APK from /api/info).
  if (!smoke.active) require('./updates').start({ notify: (st) => (toWindow('updates:state', st), companion.infoChanged()) });
  store.sweepStaleTemp().catch(() => {});
  claudecode.sweepStaleTemp().catch(() => {});

  app.on('activate', () => {
    if (closing && !handoffDone) showMain(); // the dock while the window is hidden for its handoff note
    else if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// The handoff note on closing: the window is gone at once (hidden and muted) while the note is written
// behind it, then it really closes. Starting the app again meanwhile brings the same window back.
let handoffDone = false;
let closing = false;
let quitAfterHandoff = false;
let reopenRequested = false; // the window was asked for while the note was being written (showMain)
const afterReopen = []; // what those requests do once it is back (open a routine's chat, start listening)

// Every way the main window is brought to the front (a second launch, the voice shortcut, a notification's
// click, the macOS dock) goes through here, then runs `then`. While the window is hidden for closing, the
// close is called off instead: skip() cuts the note short, and the window comes back (then `then`) once
// it is written, rather than being shown now and closed under the user when the note finishes.
function showMain(then = null) {
  if (closing && !handoffDone) {
    reopenRequested = true;
    if (then) afterReopen.push(then);
    handoff.skip();
    return;
  }
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  then?.();
}

function hideForClose() {
  if (!win || win.isDestroyed()) return;
  // Mutes what the page plays (the offline, cloud and VoiceStudio voices, sounds); the system voice
  // (speechSynthesis) is spoken by the OS, not muted by this.
  win.webContents.setAudioMuted(true);
  win.hide();
}

// The close is called off: the window comes back as it was (restored if it was minimized), and a later
// close writes the note again.
function reopenAfterClose() {
  closing = false;
  quitAfterHandoff = false;
  reopenRequested = false;
  const then = afterReopen.splice(0);
  if (!win || win.isDestroyed()) return;
  win.webContents.setAudioMuted(false);
  showMain(() => then.forEach((fn) => fn()));
}

async function closeWithHandoff() {
  if (closing) return;
  closing = true;
  try {
    const s = await store.getSettings();
    if (reopenRequested) return; // asked for again while the settings were read: no note, never hidden
    if (s.onboarded && s.journal.handoffOnClose !== false) {
      hideForClose();
      // The conversations with a reply still being written: "interrupted" only if the note's own one is
      // among them, not because a routine or the tasks sync was running elsewhere.
      await handoff.write({ replying: turns.replying() });
    }
  } catch (err) {
    log.warn('handoff on close failed', { error: err });
  } finally {
    if (reopenRequested) reopenAfterClose();
    else {
      handoffDone = true;
      if (quitAfterHandoff) app.quit();
      else if (win && !win.isDestroyed()) win.close();
    }
  }
}

app.on('before-quit', (e) => {
  // Quit from the menu or Cmd+Q: write the handoff first, then quit for real.
  if (!handoffDone && win && !win.isDestroyed()) {
    e.preventDefault();
    quitAfterHandoff = true;
    closeWithHandoff();
    return;
  }
  log.info('app quit');
  log.flush();
  claudecode.shutdown();
  companion.stop();
  helperApps.stopStarted(); // only if "close them when Nexus quits" is on, and only the ones it started
  require('./extensions').stopGodsEye(); // the globe's server, only if Nexus started it
  require('./sysmon').stop(); // its GPU reader process
  journal.stop();
  vaultgit.flushAll();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
// The GPU or audio process can crash on its own (driver updates, sleep); Chromium restarts it.
app.on('child-process-gone', (_e, details) => log.warn('helper process gone', details));
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
