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
  // Auto, not checked yet: nothing heavy until the computer is known.
  assert.deepStrictEqual(r.speechPlan(settings()), { model: 'Xenova/whisper-base.en', fallback: 'Xenova/whisper-base.en', gpu: true });
  // Full chosen by the user, not checked yet: as before.
  assert.strictEqual(r.speechPlan(settings({ mode: 'full' })).model, large);
  // A strong computer.
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
  assert.strictEqual(r.speechPlan(settings({ mode: 'full' }), 'fr').model, large, 'the large model is multilingual already');
});

test('heavy models only where they leave room: 32 GB and an 8 GB card on auto, as before on Full', () => {
  const large = 'onnx-community/whisper-large-v3-turbo';
  const hw = (ramGB, vramGB, unified = false) => ({ ramGB, vramGB, unified });
  // The case that hurt: a 16 GB laptop with a 4 GB card counts as "high" but would give 7–10 GB to speech.
  const laptop = settings({ detected: 'high', hw: hw(16, 4) });
  assert.strictEqual(r.profile(laptop), 'full', 'the full look stays');
  assert.strictEqual(r.heavyModels(laptop), false);
  assert.strictEqual(r.speechPlan(laptop).model, 'Xenova/whisper-small.en');
  assert.strictEqual(r.voiceOnGpu(laptop), false, 'the 8-bit voice on the processor');
  assert.strictEqual(r.heavyModels(settings({ detected: 'high', hw: hw(32, 6) })), false, '6 GB card');
  assert.strictEqual(r.heavyModels(settings({ detected: 'high', hw: hw(24, 12) })), false, '24 GB of memory');
  assert.strictEqual(r.heavyModels(settings({ detected: 'high', hw: hw(64, 24) })), true);
  assert.strictEqual(r.heavyModels(settings({ detected: 'high', hw: hw(36, null, true) })), true, 'a 36 GB Mac');
  assert.strictEqual(r.heavyModels(settings({ detected: 'high', hw: hw(16, null, true) })), false, 'a 16 GB Mac');
  // Full chosen by the user decides: the old bar (a 4 GB card, a 16 GB Mac).
  assert.strictEqual(r.heavyModels(settings({ mode: 'full', detected: 'high', hw: hw(16, 4) })), true);
  assert.strictEqual(r.heavyModels(settings({ mode: 'full', detected: 'low', hw: hw(32, 2) })), false);
  assert.strictEqual(r.heavyModels(settings({ mode: 'full', hw: hw(16, null, true) })), true);
  // Balanced: never.
  assert.strictEqual(r.heavyModels(settings({ mode: 'balanced', detected: 'high', hw: hw(64, 24) })), false);
  // Automatic ('' or 'auto') vs a model the user picked.
  const strong = { detected: 'high', hw: hw(64, 24) };
  for (const localModel of ['', 'auto', undefined]) {
    assert.strictEqual(r.speechPlan({ ...settings(strong), stt: { localModel } }).model, large, `auto=${localModel}`);
    assert.strictEqual(r.speechPlan({ ...settings({ detected: 'high', hw: hw(16, 4) }), stt: { localModel } }).model, 'Xenova/whisper-small.en');
    assert.strictEqual(r.speechPlan({ ...settings({ detected: 'low', hw: hw(8, null) }), stt: { localModel } }, 'de').model, 'Xenova/whisper-base');
  }
  assert.strictEqual(r.speechPlan({ ...settings(strong), stt: { localModel: 'Xenova/whisper-tiny.en' } }).model, 'Xenova/whisper-tiny.en', 'a small pick is kept');
});

test('the speech model loads at launch only for someone who used voice input this week', () => {
  const now = Date.UTC(2026, 10, 1);
  const day = 86400000;
  const s = (stt, perf = { detected: 'high' }) => settings(perf, { stt: { enabled: true, engine: 'local', ...stt } });
  assert.strictEqual(r.preloadSpeech(s({}), now - day, now), true);
  assert.strictEqual(r.preloadSpeech(s({}), now - 8 * day, now), false, 'not lately');
  assert.strictEqual(r.preloadSpeech(s({}), 0, now), false, 'never');
  assert.strictEqual(r.preloadSpeech(s({}), NaN, now), false, 'unreadable storage');
  assert.strictEqual(r.preloadSpeech(s({ engine: 'groq' }), now - day, now), false, 'cloud speech');
  assert.strictEqual(r.preloadSpeech(s({ enabled: false }), now - day, now), false, 'voice input off');
  assert.strictEqual(r.preloadSpeech(s({}, { detected: 'low' }), now - day, now), false, 'Balanced never preloads');
});

test('a fresh install chooses its speech model; the hardware scan suggests large only with room', () => {
  const store = fs.readFileSync(path.join(ROOT, 'main/store.js'), 'utf8');
  assert.match(store, /localModel: '',/, 'stt.localModel defaults to automatic');
  const { stub, load, quietLog } = require('./helpers');
  stub({ electron: { app: { getGPUInfo: async () => null } }, './logger': quietLog });
  const hw = load('main/hardware.js');
  const pc = (ramGB, vramGB) => ({ ramGB, cpuThreads: 16, gpus: [{ name: 'GPU', vendor: 'NVIDIA', vramGB }] });
  assert.strictEqual(hw.recommend(pc(16, 4), { webgpu: true }).stt.localModel, 'Xenova/whisper-small.en');
  assert.match(hw.recommend(pc(16, 4), { webgpu: true }).stt.why, /leaves room/);
  assert.strictEqual(hw.recommend(pc(32, 8), { webgpu: true }).stt.localModel, 'onnx-community/whisper-large-v3-turbo');
});

