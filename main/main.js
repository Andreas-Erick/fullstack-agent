// Electron main process: window, app:// protocol, IPC wiring.
const { app, BrowserWindow, ipcMain, protocol, shell, dialog, globalShortcut, session, systemPreferences, Menu, Notification } = require('electron');
const path = require('path');
const fsp = require('fs').promises;

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

const ROOT = path.join(__dirname, '..');

// Last-resort safety net: an unexpected error in the main process is logged, never fatal.
process.on('uncaughtException', (err) => log.error('uncaught exception', err?.stack || String(err)));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', err?.stack || String(err)));
const isDev = process.argv.includes('--dev');
// Optional override of the data folder (portable installs, testing).
if (process.env.NEXUS_USER_DATA) app.setPath('userData', path.resolve(process.env.NEXUS_USER_DATA));
// Laptops with integrated + dedicated graphics: run WebGPU (local Whisper) on the dedicated GPU.
app.commandLine.appendSwitch('force_high_performance_gpu');

// Only these folders are served to the renderer over app://bundle/...
const SERVED = ['renderer/', 'node_modules/marked/lib/', 'node_modules/dompurify/dist/', 'node_modules/katex/dist/', 'node_modules/@huggingface/transformers/dist/', 'node_modules/phonemizer/dist/', 'node_modules/pdfjs-dist/build/', 'node_modules/@fontsource/'];
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

