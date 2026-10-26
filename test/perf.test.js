// Performance profiles: the rule shared by the window (renderer/js/perfcore.js) and the main process
// (main/perfcore.js), the hardware classification, the speech model choice, the effects level, and
// which Claude sessions close under Balanced.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');
const main = require('../main/perfcore');

let r;
test.before(async () => {
  const copy = path.join(tmpDir('nexus-perf-'), 'perfcore.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/perfcore.js'), copy);
  r = await import(pathToFileURL(copy).href);
});

const settings = (perf = {}, extra = {}) => ({ perf: { mode: 'auto', detected: '', hw: null, ...perf }, stt: { localModel: 'onnx-community/whisper-large-v3-turbo' }, ui: { fx: 'hud' }, ...extra });

test('the window and the main process agree on the profile', () => {
  for (const mode of ['auto', 'full', 'balanced', undefined, 'nonsense'])
    for (const detected of ['', 'low', 'high']) {
      const s = settings({ mode, detected });
      assert.strictEqual(r.profile(s), main.profile(s), `${mode}/${detected}`);
    }
  assert.strictEqual(main.profile(settings({ detected: 'low' })), 'balanced');
  assert.strictEqual(main.profile(settings({ detected: '' })), 'full', 'not checked yet: nothing changes');
  assert.strictEqual(main.profile(settings({ mode: 'full', detected: 'low' })), 'full', 'the user decides');
  assert.strictEqual(main.profile(settings({ mode: 'balanced', detected: 'high' })), 'balanced');
  assert.strictEqual(main.profile({}), 'full');
});

test('a lighter computer: little memory, or no graphics card with its own memory', () => {
  const gaming = r.classify({ ramGB: 32, gpus: [{ name: 'RTX 4070', vendor: 'NVIDIA', vramGB: 8 }] }, { vramGB: 8 });
  assert.strictEqual(gaming.detected, 'high');
  assert.strictEqual(gaming.hw.gpu, 'RTX 4070');
  const ultrabook = r.classify({ ramGB: 16, gpus: [{ name: 'Intel Iris Xe', vendor: 'Intel', vramGB: null }] }, { vramGB: null });
  assert.strictEqual(ultrabook.detected, 'low');
  assert.match(ultrabook.hw.reason, /no graphics card with its own memory/);
  const small = r.classify({ ramGB: 8, gpus: [{ name: 'GTX 1650', vendor: 'NVIDIA', vramGB: 4 }] }, { vramGB: 4 });
  assert.strictEqual(small.detected, 'low');
  assert.match(small.hw.reason, /8 GB of memory/);
});

test('the speech model fits the computer and the language', () => {
  const large = 'onnx-community/whisper-large-v3-turbo';
  // Full, not checked yet: as before (the worker still refuses the 2.4 GB fp32 variant).
  assert.deepStrictEqual(r.speechPlan(settings()), { model: large, fallback: 'Xenova/whisper-base.en', gpu: true });
  // Full on a strong computer.
  assert.strictEqual(r.speechPlan(settings({ detected: 'high', hw: { ramGB: 32, vramGB: 8 } })).model, large);
  // A graphics card too small for it, even on Full.
  assert.strictEqual(r.speechPlan(settings({ mode: 'full', detected: 'low', hw: { ramGB: 32, vramGB: 2 } })).model, 'Xenova/whisper-small.en');
  // Balanced: small with 16 GB, base below; on the processor.
  const b16 = r.speechPlan(settings({ detected: 'low', hw: { ramGB: 16, vramGB: null } }));
  assert.deepStrictEqual(b16, { model: 'Xenova/whisper-small.en', fallback: 'Xenova/whisper-base.en', gpu: false });
  assert.strictEqual(r.speechPlan(settings({ detected: 'low', hw: { ramGB: 8 } })).model, 'Xenova/whisper-base.en');
  // Other languages get multilingual models (an English-only model can't transcribe Spanish).
  assert.strictEqual(r.speechPlan(settings({ detected: 'low', hw: { ramGB: 8 } }), 'es').model, 'Xenova/whisper-base');
  assert.strictEqual(r.speechPlan(settings({ detected: 'low', hw: { ramGB: 8 } }), 'es').fallback, 'Xenova/whisper-base');
  assert.strictEqual(r.speechPlan({ ...settings(), stt: { localModel: 'Xenova/whisper-small.en' } }, 'de').model, 'Xenova/whisper-small');
  assert.strictEqual(r.speechPlan(settings(), 'fr').model, large, 'the large model is multilingual already');
});

