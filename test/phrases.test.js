// Kept voice lines in Cache Storage (renderer/js/phrases.js), against a stand-in CacheStorage that keeps
// insertion order like the real one:
//  - what is stored can't be read back as text: hashed addresses, PCM bodies, no keys anywhere;
//  - only the main voice's own, plausible audio is kept; an implausible entry is deleted when read, on
//    the write chain;
//  - at most 256 lines, the oldest go first, a line in use moves back;
//  - forgetting removes even a line whose write was still queued (it lands first, not on the deleted cache);
//  - blocked storage logs once and then stays out of the way.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const ESM = tmpDir('nexus-phrases-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
for (const f of ['phrases.js', 'phrasecore.js', 'kokorotext.js']) fs.copyFileSync(path.join(ROOT, 'renderer/js', f), path.join(ESM, f));
// util.js needs the window; phrases.js only logs through it.
fs.writeFileSync(path.join(ESM, 'util.js'), 'export const logEvent = (...args) => (globalThis.__phraseLogs ||= []).push(args);\n');
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));
let fresh = 0;
const load = () => import(`${pathToFileURL(path.join(ESM, 'phrases.js')).href}?v=${++fresh}`); // a fresh module state
const core = () => import(pathToFileURL(path.join(ESM, 'phrasecore.js')).href);

// A CacheStorage stand-in: a put replaces an entry and moves it to the end, keys() lists the oldest first.
// Like the real one, a deleted cache's handle still takes writes that nobody will ever read: those are
// counted (`latePuts`). `log` lists the writes and deletes as they land; `gate` holds writes back.
class FakeCache {
  constructor(owner) {
    this.owner = owner;
    this.entries = [];
    this.log = [];
    this.gate = null;
  }
  urlOf = (req) => (typeof req === 'string' ? req : req.url);
  async match(req) {
    const e = this.entries.find((x) => x.url === this.urlOf(req));
    return e ? new Response(e.bytes.slice(0), { headers: e.headers }) : undefined;
  }
  async put(req, res) {
    const bytes = await res.arrayBuffer();
    await this.gate;
    if (this.deleted) this.owner.latePuts++;
    const url = this.urlOf(req);
    this.entries = this.entries.filter((x) => x.url !== url);
    this.entries.push({ url, bytes, headers: Object.fromEntries(res.headers) });
    this.log.push(['put', url]);
  }
  async delete(req) {
    const n = this.entries.length;
    this.entries = this.entries.filter((x) => x.url !== this.urlOf(req));
    this.log.push(['delete', this.urlOf(req)]);
    return this.entries.length < n;
  }
  async keys() {
    return this.entries.map((x) => ({ url: x.url }));
  }
}
class FakeStorage {
  constructor() {
    this.map = new Map();
    this.latePuts = 0;
  }
  async open(name) {
    if (!this.map.has(name)) this.map.set(name, new FakeCache(this));
    return this.map.get(name);
  }
  async delete(name) {
    const doomed = this.map.get(name);
    if (doomed) doomed.deleted = true;
    return this.map.delete(name);
  }
}
globalThis.AudioBuffer = class {
  constructor({ numberOfChannels, length, sampleRate }) {
    assert.strictEqual(numberOfChannels, 1);
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = new Float32Array(length);
  }
  getChannelData() {
    return this.data;
  }
  copyToChannel(src) {
    this.data.set(src);
  }
};

const RATE = 24000;
const speech = (sec = 1.5) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / RATE));
const local = { rev: 1, engine: 'local', voice: '', model: '', localVoice: 'af_heart', speed: 1, cloud: null };
const studio = { ...local, engine: 'voicestudio', voice: 'vs_george', model: 'tts-1', localVoice: '' };
const madeByLocal = { engine: 'local', localVoice: 'af_heart', speed: 1 };
const buffer = (samples = speech(), madeBy = madeByLocal) => ({ sampleRate: RATE, getChannelData: () => samples, madeBy });
const fill = async (phrases, n, prefix = 'Line') => {
  for (let i = 0; i < n; i++) phrases.keepPhrase(local, `${prefix} ${i}.`, buffer(speech(0.5)));
  await phrases.phrasesSettled();
};