// A second copy (e.g. a double click) hands over to the running one and exits at once, before it
// can open a window or touch the same files.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

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
    if (!/^[\w.-]+$/.test(name) || rel.includes('..')) return new Response('Forbidden', { status: 403 });
    const headers = { 'Content-Security-Policy': "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-src 'none'" };
    let file = path.join(await facesDir(), name, rel);
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
    title: 'Nexus Agent',
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
  win.once('ready-to-show', () => win.show());
  win.loadURL('app://bundle/renderer/index.html');
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  guardNavigation(win.webContents);
  // The page hides its title bar and rail only while the window really is full screen (the button,
  // F11, Esc, or the agent's set_window_state).
  win.on('enter-full-screen', () => toWindow('win:fullscreen', true));
  win.on('leave-full-screen', () => toWindow('win:fullscreen', false));
  win.on('closed', () => (win = null));
  // Closing: first the agent notes where we left off (handoff.js), then the window really closes.
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
    else dialog.showErrorBox('Nexus Agent', 'The window keeps crashing. Restart the app; if it persists, run the diagnose tool or check the log (Settings → Data).');
  });
  captureConsole(win.webContents, 'window');
  win.webContents.on('unresponsive', () => log.warn('window not responding'));
  win.webContents.on('responsive', () => log.info('window responding again'));
  // Tell the user once if their settings had to be restored from the backup.
  win.webContents.on('did-finish-load', () => {
    store.getSettings().then((s) => win && !win.isDestroyed() && win.webContents.setZoomFactor(clampZoom(s.ui.zoom))).catch(() => {});
    const r = store.settingsRecovery();
    if (r) send('app:notice', { kind: 'error', message: r.restored ? 'Your settings file was damaged and has been restored from the last good copy.' : 'Your settings file was damaged; defaults are used. The damaged file was kept for recovery.' });
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

// External links open in the system browser, never inside the app.
function guardNavigation(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
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
    run: ({ routine, text, limitMs }) =>
      new Promise((resolve) => {
        const requestId = `rt${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
        // A run that takes too long (a hung tool, an approval nobody answers…) is stopped.
        const timer = setTimeout(() => {
          activeRequests.get(requestId)?.abort();
          done({ ok: false, error: `Stopped after ${Math.round(limitMs / 60000)} minutes.` });
        }, limitMs);
        let settled = false;
        const done = (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(r);
        };
        startTurn({ conversationId: routine.conversationId, text, requestId, display: `⏰ ${routine.name}`, routine: routine.id, onFinish: done }).catch((err) => done({ ok: false, error: err.message }));
      }),
    notify: (ev) => {
      toWindow('routine:event', ev);
      if (ev.type !== 'finished' || (win && !win.isDestroyed() && win.isFocused()) || !Notification.isSupported()) return;
      const n = new Notification({ title: `${ev.ok ? '⏰' : '⚠'} ${ev.name}`, body: ev.summary || (ev.ok ? 'Done.' : 'The routine failed.'), silent: false });
      n.on('click', () => {
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        toWindow('routine:event', { type: 'open', conversationId: ev.conversationId });
      });
      n.show();
    },
  });
}

async function registerShortcut() {
  globalShortcut.unregisterAll();
  const s = await store.getSettings();
  const accel = s.stt.globalShortcut;
  if (!accel) return;
  try {
    globalShortcut.register(accel, () => {
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      send('voice:toggle', {});
    });
  } catch (err) {
    console.warn('Could not register global shortcut', accel, err.message);
  }
}

// --------------------------------------------------------------- IPC handlers
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
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
    const z = clampZoom(factor);
    e.sender.setZoomFactor(z);
    return { ok: true, data: z };
  });
  // Full screen is the window's own (like set_window_state), not the page's: the page may not ask for
  // it (the permission handler allows only the microphone and clipboard). true/false, or toggle.
  ipcMain.handle('win:fullscreen', (e, on) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return { ok: false, error: 'No window' };
    const next = typeof on === 'boolean' ? on : !w.isFullScreen();
    if (next && w.isMinimized()) w.restore();
    w.setFullScreen(next);
    return { ok: true, data: next };
  });
  ipcMain.handle('win:overlay', (e, colors) => {
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
    if (patch?.stt?.globalShortcut !== undefined) registerShortcut();
    if (patch?.logging) log.setDebug(s.logging.debug);
    if (patch?.remote) await companion.apply(s);
    // A newly used or re-enabled helper app (VoiceStudio, FreeLLMAPI) starts now.
    if (patch?.voice || patch?.llm || patch?.routing || patch?.helperApps) helperApps.ensureAll(s, 'settings');
    if (patch?.routing || patch?.llm?.provider || ['gemini', 'deepseek', 'groq', 'perplexity', 'anthropic', 'claudeCode'].some((k) => patch?.[k])) router.reset();
    return s;
  });
  handle('settings:reset', () => store.resetSettings());
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
  handle('llm:routerReset', (id) => router.reset(id));

  // Chat
  handle('chat:send', ({ conversationId, text, requestId, voice = false, hidden = false }) => startTurn({ conversationId, text, requestId, voice, hidden }));
  handle('chat:abort', (requestId) => {
    activeRequests.get(requestId)?.abort();
    return true;
  });

  // Remote access (companion server): settings and pairing stay desktop-only.
  handle('remote:status', () => companion.status());
  handle('remote:pair', () => companion.startPairing());
  handle('remote:revoke', (id) => companion.revoke(id));
  handle('remote:revokeAll', () => companion.revokeAll());
  handle('handoff:get', () => handoff.read());
  handle('handoff:dismiss', () => handoff.dismiss());
  handle('handoff:skip', () => handoff.skip());
  handle('remote:cancelPair', () => companion.cancelPairing());
  handle('remote:detectTailscale', async () => require('./tunnel').detectTailscale((await store.getSettings()).remote?.port || 7823));
  handle('remote:checkSecure', () => require('./tunnel').verify());
  handle('remote:transcribed', (id, text, error) => {
    const p = pendingTranscripts.get(id);
    if (!p) return false;
    pendingTranscripts.delete(id);
    clearTimeout(p.timer);
    error ? p.reject(new Error(String(error))) : p.resolve(String(text || ''));
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
  handle('conv:delete', (id) => {
    deletedConversations.add(id);
    for (const c of activeRequests.values()) if (c.conversationId === id) c.abort();
    claudecode.endSession(id);
    return store.deleteConversation(id);
  });
  handle('conv:rename', (id, title) => store.renameConversation(id, title));
  handle('conv:clear', async () => {
    for (const c of await store.listConversations()) {
      deletedConversations.add(c.id);
      claudecode.endSession(c.id);
    }
    for (const c of activeRequests.values()) c.abort();
    return store.clearConversations();
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
    if (r.canceled || !r.filePaths[0]) return 0;
    return memory.importEntries(JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8')));
  });

  // Voice
  // If nothing answers at VoiceStudio's address, start it (the window falls back to the system voice meanwhile).
  handle('tts:speak', (text, override) => voice.speak(text, override).catch((err) => (helperApps.onUnreachable('voicestudio', err), Promise.reject(err))));
  handle('helperApps:status', async () => helperApps.status(await store.getSettings()));
  handle('helperApps:start', async (id) => helperApps.start(String(id), await store.getSettings(), { reason: 'manual' }));
  handle('tts:voices', (override) => voice.voices(override));
  handle('tts:ping', () => voice.ping());
  handle('stt:transcribe', (wav, opts) => voice.transcribe(wav, opts || {}));

  // Calendar
  // Schedule (Schedule.md in the vault); changes made here are the user's own.
  handle('calendar:status', () => calendar.status());
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
  handle('docs:showInFolder', (p) => shell.showItemInFolder(p));
  handle('docs:openExternal', async (p) => shell.openPath(await documents.resolveAllowed(p)));

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
  handle('self:restart', () => {
    app.relaunch();
    app.exit(0);
  });

  // Claude account (Claude Code CLI)
  handle('claude:status', () => claudecode.status());
  handle('claude:login', () => claudecode.openLogin('login'));
  handle('claude:logout', () => claudecode.openLogin('logout'));
  handle('claude:installHint', () => claudecode.installHint());
  handle('claude:connectors', () => claudecode.listConnectors());
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
  handle('skills:save', (skill, oldSlug) => skills.save(skill || {}, { slug: oldSlug }));
  handle('skills:delete', (slug) => skills.remove(slug));
  handle('skills:scan', (repo) => require('./skillimport').scan(String(repo || '')).then(({ files, ...s }) => s));
  handle('skills:import', (repo, paths) => require('./skillimport').install(String(repo || ''), Array.isArray(paths) ? paths.map(String) : []));
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

  // Hardware scan (setup wizard)
  handle('hardware:scan', (opts) => require('./hardware').scan(opts || {}));

  // Persona look & feel
  handle('persona:generate', (payload) => persona.generate(payload));
  // Saved personas: each returns the new settings (the live persona changed).
  handle('persona:switch', (id) => persona.activate(String(id || '')));
  handle('persona:create', (opts) => persona.create({ name: String(opts?.name || ''), copy: opts?.copy === true, template: typeof opts?.template === 'string' ? opts.template : null, activate: opts?.activate !== false }));
  handle('persona:templates', () => persona.templates());

  // Habits (Habits.md in the vault) and routines (scheduled agent runs)
  handle('habits:status', () => require('./habits').status());
  handle('habits:log', (name, done, date) => require('./habits').log([String(name)], { done: done !== false, date: date ? String(date) : undefined }));
  handle('habits:add', (h) => require('./habits').add({ name: String(h?.name || ''), target: Number(h?.target) || 7, note: String(h?.note || '') }));
  handle('habits:pause', (name, paused) => require('./habits').setPaused(String(name), paused !== false));
  handle('skilltree:view', () => require('./skilltree').view());
  handle('skilltree:upsert', (skill) => require('./skilltree').upsert([skill && typeof skill === 'object' ? skill : {}]));
  handle('skilltree:remove', (name) => require('./skilltree').remove(String(name)));
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
  handle('routines:list', () => routines.list());
  handle('routines:save', (r) => routines.save(r && typeof r === 'object' ? r : {}));
  handle('routines:remove', (id) => routines.remove(String(id)));
  handle('routines:run', (id) => routines.runNow(String(id)));
  handle('routines:setEnabled', (id, on) => routines.setEnabled(String(id), on));
  handle('persona:remove', (id) => persona.remove(String(id || '')));

  // Internet
  handle('web:search', (q) => websearch.search(q, 5));

  // Approvals (answered in the app by click or voice)
  handle('approval:respond', (id, allow, reason) => approvals.respond(id, allow, reason));

  // Mechanic: diagnostics + log
  handle('diag:run', () => diagnostics.run());
  handle('log:write', (level, event, data) => log[['info', 'warn', 'error'].includes(level) ? level : 'info'](`ui: ${event}`, data));
  handle('log:tail', (n, filter) => log.tail(n || 300, filter || ''));
  handle('log:open', () => shell.showItemInFolder(log.file()));
  handle('log:report', async (note) => {
    const r = await envinfo.bugReport(note || '');
    shell.showItemInFolder(r.file);
    return r;
  });

  // Warm the Claude Code session for a conversation (called at launch / when a chat opens)
  handle('llm:prewarm', async (convId) => {
    const s = await store.getSettings();
    if (s.llm.provider !== 'claude-code' || !s.claudeCode.warmOnLaunch || !convId) return false;
    const conv = await store.getConversation(convId);
    if (conv?.setup) return false;
    llm.prewarm(s, conv).catch((e) => log.warn('prewarm failed', e.message));
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
// (local Whisper runs there) and answers through remote:transcribed.
const pendingTranscripts = new Map(); // id -> { resolve, reject, timer }
function transcribeInWindow(wav) {
  if (!win || win.isDestroyed()) return Promise.reject(new Error('The assistant window is closed'));
  const id = require('crypto').randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTranscripts.delete(id);
      reject(new Error('Speech-to-text took too long'));
    }, 90000);
    pendingTranscripts.set(id, { resolve, reject, timer });
    win.webContents.send('remote:transcribe', { id, wav: new Uint8Array(wav) });
  });
}

// One chat turn, from the window (chat:send) or a paired device (remote = the device name). Returns
// at once; the reply streams as chat:event. Remote turns never carry a screenshot of this desktop.
// display: what the chat shows instead of the text (routines); onFinish({ ok, text, error }) after the turn.
async function startTurn({ conversationId, text, requestId, voice: viaVoice = false, hidden = false, remote = null, display = '', routine = '', onFinish = null }) {
  const settings = await store.getSettings();
  let conv = conversationId ? await store.getConversation(conversationId) : null;
  if (!conv) conv = await store.createConversation();
  if (remote && conv.setup) throw new Error('The setup conversation can only be used on the desktop');
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
  const userMsg = {
    id: store.newId('m'),
    role: 'user',
    content: slash ? skills.instructions(slash.skill, slash.args) : String(text),
    createdAt: Date.now(),
    ...(slash ? { display: String(text), skill: slash.skill.slug } : {}),
    ...(display ? { display: String(display) } : {}),
    ...(routine ? { routine } : {}),
    ...(images.length ? { screen: true } : {}),
    ...(hidden ? { hidden: true } : {}),
    ...(remote ? { remote } : {}),
  };
  conv.messages.push(userMsg);
  if (!conv.setup && conv.messages.filter((m) => m.role === 'user').length === 1) conv.title = (slash ? slash.skill.name : display || String(text)).replace(/\s+/g, ' ').slice(0, 60);
  await store.saveConversation(conv);

  const controller = new AbortController();
  controller.conversationId = conv.id;
  activeRequests.set(requestId, controller);
  // Timing for the log: when the first words of the reply arrived, and when it finished.
  const startedAt = Date.now();
  let firstTextMs = null;
  const emit = (ev) => {
    if (firstTextMs === null && ev.type === 'text') firstTextMs = Date.now() - startedAt;
    // The Inner World sends the active persona to where the work happens (counts only).
    if (ev.type === 'tool_start' && !conv.setup) require('./innerworld').noteTool(ev.name);
    (conv.setup ? toWindow : send)('chat:event', { requestId, conversationId: conv.id, ...ev });
  };
  emit({ type: 'start', userMessage: userMsg, title: conv.title });

  // Run the turn in the background; the renderer receives streamed events. Every log line it
  // produces carries turn=<id> conv=<id>, so one request can be traced end to end.
  const tags = { turn: requestId.slice(-6), conv: conv.id.slice(-6) };
  log.withContext(tags, async () => {
    const trackChanges = settings.code.enabled && settings.code.allowSelfModify;
    const before = trackChanges ? await selfchange.fingerprint() : null;
    try {
      const result = await llm.runTurn({ settings, conv, history: conv.messages, emit, signal: controller.signal, voice: viaVoice, images });
      const assistantMsg = {
        id: store.newId('m'),
        role: 'assistant',
        content: result.text || (controller.signal.aborted ? '*(stopped)*' : ''),
        toolCalls: result.toolCalls,
        raw: result.raw,
        model: result.model,
        provider: result.provider || settings.llm.provider,
        createdAt: Date.now(),
      };
      if (deletedConversations.has(conv.id)) return onFinish?.({ ok: false, error: 'The conversation was deleted', conversationId: conv.id });
      const fresh = (await store.getConversation(conv.id)) || conv;
      fresh.messages.push(assistantMsg);
      if (result.sessionId) fresh.claudeSessionId = result.sessionId;
      if (result.convPatch) Object.assign(fresh, result.convPatch);
      await store.saveConversation(fresh);
      emit({ type: 'done', message: stripRaw(assistantMsg) });
      onFinish?.({ ok: true, text: assistantMsg.content, conversationId: conv.id });
      log.info('reply', { model: result.model, voice: viaVoice, remote: Boolean(remote), firstTextMs, totalMs: Date.now() - startedAt, chars: assistantMsg.content.length, tools: (result.toolCalls || []).map((t) => t.name).join(','), text: assistantMsg.content.slice(0, 160) });
    } catch (err) {
      const aborted = controller.signal.aborted || err?.name === 'AbortError';
      if (aborted) log.info('turn interrupted', { conversation: conv.id });
      else log.error('turn failed', { provider: settings.llm.provider, model: settings.llm.provider === 'claude-code' ? settings.claudeCode.model : undefined, voice: viaVoice, ms: Date.now() - startedAt, error: err });
      emit({ type: aborted ? 'aborted' : 'error', message: aborted ? 'Stopped' : err?.message || String(err) });
      onFinish?.({ ok: false, error: aborted ? 'Stopped' : err?.message || String(err), conversationId: conv.id });
    } finally {
      activeRequests.delete(requestId);
      if (trackChanges) recordSelfChanges(before, text).catch((e) => log.warn('self-change tracking', e.message));
    }
  });
  return { conversationId: conv.id };
}

// After a turn: if the agent changed its own source, syntax-check and record it in the history.
async function recordSelfChanges(before, userText) {
  const after = await selfchange.fingerprint();
  if (after === null || after === before) return;
  const dirty = await selfchange.dirtyFiles();
  if (!dirty.length) return;
  const r = await selfchange.commit(`Requested: "${String(userText).replace(/\s+/g, ' ').slice(0, 80)}"`, { source: 'auto (end of turn)' });
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
    notify: (ev) => send('remote:event', ev),
  });
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
  registerShortcut();

  // Make sure the change history exists before the agent can modify itself.
  const s = await store.getSettings();
  log.setDebug(s.logging?.debug);
  if (s.code.enabled && s.code.allowSelfModify) selfchange.ensureRepo().catch((e) => log.warn('change history unavailable', e));
  obsidian.vaultPath().catch(() => {});
  companion.apply(s).catch((e) => log.warn('remote server start failed', e));
  helperApps.init({ notify: (ev) => send('helperApps:event', ev) });
  helperApps.ensureAll(s, 'launch');
  journal.start();
  startRoutines();
  require('./innerworld').start({ notify: (ev) => toWindow('world:event', ev) });
  store.sweepStaleTemp().catch(() => {});
  claudecode.sweepStaleTemp().catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// The handoff note on closing: the window shows "Saving where we left off…" (with Skip) meanwhile.
let handoffDone = false;
let closing = false;
let quitAfterHandoff = false;
async function closeWithHandoff() {
  if (closing) return;
  closing = true;
  try {
    const s = await store.getSettings();
    if (s.onboarded && s.journal.handoffOnClose !== false) {
      toWindow('app:closing', {});
      await handoff.write({ interrupted: activeRequests.size > 0 });
    }
  } catch (err) {
    log.warn('handoff on close failed', { error: err });
  } finally {
    handoffDone = true;
    if (quitAfterHandoff) app.quit();
    else if (win && !win.isDestroyed()) win.close();
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
