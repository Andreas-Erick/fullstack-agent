// The agent window: a browser window the agent controls (tools browser_* and globe_open) and the user
// can use too, for websites and the God's Eye View globe. Nexus draws the toolbar and the frame around
// the page (renderer/agentwindow.html: address, back/forward, who is browsing); the page sits inside the
// frame in a view of its own
// with no preload, no access to the app, its own session (persist:agentwindow, so the user can sign in
// to sites there), no camera/microphone/location/notifications and no downloads. Only websites open:
// nothing on this computer or the local network except the globe's local server (agentwindowcore.js).
// What a page shows is external content: the tools mark it so (tools.js `untrusted`).
const path = require('path');
const { BrowserWindow, WebContentsView, session, screen } = require('electron');
const core = require('./agentwindowcore');
const log = require('./logger');

const BAR = 46; // the toolbar's height in renderer/agentwindow.html (.aw-bar)
const INSET = 6; // the page sits this far inside the window, so the frame drawn around it shows (.aw-frame)
const RADIUS = 10;
const PARTITION = 'persist:agentwindow';
const HOME = 'https://duckduckgo.com/';

let ctx = null; // { root, preload, guard(webContents), captureConsole(webContents, label), mainWindow() }
let win = null;
let view = null;
let agentUntil = 0; // the toolbar shows "<agent> is browsing" until then
let notice = '';
let sessionReady = false;

function init(options) {
  ctx = options;
}

const alive = () => win && !win.isDestroyed() && view && !view.webContents.isDestroyed();

function state() {
  if (!alive()) return { open: false };
  const wc = view.webContents;
  return {
    open: true,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canBack: wc.navigationHistory.canGoBack(),
    canForward: wc.navigationHistory.canGoForward(),
    agent: Date.now() < agentUntil,
    notice,
  };
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('agentWindow:state', state());
}

function say(text) {
  notice = text;
  pushState();
  setTimeout(() => notice === text && ((notice = ''), pushState()), 6000);
}

// The agent is acting: the toolbar says so for a few seconds after its last step.
function agentActing() {
  agentUntil = Date.now() + 4000;
  pushState();
  setTimeout(pushState, 4100);
}

// Once per app run: the page session's rules.
function prepareSession() {
  if (sessionReady) return;
  sessionReady = true;
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // Some sites refuse browsers that call themselves Electron; the page sees a plain Chrome.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|nexus-agent|Nexus ?Agent)\/\S+/gi, ''));
  ses.on('will-download', (e, item) => {
    e.preventDefault();
    say(`Downloads are off in this window (${item.getFilename()}). Open the page in your browser to download it.`);
  });
  // Pages may not reach this computer or the local network either (only the globe's own server).
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    let u;
    try {
      u = new URL(details.url);
    } catch {
      return cb({ cancel: false });
    }
    if (!/^(https?|wss?):$/.test(u.protocol)) return cb({ cancel: false });
    const local = core.isPrivateHost(u.hostname);
    cb({ cancel: local && !(['localhost', '127.0.0.1'].includes(u.hostname) && Number(u.port) === core.GLOBE_PORT) });
  });
}

function layout() {
  if (!alive()) return;
  const [width, height] = win.getContentSize();
  // Full screen: the page fills the screen below the bar, without the frame.
  const m = win.isFullScreen() ? 0 : INSET;
  view.setBounds({ x: m, y: BAR + m, width: Math.max(0, width - 2 * m), height: Math.max(0, height - BAR - 2 * m) });
}