test('stored lines can\'t be read back as text: hashed addresses, PCM bodies, no keys', async () => {
  globalThis.caches = new FakeStorage();
  const phrases = await load();
  const text = 'Hello, I\'m Siren. What are we working on today?';
  phrases.keepPhrase(local, text, buffer());
  phrases.keepPhrase({ ...studio }, 'One moment.', buffer(speech(), { engine: 'voicestudio', voice: 'vs_george', model: 'tts-1', speed: 1 }));
  await phrases.phrasesSettled();
  const cache = await caches.open('siren-voice-phrases');
  assert.strictEqual(cache.entries.length, 2);
  for (const e of cache.entries) {
    assert.match(e.url, /^https:\/\/siren-phrases\.invalid\/[0-9a-f]{64}$/);
    const visible = [e.url, JSON.stringify(e.headers), Buffer.from(e.bytes).toString('latin1')].join('\n');
    for (const secret of [text, 'Siren', 'One moment', 'gsk_', 'vs_george']) assert.ok(!visible.includes(secret), `"${secret}" is readable in the cache`);
    assert.strictEqual(e.headers['x-sample-rate'], String(RATE));
    assert.strictEqual(e.headers['content-type'], 'application/octet-stream');
  }
  // Read back: the same audio (within 16-bit steps), marked as kept.
  const back = await phrases.getPhrase(local, text);
  assert.ok(back, 'found');
  assert.deepStrictEqual(back.timing, { cached: true });
  assert.strictEqual(back.sampleRate, RATE);
  const orig = speech();
  assert.strictEqual(back.length, orig.length);
  assert.ok(back.getChannelData(0).every((x, i) => Math.abs(x - orig[i]) <= 1 / 32767));
  assert.strictEqual(await phrases.getPhrase(studio, text), null, 'another voice: a miss');
  assert.strictEqual(await phrases.getPhrase(local, 'x'.repeat(161)), null, 'too long to keep');
});

test('only the main voice\'s own, plausible audio is kept', async () => {
  globalThis.caches = new FakeStorage();
  const phrases = await load();
  phrases.keepPhrase(studio, 'One moment.', buffer(speech(), madeByLocal)); // the fallback while VoiceStudio is down
  phrases.keepPhrase(local, 'On it.', buffer(new Float32Array(RATE))); // silence
  phrases.keepPhrase(local, 'Let me see.', buffer(speech(), null)); // nobody said who made it
  phrases.keepPhrase(local, 'Give me a second.', 'system'); // the system voice: nothing to keep
  phrases.keepPhrase(local, '', buffer());
  await phrases.phrasesSettled();
  assert.strictEqual((await caches.open('siren-voice-phrases')).entries.length, 0);
});

test('at most 256 lines: the oldest goes; a line in use in the oldest quarter moves back', async () => {
  globalThis.caches = new FakeStorage();
  const phrases = await load();
  const { MAX_ENTRIES } = await core();
  await fill(phrases, MAX_ENTRIES);
  const cache = await caches.open('siren-voice-phrases');
  assert.strictEqual(cache.entries.length, 256);
  const first = cache.entries[0].url;
  const second = cache.entries[1].url;
  phrases.keepPhrase(local, 'Line 256.', buffer(speech(0.5)));
  await phrases.phrasesSettled();
  assert.strictEqual(cache.entries.length, 256);
  assert.ok(!cache.entries.some((e) => e.url === first), 'the 257th put evicted the first');
  assert.strictEqual(cache.entries[0].url, second);
  // A hit on the (now) oldest line moves it to the end, so it isn't the next to go.
  assert.ok(await phrases.getPhrase(local, 'Line 1.'));
  await phrases.phrasesSettled();
  assert.strictEqual(cache.entries.at(-1).url, second);
  assert.strictEqual(cache.entries.length, 256);
  // A hit on a recent line changes nothing.
  const order = cache.entries.map((e) => e.url).join();
  assert.ok(await phrases.getPhrase(local, 'Line 200.'));
  await phrases.phrasesSettled();
  assert.strictEqual(cache.entries.map((e) => e.url).join(), order);
});

