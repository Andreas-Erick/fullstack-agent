// Kept voice lines, the pure part (renderer/js/phrasecore.js; stored by phrases.js, spoken by voice.js):
//  - a line's key holds the voice it was made in, never an API key (the renderer's settings hold them
//    decrypted), and changes whenever the sound would;
//  - only audio that looks like the line spoken is kept or played (not silence, noise or a garbled run);
//  - audio the fallback made never goes under the main voice's key;
//  - the launch greeting and its "where we left off" line, moved here from app.js, say what they said.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const ESM = tmpDir('nexus-phrasecore-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
for (const f of ['phrasecore.js', 'kokorotext.js']) fs.copyFileSync(path.join(ROOT, 'renderer/js', f), path.join(ESM, f));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));
const core = () => import(pathToFileURL(path.join(ESM, 'phrasecore.js')).href);

const settings = (engine, extra = {}) => ({
  voice: { engine, voice: 'vs_george', model: 'tts-1', localVoice: 'bm_george', speed: 1, apiKey: 'vs_secret', ...extra.voice },
  cloudVoice: { provider: 'groq', model: 'canopylabs/orpheus-v1-english', voice: 'troy', apiKey: 'gsk_secret', ...extra.cloudVoice },
});

test('a line\'s key never holds an API key, and changes whenever the sound would', async () => {
  const { voiceIdentity, phraseKeyText, PHRASE_REV } = await core();
  const key = (s, text = 'One moment.') => phraseKeyText(voiceIdentity(s), text);
  for (const engine of ['local', 'voicestudio', 'cloud']) {
    const s = settings(engine);
    for (const text of [JSON.stringify(voiceIdentity(s)), key(s)]) {
      assert.ok(!text.includes('gsk_secret') && !text.includes('vs_secret'), `${engine}: ${text}`);
    }
    assert.strictEqual(key(settings(engine, { voice: { apiKey: 'other' }, cloudVoice: { apiKey: 'gsk_other' } })), key(s), `${engine}: only a key changed`);
    assert.notStrictEqual(key(s, 'On it.'), key(s), 'another text');
    assert.notStrictEqual(key(settings(engine, { voice: { speed: 1.2 } })), key(s), `${engine}: speed`);
  }
  assert.notStrictEqual(key(settings('local')), key(settings('voicestudio')), 'engine');
  assert.notStrictEqual(key(settings('local', { voice: { localVoice: 'af_bella' } })), key(settings('local')), 'offline voice');
  assert.notStrictEqual(key(settings('voicestudio', { voice: { voice: 'other' } })), key(settings('voicestudio')), 'VoiceStudio voice');
  assert.notStrictEqual(key(settings('voicestudio', { voice: { model: 'tts-2' } })), key(settings('voicestudio')), 'VoiceStudio model');
  for (const c of [{ provider: 'openai' }, { model: 'x' }, { voice: 'hannah' }]) assert.notStrictEqual(key(settings('cloud', { cloudVoice: c })), key(settings('cloud')), `cloud ${Object.keys(c)[0]}`);
  // Fields another engine uses don't split one engine's lines.
  assert.strictEqual(key(settings('local', { voice: { voice: 'other', model: 'x' }, cloudVoice: { voice: 'hannah' } })), key(settings('local')));
  assert.strictEqual(key(settings('voicestudio', { voice: { localVoice: 'af_bella' } })), key(settings('voicestudio')));
  // The pipeline's revision is part of it.
  assert.strictEqual(voiceIdentity(settings('local')).rev, PHRASE_REV);
  assert.notStrictEqual(phraseKeyText({ ...voiceIdentity(settings('local')), rev: PHRASE_REV + 1 }, 'One moment.'), key(settings('local')));
  // Unknown offline voices are the default one (as the worker speaks them); an unknown engine is local.
  assert.strictEqual(voiceIdentity(settings('local', { voice: { localVoice: 'nope' } })).localVoice, 'af_heart');
  assert.strictEqual(voiceIdentity({ voice: { engine: 'nonsense' } }).engine, 'local');
  assert.deepStrictEqual(Object.keys(voiceIdentity({})), ['rev', 'engine', 'voice', 'model', 'localVoice', 'speed', 'cloud'], 'a fixed key order');
});

test('phraseUrl: only a SHA-256 hex digest, under a host that never resolves', async () => {
  const { phraseUrl } = await core();
  const hex = 'ab'.repeat(32);
  assert.strictEqual(phraseUrl(hex), `https://siren-phrases.invalid/${hex}`);
  for (const bad of ['', 'ab'.repeat(31), `${'ab'.repeat(32)}0`, 'AB'.repeat(32), `${'ab'.repeat(31)}/x`, '../'.repeat(22)]) assert.throws(() => phraseUrl(bad), `"${bad}"`);
});