function create() {
  prepareSession();
  const main = ctx.mainWindow();
  const area = screen.getDisplayMatching(main && !main.isDestroyed() ? main.getBounds() : screen.getPrimaryDisplay().bounds).workArea;
  win = new BrowserWindow({
    width: Math.min(1360, area.width - 60),
    height: Math.min(900, area.height - 40),
    x: area.x + Math.max(0, Math.round((area.width - Math.min(1360, area.width - 60)) / 2)),
    y: area.y + 20,
    minWidth: 480,
    minHeight: 320,
    backgroundColor: '#0a0a0f',
    title: 'Agent window',
    icon: path.join(ctx.root, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 14 } } : { titleBarOverlay: { color: '#0a0a0f', symbolColor: '#7df9ff', height: BAR } }),
    show: false,
    webPreferences: { preload: ctx.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  ctx.guard(win.webContents);
  ctx.captureConsole?.(win.webContents, 'agent window');
  win.loadURL('app://bundle/renderer/agentwindow.html');

  view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: true } });
  view.setBackgroundColor('#ffffff');
  view.setBorderRadius?.(RADIUS);
  win.contentView.addChildView(view);
  const wc = view.webContents;
  const guardNav = (e, url) => {
    const c = core.checkUrl(url);
    if (!c.ok) {
      e.preventDefault();
      say(c.reason);
    }
  };
  wc.on('will-navigate', guardNav);
  wc.on('will-redirect', guardNav);
  // Links that open a new window open here instead.
  wc.setWindowOpenHandler(({ url }) => {
    const c = core.checkUrl(url);
    if (c.ok) wc.loadURL(c.url).catch(() => {});
    else say(c.reason);
    return { action: 'deny' };
  });
  for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(ev, pushState);
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => isMain && code !== -3 && say(`Couldn't load ${url}: ${desc}`));
  wc.on('render-process-gone', (_e, details) => {
    log.warn('agent window page crashed', details);
    if (details.reason !== 'clean-exit' && alive()) setTimeout(() => alive() && wc.reload(), 500);
  });
  win.on('resize', layout);
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', layout);
  win.on('closed', () => {
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    win = null;
    view = null;
  });
  win.once('ready-to-show', () => {
    layout();
    pushState();
  });
  layout();
}

function show({ focus = false } = {}) {
  if (!alive()) create();
  if (win.isMinimized()) win.restore();
  if (focus) win.show();
  else win.showInactive();
  win.moveTop();
}

// Resolves when the page has loaded (or after `ms`); a slow page is reported, not an error.
function settle(ms = 15000) {
  return new Promise((resolve) => {
    if (!alive()) return resolve(false);
    const wc = view.webContents;
    if (!wc.isLoading()) return setTimeout(() => resolve(true), 300);
    const t = setTimeout(() => (wc.off('did-stop-loading', done), resolve(false)), ms);
    function done() {
      clearTimeout(t);
      setTimeout(() => resolve(true), 300);
    }
    wc.once('did-stop-loading', done);
  });
}

/**
 * Shows an address. `byAgent` marks the agent as browsing (the user's address bar doesn't).
 * The globe reads its link only when the page loads, so a new view of it reloads the page.
 */
async function open(raw, { byAgent = true, monitor, position, focus = false } = {}) {
  const c = core.checkUrl(raw || HOME);
  if (!c.ok) throw new Error(c.reason);
  // Addresses from the agent are also checked by name lookup (a public name pointing at a local address).
  if (byAgent && !c.globe) await require('./websearch').assertPublic(c.url);
  show({ focus });
  if (monitor != null) require('./docwindows').move('agent window', monitor, position);
  if (byAgent) agentActing();
  const wc = view.webContents;
  if (c.globe && core.onlyHashDiffers(wc.getURL(), c.url)) {
    await wc.executeJavaScript(`location.replace(${JSON.stringify(c.url)}); location.reload();`).catch(() => wc.loadURL(c.url));
  } else {
    wc.loadURL(c.url).catch(() => {}); // failures arrive as did-fail-load
  }
  const loaded = await settle(c.globe ? 30000 : 15000);
  return { url: wc.getURL(), title: wc.getTitle(), loaded, ...(loaded ? {} : { note: 'Still loading; check again with browser_read in a moment.' }) };
}

function requireOpen() {
  if (!alive()) throw new Error('The agent window is not open. Open a page with browser_open first.');
  return view.webContents;
}

/** The page's text and its numbered links, buttons and fields. */
async function read({ maxText } = {}) {
  const wc = requireOpen();
  await settle(8000);
  return wc.executeJavaScript(core.readScript(maxText), true);
}

/** A screenshot of the page (JPEG data URL, at most 1280 wide). */
async function look() {
  const wc = requireOpen();
  await settle(8000);
  let img = await wc.capturePage();
  const { width } = img.getSize();
  if (width > 1280) img = img.resize({ width: 1280 });
  const { width: w, height: h } = img.getSize();
  return { url: wc.getURL(), title: wc.getTitle(), image: `data:image/jpeg;base64,${img.toJPEG(72).toString('base64')}`, size: `${w}×${h}` };
}

