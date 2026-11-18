// Faces yield to the offline voice (it shares the graphics card with them: a face at the screen's full
// 85–144 fps made each sentence two to three times slower):
//  - renderer/faces/core.js holds a custom face's own requestAnimationFrame loop to AV.maxFps, close to
//    the asked rate on any refresh rate, every loop of one frame in step, and passes everything through
//    at 0 (the phone and the watch's recording never send a cap);
//  - capFrame does the same for the built-in faces and the custom face's feed (faces/common.js);
//  - the desktop passes the cap (perfcore.js faceFpsCap) from state.voiceWorking; the phone doesn't.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const CORE = fs.readFileSync(path.join(ROOT, 'renderer/faces/core.js'), 'utf8');
const RATES = [60, 85, 120, 144, 165, 240];
const T0 = 5000; // a page that has been running a while

// core.js in a window of its own: requestAnimationFrame callbacks wait until frame(t) runs them.
function faceWindow() {
  let nextId = 0;
  const queue = new Map();
  const listeners = [];
  const win = {
    requestAnimationFrame: (cb) => (queue.set(++nextId, cb), nextId),
    cancelAnimationFrame: (id) => queue.delete(id),
    addEventListener: (type, fn) => type === 'message' && listeners.push(fn),
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(CORE, win, { filename: 'core.js' });
  return {
    win,
    AV: win.AV.init(),
    frame(t) {
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb(t);
    },
    post: (data) => listeners.forEach((fn) => fn({ data })),
    waiting: () => queue.size,
  };
}
const av = (maxFps) => ({ type: 'av', state: 'speaking', level: 0.5, samples: [], env: {}, ...(maxFps === undefined ? {} : { maxFps }) });

// A face's self-rescheduling loop for two seconds at `hz`: how often it ran in the second one.
function loopRate(w, hz) {
  const times = [];
  const loop = (t) => (times.push(t), w.win.requestAnimationFrame(loop));
  w.win.requestAnimationFrame(loop);
  for (let k = 0; (k * 1000) / hz < 2000; k++) w.frame(T0 + (k * 1000) / hz);
  return { times, perSecond: times.filter((t) => t >= T0 + 1000 && t < T0 + 2000).length };
}

test('core.js: no cap passes every frame through (the phone, the watch\'s recording)', () => {
  const w = faceWindow();
  assert.strictEqual(w.AV.maxFps, 0);
  assert.strictEqual(loopRate(w, 240).perSecond, 240);
  const w2 = faceWindow();
  w2.post(av(0));
  assert.strictEqual(loopRate(w2, 144).perSecond, 144);
});

test('core.js: a cap of 60 holds about 60 on any refresh rate; 30 likewise', () => {
  for (const hz of RATES) {
    const w = faceWindow();
    w.post(av(60));
    assert.strictEqual(w.AV.maxFps, 60);
    const { perSecond } = loopRate(w, hz);
    assert.ok(perSecond >= 59 && perSecond <= 61, `${hz} Hz: ${perSecond} fps`);
  }
  for (const hz of [60, 144, 240]) {
    const w = faceWindow();
    w.post(av(30));
    const { perSecond } = loopRate(w, hz);
    assert.ok(perSecond >= 29 && perSecond <= 31, `30 at ${hz} Hz: ${perSecond} fps`);
  }
});

test('core.js: the loops of one face stay in step; a cancelled callback never runs', () => {
  const w = faceWindow();
  w.post(av(60));
  const a = [];
  const b = [];
  const loopA = (t) => (a.push(t), w.win.requestAnimationFrame(loopA));
  const loopB = (t) => (b.push(t), w.win.requestAnimationFrame(loopB));
  w.win.requestAnimationFrame(loopA);
  w.win.requestAnimationFrame(loopB);
  for (let k = 0; k < 144; k++) w.frame(T0 + (k * 1000) / 144);
  assert.ok(a.length >= 58 && a.length <= 62, `${a.length}`);
  assert.deepStrictEqual(a, b, 'both drew on the same frames');

  // Deferred past a skipped frame, then cancelled: it never runs.
  const c = faceWindow();
  c.post(av(60));
  let ran = 0;
  c.win.requestAnimationFrame(() => {});
  c.frame(T0); // an allowed frame: the next one, 4 ms later at 240 Hz, is skipped
  const id = c.win.requestAnimationFrame(() => ran++);
  c.frame(T0 + 1000 / 240);
  assert.strictEqual(ran, 0, 'skipped');
  assert.strictEqual(c.waiting(), 1, 'deferred to the next frame');
  c.win.cancelAnimationFrame(id);
  assert.strictEqual(c.waiting(), 0);
  for (let k = 2; k < 60; k++) c.frame(T0 + (k * 1000) / 240);
  assert.strictEqual(ran, 0, 'never ran');
  // Cancelled before its first frame: never runs either; an unknown id is harmless.
  const id2 = c.win.requestAnimationFrame(() => ran++);
  c.win.cancelAnimationFrame(id2);
  c.win.cancelAnimationFrame(9999);
  for (let k = 60; k < 120; k++) c.frame(T0 + (k * 1000) / 240);
  assert.strictEqual(ran, 0);
});

test('core.js: AV.maxFps follows the last update; one without it lifts the cap', () => {
  const w = faceWindow();
  w.post(av(60));
  assert.strictEqual(w.AV.maxFps, 60);
  w.post(av(30));
  assert.strictEqual(w.AV.maxFps, 30);
  w.post(av(undefined));
  assert.strictEqual(w.AV.maxFps, 0, 'the phone and the watch send none');
  w.post(av('nonsense'));
  assert.strictEqual(w.AV.maxFps, 0);
  w.post({ type: 'other', maxFps: 60 });
  assert.strictEqual(w.AV.maxFps, 0, 'only av updates count');
  // The cap lifted mid-run: back to every frame at once.
  w.post(av(60));
  const times = [];
  const loop = (t) => (times.push(t), w.win.requestAnimationFrame(loop));
  w.win.requestAnimationFrame(loop);
  for (let k = 0; k < 144; k++) w.frame(T0 + (k * 1000) / 144);
  w.post(av(0));
  const before = times.length;
  for (let k = 144; k < 288; k++) w.frame(T0 + (k * 1000) / 144);
  assert.strictEqual(times.length - before, 144);
});

// The built-in faces' modules (as test/facedraw.test.js loads them).
const ESM = tmpDir('nexus-facecore-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
fs.mkdirSync(path.join(ESM, 'js', 'faces'), { recursive: true });
for (const f of ['common.js', 'env.js']) fs.copyFileSync(path.join(ROOT, 'renderer/js/faces', f), path.join(ESM, 'js', 'faces', f));
fs.copyFileSync(path.join(ROOT, 'renderer/js/themecore.js'), path.join(ESM, 'js', 'themecore.js'));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));
const faces = async () => ({
  ...(await import(pathToFileURL(path.join(ESM, 'js/faces/common.js')).href)),
  ...(await import(pathToFileURL(path.join(ESM, 'js/faces/env.js')).href)),
});

