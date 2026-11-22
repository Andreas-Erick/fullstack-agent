// The model host (renderer/js/modelhost.js), shared by voice.js's offline voice, voice detector and
// speech-to-text: one load at a time and shared, the idle unload only where the profile asks for it
// (and never while in use), the restart of a worker that hangs (logged), a failure's cool-down, and an
// unload while the model still loads. Plus the chat's reply-speech decision (speechplan.js
// createReplySpeech): spoken only while replies are spoken and the user didn't talk over this one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const ESM = tmpDir('nexus-modelhost-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
for (const f of ['modelhost.js', 'speechplan.js', 'mathtext.js']) fs.copyFileSync(path.join(ROOT, 'renderer/js', f), path.join(ESM, f));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));
const load = () => import(pathToFileURL(path.join(ESM, 'modelhost.js')).href);
const plan = () => import(pathToFileURL(path.join(ESM, 'speechplan.js')).href);

// A clock whose timers run only when advanced.
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => (timers.set(++seq, { fn, at: now + ms }), seq),
    clearTimeout: (id) => timers.delete(id),
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = until;
    },
    get pending() {
      return timers.size;
    },
  };
}

function fakeWorkers() {
  const made = [];
  const create = () => {
    const w = { posted: [], terminated: false, postMessage: (m) => w.posted.push(m), terminate: () => (w.terminated = true) };
    made.push(w);
    return w;
  };
  return { made, create };
}

async function setup(opts = {}) {
  const { createModelHost } = await load();
  const clock = fakeClock();
  const workers = fakeWorkers();
  const logs = [];
  const stops = [];
  const messages = [];
  let prof = opts.profile || 'balanced';
  const host = createModelHost({
    name: 'test model',
    create: workers.create,
    configure: (w, key) => w.postMessage({ type: 'load', key }),
    onMessage: (msg) => messages.push(msg),
    onStop: (reason, kind) => stops.push({ reason, kind }),
    idleMs: (p) => (p === 'balanced' ? 5000 : 0),
    profile: () => prof,
    idleLog: 'unloaded after idle',
    idleReason: 'idle reason',
    clock,
    log: (level, event, data) => logs.push({ level, event, data }),
    ...opts.host,
  });
  return { host, clock, workers, logs, stops, messages, setProfile: (p) => (prof = p) };
}

test('loads once: a second load while loading or loaded shares the same worker and promise', async () => {
  const { host, workers } = await setup();
  const a = host.load();
  const b = host.load();
  assert.strictEqual(a, b, 'concurrent loads await the same load');
  assert.strictEqual(workers.made.length, 1);
  assert.deepStrictEqual(workers.made[0].posted, [{ type: 'load', key: '' }], 'configured at once without a gate');
  assert.strictEqual(host.loaded, false);
  host.ready();
  await a;
  assert.strictEqual(host.loaded, true);
  assert.strictEqual(host.load(), a, 'loaded: the same promise, no new worker');
  assert.strictEqual(workers.made.length, 1);
});

test('messages reach the adapter only from the current worker', async () => {
  const { host, workers, messages } = await setup();
  host.load();
  const first = workers.made[0];
  first.onmessage({ data: { type: 'progress' } });
  host.unload('gone');
  first.onmessage({ data: { type: 'late' } });
  assert.deepStrictEqual(messages, [{ type: 'progress' }]);
});

test('a gate holds the load message until it resolves, and a worker gone meanwhile is never configured', async () => {
  let open;
  const gate = new Promise((r) => (open = r));
  const { host, workers } = await setup({ host: { gate: () => gate } });
  host.load();
  assert.deepStrictEqual(workers.made[0].posted, []);
  open();
  await gate;
  await null;
  assert.deepStrictEqual(workers.made[0].posted, [{ type: 'load', key: '' }]);
  // Unloaded before the gate opens: the old worker gets nothing.
  let open2;
  const gate2 = new Promise((r) => (open2 = r));
  const s = await setup({ host: { gate: () => gate2 } });
  s.host.load();
  s.host.unload('asked');
  open2();
  await gate2;
  await null;
  assert.deepStrictEqual(s.workers.made[0].posted, []);
});