function clickAt(wc, x, y) {
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
}

async function locate(wc, id) {
  const at = await wc.executeJavaScript(core.locateScript(id), true);
  if (!at) throw new Error(`There is no element ${id} on the page any more; read the page again (browser_read).`);
  return at;
}

const KEYS = { enter: 'Enter', escape: 'Escape', tab: 'Tab', pagedown: 'PageDown', pageup: 'PageUp', down: 'Down', up: 'Up', left: 'Left', right: 'Right', backspace: 'Backspace', space: 'Space' };

function press(wc, key) {
  const keyCode = KEYS[String(key || '').toLowerCase().replace(/\s+/g, '')];
  if (!keyCode) throw new Error(`Unknown key; use one of: ${Object.keys(KEYS).join(', ')}.`);
  wc.sendInputEvent({ type: 'keyDown', keyCode });
  if (keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' });
  wc.sendInputEvent({ type: 'keyUp', keyCode });
}

/** One step on the page: click, type, select, scroll, key, back, forward, reload. */
async function act({ action, id, text, submit, direction, key }) {
  const wc = requireOpen();
  agentActing();
  switch (action) {
    case 'click': {
      await locate(wc, id); // scrolls it into view
      await new Promise((r) => setTimeout(r, 120)); // let the scroll finish
      const at = await locate(wc, id);
      clickAt(wc, at.x, at.y);
      break;
    }
    case 'type': {
      const at = await locate(wc, id);
      if (at.sensitive) throw new Error('That is a password, payment or one-time-code field: the user types those themselves. Ask them to.');
      if (!(await wc.executeJavaScript(core.focusScript(id), true))) throw new Error(`There is no element ${id} on the page any more.`);
      await wc.insertText(String(text ?? ''));
      if (submit) press(wc, 'enter');
      break;
    }
    case 'select': {
      const ok = await wc.executeJavaScript(`(() => { const el = document.querySelector('[data-nexus-id="${String(id).replace(/[^0-9]/g, '')}"]'); if (!el || el.tagName !== 'SELECT') return false; const o = [...el.options].find((o) => o.text.trim().toLowerCase() === ${JSON.stringify(String(text || '').trim().toLowerCase())}) || [...el.options].find((o) => o.text.toLowerCase().includes(${JSON.stringify(String(text || '').trim().toLowerCase())})); if (!o) return false; el.value = o.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`, true);
      if (!ok) throw new Error('No such option in that list (read the page for its options).');
      break;
    }
    case 'scroll':
      await wc.executeJavaScript(core.scrollScript(direction), true);
      break;
    case 'key':
      press(wc, key);
      break;
    case 'back':
      if (!wc.navigationHistory.canGoBack()) throw new Error('There is no previous page.');
      wc.navigationHistory.goBack();
      break;
    case 'forward':
      if (!wc.navigationHistory.canGoForward()) throw new Error('There is no next page.');
      wc.navigationHistory.goForward();
      break;
    case 'reload':
      wc.reload();
      break;
    default:
      throw new Error('action must be click, type, select, scroll, key, back, forward or reload.');
  }
  await new Promise((r) => setTimeout(r, 400));
  await settle(10000);
  return { done: action, url: wc.getURL(), title: wc.getTitle() };
}

// ------------------------------------------------------------ the toolbar (renderer/agentwindow.js)
const toolbar = {
  state,
  go: (text) => open(core.fromAddressBar(text), { byAgent: false }).then(() => state()),
  back: () => alive() && view.webContents.navigationHistory.canGoBack() && view.webContents.navigationHistory.goBack(),
  forward: () => alive() && view.webContents.navigationHistory.canGoForward() && view.webContents.navigationHistory.goForward(),
  reload: () => alive() && view.webContents.reload(),
  stop: () => alive() && view.webContents.stop(),
  home: () => open(HOME, { byAgent: false, focus: true }).then(() => state()),
};

function close() {
  if (!win || win.isDestroyed()) return false;
  win.close();
  return true;
}

/** For docwindows.js (move to a monitor, full screen…). */
function window() {
  return win && !win.isDestroyed() ? win : null;
}

module.exports = { init, open, read, look, act, close, state, window, toolbar, show };