test('capFrame: about the asked rate on any refresh rate; 0 means no cap', async () => {
  const { capFrame } = await faces();
  const rateAt = (hz, fps) => {
    let due = 0;
    let n = 0;
    for (let k = 0; (k * 1000) / hz < 2000; k++) {
      const t = T0 + (k * 1000) / hz;
      const d = capFrame(due, t, fps);
      if (d === null) continue;
      due = d;
      if (t >= T0 + 1000) n++;
    }
    return n;
  };
  for (const hz of RATES) assert.ok(Math.abs(rateAt(hz, 60) - 60) <= 1, `${hz} Hz: ${rateAt(hz, 60)}`);
  assert.ok(Math.abs(rateAt(144, 30) - 30) <= 1, `30 at 144 Hz: ${rateAt(144, 30)}`);
  assert.strictEqual(rateAt(144, 0), 144);
  assert.strictEqual(capFrame(12345, T0, 0), 0);
  assert.strictEqual(capFrame(T0 + 10, T0, 60), null, 'too early');
  assert.strictEqual(capFrame(0, T0, 60), T0 + 1000 / 60, 'after a pause: from now, not catching up');
});

test('the built-in faces and the custom face\'s feed honour env.maxFps()', async () => {
  const { env, configureFaces, BaseFace, pumpFrame } = await faces();
  assert.strictEqual(env.maxFps(), 0, 'no cap unless the app sets one');
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  let raf = [];
  globalThis.requestAnimationFrame = (cb) => (raf.push(cb), raf.length);
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = globalThis;
  globalThis.devicePixelRatio = 1;
  let cap = 60;
  configureFaces({ maxFps: () => cap, agentState: () => 'speaking', lite: () => false });

  // A built-in face (BaseFace.frame) at 144 Hz.
  class Counting extends BaseFace {
    draw() {
      this.draws = (this.draws || 0) + 1;
    }
  }
  const canvas = { width: 0, height: 0, offsetParent: {}, getContext: () => ({ setTransform() {} }), getBoundingClientRect: () => ({ width: 200, height: 200 }) };
  const face = new Counting(canvas);
  face.resize();
  for (let k = 0; k < 144; k++) face.frame(T0 + (k * 1000) / 144);
  assert.ok(face.draws >= 59 && face.draws <= 61, `capped: ${face.draws}`);
  cap = 0;
  face.draws = 0;
  for (let k = 144; k < 288; k++) face.frame(T0 + (k * 1000) / 144);
  assert.strictEqual(face.draws, 144, 'uncapped: every frame');
  face.destroy();

  // The custom face's feed (pumpFrame) at 165 Hz.
  cap = 60;
  raf = [];
  globalThis.document = { hidden: false };
  let posts = 0;
  const frame = { offsetParent: {}, contentWindow: { postMessage: () => posts++ } };
  const stop = pumpFrame(frame, () => ({ type: 'av' }));
  for (let k = 0; k < 165; k++) {
    const due = raf;
    raf = [];
    for (const cb of due) cb(T0 + (k * 1000) / 165);
  }
  stop();
  assert.ok(posts >= 59 && posts <= 61, `feed capped: ${posts}`);
});