test('another key: the old worker goes with the switch reason, a new one loads', async () => {
  const { host, workers, stops } = await setup({ host: { switchReason: 'switched model' } });
  host.load('a');
  host.load('a');
  assert.strictEqual(workers.made.length, 1);
  host.load('b');
  assert.strictEqual(workers.made.length, 2);
  assert.strictEqual(workers.made[0].terminated, true);
  assert.deepStrictEqual(stops, [{ reason: 'switched model', kind: 'switched' }]);
  assert.strictEqual(host.key, 'b');
  assert.deepStrictEqual(workers.made[1].posted, [{ type: 'load', key: 'b' }]);
});

test('idle unload: only on Balanced, only after the idle time, logged, with the idle reason', async () => {
  const { host, clock, workers, stops, logs, setProfile } = await setup();
  host.load();
  host.ready();
  host.idle();
  clock.advance(4999);
  assert.strictEqual(host.worker, workers.made[0], 'still loaded before the idle time');
  clock.advance(1);
  assert.strictEqual(host.worker, null);
  assert.strictEqual(workers.made[0].terminated, true);
  assert.deepStrictEqual(stops, [{ reason: 'idle reason', kind: 'idle' }]);
  assert.deepStrictEqual(logs, [{ level: 'info', event: 'unloaded after idle', data: undefined }]);
  // Full: idle() sets no clock at all.
  setProfile('full');
  host.load();
  host.idle();
  assert.strictEqual(clock.pending, 0);
  clock.advance(60 * 60000);
  assert.ok(host.worker, 'kept on Full');
});

test('idle() again restarts the clock; use() cancels the pending unload until idle() is called again', async () => {
  const { host, clock } = await setup();
  host.load();
  host.idle();
  clock.advance(4000);
  host.idle();
  clock.advance(4000);
  assert.ok(host.worker, 'the clock restarted');
  host.use();
  clock.advance(60000);
  assert.ok(host.worker, 'in use: never unloaded for idleness');
  host.idle();
  clock.advance(5000);
  assert.strictEqual(host.worker, null);
});

test('an idle clock left from an earlier worker never unloads the next one', async () => {
  const { host, clock, workers } = await setup();
  host.load();
  host.idle();
  host.unload('asked');
  host.load();
  clock.advance(10000);
  assert.strictEqual(host.worker, workers.made[1]);
});

test('stuck: restart logs the warning, unloads, and the next load starts afresh', async () => {
  const { host, workers, logs, stops } = await setup();
  host.load();
  host.ready();
  assert.strictEqual(host.restart('stopped responding', { warn: 'model stopped responding; restarting it', data: { waiting: 2 } }), true);
  assert.deepStrictEqual(logs, [{ level: 'warn', event: 'model stopped responding; restarting it', data: { waiting: 2 } }]);
  assert.deepStrictEqual(stops, [{ reason: 'stopped responding', kind: 'stuck' }]);
  assert.strictEqual(host.worker, null);
  host.load();
  assert.strictEqual(workers.made.length, 2);
});

test('a deadline restarts its own worker unless cancelled in time', async () => {
  const { host, clock, logs } = await setup();
  host.load();
  const cancel = host.deadline(3000, { warn: 'timed out; restarting it', reason: 'took too long' });
  clock.advance(2000);
  cancel();
  clock.advance(5000);
  assert.ok(host.worker, 'answered in time');
  host.deadline(3000, { warn: 'timed out; restarting it', reason: 'took too long' });
  clock.advance(3000);
  assert.strictEqual(host.worker, null);
  assert.strictEqual(logs[0].event, 'timed out; restarting it');
  // A deadline for a worker that went meanwhile does nothing to the next one.
  host.load();
  host.deadline(3000, { reason: 'x' });
  host.unload('asked');
  host.load();
  clock.advance(3000);
  assert.ok(host.worker);
  assert.strictEqual(host.deadline(0, {})(), undefined, 'no limit: nothing set');
});

