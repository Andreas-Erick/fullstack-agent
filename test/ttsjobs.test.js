// The offline voice's sentence jobs (renderer/js/ttsjobs.js, used by renderer/js/voice.js with
// renderer/js/tts-worker.js):
//  - the 30 s limit counts from a sentence's begin, not from when it was queued: a long reply's later
//    sentences, waiting behind the earlier ones, timed out one after another and the voice went silent;
//  - a stop cancels the sentences not begun yet, so the next reply doesn't wait behind the old one's
//    (never the running one, never the phone's WAVs);
//  - while the model still downloads, a sentence gives up after its wait, as before;
//  - a worker that hangs is noticed (what waits behind it would never begin), a slow one is not.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const ESM = tmpDir('nexus-ttsjobs-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
fs.copyFileSync(path.join(ROOT, 'renderer/js/ttsjobs.js'), path.join(ESM, 'ttsjobs.js'));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));
const load = () => import(pathToFileURL(path.join(ESM, 'ttsjobs.js')).href);

test('a long reply queued at once: no sentence times out while it waits its turn', async () => {
  const { createJobs } = await load();
  const jobs = createJobs();
  const N = 14; // the last one finishes ~35 s after it was queued
  for (let id = 1; id <= N; id++) jobs.post(id, { now: 0, waitMs: 180000 });
  const beginAt = (id) => (id - 1) * 2500;
  const doneAt = (id) => beginAt(id) + 2400;
  assert.ok(doneAt(N) > 30000, 'longer than the old limit from the queueing');
  for (let t = 0; t <= doneAt(N) + 1000; t += 100) {
    for (let id = 1; id <= N; id++) {
      if (beginAt(id) === t) jobs.begin(id, t);
      if (doneAt(id) === t) jobs.done(id);
    }
    assert.deepStrictEqual(jobs.expired(t, { loaded: true }), [], `at ${t} ms`);
  }
  assert.strictEqual(jobs.size, 0);
});

test('a sentence that has run for more than 30 s expires', async () => {
  const { createJobs } = await load();
  const jobs = createJobs();
  jobs.post(1, { now: 0 });
  jobs.begin(1, 1000);
  assert.deepStrictEqual(jobs.expired(30000, { loaded: true }), []);
  assert.deepStrictEqual(jobs.expired(32000, { loaded: true }), [1]);
  assert.deepStrictEqual(jobs.expired(32000, { loaded: false }), [1], 'loaded or not');
  jobs.done(1);
  assert.deepStrictEqual(jobs.expired(60000, { loaded: true }), []);
});

test('a worker silent for another limit after a run went over is stalled; a slow one is not', async () => {
  const { createJobs } = await load();
  // Slow: a long sentence on a slow processor takes 40 s, then the next one begins.
  const slow = createJobs();
  slow.post(1, { now: 0 });
  slow.post(2, { now: 0 });
  slow.begin(1, 0);
  assert.deepStrictEqual(slow.expired(31000, { loaded: true }), [1]);
  slow.done(1);
  assert.strictEqual(slow.stalled(40000), false);
  slow.heard(); // its audio came at 40 s, though nobody waited for it any more
  slow.begin(2, 40000);
  assert.strictEqual(slow.stalled(70000), false, 'it reported back');
  assert.deepStrictEqual(slow.expired(69000, { loaded: true }), []);

  // Hung: nothing more after the run went over; the queued sentence would wait forever.
  const hung = createJobs();
  hung.post(1, { now: 0 });
  hung.post(2, { now: 0 });
  hung.begin(1, 0);
  assert.deepStrictEqual(hung.expired(31000, { loaded: true }), [1]);
  hung.done(1);
  assert.strictEqual(hung.stalled(60000), false);
  assert.strictEqual(hung.stalled(62000), true);
  assert.strictEqual(createJobs().stalled(1e9), false, 'nothing ran over');
});

test('a stop cancels only the queued, non-keep sentences up to its id', async () => {
  const { createJobs } = await load();
  const jobs = createJobs();
  for (let id = 1; id <= 5; id++) jobs.post(id, { now: 0, keep: id === 4 });
  jobs.begin(2, 10); // being made: it finishes
  assert.deepStrictEqual(jobs.cancel(4), [1, 3]);
  assert.strictEqual(jobs.size, 3, 'the running one, the phone WAV and the later one stay');
  assert.deepStrictEqual(jobs.cancel(4), [], 'nothing twice');
  assert.deepStrictEqual(jobs.cancel(5), [5]);
  jobs.begin(99, 20); // unknown (already cancelled): ignored
  assert.strictEqual(jobs.size, 2);
});

