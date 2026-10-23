// Document windows and monitors: each document the agent opens gets its own window (opening one that
// is already open brings it forward), and any of them, or the assistant's own window, can be moved
// to a monitor. Monitors are numbered left to right (then top to bottom), the way the user points at
// them; identify() flashes each number on its screen.
const path = require('path');
const { BrowserWindow, screen } = require('electron');

const MAX_WINDOWS = 8;
const docs = new Map(); // full path -> BrowserWindow
let ctx = null; // { root, preload, mainWindow(), guard(webContents) }

function init(options) {
  ctx = options;
}

function displays() {
  return screen
    .getAllDisplays()
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map((d, i) => ({ number: i + 1, display: d }));
}

function monitorOf(win) {
  const d = screen.getDisplayMatching(win.getBounds());
  return displays().find((m) => m.display.id === d.id)?.number;
}

function listMonitors() {
  const primary = screen.getPrimaryDisplay().id;
  const main = ctx.mainWindow();
  const windows = [
    ...(main && !main.isDestroyed() ? [{ window: 'assistant', monitor: monitorOf(main) }] : []),
    ...[...docs].map(([file, w]) => ({ window: path.basename(file), monitor: monitorOf(w) })),
  ];
  return {
    monitors: displays().map(({ number, display: d }) => ({
      number,
      primary: d.id === primary || undefined,
      name: d.label || undefined,
      resolution: `${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}`,
      position: `${d.bounds.x},${d.bounds.y}`,
    })),
    windows,
  };
}

// "2", 2, "primary"/"main", "left"/"leftmost", "right"/"rightmost", "other"/"next".
function resolveMonitor(which, current) {
  const all = displays();
  const w = String(which ?? '').trim().toLowerCase();
  if (/^\d+$/.test(w)) {
    const m = all[Number(w) - 1];
    if (!m) throw new Error(`There is no monitor ${w}; ${all.length === 1 ? 'only one monitor is connected' : `monitors are numbered 1 to ${all.length}, left to right`}.`);
    return m.display;
  }
  if (/primary|main/.test(w)) return screen.getPrimaryDisplay();
  if (/left/.test(w)) return all[0].display;
  if (/right/.test(w)) return all[all.length - 1].display;
  if (/other|next|second/.test(w)) {
    if (all.length < 2) throw new Error('Only one monitor is connected.');
    const i = all.findIndex((m) => m.display.id === current?.id);
    return all[(i + 1) % all.length].display;
  }
  throw new Error(`Say which monitor: a number from 1 to ${all.length} (left to right), "primary", "left" or "right".`);
}

// Places a window on a display: centered (keeping its size), maximized, full screen, or a half.
function place(win, display, position = 'center') {
  if (win.isFullScreen()) win.setFullScreen(false);
  if (win.isMaximized()) win.unmaximize();
  if (win.isMinimized()) win.restore();
  const a = display.workArea;
  const [w, h] = win.getSize();
  let bounds;
  if (position === 'left' || position === 'right') {
    const width = Math.floor(a.width / 2);
    bounds = { x: position === 'left' ? a.x : a.x + a.width - width, y: a.y, width, height: a.height };
  } else {
    const width = Math.min(w, a.width);
    const height = Math.min(h, a.height);
    bounds = { x: a.x + Math.round((a.width - width) / 2), y: a.y + Math.round((a.height - height) / 2), width, height };
  }
  // Moving between monitors with different scaling, Windows rescales the window on arrival; setting
  // the bounds again once it is there gives the intended size.
  win.setBounds(bounds);
  win.setBounds(bounds);
  if (position !== 'left' && position !== 'right') {
    if (position === 'maximize') win.maximize();
    if (position === 'fullscreen') win.setFullScreen(true);
  }
}