test('unload while loading: the load rejects with the reason; unload without a worker does nothing', async () => {
  const { host, workers, stops } = await setup();
  const p = host.load();
  assert.strictEqual(host.unload('freed to save memory'), true);
  await assert.rejects(p, /freed to save memory/);
  assert.strictEqual(workers.made[0].terminated, true);
  assert.strictEqual(host.loaded, false);
  assert.strictEqual(host.unload('again'), false);
  assert.strictEqual(stops.length, 1);
});

test('a failure: the load rejects; with a cool-down load() returns the failure until it passes', async () => {
  const { host, clock, workers, stops } = await setup({ host: { retryAfterMs: 60000 } });
  const p = host.load();
  workers.made[0].onerror({ message: 'model download failed' });
  await assert.rejects(p, /model download failed/);
  assert.deepStrictEqual(stops, [{ reason: 'model download failed', kind: 'failed' }]);
  const during = host.load();
  await assert.rejects(during, /model download failed/);
  assert.strictEqual(workers.made.length, 1, 'no new worker during the cool-down');
  assert.strictEqual(host.cooling, true);
  clock.advance(60000);
  host.load();
  assert.strictEqual(workers.made.length, 2, 'retried after the cool-down');
  // No cool-down: the next load starts a new worker at once; an event without a message uses failText.
  const s = await setup({ host: { failText: 'worker failed' } });
  const q = s.host.load();
  s.workers.made[0].onerror({});
  await assert.rejects(q, /worker failed/);
  s.host.load();
  assert.strictEqual(s.workers.made.length, 2);
});

// ------------------------------------------------------------------ the chat's reply speech
function fakeSpeaker() {
  const calls = [];
  return {
    calls,
    capped: undefined,
    busy: false,
    feed: (t) => calls.push(['feed', t]),
    flush: () => calls.push(['flush']),
    filler: (t) => (calls.push(['filler', t]), true),
    follow: (t, o) => calls.push(['follow', t, o]),
    warmFillers: (lines, idle) => calls.push(['warm', lines, typeof idle]),
    stop: () => calls.push(['stop']),
    say: (t, o) => calls.push(['say', t, o]),
  };
}

test('reply speech: spoken only while replies are spoken and the turn is not muted', async () => {
  const { createReplySpeech } = await plan();
  const speaker = fakeSpeaker();
  let active = true;
  let fillers = true;
  const rs = createReplySpeech({ speaker, active: () => active, fillersOn: () => fillers, fillerLines: () => ['a', 'b'] });
  const turn = { muted: false };
  assert.strictEqual(rs.spoken(turn), true);
  assert.strictEqual(rs.feed(turn, 'Hello > there', (d) => d.toUpperCase()), true);
  assert.deepStrictEqual(speaker.calls.pop(), ['feed', 'HELLO > THERE'], 'through the filter');
  turn.muted = true; // talked over (turnstate bargeIn)
  assert.strictEqual(rs.spoken(turn), false);
  assert.strictEqual(rs.feed(turn, 'x'), false);
  rs.flush(turn);
  assert.strictEqual(rs.filler(turn, 'One moment.'), false);
  assert.deepStrictEqual(speaker.calls, [], 'a muted reply is not spoken, gets no filler and no flush');
  turn.muted = false;
  active = false; // voice or auto-speak off
  assert.strictEqual(rs.feed(turn, 'x'), false);
  rs.flush(turn);
  rs.follow('Hi');
  rs.warm(() => true);
  assert.strictEqual(rs.active(), false);
  assert.deepStrictEqual(speaker.calls, []);
  active = true;
  rs.flush(turn);
  rs.follow('Hi, I am new.');
  assert.deepStrictEqual(speaker.calls.splice(0), [['flush'], ['follow', 'Hi, I am new.', { remember: true, firstAlone: true }]]);
  // Fillers: only when wanted, never an empty line.
  assert.strictEqual(rs.filler(turn, null), false);
  assert.strictEqual(rs.filler(turn, 'Let me look.'), true);
  fillers = false;
  assert.strictEqual(rs.fillers(), false);
  assert.strictEqual(rs.filler(turn, 'Let me look.'), false);
  rs.warm(() => true);
  fillers = true;
  rs.warm(() => true);
  assert.deepStrictEqual(speaker.calls.splice(0), [['filler', 'Let me look.'], ['warm', ['a', 'b'], 'function']]);
  // The card reads the cap; stop and say pass through.
  assert.strictEqual(rs.capped, false);
  speaker.capped = true;
  assert.strictEqual(rs.capped, true);
  rs.stop();
  rs.say('Sample', { voice: 'v' });
  assert.deepStrictEqual(speaker.calls, [['stop'], ['say', 'Sample', { voice: 'v' }]]);
});

