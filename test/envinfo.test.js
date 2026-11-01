// The environment line in the log names the voice engine actually in use (it said VoiceStudio for the
// offline voice, which misled a memory investigation).
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

stub({ electron: { app: {}, screen: {} }, './store': {}, './logger': quietLog });
const { voiceLine } = load('main/envinfo.js');

test('voiceLine names the engine in use', () => {
  assert.strictEqual(voiceLine({ ttsEnabled: false, engine: 'local' }), 'off');
  assert.strictEqual(voiceLine({ ttsEnabled: true, engine: 'local', localVoice: 'bm_george', baseUrl: 'http://localhost:3900' }), 'offline (Kokoro bm_george)');
  assert.strictEqual(voiceLine({ ttsEnabled: true, engine: 'voicestudio', baseUrl: 'http://localhost:3900' }), 'VoiceStudio http://localhost:3900');
  assert.strictEqual(voiceLine({ ttsEnabled: true, engine: 'cloud' }), 'cloud');
});