test('Balanced keeps the HUD look without motion; the other levels stay', () => {
  assert.strictEqual(r.effectsLevel(settings({ detected: 'low' })), 'subtle');
  assert.strictEqual(r.effectsLevel(settings({ detected: 'high' })), 'hud');
  assert.strictEqual(r.effectsLevel({ ...settings({ detected: 'low' }), ui: { fx: 'off' } }), 'off');
  assert.strictEqual(r.effectsLevel({ ui: {} }), 'hud');
});

test('Balanced closes the least recently used idle sessions, never a busy one or the one starting', () => {
  const s = (id, lastUsed, busy = false, alive = true) => ({ id, lastUsed, busy, alive });
  assert.deepStrictEqual(main.sessionsToClose([s('a', 1)], 2, 'new'), []);
  assert.deepStrictEqual(main.sessionsToClose([s('a', 3), s('b', 1), s('c', 2)], 2, 'new'), ['b', 'c']);
  assert.deepStrictEqual(main.sessionsToClose([s('a', 1, true), s('b', 2)], 2, 'new'), ['b'], 'the busy one stays');
  assert.deepStrictEqual(main.sessionsToClose([s('a', 1, true), s('b', 2, true)], 2, 'new'), [], 'over the cap rather than stop a reply');
  assert.deepStrictEqual(main.sessionsToClose([s('a', 1), s('new', 0)], 2, 'new'), [], 'the starting one is not counted twice');
  assert.deepStrictEqual(main.sessionsToClose([s('a', 1, false, false), s('b', 2)], 2, 'new'), [], 'dead ones are not counted');
});

test('the performance setting is the user\'s: it has a default and the agent cannot change it', () => {
  const store = fs.readFileSync(path.join(ROOT, 'main/store.js'), 'utf8');
  assert.match(store, /perf: \{\s*\n\s*mode: 'auto'/);
  const tools = fs.readFileSync(path.join(ROOT, 'main/tools.js'), 'utf8');
  const settable = /const SETTABLE = \{([\s\S]*?)\n\};/.exec(tools)[1];
  assert.ok(!/\bperf\b/.test(settable), 'no performance setting in SETTABLE');
});

test('Macs with Apple silicon: unified memory, lighter below 16 GB, the GPU’s share as macOS allows', () => {
  const { stub, load, quietLog } = require('./helpers');
  stub({ electron: { app: { getGPUInfo: async () => null } }, './logger': quietLog });
  const hw = load('main/hardware.js');
  assert.strictEqual(hw.gpuMemoryBudget(16), 10.7, 'two thirds up to 36 GB');
  assert.strictEqual(hw.gpuMemoryBudget(64), 48, 'three quarters above');
  const mac = (ramGB) => ({ ramGB, cpuThreads: 10, gpus: [{ name: 'Apple M3', vendor: 'Apple', unified: true }] });
  const small = hw.recommend(mac(8), { webgpu: true });
  assert.strictEqual(small.unified, true);
  assert.notStrictEqual(small.stt.localModel, 'onnx-community/whisper-large-v3-turbo', 'no large speech model on an 8 GB Mac');
  assert.match(small.notes.join(' '), /share the same 8 GB/);
  const big = hw.recommend(mac(36), { webgpu: true });
  assert.strictEqual(big.stt.localModel, 'onnx-community/whisper-large-v3-turbo');
  assert.strictEqual(big.tier, 'high', '24 GB usable by the graphics');
  assert.match(big.stt.why, /Apple chip \(36 GB of unified memory/);
  const light = r.classify(mac(8), small);
  assert.strictEqual(light.detected, 'low');
  assert.match(light.hw.reason, /unified memory/);
  assert.doesNotMatch(light.hw.reason, /graphics card/, 'a Mac is never told it has no graphics card');
  assert.strictEqual(r.classify(mac(16), hw.recommend(mac(16), { webgpu: true })).detected, 'high');
});