// voice.js needs the window, so its wiring onto the host is checked in its source.
test('voice.js: the offline voice, the voice detector and speech-to-text run on the model host', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/voice.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /import \{ createModelHost \} from '\.\/modelhost\.js';/);
  assert.strictEqual(src.split('createModelHost({').length, 4, 'three hosts');
  assert.strictEqual(src.split('new Worker(').length, 4, 'each worker made by its host only');
  for (const gone of [/resetWorker/, /scheduleUnload/, /unloadTimer/, /workerReady/, /this\.idle = setTimeout/]) assert.doesNotMatch(src, gone);
  // The offline voice: loads after the hardware check, Balanced's idle time, a minute's cool-down, the hang's log line.
  assert.match(src, /gate: \(\) => perfReady,/);
  assert.match(src, /idleMs: \(p\) => \(p === 'balanced' \? BALANCED\.voiceIdleMin \* 60000 : 0\),/);
  assert.match(src, /retryAfterMs: 60000,/);
  assert.match(src, /this\.host\.restart\('the offline voice stopped responding', \{ warn: 'offline voice stopped responding; restarting it', data: \{ waiting: this\.pending\.size \} \}\)/);
  // The voice detector: NEURAL_IDLE_MS after hands-free stops, on any profile; a start cancels it.
  assert.match(src, /const NEURAL_IDLE_MS = 60000;/);
  assert.match(src, /idleMs: \(\) => NEURAL_IDLE_MS,/);
  assert.match(src, /start\(\) \{\s*\n\s*this\.host\.use\(\);[^\n]*\n\s*this\.host\.load\(\);/);
  assert.match(src, /neural\.stopSoon\(\);/);
  // Speech-to-text: Balanced's idle time after each sentence, the timeout's restart, a failed run's reload.
  assert.match(src, /idleMs: \(p\) => \(p === 'balanced' \? BALANCED\.speechIdleMin \* 60000 : 0\),/);
  assert.match(src, /idleLog: 'speech model unloaded after idle',/);
  assert.match(src, /stt\.deadline\(limitMs, \{ warn: 'speech-to-text timed out; restarting it', reason: 'Speech-to-text took too long and was restarted' \}\)/);
  assert.match(src, /stt\.restart\('Speech-to-text was restarted', \{ warn: 'speech-to-text failed; reloading the model', data: msg\.error \}\)/);
  assert.match(src, /export const replySpeech = createReplySpeech\(\{ speaker, active: ttsActive,/);
});

test('chat.js speaks through replySpeech only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/chat.js'), 'utf8');
  assert.match(src, /import \{ replySpeech \} from '\.\/voice\.js';/);
  assert.doesNotMatch(src, /\bspeaker\./, 'no Speaker internals');
  assert.doesNotMatch(src, /ttsActive/, 'one spoken rule, in replySpeech');
  assert.doesNotMatch(src, /\.muted\) speaker|!t\.muted/, 'the muted check lives in replySpeech');
});
