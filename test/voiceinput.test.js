// The voice-input arbiter (renderer/js/voiceinput.js, fed by renderer/js/voice.js): who holds the
// microphone, one outcome per utterance, and the reply-resumes contract (a barge-in it caused is answered
// once, by words or by 'resume' = barge-in-over). Scripted timelines on a fake clock.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const ESM = tmpDir('nexus-voiceinput-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
for (const f of ['utterance.js', 'voiceinput.js']) fs.copyFileSync(path.join(ROOT, 'renderer/js', f), path.join(ESM, f));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));
const load = () => import(pathToFileURL(path.join(ESM, 'voiceinput.js')).href);

// A fake clock with timers, the flags the arbiter sets, and every event it emits.
async function rig({ talking = false, approval = false } = {}) {
  const { createVoiceInput, NOISE_VOICED_MS } = await load();
  const { HOLD_MS } = await import(pathToFileURL(path.join(ESM, 'utterance.js')).href);
  let t = 1000;
  let timers = [];
  let seq = 0;
  const flags = { recording: false, transcribing: false };
  const events = [];
  const env = { talking, approval };
  const input = createVoiceInput({
    now: () => t,
    setTimer: (fn, ms) => (timers.push({ id: ++seq, at: t + ms, fn }), seq),
    clearTimer: (id) => (timers = timers.filter((x) => x.id !== id)),
    setFlag: (k, v) => (flags[k] = v),
    agentTalking: () => env.talking,
    approvalPending: () => env.approval,
    on: (e) => events.push(e),
  });
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.fn();
    }
    t = end;
  };
  const types = () => events.map((e) => e.type);
  const count = (type) => events.filter((e) => e.type === type).length;
  return { input, flags, events, env, advance, types, count, HOLD_MS, NOISE_VOICED_MS, now: () => t };
}

// A talk-key press that records (mic opens) and is let go; returns the utterance handle.
function talk(r, { ms = 1500 } = {}) {
  const p = r.input.press();
  r.input.micStarted(p.id, r.now());
  r.advance(ms);
  assert.strictEqual(r.input.release(), true);
  return r.input.begin({ fromKey: true });
}

test('a talk-key utterance: barge-in, recording, then exactly one outcome with the key as source', async () => {
  const r = await rig();
  const p = r.input.press();
  assert.deepStrictEqual(r.types(), ['barge-in']);
  const pressedAt = r.now();
  r.input.micStarted(p.id, pressedAt);
  assert.strictEqual(r.flags.recording, true);
  r.advance(1200);
  r.input.release();
  assert.strictEqual(r.flags.recording, false, 'the flag goes as the key is let go');
  const u = r.input.begin({ fromKey: true });
  assert.deepStrictEqual(r.input.info(), { source: 'ptt', startedAt: pressedAt }, 'set before the words are written down');
  u.transcribing();
  assert.strictEqual(r.flags.transcribing, true);
  assert.strictEqual(r.input.busy, true);
  assert.strictEqual(u.heard('hello there'), 'words');
  assert.strictEqual(u.heard('again'), 'words', 'a handle settles once');
  assert.strictEqual(u.failed([1], new Error('x')), 'words');
  assert.deepStrictEqual(r.types(), ['barge-in', 'words']);
  assert.deepStrictEqual(r.events[1], { type: 'words', text: 'hello there', source: 'ptt', startedAt: pressedAt });
  assert.strictEqual(r.flags.transcribing, false);
  assert.strictEqual(r.input.busy, false);
});

test('an empty recording (an accidental press) resumes the reply once', async () => {
  const r = await rig();
  const u = talk(r, { ms: 100 });
  assert.strictEqual(u.empty(), 'nothing');
  assert.deepStrictEqual(r.types(), ['barge-in', 'resume']);
  u.empty();
  assert.strictEqual(r.count('resume'), 1);
});