test('16-bit PCM round trip: within one step of the clamped samples', async () => {
  const { toPcm16, fromPcm16 } = await core();
  const input = [-1.5, -1, -0.5, 0, 0.25, 1, 2];
  const pcm = toPcm16(Float32Array.from(input));
  assert.ok(pcm instanceof Int16Array);
  const back = fromPcm16(pcm);
  assert.strictEqual(back.length, input.length);
  input.forEach((x, i) => assert.ok(Math.abs(back[i] - Math.max(-1, Math.min(1, x))) <= 1 / 32767, `${x} → ${back[i]}`));
});

const RATE = 24000;
const sine = (sec, peak = 0.5, hz = 220) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => peak * Math.sin((2 * Math.PI * hz * i) / RATE));

test('plausibleSpeech: speech-like audio passes; silence, noise, garbage and wrong lengths do not', async () => {
  const { plausibleSpeech, zeroCrossingRate, MAX_ZCR } = await core();
  const ok = (samples, chars = 34, rate = RATE) => plausibleSpeech({ chars, samples, rate });
  assert.strictEqual(ok(sine(2.7)), true, 'a 2.7 s tone for a 34-character line');
  const nan = sine(1);
  nan[100] = NaN;
  assert.strictEqual(ok(nan), false, 'NaN');
  const inf = sine(1);
  inf[5] = Infinity;
  assert.strictEqual(ok(inf), false, 'Infinity');
  assert.strictEqual(ok(sine(1, 0.01)), false, 'too quiet: peak 0.01');
  const spike = new Float32Array(RATE);
  spike[1000] = 0.5;
  assert.strictEqual(ok(spike), false, 'one click in silence: the RMS floor');
  assert.strictEqual(ok(sine(1, 3)), false, 'peak far over 1');
  assert.strictEqual(ok(sine(60), 10), false, '60 s for 10 characters');
  assert.strictEqual(ok(sine(0.1)), false, '0.1 s');
  assert.strictEqual(ok(sine(1), 34, 0), false, 'rate 0');
  assert.strictEqual(ok(sine(1), 34, 200000), false, 'rate 200000');
  assert.strictEqual(ok(new Float32Array(0)), false, 'empty');
  assert.strictEqual(plausibleSpeech({ chars: 34, samples: null, rate: RATE }), false, 'no samples');
  // White noise as loud as speech (a garbled run): its zero-crossing rate gives it away.
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  const noise = Float32Array.from({ length: Math.round(2.7 * RATE) }, () => 0.8 * rand());
  assert.ok(zeroCrossingRate(noise) > MAX_ZCR, `noise ZCR ${zeroCrossingRate(noise)}`);
  assert.strictEqual(ok(noise), false, 'white noise at peak 0.8');
  assert.ok(zeroCrossingRate(sine(1)) < 0.05, 'a 220 Hz tone crosses ~0.018 per sample');
  assert.strictEqual(zeroCrossingRate(new Float32Array(100)), 0, 'silence: no loud pairs');
});

test('keepable: a short fixed line, not empty and not long', async () => {
  const { keepable, MAX_CHARS } = await core();
  assert.strictEqual(MAX_CHARS, 160);
  assert.strictEqual(keepable('One moment.'), true);
  assert.strictEqual(keepable('x'.repeat(160)), true);
  assert.strictEqual(keepable(''), false);
  assert.strictEqual(keepable('x'.repeat(161)), false);
  assert.strictEqual(keepable(null), false);
});

