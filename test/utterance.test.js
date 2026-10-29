// Spoken messages that are long, get cut off, or interrupt the agent (renderer/js/utterance.js with
// renderer/js/bargein.js):
//  - a long monologue isn't chopped into separate messages at a length limit (it used to be, at 30 s,
//    and the second half then interrupted the reply to the first);
//  - a pause mid-sentence ("I want to go to the… station") waits for the rest instead of sending half;
//  - talking over the agent stops its reply only for real speech, and a reply resumes when the words
//    turn out to be nothing or only an approval answer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const ESM = tmpDir('nexus-utter-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
for (const f of ['utterance.js', 'bargein.js']) fs.copyFileSync(path.join(ROOT, 'renderer/js', f), path.join(ESM, f));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));
const load = (f) => import(pathToFileURL(path.join(ESM, f)).href);

// Feeds a hands-free recording frame by frame (20 ms) until it ends: [{ ms, speech }] runs.
function record(segmentEnd, runs, opts) {
  const seg = { silenceMs: 0, lengthMs: 0 };
  for (const { ms, speech } of runs) {
    for (let t = 0; t < ms; t += 20) {
      seg.lengthMs += 20;
      seg.silenceMs = speech ? 0 : seg.silenceMs + 20;
      const end = segmentEnd(seg, opts);
      if (end) return { end, sec: seg.lengthMs / 1000 };
    }
  }
  return { end: null, sec: seg.lengthMs / 1000 };
}

test('a long spoken prompt is one recording, well past 30 seconds', async () => {
  const { segmentEnd, MAX_UTTERANCE_MS } = await load('utterance.js');
  assert.ok(MAX_UTTERANCE_MS >= 120000, 'two minutes at least');
  // 90 s of talking with short breaths between sentences: still going.
  const runs = Array.from({ length: 30 }, () => [{ ms: 2700, speech: true }, { ms: 300, speech: false }]).flat();
  assert.strictEqual(record(segmentEnd, runs, { endMs: 600 }).end, null);
  // Then a real pause ends it.
  assert.strictEqual(record(segmentEnd, [...runs, { ms: 700, speech: false }], { endMs: 600 }).end, 'pause');
  // A mic that never goes quiet stops at the limit.
  assert.deepStrictEqual(record(segmentEnd, [{ ms: MAX_UTTERANCE_MS + 1000, speech: true }], { endMs: 600 }), { end: 'limit', sec: MAX_UTTERANCE_MS / 1000 + 0.02 });
});

test('the end-of-speech pause stays within reason', async () => {
  const { endSilence } = await load('utterance.js');
  assert.deepStrictEqual([endSilence(undefined), endSilence(50), endSilence(900), endSilence(9000)], [600, 300, 900, 2000]);
});

test('pieces of one message are joined: the length limit, or a sentence that trails off', async () => {
  const { createJoiner, looksUnfinished, HOLD_MS } = await load('utterance.js');
  const j = createJoiner();
  assert.strictEqual(j.add('Tell me about the history of Rome, especially', { limit: true, now: 0 }), null, 'held at the limit');
  assert.strictEqual(j.add('the late republic.', { now: 1000 }), 'Tell me about the history of Rome, especially the late republic.');
  assert.strictEqual(j.pending, '');
  // Cut off mid-sentence by a pause: Whisper's full stop on the first half goes.
  assert.strictEqual(j.add('I need to get to the.', { now: 5000 }), null);
  assert.strictEqual(j.add('Train station by six.', { now: 6000 }), 'I need to get to the Train station by six.');
  // A complete sentence goes at once, as before.
  assert.strictEqual(j.add('What time is it?', { now: 9000 }), 'What time is it?');
  // At the limit after a complete sentence, its full stop stays.
  j.add('That is the first part.', { limit: true, now: 10000 });
  assert.strictEqual(j.add('Here is the second.', { now: 11000 }), 'That is the first part. Here is the second.');
  for (const t of ['and', 'Book a table for', 'so, um', 'I was thinking that…', 'The meeting is on…', 'because.']) assert.ok(looksUnfinished(t), t);
  for (const t of ['Thanks.', 'What is the weather like?', 'Send it to Anna', 'Yes', '']) assert.ok(!looksUnfinished(t), t);
});

test('the user gets cut off and says nothing more: what was heard still goes, after a moment', async () => {
  const { createJoiner, HOLD_MS } = await load('utterance.js');
  const j = createJoiner();
  j.add('Remind me tomorrow to call my', { now: 0 });
  assert.strictEqual(j.due(HOLD_MS - 1), null, 'still waiting');
  assert.strictEqual(j.due(HOLD_MS), 'Remind me tomorrow to call my');
  assert.strictEqual(j.due(HOLD_MS * 3), null, 'sent once');
  // Speaking again restarts the wait, so a slow speaker isn't sent half way.
  j.add('Move the meeting to', { now: 10000 });
  j.hold(12000);
  assert.strictEqual(j.due(10000 + HOLD_MS), null);
  assert.strictEqual(j.add('Thursday.', { now: 13000 }), 'Move the meeting to Thursday.');
  assert.strictEqual(j.add('   ', { now: 14000 }), null, 'an empty transcript sends nothing');
});

test('interrupting the agent while it speaks: real speech stops the reply, a cough does not', async () => {
  const { onset } = await load('utterance.js');
  const { bargeIn, bargeInOver } = await load('bargein.js');
  assert.strictEqual(onset({ agentTalking: false, loudMs: 140 }), true, 'starting to talk to a quiet agent');
  assert.strictEqual(onset({ agentTalking: false, loudMs: 100 }), false, 'a click');
  assert.strictEqual(onset({ agentTalking: true, loudMs: 400, voicedMs: 120 }), false, 'a cough over the agent');
  assert.strictEqual(onset({ agentTalking: true, loudMs: 400, voicedMs: 260 }), true, 'a word over the agent');

  const reply = { muted: false };
  bargeIn(reply);
  assert.strictEqual(reply.muted, true, 'the rest of the reply is not spoken');
  bargeInOver(reply);
  assert.strictEqual(reply.muted, false, 'nothing was said after all: it speaks again');
  bargeIn(reply, { approvalPending: true });
  assert.strictEqual(reply.muted, false, 'answering an approval does not silence the reply');
  bargeIn(null);
  bargeInOver(null); // no reply streaming: nothing to do, no error
});

test('the phone records as long as the computer accepts, and as long as the desktop listens', async () => {
  const { MAX_UTTERANCE_MS } = await load('utterance.js');
  const client = Number(/const MAX_REC_MS = (\d+);/.exec(fs.readFileSync(path.join(ROOT, 'renderer/remote/app.js'), 'utf8'))[1]);
  const server = Number(/const MAX_AUDIO_SEC = (\d+);/.exec(fs.readFileSync(path.join(ROOT, 'main/companion.js'), 'utf8'))[1]);
  assert.strictEqual(client, server * 1000);
  assert.strictEqual(client, MAX_UTTERANCE_MS);
});