test('nothing written down ("") resumes the reply', async () => {
  const r = await rig();
  const u = talk(r);
  u.transcribing();
  assert.strictEqual(u.heard(''), 'nothing');
  assert.deepStrictEqual(r.types(), ['barge-in', 'resume']);
});

test('the mic fails on the press: the reply resumes, nothing records', async () => {
  const r = await rig();
  const p = r.input.press();
  r.input.micFailed(p.id);
  assert.deepStrictEqual(r.types(), ['barge-in', 'resume']);
  assert.strictEqual(r.flags.recording, false);
  assert.strictEqual(r.input.release(), false, 'the release that follows has nothing to hand over');
  assert.strictEqual(r.count('resume'), 1);
});

test('let go before the mic started: the start still lands, its recording is handed over, never left recording', async () => {
  const r = await rig();
  const p = r.input.press();
  assert.strictEqual(r.input.release(), true, 'a recording may still come');
  r.input.micStarted(p.id, r.now());
  assert.strictEqual(r.flags.recording, false, 'never shown as recording after the key went up');
  assert.strictEqual(r.input.holds(p.id), false, 'the stuck-key limit has nothing to stop');
  const u = r.input.begin({ fromKey: true });
  assert.strictEqual(u.empty(), 'nothing'); // the recorder returns nothing under 350 ms
  assert.deepStrictEqual(r.types(), ['barge-in', 'resume']);
});

test('a press while a piece is being written down waits; a release meanwhile ends it and the reply waits for that piece', async () => {
  const r = await rig();
  const first = talk(r);
  first.transcribing();
  const p = r.input.press();
  assert.strictEqual(p.wait, true);
  assert.strictEqual(r.input.release(), false, 'released while waiting: nothing to hand over');
  assert.strictEqual(r.input.ready(p.id), false, 'the wait is over: no recording starts');
  assert.strictEqual(r.count('resume'), 0, 'the first piece still decides');
  first.heard('');
  assert.strictEqual(r.count('resume'), 1);
});

test('a press after the wait starts recording; its release does not take over the earlier piece\'s source', async () => {
  const r = await rig();
  // A hands-free piece is being written down.
  const start = r.input.openOnset({ loudMs: 200, voicedMs: 200 });
  assert.deepStrictEqual(start, { source: 'open', startedAt: r.now() - 200 });
  r.advance(1000);
  const piece = r.input.openEnd({ start, voicedMs: 400, ended: 'pause' });
  piece.transcribing();
  const p = r.input.press();
  assert.strictEqual(p.wait, true);
  assert.strictEqual(r.input.ready(p.id), true);
  r.input.micStarted(p.id, r.now());
  r.advance(800);
  r.input.release();
  const key = r.input.begin({ fromKey: true });
  assert.strictEqual(r.input.info().source, 'open', 'a release never takes over a piece still being written down');
  piece.heard('first thing');
  key.heard('second thing');
  assert.deepStrictEqual(r.events.filter((e) => e.type === 'words').map((e) => e.text), ['first thing', 'second thing']);
});