test('a sentence waiting for the model gives up after its wait, only while it still loads', async () => {
  const { createJobs } = await load();
  const jobs = createJobs();
  jobs.post(1, { now: 0, waitMs: 8000 });
  assert.deepStrictEqual(jobs.expired(7000, { loaded: false }), []);
  assert.deepStrictEqual(jobs.expired(9000, { loaded: false }), [1]);
  assert.deepStrictEqual(jobs.expired(9000, { loaded: true }), [], 'loaded: it waits for its turn');
  jobs.post(2, { now: 0 }); // no wait given: waits as long as it takes
  assert.deepStrictEqual(jobs.expired(1e9, { loaded: false }), [1]);
});

// The worker and the window run in the browser, so their protocol is checked in the source.
test('tts-worker.js: begin, skipped, cancel, the load gate and the skipped warm-up', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/tts-worker.js'), 'utf8');
  assert.match(src, /postMessage\(\{ type: 'begin', id: msg\.id/);
  assert.match(src, /postMessage\(\{ type: 'skipped', id: msg\.id \}\)/);
  assert.match(src, /msg\.type === 'cancel'/);
  assert.doesNotMatch(src, /seenLengths|newLength/);
  const guard = /const (\w+) = waiting > 0;/.exec(src);
  assert.ok(guard, 'the warm-up decision reads the waiting count');
  const readyLine = src.split('\n').find((l) => l.includes("generate(engine, 'Ready.'"));
  assert.ok(readyLine?.includes(`if (!${guard[1]})`), 'the "Ready." warm-up runs only when nothing waits');
  const speak = src.slice(src.indexOf('async function speak('), src.indexOf('self.onmessage'));
  const gate = speak.indexOf('await loadAsked');
  assert.ok(gate >= 0 && gate < speak.indexOf('await load()'), 'a sentence waits for the window\'s load before loading');
  // Found in the real app: back-to-back sentences never let the worker read a 'cancel' in time.
  const yieldAt = speak.indexOf('await nextTask()');
  assert.ok(yieldAt > speak.indexOf('await load()') && yieldAt < speak.indexOf('cancelled(msg)'), 'a task boundary before the cancel check');
  assert.match(src, /const nextTask = \(\) => new Promise\(\(r\) => setTimeout\(r, 0\)\)/);
  assert.match(src, /askLoad\(\);/);
  assert.match(src, /type: 'ready', device, timing/);
});

// Found by timing launches: a sentence posted while the session was being built still sat in the
// worker's message queue when the warm-up was decided (the awaits resume as microtasks), so the
// "Ready." warm-up ran in front of the launch greeting (3 of 3 launches, +1.4–1.6 s).
test('tts-worker.js: one task boundary before the warm-up decision', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/tts-worker.js'), 'utf8');
  const load = src.slice(src.indexOf('function load()'), src.indexOf('async function style('));
  const session = load.lastIndexOf('StyleTextToSpeech2Model.from_pretrained');
  const yieldAt = load.indexOf('await nextTask();', session);
  assert.ok(session > 0 && yieldAt > session, 'after the model session is built');
  assert.ok(yieldAt < load.indexOf('waiting > 0'), 'before the waiting count is read');
});

test('voice.js: a stop cancels the queued sentences; the phone WAVs are kept', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, 'renderer/js', f), 'utf8');
  const speakerSrc = read('speaker.js');
  const stop = speakerSrc.slice(speakerSrc.indexOf('  stop() {'), speakerSrc.indexOf('  get busy()'));
  assert.match(stop, /localVoice\.cancelQueued\(\)/);
  assert.match(read('voice.js'), /offlineVoiceWav[\s\S]{0,200}keep: true/);
  const offline = read('offlinevoice.js');
  assert.match(offline, /createJobs\(\)/);
  for (const src of [offline, speakerSrc, read('voice.js')]) assert.doesNotMatch(src, /setTimeout\([^\n]*the offline voice took too long[^\n]*30000\)/, 'no limit counted from the queueing');
});
