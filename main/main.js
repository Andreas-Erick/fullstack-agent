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
const attachcore = require('./attachcore');
const { navDecision } = require('./navguard');
const { UNTRUSTED_NOTICE } = require('./tools/common');

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
const activeRequests = new Map(); // requestId -> AbortController (with .conversationId)
const deletedConversations = new Set(); // a reply finishing after its conversation was deleted is dropped
const busyIn = (id) => [...activeRequests.values()].some((c) => c.conversationId === id); // a reply is being written there
const redo = require('./redo');

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
        // The log tag its turn runs under (startTurn's tags): a delete or pause from this turn's own tools
        // doesn't stop it (routines.js stopRun).
        onTurn?.(requestId.slice(-6));
        let conversationId = ''; // once startTurn has it (a first run makes one): a stopped run keeps it
        // A run that takes too long (a hung tool, an approval nobody answers…) is stopped.
        const timer = setTimeout(() => {
          activeRequests.get(requestId)?.abort();
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
        // when it was still being set up (startTurn registers the request after a few awaits).
        const stop = () => {
          stopRequested = true;
          activeRequests.get(requestId)?.abort();
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
          .then((id) => (stopRequested ? null : startTurn({ conversationId: id, text, requestId, display: `⏰ ${routine.name}`, routine: routine.id, onFinish: done })))
          .then((started) => {
            conversationId = started?.conversationId || '';
            if (stopRequested) activeRequests.get(requestId)?.abort();
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
          activeRequests.get(requestId)?.abort();
          resolve({ ok: false, error: 'Stopped after 5 minutes.' });
        }, 5 * 60000);
        startTurn({ conversationId: conversationId || undefined, text, requestId, display: store.TASKS_SYNC_DISPLAY, auto: 'tasks', onFinish: (r) => (clearTimeout(timer), resolve(r)) }).catch((err) => (clearTimeout(timer), resolve({ ok: false, error: err.message })));
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
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

// Errors printed in any window's console (also scripts that fail to load) end up in the log.
function captureConsole(wc, label) {
  wc.on('console-message', (e) => {
    if (e.level !== 'error') return;
    log.warn(`${label} console error`, { message: String(e.message).slice(0, 500), source: `${String(e.sourceId || '').replace(/^.*\/renderer\//, 'renderer/')}:${e.lineNumber}` });
  });
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
  handle('settings:set', async (patch) => {
    const s = await store.setSettings(patch);
    if (patch?.stt?.globalShortcut !== undefined) registerShortcut().catch((error) => log.warn('voice shortcut not registered', { error }));
    if (patch?.logging) log.setDebug(s.logging.debug);
    if (patch?.remote) await companion.apply(s);
    // A newly used or re-enabled helper app (VoiceStudio, FreeLLMAPI) starts now.
    if (patch?.voice || patch?.llm || patch?.routing || patch?.helperApps) helperApps.ensureAll(s, 'settings');
    if (patch?.routing || patch?.llm?.provider || ['gemini', 'deepseek', 'groq', 'perplexity', 'anthropic', 'claudeCode'].some((k) => patch?.[k])) router.reset();
    return s;
  });
  handle('settings:reset', () => store.resetSettings());
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
    log.info('window ready', { ms: Math.round(Number(ms) || 0) });
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
    startTurn({ conversationId, text, requestId, voice, hidden, attachments: Array.isArray(tokens) ? tokens.filter((t) => typeof t === 'string').slice(0, 7) : [] }),
  );
  handle('chat:attach', (item) => attachments.prepare(item));
  handle('chat:abort', (requestId) => {
    activeRequests.get(requestId)?.abort();
    return true;
  });
  // Try again / Regenerate / Edit (main/redo.js): desktop only; the window checks first (a confirm may be needed).
  handle('chat:redoCheck', async (req) => redo.forWindow(redo.check(await store.getConversation(String(req?.conversationId || '')).catch(() => null), req, { busy: busyIn(req?.conversationId) })));
  handle('chat:redo', (req) => {
    if (!/^[\w-]{1,64}$/.test(String(req?.requestId || ''))) throw new Error('Bad request');
    return startTurn({ conversationId: String(req?.conversationId || ''), requestId: String(req.requestId), text: '', redo: req });
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
    if (c) c.messages = c.messages.map(stripRaw);
    return c;
  });
  handle('conv:new', () => store.createConversation());
  // Paired devices hear that their conversation list changed (companion.dataChanged).
  const convsChanged = (r) => (companion.dataChanged(['conversations']), r);
  const historysearch = () => require('./historysearch'); // the words inside conversations (History's search)
  handle('conv:delete', (id) => {
    deletedConversations.add(id);
    historysearch().forget(id);
    for (const c of activeRequests.values()) if (c.conversationId === id) c.abort();
    claudecode.forget(id); // its session ends, and a warm-up queued by opening it a moment ago doesn't run
    return store
      .deleteConversation(id)
      .then((r) => attachments.removeFor(id).catch((error) => log.warn('attachments not removed', { error })).then(() => r))
      .then((r) => (historysearch().forget(id), r)) // a scan running meanwhile can't keep it
      .then(convsChanged);
  });
  handle('conv:rename', (id, title) => store.renameConversation(id, title).then(convsChanged));
  // History: ids, titles and snippets, never conversations (main/historysearch.js).
  handle('conv:search', (query, opts) => historysearch().search(String(query ?? ''), { cursor: opts?.cursor ?? null, limit: Number(opts?.limit) || undefined }));
  handle('conv:clear', async () => {
    historysearch().clear();
    for (const c of await store.listConversations()) {
      deletedConversations.add(c.id);
      claudecode.forget(c.id);
    }
    for (const c of activeRequests.values()) c.abort();
    return store
      .clearConversations()
      .then((r) => attachments.removeAll().catch((error) => log.warn('attachments not removed', { error })).then(() => r))
      .then(convsChanged);
  });
  handle('conv:export', async () => {
    const all = (await store.exportConversations()).filter(Boolean).map((c) => ({ ...c, messages: c.messages.map(stripRaw) }));
    return saveFile('nexus-conversations.json', JSON.stringify(all, null, 2), [{ name: 'JSON', extensions: ['json'] }]);
  });

  // Memory vault
  handle('memory:list', () => memory.list());
  handle('memory:search', (q) => memory.search(q));
  handle('memory:save', (e) => memory.save(e));
  handle('memory:update', (id, patch) => memory.update(id, patch));
  handle('memory:delete', (id) => memory.remove(id));
  handle('memory:clear', () => memory.clear());
  handle('memory:dir', () => memory.vaultDir());
  handle('memory:openDir', async () => shell.openPath(await memory.vaultDir()));
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
  handle('docs:openExternal', async (p) => shell.openPath(await documents.externalPath(p)));

  // Vault (the agent's own Obsidian vault)
  handle('obsidian:write', (p, content, mode) => obsidian.writeNote(p, content, mode));
  handle('obsidian:delete', (p) => obsidian.deleteNote(p));
  handle('obsidian:openFolder', async () => shell.openPath(await obsidian.vaultPath()));
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
    return shell.openPath(skills.dir());
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
  handle('notebook:pin', (rel, on) => notebook().pin(String(rel || ''), Boolean(on)));
  handle('notebook:polish', (rel) => notebook().polish(String(rel || '')));

  // Hardware scan (setup wizard)
  handle('hardware:scan', (opts) => require('./hardware').scan(opts || {}));

  // Persona look & feel
  handle('persona:generate', (payload) => persona.generate(payload));
  handle('persona:scene', (payload) => persona.generateScene(payload));
  handle('persona:summaryStatus', () => persona.summaryStatus());
  handle('persona:summarize', () => persona.ensureSummary({ force: true }));
  handle('persona:setSummary', (text) => persona.setSummary(String(text ?? '')));
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
  handle('log:write', (level, event, data) => log[['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info'](`ui: ${event}`, data));
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

  // Warm the Claude Code session for a conversation (called at launch / when a chat opens)
  handle('llm:prewarm', async (convId) => {
    if (smoke.active) return false; // the launch check never reaches a real model (test/smokemodel.test.js)
    const s = await store.getSettings();
    if (s.llm.provider !== 'claude-code' || !s.claudeCode.warmOnLaunch || !convId) return false;
    // Taken before the read: a message run again while it reads (claudecode.forget) makes this copy stale.
    const epoch = claudecode.epochOf(convId);
    const conv = await store.getConversation(convId);
    if (conv?.setup) return false;
    llm.prewarm(s, conv, { epoch }).catch((e) => log.warn('prewarm failed', e.message));
    return true;
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
  handle('faces:openFolder', async () => shell.openPath(await facesDir()));

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

// One chat turn, from the window (chat:send) or a paired device (remote = the device name). Returns
// at once; the reply streams as chat:event. Remote turns never carry a screenshot of this desktop.
// display: what the chat shows instead of the text (routines); onFinish({ ok, text, error }) after the turn.
// routine / auto ('tasks'): a turn the user didn't write, so it never counts as their chat (store.js lastOwnAt).
// redo: Try again / Regenerate / Edit from the window (chat:redo; its text replaces `text`).
// attachments: one-time tokens from chat:attach (main/attachments.js); only the user's own messages in the
// window carry them. An expired one returns { refused } and nothing is stored.
async function startTurn({ conversationId, text, requestId, voice: viaVoice = false, hidden = false, remote = null, display = '', routine = '', auto = '', onFinish = null, redo: redoReq = null, attachments: tokens = [] }) {
  const settings = await store.getSettings();
  // Attachments (main/attachments.js): one-time tokens from chat:attach, claimed before anything is stored.
  const claim = tokens.length ? attachments.claim(tokens) : { items: [] };
  if (claim.error) return { refused: claim.error };
  // A failure before the turn runs in the background: it no longer counts as busy (below), and the
  // attachments' chips come back in the window.
  const fail = (err) => {
    activeRequests.delete(requestId);
    attachments.unclaim(tokens);
    throw err;
  };
  let conv = conversationId ? await store.getConversation(conversationId).catch(fail) : null;
  if (redoReq && !conv) fail(new Error('Conversation not found'));
  if (!conv) conv = await store.createConversation().catch(fail);
  if (remote && conv.setup) fail(new Error('The setup conversation can only be used on the desktop'));
  if (claim.items.length && (remote || conv.setup || hidden || routine || auto)) fail(new Error('Attachments can only go with your own messages in the chat.'));
  // Try again / Regenerate / Edit, and the same message sent again after a failure (main/redo.js).
  let prep;
  try {
    prep = redo.prepare({ conv, redo: redoReq, text, voice: viaVoice, remote, routine, auto, hidden, busy: busyIn(conv.id), forget: claudecode.forget });
  } catch (err) {
    fail(err);
  }
  text = prep.text;
  viaVoice = prep.voice;
  const again = prep.again;
  if (again) log.info('turn again', { kind: again.kind, fresh: again.fresh, acted: again.acted.length, uncertain: again.uncertain || undefined, from: remote ? 'device' : 'window' });
  const own = !conv.setup && !routine && !auto && !hidden; // the user's own message: its attempt is recorded (Try again)
  // Busy from the gates on (busyIn), not only once the reply runs: another Try again, or the same message
  // sent again from the phone or the watch, can't pass them during the awaits below.
  const controller = new AbortController();
  controller.conversationId = conv.id;
  activeRequests.set(requestId, controller);
  // "/skill-name input": the agent gets the skill's steps; the chat shows what was typed.
  const slash = conv.setup ? null : await skills.fromSlash(text).catch(() => null);
  // While the screen is shared, the message carries a fresh screenshot (not stored).
  let images = [];
  if (!remote && !conv.setup && screenshare.state().active && settings.screen.attachToMessages !== false) {
    images = await screenshare.capture().then(
      (shot) => [shot.url],
      (err) => (send('app:notice', { kind: 'error', message: err.message }), []),
    );
  }
  const screenShot = images.length > 0;
  // Attached files: copies kept with the conversation, their text in blocks before the user's words;
  // attached images go with the message like a screenshot and are never stored (attachcore.compose).
  const saved = claim.items.length ? await attachments.save(conv.id, claim.items).catch(fail) : [];
  const prompt = slash ? skills.instructions(slash.skill, slash.args) : String(text);
  // A message run again keeps its files (their text is in the old message's blocks); its pictures are gone.
  const composed = saved.length
    ? attachcore.compose({ prompt, typed: String(text), items: saved, notice: UNTRUSTED_NOTICE })
    : again?.user?.attachments?.length
      ? attachcore.recompose(again.user, { prompt, typed: String(text) })
      : null;
  if (composed) images.push(...composed.images);
  const userMsg = {
    id: store.newId('m'),
    role: 'user',
    content: composed ? composed.content : prompt,
    createdAt: Date.now(),
    ...(slash ? { display: String(text), skill: slash.skill.slug } : {}),
    ...(composed ? { display: composed.display, attachments: composed.meta } : {}),
    ...(display ? { display: String(display) } : {}),
    ...(routine ? { routine } : {}),
    ...(auto ? { auto } : {}),
    ...(screenShot ? { screen: true } : {}),
    ...(hidden ? { hidden: true } : {}),
    ...(remote ? { remote } : {}),
    ...(viaVoice ? { spoken: true } : {}), // the cache warm-up guesses the next model from it (llm.warmTarget)
    ...(own ? { attempt: { outcome: 'running', at: Date.now() } } : {}),
  };
  conv.messages.push(userMsg);
  if (!conv.setup && !again?.keepTitle && conv.messages.filter((m) => m.role === 'user').length === 1) conv.title = (slash ? slash.skill.name : display || (composed && !String(text).trim() ? composed.title : String(text))).replace(/\s+/g, ' ').slice(0, 60);
  // Deleted (History ✕, Clear all) during the awaits above: the save would bring it back, with the files just copied.
  if (deletedConversations.has(conv.id)) {
    if (saved.length) attachments.removeFor(conv.id).catch((error) => log.warn('attachments not removed', { error }));
    fail(new Error('The conversation was deleted'));
  }
  await store.saveConversation(conv).catch(fail);
  attachments.release(tokens);

  // Until that save, the file still had the old exchange: a warm-up that read it meanwhile is stale too.
  if (again?.fresh) claudecode.forget(conv.id);
  // Timing for the log: when the first words of the reply arrived, and when it finished.
  const startedAt = Date.now();
  let firstTextMs = null;
  // The source files the agent's tools write this turn (selfchange.touchedBy): the end-of-turn record
  // commits those and nothing else.
  const touched = new Set();
  let codeRoot = null;
  // The tools this turn ran (Try again tells the next attempt what already happened).
  const ran = new Map();
  let attemptSaved = false;
  const emit = (ev) => {
    if (firstTextMs === null && ev.type === 'text') firstTextMs = Date.now() - startedAt;
    // The Inner World sends the active persona to where the work happens (counts only).
    if (ev.type === 'tool_start' && !conv.setup) {
      require('./innerworld').noteTool(ev.name);
      const t = selfchange.touchedBy(ev.name, ev.input, codeRoot);
      if (t) touched.add(t);
    }
    if (ev.type === 'tool_start') {
      ran.set(ev.id, { name: ev.name, ok: null, input: ev.input });
      // The first action that changes something is recorded at once: a quit or crash mid-turn leaves a trace.
      if (own && !attemptSaved && !redo.readOnly(ev.name)) {
        attemptSaved = true;
        const a = redo.attemptFrom({ running: true, ran, firstTextMs });
        redo.remember(conv.id, userMsg.id, a);
        store.updateConversation(conv.id, (c) => redo.withAttempt(c, userMsg.id, a)).catch((error) => log.warn('could not record the attempt', { error }));
      }
    }
    if (ev.type === 'tool_end' && ran.has(ev.id)) ran.get(ev.id).ok = ev.ok;
    (conv.setup ? toWindow : send)('chat:event', { requestId, conversationId: conv.id, ...ev });
  };
  emit({ type: 'start', userMessage: redo.publicMessage(userMsg), title: conv.title, ...(again ? { replaces: again.replaces } : {}) });
  if (again?.acted.length || again?.uncertain) {
    const names = (list) => [...new Set(list.map((a) => a.name.replace(/^mcp__(claude_ai_)?/, '').replace(/_+/g, ' ')))].join(', ');
    const cut = again.unsure || [];
    const done = again.acted.filter((a) => !cut.includes(a));
    const who = settings.agent?.name || 'Siren';
    const said = [done.length ? `Already done by the earlier ${again.replyDropped ? 'reply' : 'attempt'} (not undone): ${names(done)}.` : '', cut.length ? `Cut off before it reported back (check before repeating): ${names(cut)}.` : ''].filter(Boolean).join(' ');
    emit({ type: 'notice', message: said || `The earlier attempt was cut off; ${who} checks before repeating anything.`, tools: done.map((a) => a.name), cut: cut.map((a) => a.name) });
  }
  if (again?.hadImages && !images.length) emit({ type: 'notice', message: 'This message had a picture with it; pictures aren’t kept, so the new reply can’t see it.' });

  // Run the turn in the background; the renderer receives streamed events. Every log line it
  // produces carries turn=<id> conv=<id>, so one request can be traced end to end.
  const tags = { turn: requestId.slice(-6), conv: conv.id.slice(-6) };
  log.withContext(tags, async () => {
    const trackChanges = settings.code.enabled && settings.code.allowSelfModify;
    const before = trackChanges ? await selfchange.fingerprint() : null;
    codeRoot = trackChanges ? await selfchange.root().catch(() => null) : null;
    try {
      const result = await llm.runTurn({ settings, conv, history: conv.messages, emit, signal: controller.signal, voice: viaVoice, images, routine: Boolean(routine), again: again?.again || null, taint: [...(screenShot ? ['the shared screen'] : []), ...(composed?.taint || [])], imageNoun: attachcore.imageNoun({ screen: screenShot, images: composed?.images.length || 0 }) });
      const assistantMsg = {
        id: store.newId('m'),
        role: 'assistant',
        content: result.text || (controller.signal.aborted ? '*(stopped)*' : ''),
        toolCalls: result.toolCalls,
        raw: result.raw,
        model: result.model,
        provider: result.provider || settings.llm.provider,
        persona: settings.agent?.name || undefined, // who answered: a later switch is named in the next turn's context
        createdAt: Date.now(),
        ...(controller.signal.aborted ? { stopped: true } : {}), // the Claude API path stores a stopped reply (Try again)
      };
      if (deletedConversations.has(conv.id)) {
        // Deleted mid-reply: the API paths return from an abort (no AbortError), so the window and devices
        // hear the end here, as the Claude Code path's throw tells them below.
        emit({ type: 'aborted', message: 'Stopped' });
        return onFinish?.({ ok: false, error: 'The conversation was deleted', conversationId: conv.id });
      }
      const fresh = (await store.getConversation(conv.id)) || conv;
      fresh.messages.push(assistantMsg);
      redo.stripAttempt(fresh, userMsg.id); // answered: nothing to try again
      redo.remember(conv.id, null);
      // A session that rolled over (too big, llm.runOn) is not resumed: the next one starts fresh.
      if (result.rollover) fresh.claudeSessionId = null;
      else if (result.sessionId) fresh.claudeSessionId = result.sessionId;
      if (result.freshTokens) fresh.claudeFreshTokens = result.freshTokens; // how big a fresh session starts here (rollover)
      // How big the session is now: a cold one well past a fresh one isn't resumed (claudecode.startFresh).
      if (result.contextTokens) fresh.claudeTokens = result.rollover ? 0 : result.contextTokens;
      if (result.convPatch) Object.assign(fresh, result.convPatch);
      await store.saveConversation(fresh);
      emit({ type: 'done', message: stripRaw(assistantMsg) });
      onFinish?.({ ok: true, text: assistantMsg.content, conversationId: conv.id });
      log.info('reply', { model: result.model, voice: viaVoice, remote: Boolean(remote), firstTextMs, totalMs: Date.now() - startedAt, chars: assistantMsg.content.length, tools: (result.toolCalls || []).map((t) => t.name).join(',') });
      log.debug('reply text', { text: assistantMsg.content.slice(0, 160) });
      // The turn switched persona (or another setting that defines the session): the next session
      // starts now, while the reply is read or heard, not when the user speaks again.
      const after = await store.getSettings();
      if (!fresh.setup && after.claudeCode?.warmOnLaunch && llm.sessionConfigKey(after) !== llm.sessionConfigKey(settings)) llm.prewarm(after, fresh).catch((error) => log.warn('prewarm failed', { error }));
    } catch (err) {
      const aborted = controller.signal.aborted || err?.name === 'AbortError';
      // A routine whose brain isn't ready yet, or that ran while the computer was offline, waits and
      // runs again (routinecore.retryPlan): not a fault.
      const rc = require('./routinecore');
      const notReady = !aborted && routine && (rc.brainNotReady(err) || rc.offline(err));
      if (aborted) log.info('turn interrupted', { conversation: conv.id });
      else log[notReady ? 'warn' : 'error'](notReady ? 'turn not ready' : 'turn failed', { provider: settings.llm.provider, model: settings.llm.provider === 'claude-code' ? settings.claudeCode.model : undefined, voice: viaVoice, ms: Date.now() - startedAt, error: err });
      const attempt = own && !deletedConversations.has(conv.id) ? redo.attemptFrom({ aborted, err, ran, firstTextMs }) : null;
      if (attempt) redo.remember(conv.id, userMsg.id, attempt); // an immediate Try again sees it
      // The window hears it first (a barge-in waits for this); the record is written after.
      emit({ type: aborted ? 'aborted' : 'error', message: aborted ? 'Stopped' : err?.message || String(err) });
      onFinish?.({ ok: false, error: aborted ? 'Stopped' : err?.message || String(err), conversationId: conv.id });
      if (attempt) store.updateConversation(conv.id, (c) => redo.withAttempt(c, userMsg.id, attempt)).catch((e) => log.warn('could not record the failed attempt', { error: e }));
    } finally {
      activeRequests.delete(requestId);
      if (trackChanges) recordSelfChanges(before, text, [...touched]).catch((e) => log.warn('self-change tracking', e.message));
    }
  });
  return { conversationId: conv.id };
}

// After a turn: if the agent changed its own source, syntax-check and record it in the history. Only
// what its tools wrote (`touched`, see selfchange.touchedBy): the repo may be edited by someone else
// while a turn runs (the developer, another session), and that is never the agent's change to record.
// A shell command in the turn ('*') could have changed anything, so then everything dirty counts.
async function recordSelfChanges(before, userText, touched = []) {
  const after = await selfchange.fingerprint();
  if (after === null || after === before) return;
  const dirty = await selfchange.dirtyFiles();
  if (!dirty.length) return;
  const all = touched.includes('*');
  const only = all ? null : touched;
  if (!all && !dirty.some((d) => only.includes(d.file))) {
    log.info('self-change tracking: the repo changed during the turn, but not by the agent', { dirty: dirty.length, touched: touched.length });
    return;
  }
  const r = await selfchange.commit(`Requested: "${String(userText).replace(/\s+/g, ' ').slice(0, 80)}"`, { source: 'auto (end of turn)', only });
  if (r.ok && !r.nothing) send('self:event', { type: 'committed', change: r });
  else if (!r.ok) send('self:event', { type: 'check_failed', files: r.files, output: r.check.output });
}

function merge(settings, override) {
  if (!override) return settings;
  const out = JSON.parse(JSON.stringify(settings));
  for (const [k, v] of Object.entries(override)) out[k] = { ...out[k], ...v };
  return out;
}

function stripRaw(m) {
  const { raw, ...rest } = m;
  return rest;
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
    startTurn,
    abortTurn: (requestId) => activeRequests.get(requestId)?.abort(),
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
  log.info('==================== app start', { version: app.getVersion(), pid: process.pid });
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
      await handoff.write({ replying: new Set([...activeRequests.values()].map((c) => c.conversationId)) });
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