test('an implausible entry is deleted when read', async () => {
  globalThis.caches = new FakeStorage();
  const phrases = await load();
  phrases.keepPhrase(local, 'One moment.', buffer());
  await phrases.phrasesSettled();
  const cache = await caches.open('siren-voice-phrases');
  const e = cache.entries[0];
  e.bytes = new Int16Array(RATE).buffer; // a second of silence where the audio was
  assert.strictEqual(await phrases.getPhrase(local, 'One moment.'), null);
  await phrases.phrasesSettled();
  assert.strictEqual(cache.entries.length, 0, 'deleted');
  // An odd-length body or a missing rate is no audio either.
  phrases.keepPhrase(local, 'On it.', buffer());
  await phrases.phrasesSettled();
  cache.entries[0].bytes = new Uint8Array(101).buffer;
  assert.strictEqual(await phrases.getPhrase(local, 'On it.'), null);
  phrases.keepPhrase(local, 'Let me see.', buffer());
  await phrases.phrasesSettled();
  cache.entries.at(-1).headers['x-sample-rate'] = 'nope';
  assert.strictEqual(await phrases.getPhrase(local, 'Let me see.'), null);
  await phrases.phrasesSettled();
  assert.strictEqual(cache.entries.length, 0);
});

// The delete goes on the write chain, behind what was asked before it (a forget after it can't be
// undone by a delete that opens the cache again).
test('the delete of an implausible entry waits for the writes asked before it', async () => {
  globalThis.caches = new FakeStorage();
  const phrases = await load();
  phrases.keepPhrase(local, 'One moment.', buffer());
  await phrases.phrasesSettled();
  const cache = await caches.open('siren-voice-phrases');
  const bad = cache.entries[0].url;
  cache.entries[0].bytes = new Int16Array(RATE).buffer;
  cache.log = [];
  let open;
  cache.gate = new Promise((r) => (open = r));
  phrases.keepPhrase(local, 'On it.', buffer()); // held at the gate
  assert.strictEqual(await phrases.getPhrase(local, 'One moment.'), null);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(cache.log, [], 'nothing lands while the earlier write waits');
  open();
  await phrases.phrasesSettled();
  assert.deepStrictEqual(cache.log.map(([op, url]) => `${op} ${url === bad ? 'bad' : 'other'}`), ['put other', 'delete bad']);
});

test('forgetting removes everything, also a line whose write was still queued', async () => {
  globalThis.caches = new FakeStorage();
  const phrases = await load();
  await fill(phrases, 3);
  phrases.keepPhrase(local, 'One moment.', buffer()); // not landed yet
  assert.strictEqual(await phrases.forgetPhrases(), true);
  await phrases.phrasesSettled();
  assert.strictEqual(caches.latePuts, 0, 'the queued write landed before the forget, not on the deleted cache after it');
  assert.strictEqual(caches.map.has('siren-voice-phrases'), false);
  assert.strictEqual(await phrases.getPhrase(local, 'One moment.'), null);
  assert.strictEqual(await phrases.forgetPhrases(), false, 'nothing left to forget (the lookup only opened an empty cache)');
  assert.strictEqual(caches.map.has('siren-voice-phrases'), false);
});

test('blocked Cache Storage: one log line, then every call is a quiet no-op', async () => {
  globalThis.__phraseLogs = [];
  let opens = 0;
  globalThis.caches = {
    open: async () => {
      opens++;
      throw new Error('SecurityError: blocked');
    },
    delete: async () => {
      throw new Error('blocked');
    },
  };
  const phrases = await load();
  assert.strictEqual(await phrases.getPhrase(local, 'One moment.'), null);
  phrases.keepPhrase(local, 'One moment.', buffer());
  await phrases.phrasesSettled();
  assert.strictEqual(await phrases.getPhrase(local, 'On it.'), null);
  assert.strictEqual(await phrases.forgetPhrases(), false);
  assert.strictEqual(globalThis.__phraseLogs.length, 1);
  assert.deepStrictEqual(globalThis.__phraseLogs[0].slice(0, 2), ['info', 'kept voice lines unavailable']);
  assert.match(globalThis.__phraseLogs[0][2].error, /blocked/);
  assert.strictEqual(opens, 1, 'not tried again this session');
});
