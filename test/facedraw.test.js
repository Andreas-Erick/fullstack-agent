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
const FACES = [
  ['renderer/js/faces/siren.js', 'SirenFace'],
  ['renderer/js/faces/radial.js', 'RadialFace'],
  ['renderer/js/faces/rain.js', 'RainFace'],
  ['renderer/js/faces/neural.js', 'NeuralFace'],
  ['renderer/js/faces/companion.js', 'CompanionFace'],
];
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