// A face drawing at the screen's full rate (85–144 fps) slowed the offline voice two to three times:
// while it works, faces draw at most 60 frames a second; on Balanced always at most 30.
test('faceFpsCap: 60 while the offline voice works, 30 on Balanced, else no cap', () => {
  assert.strictEqual(r.SYNTH_FACE_FPS, 60);
  assert.strictEqual(r.faceFpsCap({}), 0);
  assert.strictEqual(r.faceFpsCap(), 0);
  assert.strictEqual(r.faceFpsCap({ voiceWorking: true }), r.SYNTH_FACE_FPS);
  assert.strictEqual(r.faceFpsCap({ balanced: true }), r.BALANCED.faceFps);
  assert.strictEqual(r.BALANCED.faceFps, 30);
  assert.strictEqual(r.faceFpsCap({ balanced: true, voiceWorking: true }), 30);
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

// Efficiency pass: Full had no cap, so every chat opened kept a ~250–400 MB process for 20 minutes.
test('Full caps live Claude sessions too, above Balanced', () => {
  assert.strictEqual(main.sessionCap({ perf: { mode: 'balanced' } }), main.BALANCED.sessionCap);
  assert.strictEqual(main.sessionCap({ perf: { mode: 'full' } }), main.FULL.sessionCap);
  assert.strictEqual(main.sessionCap({ perf: { mode: 'auto', detected: 'low' } }), main.BALANCED.sessionCap);
  assert.strictEqual(main.sessionCap({}), main.FULL.sessionCap);
  assert.strictEqual(main.sessionCap(undefined), main.FULL.sessionCap);
  assert.ok(main.FULL.sessionCap > main.BALANCED.sessionCap);
  assert.strictEqual(main.FULL.sessionCap, 4);
  const s = (id, lastUsed) => ({ id, lastUsed, busy: false, alive: true });
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => s(id, i + 1));
  assert.deepStrictEqual(main.sessionsToClose(six, main.FULL.sessionCap, 'new'), ['a', 'b', 'c']);
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

// Nobody looking (the window unfocused and idle, or asleep): faces rest; the village and its rooms follow the
// voice cap and rest with the window. Each cap is the lowest that applies.
test('faceFpsCap: resting 30, asleep 20, the lowest cap wins', () => {
  assert.strictEqual(r.REST_FACE_FPS, 30);
  assert.strictEqual(r.SLEEP_FACE_FPS, 20);
  assert.strictEqual(r.faceFpsCap({ resting: true }), 30);
  assert.strictEqual(r.faceFpsCap({ sleeping: true }), 20);
  assert.strictEqual(r.faceFpsCap({ resting: true, voiceWorking: true }), 30, 'resting beats the voice cap');
  assert.strictEqual(r.faceFpsCap({ balanced: true, sleeping: true }), 20);
  assert.strictEqual(r.faceFpsCap({ voiceWorking: true }), 60, 'the voice alone, as before');
  assert.strictEqual(r.faceFpsCap({ balanced: true, voiceWorking: true }), 30, 'as before');
  assert.strictEqual(r.faceFpsCap({ resting: false, sleeping: false, balanced: false, voiceWorking: false }), 0);
  assert.strictEqual(r.faceFpsCap({}), 0);
  assert.strictEqual(r.faceFpsCap(), 0);
  // Asked on every display frame (env.maxFps): no arrays built there.
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/perfcore.js'), 'utf8');
  const body = src.slice(src.indexOf('export function faceFpsCap('), src.indexOf('export const REST_CANVAS_FPS'));
  assert.ok(body.includes('let cap = Infinity;'), 'faceFpsCap found');
  assert.ok(!/\[|\.filter\(|\.\.\./.test(body), 'allocates nothing');
});

test('canvasFps: the chosen rate, held to the voice cap and the resting rate; anything else is auto', () => {
  assert.strictEqual(r.REST_CANVAS_FPS, 20);
  assert.strictEqual(r.canvasFps({ chosen: 120, voiceWorking: true }), 60);
  assert.strictEqual(r.canvasFps({ chosen: 120, resting: true }), 20);
  assert.strictEqual(r.canvasFps({ chosen: 120, voiceWorking: true, resting: true }), 20);
  assert.strictEqual(r.canvasFps({ chosen: 120 }), 120);
  assert.strictEqual(r.canvasFps({ chosen: 'auto' }), 30);
  assert.strictEqual(r.canvasFps({ chosen: 'auto', balanced: true }), 15);
  assert.strictEqual(r.canvasFps({ chosen: '60' }), 60, 'the view’s select saves a string');
  assert.strictEqual(r.canvasFps({ chosen: 15, voiceWorking: true }), 15, 'a lower choice stays');
  assert.strictEqual(r.canvasFps({ chosen: 30, balanced: true }), 30, 'a choice beats Balanced’s auto');
  for (const chosen of ['auto', 'abc', '', 0, -1, NaN, Infinity, null, undefined, 45, '30.5', {}, []]) {
    assert.strictEqual(r.canvasFps({ chosen }), 30, `auto for ${String(chosen)}`);
    assert.strictEqual(r.canvasFps({ chosen, balanced: true }), 15, `Balanced auto for ${String(chosen)}`);
  }
  assert.strictEqual(r.canvasFps(), 30, 'no argument: auto');
  for (const opts of [{ chosen: 120 }, { chosen: 120, voiceWorking: true }, { chosen: 'x', resting: true }, { balanced: true, resting: true }]) {
    const fps = r.canvasFps(opts);
    assert.ok(Number.isFinite(fps) && fps > 0, `a usable rate for ${JSON.stringify(opts)}`);
  }
});
