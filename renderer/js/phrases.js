// Kept voice lines in the window's Cache Storage (beside the offline voice's model): 16-bit PCM under a
// SHA-256 of the voice and the text (phrasecore.js). Best effort throughout: every call catches, and
// blocked or broken storage only means the line is made by the voice as before.
import { logEvent } from './util.js';
import { PHRASE_CACHE, phraseKeyText, phraseUrl, keepable, toPcm16, fromPcm16, plausibleSpeech, madeByMatches, toEvict, rePutWanted } from './phrasecore.js';

let off = false; // Cache Storage can't be opened here: nothing is read or kept this session
// Writes and deletes run one at a time, in order (a forget queued after a keep removes it too).
let chain = Promise.resolve();
const queue = (fn) => {
  const run = chain.then(fn).catch(() => null);
  chain = run;
  return run;
};

// No handle is kept between calls (opening one costs ~1 ms): a forget can't leave a stale one behind.
async function open() {
  if (off) return null;
  try {
    return await caches.open(PHRASE_CACHE);
  } catch (err) {
    off = true;
    logEvent('info', 'kept voice lines unavailable', { error: String(err?.message || err) });
    return null;
  }
}

async function urlFor(identity, text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(phraseKeyText(identity, text)));
  return phraseUrl([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''));
}

const headers = (rate) => ({ 'content-type': 'application/octet-stream', 'x-sample-rate': String(rate) });

/** The kept audio of `text` in this voice (an AudioBuffer, timing { cached: true }), or null. */
export async function getPhrase(identity, text) {
  if (!keepable(text)) return null;
  try {
    const cache = await open();
    if (!cache) return null;
    const url = await urlFor(identity, text);
    const res = await cache.match(url);
    if (!res) return null;
    const rate = Number(res.headers.get('x-sample-rate'));
    const bytes = await res.arrayBuffer();
    const samples = bytes.byteLength % 2 ? null : fromPcm16(new Int16Array(bytes));
    if (!samples || !plausibleSpeech({ chars: text.length, samples, rate })) {
      queue(async () => (await open())?.delete(url));
      return null;
    }
    const buf = new AudioBuffer({ numberOfChannels: 1, length: samples.length, sampleRate: rate });
    buf.copyToChannel(samples, 0);
    buf.timing = { cached: true };
    queue(() => keepInUse(url, bytes, rate));
    return buf;
  } catch {
    return null; // a miss: the voice makes the line
  }
}

// Cache Storage lists the oldest first, and eviction drops from there: a line still in use moves back.
async function keepInUse(url, bytes, rate) {
  const cache = await open();
  if (!cache) return;
  const keys = await cache.keys();
  if (rePutWanted(keys.findIndex((r) => r.url === url), keys.length)) await cache.put(url, new Response(bytes, { headers: headers(rate) }));
}

/** Keeps `buf` as the audio of `text` in this voice, if that voice made it and it sounds like speech. */
export function keepPhrase(identity, text, buf) {
  if (!keepable(text) || !buf || typeof buf !== 'object' || !madeByMatches(identity, buf.madeBy)) return;
  queue(async () => {
    const samples = buf.getChannelData(0);
    if (!plausibleSpeech({ chars: text.length, samples, rate: buf.sampleRate })) return;
    const cache = await open();
    if (!cache) return;
    await cache.put(await urlFor(identity, text), new Response(toPcm16(samples).buffer, { headers: headers(buf.sampleRate) }));
    for (const req of toEvict(await cache.keys())) await cache.delete(req);
  });
}

/** Resolves once the writes and deletes asked for so far have landed (tests). */
export const phrasesSettled = () => chain.then(() => {});

/** Every kept line goes (Settings → Voice output). True when there was a line to forget. */
export function forgetPhrases() {
  return queue(async () => {
    if (off) return false;
    try {
      // A lookup opens (and so creates) the cache even when nothing was ever kept in it.
      const had = (await (await caches.open(PHRASE_CACHE)).keys()).length > 0;
      await caches.delete(PHRASE_CACHE);
      return had;
    } catch {
      return false;
    }
  }).then(Boolean);
}
