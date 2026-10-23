// Electron main process: window, app:// protocol, IPC wiring.
const { app, BrowserWindow, ipcMain, protocol, shell, dialog, globalShortcut, session, systemPreferences, Menu } = require('electron');
const path = require('path');
const fsp = require('fs').promises;

const store = require('./store');
const memory = require('./memory');
const calendar = require('./calendar');
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
const vaultgit = require('./vaultgit');
const faces = require('./faces');

const ROOT = path.join(__dirname, '..');
const isDev = process.argv.includes('--dev');
// Optional override of the data folder (portable installs, testing).
if (process.env.NEXUS_USER_DATA) app.setPath('userData', path.resolve(process.env.NEXUS_USER_DATA));

// Only these folders are served to the renderer over app://bundle/...
const SERVED = ['renderer/', 'node_modules/marked/lib/', 'node_modules/dompurify/dist/', 'node_modules/@huggingface/transformers/dist/', 'node_modules/pdfjs-dist/build/', 'node_modules/@fontsource/'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
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
const activeRequests = new Map(); // requestId -> AbortController

if (!app.requestSingleInstanceLock()) app.quit();
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
    ...(isMac ? { trafficLightPosition: { x: 14, y: 12 } } : { titleBarOverlay: { color: '#0a0a0f', symbolColor: '#7df9ff', height: 38 } }),
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

  // External links open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  win.on('closed', () => (win = null));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
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
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

function registerIpc() {
  // Settings
  handle('settings:get', () => store.getSettings());
  handle('settings:set', async (patch) => {
    const s = await store.setSettings(patch);
    if (patch?.stt?.globalShortcut !== undefined) registerShortcut();
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

  // Chat
  handle('chat:send', async ({ conversationId, text, requestId, voice: viaVoice = false, hidden = false }) => {
    const settings = await store.getSettings();
    let conv = conversationId ? await store.getConversation(conversationId) : null;
    if (!conv) conv = await store.createConversation();
    const userMsg = { id: store.newId('m'), role: 'user', content: String(text), createdAt: Date.now(), ...(hidden ? { hidden: true } : {}) };
    conv.messages.push(userMsg);
    if (!conv.setup && conv.messages.filter((m) => m.role === 'user').length === 1) conv.title = String(text).replace(/\s+/g, ' ').slice(0, 60);
    await store.saveConversation(conv);

    const controller = new AbortController();
    activeRequests.set(requestId, controller);
    const emit = (ev) => send('chat:event', { requestId, conversationId: conv.id, ...ev });
    emit({ type: 'start', userMessage: userMsg, title: conv.title });

    // Run the turn in the background; the renderer receives streamed events.
    (async () => {
      const trackChanges = settings.code.enabled && settings.code.allowSelfModify;
      const before = trackChanges ? await selfchange.fingerprint() : null;
      try {
        const result = await llm.runTurn({ settings, conv, history: conv.messages, emit, signal: controller.signal, voice: viaVoice });
        const assistantMsg = {
          id: store.newId('m'),
          role: 'assistant',
          content: result.text || (controller.signal.aborted ? '*(stopped)*' : ''),
          toolCalls: result.toolCalls,
          raw: result.raw,
          model: result.model,
          provider: settings.llm.provider,
          createdAt: Date.now(),
        };
        const fresh = (await store.getConversation(conv.id)) || conv;
        fresh.messages.push(assistantMsg);
        if (result.sessionId) fresh.claudeSessionId = result.sessionId;
        if (result.convPatch) Object.assign(fresh, result.convPatch);
        await store.saveConversation(fresh);
        emit({ type: 'done', message: stripRaw(assistantMsg) });
        log.info('reply', { model: result.model, chars: assistantMsg.content.length, tools: (result.toolCalls || []).map((t) => t.name).join(','), text: assistantMsg.content.slice(0, 160) });
      } catch (err) {
        const aborted = controller.signal.aborted || err?.name === 'AbortError';
        if (aborted) log.info('turn interrupted', { conversation: conv.id });
        else log.error('turn failed', { conversation: conv.id, provider: settings.llm.provider, error: err?.message });
        emit({ type: aborted ? 'aborted' : 'error', message: aborted ? 'Stopped' : err?.message || String(err) });
      } finally {
        activeRequests.delete(requestId);
        if (trackChanges) recordSelfChanges(before, text).catch((e) => log.warn('self-change tracking', e.message));
      }
    })();
    return { conversationId: conv.id };
  });
  handle('chat:abort', (requestId) => {
    activeRequests.get(requestId)?.abort();
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
    claudecode.endSession(id);
    return store.deleteConversation(id);
  });
  handle('conv:rename', (id, title) => store.renameConversation(id, title));
  handle('conv:clear', () => store.clearConversations());
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
  handle('tts:speak', (text, override) => voice.speak(text, override));
  handle('tts:voices', (override) => voice.voices(override));
  handle('tts:ping', () => voice.ping());
  handle('stt:transcribe', (wav) => voice.transcribe(wav));

  // Calendar
  handle('calendar:status', () => calendar.status());
  handle('calendar:signIn', () => calendar.signIn());
  handle('calendar:signOut', () => calendar.signOut());
  handle('calendar:events', (range) => calendar.events(range || {}));

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

  // Persona look & feel
  handle('persona:generate', (payload) => persona.generate(payload));

  // Internet
  handle('web:search', (q) => websearch.search(q, 5));

  // Approvals (answered in the app by click or voice)
  handle('approval:respond', (id, allow, reason) => approvals.respond(id, allow, reason));

  // Mechanic: diagnostics + log
  handle('diag:run', () => diagnostics.run());
  handle('log:write', (level, event, data) => log[['info', 'warn', 'error'].includes(level) ? level : 'info'](`ui: ${event}`, data));
  handle('log:tail', (n, filter) => log.tail(n || 300, filter || ''));
  handle('log:open', () => shell.showItemInFolder(log.file()));

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
  obsidian.setChangeListener((rel) => send('vault:changed', rel));
  log.info('app start', { version: app.getVersion(), platform: process.platform, electron: process.versions.electron });
  process.on('uncaughtException', (err) => log.error('uncaught exception', err.stack || err.message));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', err?.stack || String(err)));

  // Allow microphone access for push-to-talk; deny everything else by default.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'audioCapture', 'clipboard-sanitized-write'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['media', 'audioCapture', 'clipboard-sanitized-write'].includes(permission));

  if (!isDev) Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  createWindow();
  registerShortcut();

  // Make sure the change history exists before the agent can modify itself.
  const s = await store.getSettings();
  if (s.code.enabled && s.code.allowSelfModify) selfchange.ensureRepo().catch((e) => log.warn('change history unavailable', e.message));
  obsidian.vaultPath().catch(() => {});
  journal.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  claudecode.shutdown();
  journal.stop();
  vaultgit.flushAll();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