test('the open mic: onset with its start, recording flag, the segment keeps its own start through a talk-key tap', async () => {
  const r = await rig();
  assert.strictEqual(r.input.openOnset({ loudMs: 100, voicedMs: 0 }), null, 'too short to start');
  const start = r.input.openOnset({ loudMs: 140, voicedMs: 0 });
  assert.ok(start);
  assert.strictEqual(r.flags.recording, true);
  assert.deepStrictEqual(r.types(), [], 'no barge-in while the agent is quiet');
  r.advance(500);
  // A tap on the talk key mid-segment: the segment is cut (cutOpen) and written down as a held piece.
  const p = r.input.press();
  assert.strictEqual(p.cutOpen, true);
  assert.strictEqual(p.wait, false, 'the cut piece does not delay the talk key');
  const cut = r.input.openEnd({ start, voicedMs: 300, ended: 'cut' });
  assert.strictEqual(r.input.info(), start, 'the open microphone\'s start, not the key\'s');
  r.input.micStarted(p.id, r.now());
  assert.strictEqual(r.input.openGate().listen, false, 'the open mic is paused while the key holds it');
  r.advance(100);
  r.input.release();
  const tap = r.input.begin({ fromKey: true });
  assert.strictEqual(r.input.info().source, 'open', 'the tap does not take over the cut piece\'s source');
  assert.strictEqual(tap.empty(), 'nothing');
  cut.transcribing();
  assert.strictEqual(cut.heard('I want to'), 'held', 'cut off: waits for its continuation');
  assert.strictEqual(r.count('resume'), 0, 'a held piece keeps the reply silent');
  // The open mic hears the rest: one message.
  r.advance(500);
  const more = r.input.openOnset({ loudMs: 200, voicedMs: 200 });
  assert.strictEqual(more, start, 'a held piece keeps the earlier start');
  r.advance(800);
  const rest = r.input.openEnd({ start: more, voicedMs: 400, ended: 'pause' });
  rest.heard('go home.');
  const out = r.events.filter((e) => e.type === 'words');
  assert.deepStrictEqual(out.map((e) => [e.text, e.source]), [['I want to go home.', 'open']]);
  r.advance(10000);
  assert.strictEqual(r.count('words'), 1, 'the hold timer sends nothing more');
  assert.strictEqual(r.count('resume'), 0);
});

test('talk key pressed while hands-free is mid-segment: the open piece comes first, joined with the key\'s words', async () => {
  const r = await rig();
  const start = r.input.openOnset({ loudMs: 200, voicedMs: 200 });
  r.advance(1500);
  const p = r.input.press();
  assert.ok(p.cutOpen);
  const cut = r.input.openEnd({ start, voicedMs: 900, ended: 'cut' });
  assert.strictEqual(r.flags.recording, false, 'the open segment ended; the key is not recording yet');
  r.input.micStarted(p.id, r.now());
  assert.strictEqual(r.flags.recording, true);
  assert.strictEqual(r.input.openOnset({ loudMs: 500, voicedMs: 500 }), null, 'no second segment while the key holds the mic');
  cut.heard('remind me');
  // The key is held well past the hold time: the piece waits for the key's words.
  r.advance(r.HOLD_MS * 3);
  assert.strictEqual(r.count('words'), 0);
  r.input.release();
  const key = r.input.begin({ fromKey: true });
  r.advance(r.HOLD_MS * 2);
  assert.strictEqual(r.count('words'), 0, 'nor while the key\'s words are being written down');
  key.heard('to call Anna');
  assert.deepStrictEqual(r.events.filter((e) => e.type === 'words').map((e) => e.text), ['remind me to call Anna']);
  r.advance(10000);
  assert.strictEqual(r.count('words'), 1);
});

test('hands-free stopping never clears a talk-key recording (the double-clear bug)', async () => {
  const r = await rig();
  const p = r.input.press();
  r.input.micStarted(p.id, r.now());
  assert.strictEqual(r.flags.recording, true);
  r.input.openStopped();
  assert.strictEqual(r.flags.recording, true, 'the talk key still records');
  // And a hands-free segment that stops does clear it when nothing else records.
  r.advance(500);
  r.input.release();
  r.input.begin({ fromKey: true }).heard('ok');
  r.input.openOnset({ loudMs: 200, voicedMs: 0 });
  assert.strictEqual(r.flags.recording, true);
  r.input.openStopped();
  assert.strictEqual(r.flags.recording, false);
});

test('barge-in over the agent needs voiced speech; an interrupting segment that comes to nothing resumes the reply', async () => {
  const r = await rig({ talking: true });
  assert.deepStrictEqual(r.input.openGate({ headphones: false }), { listen: false, drop: true }, 'the agent speaking without headphones: the mic is ignored');
  assert.strictEqual(r.input.openGate({ headphones: true }).listen, true);
  assert.strictEqual(r.input.openOnset({ loudMs: 600, voicedMs: 100 }), null, 'a breath or cough does not cut the agent off');
  const start = r.input.openOnset({ loudMs: 600, voicedMs: 260 });
  assert.ok(start);
  assert.deepStrictEqual(r.types(), ['barge-in']);
  r.env.talking = false;
  const u = r.input.openEnd({ start, voicedMs: 300, ended: 'pause' });
  u.heard('');
  assert.deepStrictEqual(r.types(), ['barge-in', 'resume']);
});

