// The offline voice's text side (renderer/js/kokorotext.js) and the fallback setting's migration
// (main/store.js). The model itself needs a browser and a download, so it is not run here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, stub, load, tmpDir } = require('./helpers');

let k;
test.before(async () => {
  // A renderer ES module in a CommonJS package: import a .mjs copy.
  const copy = path.join(tmpDir('nexus-kokoro-'), 'kokorotext.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/kokorotext.js'), copy);
  k = await import(pathToFileURL(copy).href);
});

test('normalizeText spells out what eSpeak would misread', () => {
  assert.strictEqual(k.normalizeText('It costs $5.50.'), 'It costs 5 dollars and 50 cents.');
  assert.strictEqual(k.normalizeText('Meet at 3:05 with Dr. Smith'), 'Meet at 3 oh 5 with Doctor Smith');
  assert.strictEqual(k.normalizeText('Back in 1984, pages 3-7'), 'Back in 19 84, pages 3 to 7');
  assert.strictEqual(k.normalizeText('“Hi” (there)'), '"Hi" «there»');
});

test('toPhonemes phonemizes the words and keeps punctuation as it is', async () => {
  const calls = [];
  const phonemize = async (text, lang) => (calls.push([text, lang]), [`<${text.trim().toUpperCase()}>`]);
  assert.strictEqual(await k.toPhonemes('Hello, world!', 'af_heart', phonemize), '<HELLO>, <WORLD>!');
  assert.deepStrictEqual(calls, [['Hello', 'en-us'], ['world', 'en-us']]);
  await k.toPhonemes('Cheers.', 'bf_emma', phonemize);
  assert.strictEqual(calls.at(-1)[1], 'en', 'UK voices use British pronunciation');
});

test('fixPhonemes maps eSpeak symbols to the model vocabulary', () => {
  assert.strictEqual(k.fixPhonemes('ræbɪt x'), 'ɹæbɪt k');
  assert.strictEqual(k.fixPhonemes('nˈaɪnti', 'a'), 'nˈaɪndi');
  assert.strictEqual(k.fixPhonemes('nˈaɪnti', 'b'), 'nˈaɪnti');
});

test('styleOffset picks one style row per token count, clamped to the voice file', () => {
  assert.strictEqual(k.styleOffset(0), 0);
  assert.strictEqual(k.styleOffset(12), 2560);
  assert.strictEqual(k.styleOffset(10000), 256 * 509);
});

test('kokoroVoice falls back to the default for unknown ids (e.g. a VoiceStudio voice)', () => {
  assert.strictEqual(k.kokoroVoice('bm_george'), 'bm_george');
  assert.strictEqual(k.kokoroVoice('my-cloned-voice'), k.DEFAULT_KOKORO_VOICE);
  assert.ok(k.KOKORO_VOICES.some(([id]) => id === k.DEFAULT_KOKORO_VOICE));
});

test('the old system-voice toggle becomes the fallback choice', async () => {
  const dir = tmpDir('nexus-store-');
  stub({ electron: { app: { getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => false } } });
  const store = load('main/store.js');
  assert.strictEqual(store.DEFAULTS.voice.fallback, 'local');
  assert.ok(store.DEFAULTS.voice.localVoice);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ onboarded: true, voice: { fallbackSystemVoice: false } }));
  const s = await store.getSettings();
  assert.strictEqual(s.voice.fallback, 'off');
  assert.ok(!('fallbackSystemVoice' in s.voice));
});