test('madeByMatches: only the main voice\'s own audio goes under its key', async () => {
  const { voiceIdentity, madeByMatches, madeByOf } = await core();
  const local = voiceIdentity(settings('local'));
  const studio = voiceIdentity(settings('voicestudio'));
  const cloud = voiceIdentity(settings('cloud'));
  assert.strictEqual(madeByMatches(local, { engine: 'local', localVoice: 'bm_george', speed: 1 }), true);
  assert.strictEqual(madeByMatches(studio, { engine: 'local', localVoice: 'bm_george', speed: 1 }), false, 'the fallback while VoiceStudio is down');
  assert.strictEqual(madeByMatches(cloud, { engine: 'local', localVoice: 'bm_george', speed: 1 }), false, 'the fallback while the cloud voice is down');
  assert.strictEqual(madeByMatches(local, { engine: 'local', localVoice: 'af_bella', speed: 1 }), false, 'the voice changed mid-request');
  assert.strictEqual(madeByMatches(local, { engine: 'local', localVoice: 'bm_george', speed: 1.2 }), false, 'the speed changed');
  assert.strictEqual(madeByMatches(studio, { engine: 'voicestudio', voice: 'vs_george', model: 'tts-1', speed: 1 }), true);
  assert.strictEqual(madeByMatches(studio, { engine: 'voicestudio', voice: 'other', model: 'tts-1', speed: 1 }), false);
  assert.strictEqual(madeByMatches(studio, { engine: 'voicestudio', voice: 'vs_george', model: 'tts-2', speed: 1 }), false);
  assert.strictEqual(madeByMatches(cloud, { engine: 'cloud', cloud: ['groq', 'canopylabs/orpheus-v1-english', 'troy'], speed: 1 }), true);
  assert.strictEqual(madeByMatches(cloud, { engine: 'cloud', cloud: ['groq', 'canopylabs/orpheus-v1-english', 'hannah'], speed: 1 }), false);
  assert.strictEqual(madeByMatches(local, undefined), false, 'nothing said who made it');
  assert.strictEqual(madeByMatches(undefined, { engine: 'local' }), false);
  // What voice.js stamps on its audio matches the identity of the same settings, and only that.
  for (const engine of ['local', 'voicestudio', 'cloud']) {
    const s = settings(engine);
    assert.strictEqual(madeByMatches(voiceIdentity(s), madeByOf(engine, s)), true, engine);
    for (const other of ['local', 'voicestudio', 'cloud'].filter((e) => e !== engine)) assert.strictEqual(madeByMatches(voiceIdentity(s), madeByOf(other, s)), false, `${other} audio under ${engine}`);
  }
  assert.ok(!JSON.stringify(madeByOf('cloud', settings('cloud'))).includes('secret'));
});

test('eviction drops the oldest; a line in use in the oldest quarter moves back', async () => {
  const { toEvict, rePutWanted, MAX_ENTRIES } = await core();
  assert.strictEqual(MAX_ENTRIES, 256);
  assert.deepStrictEqual(toEvict(['a', 'b', 'c'], 2), ['a']);
  assert.deepStrictEqual(toEvict(['a'], 2), []);
  assert.deepStrictEqual(toEvict([]), []);
  assert.strictEqual(toEvict(Array.from({ length: 257 }, (_, i) => i)).length, 1);
  assert.strictEqual(rePutWanted(0, 200), true);
  assert.strictEqual(rePutWanted(150, 200), false);
  assert.strictEqual(rePutWanted(0, 100), false, 'a cache under half full evicts nothing soon');
  assert.strictEqual(rePutWanted(-1, 200), false, 'gone meanwhile (forgotten): never brought back');
});

test('launchGreeting: the persona\'s greeting, and a recent note\'s line said apart', async () => {
  const { launchGreeting, HANDOFF_RECENT_MS, HANDOFF_LATE_MS } = await core();
  const now = Date.UTC(2026, 10, 18, 9);
  const s = (name, greeting = '') => ({ agent: { name }, appearance: { greeting } });
  assert.strictEqual(launchGreeting(s('Nova'), null, now).greeting, "Hello, I'm Nova. What are we working on today?");
  assert.strictEqual(launchGreeting(s(''), null, now).greeting, "Hello, I'm Siren. What are we working on today?");
  assert.strictEqual(launchGreeting(s('Nova', 'Hey champ!'), null, now).greeting, 'Hey champ!');
  const note = { at: now - 3600e3, topic: 'the lab report', title: 'Lab report' };
  assert.deepStrictEqual(launchGreeting(s('Nova'), note, now), { greeting: "Hello, I'm Nova. What are we working on today?", handoff: 'Last time we were on the lab report; say the word and we continue.' });
  assert.strictEqual(launchGreeting(s('Nova'), { ...note, topic: '' }, now).handoff, 'Last time we were on Lab report; say the word and we continue.', 'the title when there is no topic');
  assert.strictEqual(launchGreeting(s('Nova'), { ...note, at: now - 4 * 86400e3 }, now).handoff, '', 'four days old');
  assert.strictEqual(launchGreeting(s('Nova'), null, now).handoff, '');
  assert.strictEqual(HANDOFF_RECENT_MS, 3 * 86400e3);
  assert.strictEqual(HANDOFF_LATE_MS, 20000);
});