test('the open mic: noise comes to nothing, never resumes a reply it did not interrupt, and a held piece waits on', async () => {
  const r = await rig();
  const start = r.input.openOnset({ loudMs: 200, voicedMs: 0 });
  assert.strictEqual(r.input.openEnd({ start, voicedMs: r.NOISE_VOICED_MS - 1 }), null);
  assert.strictEqual(r.flags.recording, false);
  assert.deepStrictEqual(r.types(), [], 'nothing interrupted, nothing to resume');
  // A piece that trailed off, then noise: the piece still goes out after its hold.
  const s2 = r.input.openOnset({ loudMs: 200, voicedMs: 200 });
  r.input.openEnd({ start: s2, voicedMs: 400 }).heard('and then the');
  assert.deepStrictEqual(r.events.at(-1), { type: 'held', text: 'and then the' });
  assert.strictEqual(r.input.heldText, 'and then the');
  r.advance(200);
  const s3 = r.input.openOnset({ loudMs: 200, voicedMs: 0 });
  r.input.openEnd({ start: s3, voicedMs: 10 });
  r.advance(r.HOLD_MS + 100);
  const sent = r.events.filter((e) => e.type === 'words');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].text, 'and then the');
  assert.ok(sent[0].heldMs >= r.HOLD_MS, 'the hold is logged');
});

test('the agent starting to speak drops a segment in progress and its recording flag', async () => {
  const r = await rig();
  r.input.openOnset({ loudMs: 200, voicedMs: 0 });
  assert.strictEqual(r.flags.recording, true);
  r.env.talking = true;
  assert.deepStrictEqual(r.input.openGate({ headphones: false }), { listen: false, drop: true });
  assert.strictEqual(r.flags.recording, false);
});

test('the open mic is paused while words are written down, a clip records, or the key holds the mic', async () => {
  const r = await rig();
  assert.strictEqual(r.input.openGate().listen, true);
  r.input.clip(true);
  assert.deepStrictEqual(r.input.openGate(), { listen: false, drop: false });
  r.input.clip(false);
  const u = talk(r);
  assert.strictEqual(r.input.openGate().listen, false, 'writing down');
  u.heard('x');
  assert.strictEqual(r.input.openGate().listen, true);
});

test('transcription failure with a held piece: the recording is kept, the held words still go out, the reply resumes after', async () => {
  const r = await rig({ talking: true });
  const s1 = r.input.openOnset({ loudMs: 300, voicedMs: 300 });
  r.env.talking = false;
  r.input.openEnd({ start: s1, voicedMs: 500, ended: 'limit' }).heard('this is a long one.');
  assert.strictEqual(r.input.heldText, 'this is a long one.', 'cut at the length limit: held');
  r.advance(100);
  const s2 = r.input.openOnset({ loudMs: 200, voicedMs: 200 });
  const u = r.input.openEnd({ start: s2, voicedMs: 400 });
  u.transcribing();
  const samples = new Float32Array(16000);
  assert.strictEqual(u.failed(samples, new Error('GPU reset')), 'failed');
  const f = r.events.find((e) => e.type === 'failed');
  assert.strictEqual(f.kept, true);
  assert.strictEqual(f.error.message, 'GPU reset');
  assert.strictEqual(r.count('resume'), 0, 'the held piece is still on its way');
  assert.strictEqual(r.flags.transcribing, false);
  r.advance(r.HOLD_MS + 100);
  assert.deepStrictEqual(r.events.filter((e) => e.type === 'words').map((e) => e.text), ['this is a long one.']);
  assert.strictEqual(r.input.hasFailed, true);
  const again = r.input.retry();
  assert.strictEqual(again.samples, samples, 'only the latest recording, handed out once');
  assert.strictEqual(r.input.retry(), null);
});

