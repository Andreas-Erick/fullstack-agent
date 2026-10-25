// Internet speed test for the system monitor panel, run only when the user clicks "Measure" (never on
// a timer, never by the agent). It uses Cloudflare's public speed test endpoints: latency from a few
// empty requests, download from parallel streams, upload from parallel posts, each phase time-limited.
// The result stays with the user (the window only), like the rest of the system monitor.
const log = require('./logger');

const BASE = 'https://speed.cloudflare.com';
const PHASE_MS = 8000; // longest a download or upload phase runs
const STREAMS = 4;

/** Megabits per second from bytes over milliseconds (one decimal). */
function mbps(bytes, ms) {
  return ms > 0 ? Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 10) / 10 : 0;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

async function ping(n = 5) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const res = await fetch(`${BASE}/__down?bytes=0`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    await res.arrayBuffer();
    times.push(performance.now() - t);
  }
  return Math.round(median(times.slice(1)) ?? 0); // the first one includes the connection setup
}

// Reads as much as arrives within the phase; streams that finish early count fully.
async function download() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PHASE_MS);
  let bytes = 0;
  const start = performance.now();
  const one = async () => {
    try {
      const res = await fetch(`${BASE}/__down?bytes=50000000`, { cache: 'no-store', signal: ac.signal });
      for await (const chunk of res.body) bytes += chunk.length;
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
  };
  try {
    await Promise.all(Array.from({ length: STREAMS }, one));
  } finally {
    clearTimeout(timer);
  }
  return mbps(bytes, performance.now() - start);
}

// Posts of a fixed size, repeated until the phase is over; only completed posts count.
async function upload() {
  const body = new Uint8Array(4 * 1024 * 1024);
  const until = performance.now() + PHASE_MS;
  let bytes = 0;
  const start = performance.now();
  const one = async () => {
    while (performance.now() < until) {
      const res = await fetch(`${BASE}/__up`, { method: 'POST', body, cache: 'no-store', signal: AbortSignal.timeout(PHASE_MS + 4000) });
      await res.arrayBuffer();
      bytes += body.length;
    }
  };
  await Promise.all(Array.from({ length: STREAMS }, one));
  return mbps(bytes, performance.now() - start);
}

let running = null;
let last = null;

/** Runs the test (one at a time); { pingMs, downMbps, upMbps, at, server } or throws when offline. */
function run() {
  running ||= (async () => {
    try {
      const pingMs = await ping();
      const downMbps = await download();
      const upMbps = await upload();
      last = { pingMs, downMbps, upMbps, at: Date.now(), server: 'speed.cloudflare.com' };
      return last;
    } catch (err) {
      log.warn('speed test failed', { error: err });
      throw new Error(/fetch failed|ENOTFOUND|EAI_AGAIN|timeout/i.test(`${err.message} ${err.cause?.code || ''}`) ? 'No connection to the internet (or the speed test server is unreachable).' : err.message);
    }
  })().finally(() => (running = null));
  return running;
}

module.exports = { mbps, run, last: () => last, running: () => Boolean(running) };
