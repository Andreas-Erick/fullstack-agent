// Every built-in face can be created and draws frames in every state without throwing (a face that
// throws in its constructor stops the whole window from booting). Runs the real face modules against a
// stand-in canvas whose 2D context accepts any call.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

// The renderer's modules are ES modules in a CommonJS package: test copies in a folder of type module.
const ESM = tmpDir('nexus-faces-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
fs.mkdirSync(path.join(ESM, 'js', 'faces'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'renderer/js/faces'))) fs.copyFileSync(path.join(ROOT, 'renderer/js/faces', f), path.join(ESM, 'js', 'faces', f));
fs.copyFileSync(path.join(ROOT, 'renderer/js/themecore.js'), path.join(ESM, 'js', 'themecore.js'));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));
// Every built-in face, from the one list (renderer/js/faces/registry.mjs) as [file, class]. The Circuit
// face (visualizer.js) runs its own loop instead of draw(): the reduced-motion test below drives it.
const ALL = require('../main/facesregistry').BUILT_IN_FACES.map((f) => [`renderer/js/${f.module}`, f.export]);
const FACES = ALL.filter(([file]) => file.startsWith('renderer/js/faces/'));
const STATES = ['idle', 'listening', 'thinking', 'working', 'speaking', 'happy', 'sleeping'];

// A 2D context where every method works and returns something usable (gradients, metrics, data).
function fakeContext() {
  const gradient = { addColorStop() {} };
  return new Proxy(
    {},
    {
      get: (t, k) => {
        if (k in t) return t[k];
        if (/^create\w*Gradient$|^createPattern$/.test(k)) return () => gradient;
        if (k === 'measureText') return (s) => ({ width: String(s).length * 7 });
        if (k === 'getImageData' || k === 'createImageData') return (x, y, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
        if (k === 'getLineDash') return () => [];
        return () => {};
      },
      set: (t, k, v) => ((t[k] = v), true),
    },
  );
}

function fakeCanvas(width = 400, height = 400) {
  return { width, height, offsetParent: {}, getContext: () => fakeContext(), getBoundingClientRect: () => ({ width, height }) };
}

test('built-in faces construct and draw every state', async () => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.devicePixelRatio = 1;
  globalThis.window = globalThis;
  globalThis.Image = class {};
  globalThis.document ||= { createElement: () => fakeCanvas(64, 64) };
  const { configureFaces } = await import(pathToFileURL(path.join(ESM, 'js/faces/env.js')).href);
  let shown = 'idle';
  configureFaces({ agentState: () => shown });
  for (const [file, cls] of FACES) {
    const Face = (await import(pathToFileURL(path.join(ESM, file.replace('renderer/', ''))).href))[cls];
    for (const compact of [true, false]) {
      const face = new Face(fakeCanvas(), { compact });
      face.setLabel('Siren');
      face.resize();
      for (const st of STATES) {
        shown = st;
        assert.doesNotThrow(() => {
          face.t += 0.016;
          face.draw(0.016);
        }, `${cls} (${compact ? 'compact' : 'full'}) in ${st}`);
      }
      face.destroy();
    }
  }
});

// Reduced motion (env.reducedMotion: the system setting or the desktop's body.fx-still) slows every
// built-in face. The phone wires env without it: the default reads the same two signals.
test('reduced motion slows every built-in face, the Circuit face too', async () => {
  for (const [file] of ALL) if (!file.startsWith('renderer/js/faces/')) fs.copyFileSync(path.join(ROOT, file), path.join(ESM, file.replace('renderer/', ''))); // visualizer.js
  globalThis.getComputedStyle ||= () => ({ getPropertyValue: () => '' }); // the Circuit face reads its font
  const envMod = await import(pathToFileURL(path.join(ESM, 'js/faces/env.js')).href);
  const { configureFaces, env, REDUCED_MOTION } = envMod;
  // The default: the media query (stubbed off above) or body.fx-still.
  const fallback = env.reducedMotion;
  assert.strictEqual(fallback(), false);
  const prevDoc = globalThis.document;
  globalThis.document = { ...prevDoc, body: { classList: { contains: (c) => c === 'fx-still' } } };
  assert.strictEqual(fallback(), true, 'body.fx-still counts');
  globalThis.document = prevDoc;
  const all = ALL;
  const clock = async ([file, cls], reduced) => {
    configureFaces({ agentState: () => 'speaking', reducedMotion: () => reduced });
    const Face = (await import(pathToFileURL(path.join(ESM, file.replace('renderer/', ''))).href))[cls];
    const face = new Face(fakeCanvas(), { compact: false });
    face.setLabel?.('Siren');
    face.resize();
    const step = (face.frame || face.loop).bind(face);
    face.last = 1000;
    for (let k = 1; k <= 10; k++) step(1000 + k * 16);
    const out = { t: face.t, reduced: face.reduced };
    face.destroy();
    return out;
  };
  for (const f of all) {
    const normal = await clock(f, false);
    const calm = await clock(f, true);
    assert.ok(Math.abs(normal.t - 0.16) < 1e-9, `${f[1]} runs in real time: ${normal.t}`);
    if (f[1] === 'SirenFace') {
      // Siren scales her own drift and rings (this.reduced); her clock stays real.
      assert.strictEqual(calm.reduced, true);
      assert.ok(Math.abs(calm.t - 0.16) < 1e-9);
    } else {
      assert.ok(Math.abs(calm.t - 0.16 * REDUCED_MOTION) < 1e-9, `${f[1]} slows under reduced motion: ${calm.t}`);
    }
  }
  configureFaces({ reducedMotion: fallback });
});