test('the wiring: every face loop asks env.maxFps(); the desktop sets it, the phone doesn\'t', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const common = read('renderer/js/faces/common.js');
  const pump = common.slice(common.indexOf('export function pumpFrame('), common.indexOf('export class BaseFace'));
  assert.match(pump, /capFrame\(due, now, env\.maxFps\(\)\)/);
  const frame = common.slice(common.indexOf('  frame(now) {'), common.indexOf('  destroy() {'));
  assert.match(frame, /capFrame\(this\.due \|\| 0, now, env\.maxFps\(\)\)/);
  const vis = read('renderer/js/visualizer.js');
  const loop = vis.slice(vis.indexOf('  loop(now) {'), vis.indexOf('  update(dt) {'));
  assert.match(loop, /capFrame\(this\.due \|\| 0, now, env\.maxFps\(\)\)/, 'the Circuit face too');
  assert.match(vis, /import \{[^}]*\bcapFrame\b[^}]*\} from '\.\/faces\/common\.js'/);
  const host = read('renderer/js/faces/host.js');
  assert.match(host, /maxFps: \(\) => faceFpsCap\(\{ balanced: profile\(state\.settings\) === 'balanced', voiceWorking: state\.voiceWorking, resting: !document\.hasFocus\(\) && state\.agentState === 'idle', sleeping: state\.agentState === 'sleeping' \}\)/);
  const message = host.slice(host.indexOf('  message(name) {'), host.indexOf('  setAvatar(a) {'));
  assert.match(message, /maxFps: env\.maxFps\(\)/, 'custom faces get the cap with every update');
  assert.doesNotMatch(read('renderer/remote/app.js'), /maxFps/, 'the phone keeps every frame');
  assert.doesNotMatch(read('renderer/js/facecapture.js'), /maxFps/, 'so does the watch\'s recording');
  assert.match(read('renderer/js/state.js'), /voiceWorking: false,/);
});
