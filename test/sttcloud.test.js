// Cloud speech-to-text (main/voice.js): Groq's Whisper as an engine or as local Whisper's fallback,
// with the Groq key the AI brain uses; the custom endpoint as before; readable errors; and the address
// your voice goes to is a setting only the user changes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, quietLog } = require('./helpers');

let settings;
const base = (stt = {}, extra = {}) => ({ stt: { engine: 'local', language: 'de', remoteUrl: '', remoteKey: '', remoteModel: 'whisper-1', ...stt }, llm: { baseUrl: 'http://localhost:3001/v1', apiKey: 'llm-key' }, groq: { apiKey: 'gsk_test' }, learning: {}, voice: {}, ...extra });
stub({ './logger': quietLog, './store': { getSettings: async () => settings } });
const voice = load('main/voice.js');

test('which endpoint: Groq by engine or as the fallback, else the custom one', () => {
  assert.deepStrictEqual(voice.sttEndpoint(base({ engine: 'groq' })), { base: 'https://api.groq.com/openai/v1', key: 'gsk_test', model: 'whisper-large-v3-turbo', name: 'Groq' });
  assert.strictEqual(voice.sttEndpoint(base({ engine: 'local' }), 'groq').name, 'Groq', 'the local engine\'s fallback');
  assert.deepStrictEqual(voice.sttEndpoint(base({ engine: 'remote', remoteUrl: 'https://stt.example.com/v1/', remoteKey: 'k' })), { base: 'https://stt.example.com/v1', key: 'k', model: 'whisper-1', name: 'remote' });
  assert.strictEqual(voice.sttEndpoint(base({ engine: 'remote' })).base, 'http://localhost:3001/v1', 'no URL: the FreeLLMAPI one, as before');
  assert.throws(() => voice.sttEndpoint(base({ engine: 'groq' }, { groq: { apiKey: '' } })), /Groq API key/);
  assert.throws(() => voice.sttEndpoint({ ...base({ engine: 'remote' }), llm: {} }), /transcription URL/);
});

function mockFetch(respond) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => (calls.push({ url, init }), respond(url, init));
  return { calls, restore: () => (global.fetch = original) };
}

test('Groq gets the audio, the model, the language and the key; the text comes back', async () => {
  settings = base({ engine: 'groq', vocabulary: ['Siren', 'Obsidian'] });
  const m = mockFetch(async () => new Response(JSON.stringify({ text: 'Hallo Siren' }), { status: 200 }));
  try {
    assert.strictEqual(await voice.transcribe(new Uint8Array([1, 2, 3])), 'Hallo Siren');
    const { url, init } = m.calls[0];
    assert.strictEqual(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.strictEqual(init.headers.Authorization, 'Bearer gsk_test');
    assert.strictEqual(init.body.get('model'), 'whisper-large-v3-turbo');
    assert.strictEqual(init.body.get('language'), 'de');
    assert.strictEqual(init.body.get('prompt'), 'Siren, Obsidian', 'the calibrated words help it spell names');
    assert.ok(init.body.get('file') instanceof Blob);
  } finally {
    m.restore();
  }
});

test('the fallback asks Groq even with the local engine; nothing else changes', async () => {
  settings = base({ engine: 'local', cloudFallback: true });
  const m = mockFetch(async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }));
  try {
    assert.strictEqual(await voice.transcribe(new Uint8Array([1]), { provider: 'groq' }), 'ok');
    assert.match(m.calls[0].url, /api\.groq\.com/);
  } finally {
    m.restore();
  }
});

test('errors say what to do: a wrong key, the free limit, anything else', async () => {
  settings = base({ engine: 'groq' });
  for (const [status, re] of [[401, /did not accept the API key/], [429, /limit is used up/], [500, /Transcription error 500/]]) {
    const m = mockFetch(async () => new Response('{"error":"x"}', { status }));
    try {
      await assert.rejects(() => voice.transcribe(new Uint8Array([1])), re, String(status));
    } finally {
      m.restore();
    }
  }
});

test('the agent can switch engines but never where your voice is sent, nor the cloud fallback', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'tools.js'), 'utf8');
  const settable = /const SETTABLE = \{([\s\S]*?)\n\};/.exec(src)[1];
  const stt = /stt: \[([^\]]*)\]/.exec(settable)[1];
  for (const key of ['remoteUrl', 'remoteKey', 'remoteModel', 'cloudFallback', 'groqModel']) assert.ok(!stt.includes(`'${key}'`), key);
  assert.ok(!/groq:\s*\[[^\]]*apiKey/.test(settable), 'the key is never settable');
});

test('local Whisper stays the default, the fallback off', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'store.js'), 'utf8');
  assert.match(src, /engine: 'local', \/\/ 'local' = Whisper in-app/);
  assert.match(src, /cloudFallback: false,/);
});
