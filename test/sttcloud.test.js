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
  const sleep = async () => {}; // retries never wait in a test
  for (const [status, re] of [[401, /did not accept the API key/], [429, /limit is used up/], [500, /Groq answered with an error \(500\); details are in the log\./]]) {
    const m = mockFetch(async () => new Response('{"error":"x"}', { status }));
    try {
      await assert.rejects(() => voice.transcribe(new Uint8Array([1]), { retry: { sleep } }), re, String(status));
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

// io-2: one attempt and a 120 s limit; a 503 or a reset threw the recording away.
function recordingSleep() {
  const waits = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
}
// A fetch that answers from a list, one per call (the last one repeats).
function answers(...list) {
  let i = 0;
  return mockFetch(async () => {
    const a = list[Math.min(i++, list.length - 1)];
    if (a instanceof Error) throw a;
    return new Response(a.body ?? '{"text":"hello"}', { status: a.status, headers: a.headers || {} });
  });
}
const reset = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

test('a busy service (503) is tried again and the words arrive', async () => {
  settings = base({ engine: 'groq' });
  const s = recordingSleep();
  const m = answers({ status: 503, body: '{"error":"busy"}' }, { status: 200, body: '{"text":"Hallo Siren"}' });
  try {
    assert.strictEqual(await voice.transcribe(new Uint8Array([1, 2]), { retry: { sleep: s.sleep } }), 'Hallo Siren');
    assert.strictEqual(m.calls.length, 2);
    assert.strictEqual(s.waits.length, 1);
    assert.ok(s.waits[0] >= 500 && s.waits[0] < 750, `waited ${s.waits[0]} ms`);
    assert.notStrictEqual(m.calls[0].init.body, m.calls[1].init.body, 'a fresh body for each attempt');
    assert.strictEqual(m.calls[1].init.body.get('model'), 'whisper-large-v3-turbo');
  } finally {
    m.restore();
  }
});

test('a wrong key, a bad request or the daily cap is never tried again', async () => {
  settings = base({ engine: 'groq' });
  for (const [status, headers, re] of [
    [401, {}, /did not accept the API key/],
    [403, {}, /did not accept the API key/],
    [400, {}, /answered with an error \(400\)/],
    [413, {}, /answered with an error \(413\)/],
    [429, {}, /limit is used up/],
    [429, { 'retry-after': '3600' }, /limit is used up/],
  ]) {
    const s = recordingSleep();
    const m = answers({ status, headers, body: '{"error":"no"}' });
    try {
      await assert.rejects(() => voice.transcribe(new Uint8Array([1]), { retry: { sleep: s.sleep } }), re, `${status} ${JSON.stringify(headers)}`);
      assert.strictEqual(m.calls.length, 1, `${status}: one call`);
      assert.deepStrictEqual(s.waits, []);
    } finally {
      m.restore();
    }
  }
});

test('a 429 with a short retry-after waits exactly that long, then tries again', async () => {
  settings = base({ engine: 'groq' });
  const s = recordingSleep();
  const m = answers({ status: 429, headers: { 'retry-after': '2' } }, { status: 200, body: '{"text":"ok"}' });
  try {
    assert.strictEqual(await voice.transcribe(new Uint8Array([1]), { retry: { sleep: s.sleep } }), 'ok');
    assert.deepStrictEqual(s.waits, [2000]);
  } finally {
    m.restore();
  }
});

test('three failures in a row: three calls, then plain words without the service’s reply in them', async () => {
  settings = base({ engine: 'groq' });
  const s = recordingSleep();
  const m = answers({ status: 500, body: '{"error":{"message":"secret detail"}}' });
  try {
    await assert.rejects(
      () => voice.transcribe(new Uint8Array([1]), { retry: { sleep: s.sleep } }),
      (err) => /Groq answered with an error \(500\); details are in the log\./.test(err.message) && !/secret detail|Transcription error|\{/.test(err.message),
    );
    assert.strictEqual(m.calls.length, 3);
    assert.strictEqual(s.waits.length, 2);
    assert.ok(s.waits[1] >= 1000 && s.waits[1] < 1250, 'twice as long the second time');
  } finally {
    m.restore();
  }
  const m2 = answers({ status: 503, body: '{"error":{"message":"secret detail"}}' });
  try {
    await assert.rejects(() => voice.transcribe(new Uint8Array([1]), { retry: { sleep: async () => {} } }), (err) => !/secret detail|Transcription error/.test(err.message));
  } finally {
    m2.restore();
  }
});

test('a dropped connection is tried again; still down, it says the service couldn’t be reached', async () => {
  settings = base({ engine: 'groq' });
  const s = recordingSleep();
  const m = answers(reset(), { status: 200, body: '{"text":"back"}' });
  try {
    assert.strictEqual(await voice.transcribe(new Uint8Array([1]), { retry: { sleep: s.sleep } }), 'back');
    assert.strictEqual(m.calls.length, 2);
  } finally {
    m.restore();
  }
  const down = answers(reset());
  try {
    await assert.rejects(() => voice.transcribe(new Uint8Array([1]), { retry: { sleep: async () => {} } }), /^Error: Couldn't reach Groq; check the internet connection\.$/);
    assert.strictEqual(down.calls.length, 3);
  } finally {
    down.restore();
  }
  // The custom endpoint is named as such.
  settings = base({ engine: 'remote', remoteUrl: 'https://stt.example.com/v1' });
  const custom = answers(reset());
  try {
    await assert.rejects(() => voice.transcribe(new Uint8Array([1]), { retry: { sleep: async () => {} } }), /Couldn't reach the transcription service/);
  } finally {
    custom.restore();
  }
  const customStatus = answers({ status: 502 });
  try {
    await assert.rejects(() => voice.transcribe(new Uint8Array([1]), { retry: { sleep: async () => {} } }), /^Error: The transcription service answered with an error \(502\)/);
  } finally {
    customStatus.restore();
  }
  // A custom endpoint that isn't running (refused): one call, no waiting.
  const refused = answers(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
  try {
    await assert.rejects(() => voice.transcribe(new Uint8Array([1]), { retry: { sleep: async () => assert.fail('no wait') } }), /Couldn't reach the transcription service/);
    assert.strictEqual(refused.calls.length, 1);
  } finally {
    refused.restore();
  }
  // Something else thrown (not the network) is passed on as it was.
  settings = base({ engine: 'groq' });
  const odd = answers(new RangeError('odd'));
  try {
    await assert.rejects(() => voice.transcribe(new Uint8Array([1]), { retry: { sleep: async () => {} } }), /^RangeError: odd$/);
    assert.strictEqual(odd.calls.length, 1);
  } finally {
    odd.restore();
  }
});

test('no retry that would end past the time budget (the phone waits only so long)', async () => {
  settings = base({ engine: 'groq' });
  let t = 1000000;
  const m = mockFetch(async () => ((t += 50000), new Response('{}', { status: 503 })));
  try {
    await assert.rejects(() => voice.transcribe(new Uint8Array([1]), { retry: { sleep: async () => {}, now: () => t } }), /answered with an error \(503\)/);
    assert.strictEqual(m.calls.length, 1, 'the first call ended 50 s in: no second attempt');
  } finally {
    m.restore();
  }
  // An odd retry option from the window (not functions) is ignored, never a crash.
  const ok = answers({ status: 200, body: '{"text":"fine"}' });
  try {
    assert.strictEqual(await voice.transcribe(new Uint8Array([1]), { retry: null }), 'fine');
    assert.strictEqual(await voice.transcribe(new Uint8Array([1]), { retry: { sleep: 'x', now: 5 } }), 'fine');
  } finally {
    ok.restore();
  }
});

test('which failures are tried again, and how long one attempt and all may take', () => {
  const d = (o) => voice.sttRetryDelay({ attempt: 1, ...o });
  assert.strictEqual(voice.sttRetryDelay({ status: 503, attempt: 3 }), null, 'three attempts at most');
  for (const status of [400, 401, 403, 404, 413, 422]) assert.strictEqual(d({ status }), null, String(status));
  for (const status of [408, 500, 502, 503, 504]) assert.ok(d({ status }) >= 500, String(status));
  assert.strictEqual(d({ status: 429, retryAfter: 9 }), null, 'a long wait is the cap, not a hiccup');
  assert.strictEqual(d({ status: 429, retryAfter: 0 }), null);
  assert.strictEqual(d({ status: 429, retryAfter: 8 }), 8000);
  assert.strictEqual(d({ status: 429, retryAfter: NaN }), null);
  assert.strictEqual(d({ error: 'Error connect ECONNREFUSED 127.0.0.1:3001' }), null, 'nothing listening: not a hiccup');
  assert.strictEqual(d({ error: 'TypeError fetch failed ECONNREFUSED' }), null, 'as Node reports it: fetch failed, refused');
  for (const error of ['TimeoutError The operation was aborted due to timeout', 'TypeError fetch failed ECONNRESET', 'Error getaddrinfo ENOTFOUND api.groq.com', 'EAI_AGAIN', 'ETIMEDOUT']) assert.ok(d({ error }) >= 500, error);
  assert.strictEqual(d({ error: '' }), null);
  const second = voice.sttRetryDelay({ status: 503, attempt: 2 });
  assert.ok(second >= 1000 && second < 1250);
  for (const bytes of [0, undefined, NaN, -5, null, 'x', Infinity * -1]) assert.deepStrictEqual(voice.sttLimits(bytes), { attemptMs: 10000, budgetMs: 55000 }, String(bytes));
  assert.deepStrictEqual(voice.sttLimits(32000), { attemptMs: 10500, budgetMs: 56000 });
  assert.deepStrictEqual(voice.sttLimits(3840000), { attemptMs: 70000, budgetMs: 175000 }, 'two minutes of audio (the phone\'s longest)');
  assert.deepStrictEqual(voice.sttLimits(9600000), { attemptMs: 120000, budgetMs: 355000 }, 'five minutes (the desktop talk key\'s longest): a slow upload has two minutes');
  assert.deepStrictEqual(voice.sttLimits(Number.MAX_SAFE_INTEGER).attemptMs, 120000, 'one attempt never waits more than the two minutes it always had');
});

// The time limit said "Couldn't reach Groq; check the internet connection" for a service that was reached
// but slow; a self-hosted endpoint (Whisper on a processor) got Groq's short attempts.
test('a service that is too slow is named as slow, and a self-hosted one gets the time that is left', async () => {
  const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const limits = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => (limits.push(ms), original.call(AbortSignal, ms));
  try {
    settings = base({ engine: 'groq' });
    const slow = answers(timeout());
    try {
      await assert.rejects(() => voice.transcribe(new Uint8Array(32000), { retry: { sleep: async () => {} } }), /^Error: Groq took too long to answer; try again in a moment\.$/);
      assert.strictEqual(slow.calls.length, 3, 'tried again first');
      assert.deepStrictEqual(limits, [10500, 10500, 10500], 'Groq: the same short attempt each time');
    } finally {
      slow.restore();
    }

    settings = base({ engine: 'remote', remoteUrl: 'http://127.0.0.1:9000/v1' });
    limits.length = 0;
    let t = 1000000;
    const custom = mockFetch(async () => ((t += 1000), new Response('{}', { status: 503 })));
    try {
      await assert.rejects(() => voice.transcribe(new Uint8Array(32000), { retry: { sleep: async () => {}, now: () => t } }), /The transcription service answered with an error \(503\)/);
      assert.strictEqual(limits[0], 56000, 'the first attempt may take the whole budget (56 s for one second of audio)');
      assert.strictEqual(limits[1], 55000, 'the next what is left of it');
      assert.ok(limits.every((ms) => ms >= 10500 && ms <= 120000), limits.join());
    } finally {
      custom.restore();
    }
    limits.length = 0;
    const long = answers({ status: 200, body: '{"text":"a long one"}' });
    try {
      assert.strictEqual(await voice.transcribe(new Uint8Array(3840000), { retry: { sleep: async () => {} } }), 'a long one');
      assert.deepStrictEqual(limits, [120000], 'two minutes of audio: the two minutes it always had');
    } finally {
      long.restore();
    }
    const slowCustom = answers(timeout());
    try {
      await assert.rejects(() => voice.transcribe(new Uint8Array(1), { retry: { sleep: async () => {} } }), /^Error: The transcription service took too long to answer/);
    } finally {
      slowCustom.restore();
    }
  } finally {
    AbortSignal.timeout = original;
  }
});