test('a failure without samples keeps nothing; one with samples resumes the reply it interrupted', async () => {
  const r = await rig();
  const u = talk(r);
  u.failed(null, new Error('no audio'));
  assert.strictEqual(r.events.find((e) => e.type === 'failed').kept, false);
  assert.strictEqual(r.input.hasFailed, false);
  assert.deepStrictEqual(r.types(), ['barge-in', 'failed', 'resume']);
});

test('Try again waits while an approval is open, and while another recording is made or written down', async () => {
  const r = await rig();
  const u = talk(r);
  u.transcribing();
  u.failed([0.1, 0.2], new Error('timeout'));
  r.env.approval = true;
  assert.deepStrictEqual(r.input.retry(), { refused: 'approval' });
  r.env.approval = false;
  const p = r.input.press();
  assert.deepStrictEqual(r.input.retry(), { refused: 'busy' }, 'the key is down');
  r.input.micFailed(p.id);
  assert.deepStrictEqual(r.input.retry(), { samples: [0.1, 0.2] });
  // The retry is one piece that keeps the earlier start and source.
  const before = r.input.info();
  const again = r.input.begin();
  assert.strictEqual(r.input.info(), before);
  again.heard('call mum');
  assert.deepStrictEqual(r.events.at(-1), { type: 'words', text: 'call mum', source: 'ptt', startedAt: before.startedAt });
  r.input.forget();
  assert.strictEqual(r.input.retry(), null);
});

test('an approval opening mid-utterance: the words still carry the start from before it appeared', async () => {
  const r = await rig();
  const start = r.input.openOnset({ loudMs: 200, voicedMs: 200 });
  const spokeAt = start.startedAt;
  r.advance(600);
  r.env.approval = true; // the dialog appears while the user is still speaking
  const shownAt = r.now();
  r.advance(600);
  r.input.openEnd({ start, voicedMs: 600 }).heard('yes');
  const w = r.events.at(-1);
  assert.strictEqual(w.text, 'yes');
  assert.ok(w.startedAt < shownAt, 'approval.js treats it as early (approvalAnswer)');
  assert.ok(r.input.info().startedAt === spokeAt && r.input.info().source === 'open');
});

test('the stuck-key limit only stops the press that is recording', async () => {
  const r = await rig();
  const p = r.input.press();
  assert.strictEqual(r.input.holds(p.id), false);
  r.input.micStarted(p.id, r.now());
  assert.strictEqual(r.input.holds(p.id), true);
  r.input.release();
  assert.strictEqual(r.input.holds(p.id), false);
});

test('voice.js feeds the arbiter instead of keeping its own listening state', () => {
  const voice = fs.readFileSync(path.join(ROOT, 'renderer/js/voice.js'), 'utf8');
  assert.match(voice, /export const utteranceInfo = \(\) => input\.info\(\);/);
  assert.match(voice, /agentTalking: \(\) => speaker\.playing,/, 'asks the speaker, not state.playing');
  // Every voice module (voice.js and the parts it was split into) for what must not come back anywhere.
  const src = ['voice.js', 'voicecommon.js', 'offlinevoice.js', 'speaker.js', 'mic.js', 'handsfree.js'].map((f) => fs.readFileSync(path.join(ROOT, 'renderer/js', f), 'utf8')).join('\n');
  for (const gone of [/\blet busy\b/, /\butteranceStart\b/, /\bheldPiece\b/, /\blastFailed\b/, /\bclipActive\b/, /\blet press\b/]) assert.doesNotMatch(src, gone);
  assert.doesNotMatch(src, /setFlag\('(recording|transcribing)'/, 'those flags belong to the arbiter');
  assert.strictEqual(src.split("emit('barge-in-over')").length, 2, 'one place emits barge-in-over: the resume outcome');
});