// "assistant"/"main"/"app" is the main window; anything else names an open document.
function findWindow(name) {
  const n = String(name || '').toLowerCase().trim();
  if (/^(assistant|main|app|you|yourself|nexus|chat)( window)?$/.test(n)) {
    const main = ctx.mainWindow();
    if (!main || main.isDestroyed()) throw new Error('The assistant window is not open.');
    return { win: main, label: 'the assistant window' };
  }
  const open = [...docs];
  if (!open.length) throw new Error('No document window is open.');
  if (!n || /^(it|this|that|the document|document|pdf|the pdf|image|the image|last|latest)$/.test(n)) {
    const [file, win] = open[open.length - 1];
    return { win, label: path.basename(file) };
  }
  const wanted = n.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const scored = open
    .map(([file, win]) => {
      const name = path.basename(file).toLowerCase();
      return { file, win, hits: wanted.filter((w) => name.includes(w)).length };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  if (!scored.length || (scored[1] && scored[1].hits === scored[0].hits)) {
    throw new Error(`Which document? Open: ${open.map(([f]) => path.basename(f)).join(', ')}.`);
  }
  return { win: scored[0].win, label: path.basename(scored[0].file) };
}

/** Opens (or brings forward) a document window; optionally on a monitor. Never takes focus. */
function open(full, { monitor, position } = {}) {
  let win = docs.get(full);
  if (!win || win.isDestroyed()) {
    if (docs.size >= MAX_WINDOWS) {
      const [oldest, w] = docs.entries().next().value;
      w.close();
      docs.delete(oldest);
    }
    const main = ctx.mainWindow();
    const area = screen.getDisplayMatching(main && !main.isDestroyed() ? main.getBounds() : screen.getPrimaryDisplay().bounds).workArea;
    const cascade = (docs.size % 5) * 28;
    win = new BrowserWindow({
      x: area.x + Math.max(0, area.width - 960) - cascade,
      y: area.y + 30 + cascade,
      width: Math.min(920, area.width - 80),
      height: Math.min(1100, area.height - 60),
      minWidth: 420,
      minHeight: 320,
      parent: main && !main.isDestroyed() ? main : undefined,
      backgroundColor: '#0a0a0f',
      title: path.basename(full),
      icon: path.join(ctx.root, 'assets', 'icon.ico'),
      autoHideMenuBar: true,
      show: false,
      webPreferences: { preload: ctx.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    ctx.guard(win.webContents);
    ctx.captureConsole?.(win.webContents, 'document window');
    docs.set(full, win);
    win.on('closed', () => docs.get(full) === win && docs.delete(full));
    win.once('ready-to-show', () => !win.isDestroyed() && win.showInactive());
    win.loadURL(`app://bundle/renderer/viewer.html?path=${encodeURIComponent(full)}`);
  } else {
    // Bring it forward and make it the most recent one.
    docs.delete(full);
    docs.set(full, win);
    if (win.isMinimized()) win.restore();
    win.showInactive();
    win.moveTop();
  }
  if (monitor != null) place(win, resolveMonitor(monitor, screen.getDisplayMatching(win.getBounds())), position);
  return { opened: path.basename(full), monitor: monitorOf(win), openDocuments: docs.size };
}

/** Closes one document window (by name, or the latest), or all of them ("all"). */
function close(name) {
  if (/^all|every/i.test(String(name || ''))) {
    const names = [...docs.keys()].map((f) => path.basename(f));
    for (const w of docs.values()) w.close();
    docs.clear();
    return names;
  }
  if (!docs.size) return [];
  const { win, label } = findWindow(name);
  // Forget it now; the window's own 'closed' event comes later.
  for (const [file, w] of docs) if (w === win) docs.delete(file);
  win.close();
  return [label];
}

// fullscreen | exit_fullscreen | maximize | minimize | restore (back to a normal window).
function setState(name, state) {
  const { win, label } = findWindow(name);
  switch (state) {
    case 'fullscreen':
      if (win.isMinimized()) win.restore();
      win.setFullScreen(true);
      break;
    case 'exit_fullscreen':
      win.setFullScreen(false);
      break;
    case 'maximize':
      if (win.isFullScreen()) win.setFullScreen(false);
      if (win.isMinimized()) win.restore();
      win.maximize();
      break;
    case 'minimize':
      win.minimize();
      break;
    case 'restore':
      if (win.isFullScreen()) win.setFullScreen(false);
      if (win.isMinimized()) win.restore();
      if (win.isMaximized()) win.unmaximize();
      win.showInactive();
      break;
    default:
      throw new Error('state must be fullscreen, exit_fullscreen, maximize, minimize or restore.');
  }
  return { window: label, state };
}

function move(name, monitor, position) {
  const { win, label } = findWindow(name);
  const target = resolveMonitor(monitor, screen.getDisplayMatching(win.getBounds()));
  place(win, target, position);
  return { moved: label, monitor: monitorOf(win), position: position || 'center' };
}

// Flashes each monitor's number on its screen for a few seconds (like Windows' "Identify").
function identify(seconds = 3) {
  for (const { number, display } of displays()) {
    const b = display.bounds;
    const size = Math.round(Math.min(b.width, b.height) / 3);
    const w = new BrowserWindow({
      x: b.x + Math.round((b.width - size) / 2),
      y: b.y + Math.round((b.height - size) / 2),
      width: size,
      height: size,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    w.setIgnoreMouseEvents(true);
    const html = `<body style="margin:0;display:grid;place-items:center;height:100vh;background:rgba(10,10,15,.82);border-radius:24px;color:#7df9ff;font:700 ${Math.round(size * 0.6)}px system-ui;overflow:hidden">${number}</body>`;
    w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    w.once('ready-to-show', () => w.showInactive());
    setTimeout(() => !w.isDestroyed() && w.close(), seconds * 1000);
  }
  return { monitors: displays().length };
}

function current() {
  return [...docs.keys()].map((f) => path.basename(f));
}

module.exports = { init, open, close, move, setState, identify, listMonitors, current };
