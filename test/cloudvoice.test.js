// The cloud voice (main/voice.js, voice.engine 'cloud'): Groq's Orpheus with the Groq key the user
// already has, or OpenAI with its own key; one request per line in the OpenAI speech format; readable
// errors; and VoiceStudio isn't started for it.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

let settings;
stub({ './logger': quietLog, './store': { getSettings: async () => settings } });
const voice = load('main/voice.js');
const base = (cloudVoice = {}, extra = {}) => ({ voice: { engine: 'cloud', speed: 1, baseUrl: 'http://localhost:3900', ttsEnabled: true }, cloudVoice: { provider: 'groq', apiKey: '', model: '', voice: '', ...cloudVoice }, groq: { apiKey: 'gsk_test' }, ...extra });

test('Groq by default, with the Groq key; OpenAI with its own', () => {
  const g = voice.cloudRequest(base(), 'Hello there.');
  assert.deepStrictEqual(g, { url: 'https://api.groq.com/openai/v1/audio/speech', key: 'gsk_test', name: 'Groq (Orpheus)', body: { model: 'canopylabs/orpheus-v1-english', input: 'Hello there.', voice: 'hannah', response_format: 'wav' } });
  const o = voice.cloudRequest(base({ provider: 'openai', apiKey: 'sk-x', voice: 'nova' }, { voice: { speed: 1.25 } }), 'Hi');
  assert.deepStrictEqual([o.url, o.key, o.body.model, o.body.voice, o.body.speed, o.body.response_format], ['https://api.openai.com/v1/audio/speech', 'sk-x', 'gpt-4o-mini-tts', 'nova', 1.25, 'mp3']);
  assert.strictEqual(voice.cloudRequest(base({ voice: 'nova' }), 'x').body.voice, 'hannah', 'a voice the service lacks: its first');
  assert.strictEqual(voice.cloudRequest(base({}, { voice: { speed: 1.5 } }), 'x').body.speed, undefined, 'Orpheus has no speed');
  assert.strictEqual(voice.cloudRequest(base(), 'y'.repeat(9000)).body.input.length, 4000);
  assert.throws(() => voice.cloudRequest(base({}, { groq: { apiKey: '' } }), 'x'), /Groq API key/);
  assert.throws(() => voice.cloudRequest(base({ provider: 'openai' }), 'x'), /OpenAI API key/);
});

test('speak() uses the cloud voice, and says which service failed', async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    if (calls.length === 1) return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200, headers: { 'content-type': 'audio/wav' } });
    return new Response('terms not accepted', { status: 400 });
  };
  try {
    settings = base();
    const r = await voice.speak('Good morning.');
    assert.deepStrictEqual([r.mime, r.audio.length, calls[0].url, calls[0].auth], ['audio/wav', 4, 'https://api.groq.com/openai/v1/audio/speech', 'Bearer gsk_test']);
    await assert.rejects(voice.speak('Again.'), /Groq \(Orpheus\) voice error 400: terms not accepted/);
  } finally {
    global.fetch = realFetch;
  }
});

test('VoiceStudio is not started for the cloud voice', () => {
  stub({ './logger': quietLog, './store': { getSettings: async () => settings } });
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main', 'helperapps.js'), 'utf8');
  assert.match(src, /needed: \(s\) => Boolean\(s\.voice\?\.ttsEnabled && s\.voice\.engine !== 'local' && s\.voice\.engine !== 'cloud'\)/);
});
