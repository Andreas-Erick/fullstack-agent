// Exposes a small, explicit API to the renderer. Every call returns the handler's data or throws.
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res?.ok) throw new Error(res?.error || 'Unknown error');
  return res.data;
}

function on(channel, fn) {
  const listener = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const channels = {
  settings: ['get', 'set', 'reset'],
  llm: ['models', 'test', 'prewarm', 'routerStatus', 'routerReset'],
  win: ['zoom', 'overlay', 'fullscreen'],
  screen: ['sources', 'start', 'stop', 'state', 'preview'],
  skills: ['list', 'save', 'delete', 'openFolder', 'scan', 'import'],
  pdf: ['fromMarkdown', 'fromNote', 'fromConversation'],
  notes: ['quick'],
  hardware: ['scan'],
  chat: ['send', 'abort', 'endSession'],
  approval: ['respond'],
  remote: ['status', 'pair', 'cancelPair', 'revoke', 'revokeAll', 'setReadOnly', 'transcribed', 'spoken', 'detectTailscale', 'checkSecure', 'setupTailscale'],
  handoff: ['get', 'dismiss', 'skip'],
  helperApps: ['status', 'start'],
  setup: ['start', 'skip', 'checkService'],
  guide: ['features'],
  diag: ['run'],
  log: ['write', 'tail', 'open', 'report'],
  faces: ['list', 'openFolder'],
  conv: ['list', 'get', 'new', 'delete', 'rename', 'clear', 'export'],
  memory: ['list', 'search', 'save', 'update', 'delete', 'clear', 'dir', 'openDir', 'export', 'import'],
  tts: ['speak', 'voices', 'ping'],
  stt: ['transcribe'],
  calendar: ['status', 'events', 'entries', 'add', 'update', 'remove'],
  tasks: ['status', 'sync'],
  github: ['status'],
  obsidian: ['status', 'list', 'read', 'search', 'write', 'delete', 'openFolder', 'openInObsidian', 'defaultPath', 'vaults', 'register', 'history', 'showVersion', 'restoreVersion', 'priorities', 'growth', 'links'],
  docs: ['pick', 'load', 'popup', 'closePopup', 'windowState', 'recent', 'clearRecent', 'roots', 'showInFolder', 'openExternal'],
  code: ['root'],
  self: ['status', 'ensure', 'log', 'show', 'check', 'verification', 'commit', 'revert', 'restore', 'discard', 'reload', 'restart'],
  claude: ['status', 'login', 'logout', 'installHint', 'connectors', 'usage'],
  persona: ['generate', 'scene', 'switch', 'create', 'remove', 'templates'],
  habits: ['status', 'log', 'add', 'pause'],
  skilltree: ['view', 'upsert', 'remove'],
  stream: ['recent', 'reflect'],
  world: ['view', 'simulate', 'resident'],
  extensions: ['status', 'check', 'install', 'start', 'stop', 'openGlobe'],
  agentWindow: ['state', 'go', 'back', 'forward', 'reload', 'stop', 'home', 'open'],
  arch: ['get', 'build', 'history'],
  routines: ['list', 'save', 'remove', 'run', 'setEnabled'],
  web: ['search'],
  dialog: ['pickFolder', 'pickImage'],
  shell: ['openExternal'],
  mic: ['request'],
  system: ['watch', 'bluetooth', 'network', 'speedtest', 'usage', 'free'],
  app: ['info', 'ready'],
  updates: ['status', 'check', 'skip', 'open'],
  flashcards: ['decks', 'browse', 'card', 'next', 'answer', 'undo', 'mixStart', 'mixNext', 'mixAnswer', 'mixUndo','create', 'add', 'edit', 'options', 'delete', 'importable', 'import'],
};

const api = { on };
for (const [ns, methods] of Object.entries(channels)) {
  api[ns] = {};
  for (const m of methods) api[ns][m] = (...args) => call(`${ns}:${m}`, ...args);
}

contextBridge.exposeInMainWorld('nexus', api);
