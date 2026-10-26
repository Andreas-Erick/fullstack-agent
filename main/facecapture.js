// The face on the watch: Wear OS has no web view, so the desktop records the active face (built-in or
// custom, in the persona's theme) as short looping animations, one per agent state, in a hidden
// offscreen window (renderer/facecapture.html). The pack goes to the phone (/api/face/frames), which
// hands it to the watch through the Wear Data Layer. Recorded only when asked and cached until the
// face, theme or name changes; one recording at a time. The page has no network and no app state.
const crypto = require('crypto');
const path = require('path');
const fsp = require('fs').promises;
const store = require('./store');
const log = require('./logger');

const STATES = ['idle', 'listening', 'thinking', 'working', 'speaking', 'happy', 'sleeping'];
const FPS = 12;
const FRAMES = 24; // two seconds per state
const DRAW = 320; // the page's size; frames are scaled down to SIZE
const SIZE = 240;
const CROP = 32; // a round watch shows the middle: the margin around the face is cut
const QUALITY = 72;
const WARMUP_MS = 1200; // let the face settle into a state before recording it
const MAGIC = 'SRF1';

let running = null; // { key, promise }

const cacheDir = () => path.join(store.dataDir(), 'face-frames');

/** What a recording depends on: the face, its theme and the name it shows. */
function recipe(settings) {
  const face = String(settings.ui?.face || 'siren');
  return { face: /^(custom:[\w.-]{1,80}|\w{1,20})$/.test(face) ? face : 'siren', theme: settings.appearance?.theme || {}, name: String(settings.agent?.name || 'Siren').slice(0, 40) };
}

const keyOf = (r) => crypto.createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 24);

/**
 * The pack: "SRF1", a 4-byte header length, the JSON header { v, fps, size, name, colors, states: { idle: n, … } },
 * then every frame as a 4-byte length and its JPEG, state by state in the header's order.
 */
function pack(meta, frames) {
  const header = Buffer.from(JSON.stringify({ v: 1, ...meta, states: Object.fromEntries(Object.entries(frames).map(([s, list]) => [s, list.length])) }));
  const parts = [Buffer.from(MAGIC), u32(header.length), header];
  for (const list of Object.values(frames)) for (const f of list) parts.push(u32(f.length), f);
  return Buffer.concat(parts);
}

function unpack(buf) {
  if (buf.subarray(0, 4).toString() !== MAGIC) throw new Error('Not a face pack');
  const len = buf.readUInt32BE(4);
  const header = JSON.parse(buf.subarray(8, 8 + len).toString());
  let at = 8 + len;
  const frames = {};
  for (const [s, n] of Object.entries(header.states)) {
    frames[s] = [];
    for (let i = 0; i < n; i++) {
      const fl = buf.readUInt32BE(at);
      frames[s].push(buf.subarray(at + 4, at + 4 + fl));
      at += 4 + fl;
    }
  }
  return { header, frames };
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Draws the face offscreen and records FRAMES frames of each state.
async function record(r) {
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({ show: false, width: DRAW, height: DRAW, frame: false, paintWhenInitiallyHidden: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  try {
    wc.setFrameRate(FPS);
    await win.loadURL('app://bundle/renderer/facecapture.html');
    await wc.executeJavaScript(`window.__face.mount(${JSON.stringify(r)})`);
    const frames = {};
    for (const s of STATES) {
      await wc.executeJavaScript(`window.__face.set(${JSON.stringify(s)})`);
      await wait(WARMUP_MS);
      frames[s] = [];
      for (let i = 0; i < FRAMES; i++) {
        const t = Date.now();
        const img = await wc.capturePage({ x: CROP, y: CROP, width: DRAW - 2 * CROP, height: DRAW - 2 * CROP });
        frames[s].push(img.resize({ width: SIZE, height: SIZE, quality: 'good' }).toJPEG(QUALITY));
        await wait(Math.max(0, 1000 / FPS - (Date.now() - t)));
      }
    }
    return frames;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** The pack for the current face and theme: from the cache, or recorded now (~25 s). */
async function frames(settings) {
  const r = recipe(settings);
  const key = keyOf(r);
  const file = path.join(cacheDir(), `${key}.bin`);
  const cached = await fsp.readFile(file).catch(() => null);
  if (cached) return { key, data: cached };
  if (running?.key === key) return running.promise;
  if (running) await running.promise.catch(() => {});
  const promise = (async () => {
    const started = Date.now();
    const recorded = await record(r);
    const colors = Object.fromEntries(Object.entries(r.theme.colors || {}).filter(([k, v]) => /^\w{1,20}$/.test(k) && /^#[0-9a-f]{6}$/i.test(v)));
    const data = pack({ fps: FPS, size: SIZE, name: r.name, colors }, recorded);
    // Only the latest face is kept.
    await fsp.rm(cacheDir(), { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(cacheDir(), { recursive: true });
    await fsp.writeFile(file, data);
    log.info('face frames recorded', { face: r.face.startsWith('custom:') ? 'custom' : r.face, ms: Date.now() - started, bytes: data.length });
    return { key, data };
  })();
  running = { key, promise };
  try {
    return await promise;
  } finally {
    if (running?.promise === promise) running = null;
  }
}

module.exports = { frames, recipe, keyOf, pack, unpack, STATES };
