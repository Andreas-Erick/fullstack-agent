// Error grouping (main/errorinsight.js): the same problem with different numbers is one group, with
// code locations from the stack and example turn ids.
const test = require('node:test');
const assert = require('node:assert');
const { analyze } = require('../main/errorinsight');

const now = Date.parse('2026-10-24T12:00:00Z');
const LOG = [
  '2026-10-24T11:00:00.000Z INFO  turn {"provider":"anthropic"}',
  '2026-10-24T11:01:00.000Z WARN  ipc failed {"channel":"tts:speak","error":{"message":"VoiceStudio error 429: 3 running, 4 queued","stack":"speak main/voice.js:32:11 | main/main.js:212:5"}}',
  '2026-10-24T11:02:00.000Z WARN  ipc failed {"channel":"tts:speak","error":{"message":"VoiceStudio error 429: 4 running, 4 queued","stack":"speak main/voice.js:32:11"}}',
  '2026-10-24T11:03:00.000Z ERROR [turn=ab12cd conv=x1] turn failed {"error":{"message":"Cannot read properties of undefined (reading \'id\')","stack":"runTurn main/llm.js:240:9"}}',
  '2026-10-24T11:04:00.000Z WARN  ui: reply failed app://bundle/renderer/js/chat.js:88:3',
  '2026-10-20T11:00:00.000Z ERROR old failure {"error":{"message":"long ago"}}',
].join('\n');

test('groups repeats, errors first, with locations and turns', () => {
  const groups = analyze(LOG, { now, sinceMs: 24 * 3600000 });
  assert.strictEqual(groups.length, 3, JSON.stringify(groups, null, 1));
  const [first, ...rest] = groups;
  assert.strictEqual(first.level, 'error');
  assert.deepStrictEqual(first.turns, ['ab12cd']);
  assert.deepStrictEqual(first.locations, ['main/llm.js:240']);
  const tts = rest.find((g) => g.where === 'tts:speak');
  assert.strictEqual(tts.count, 2, 'numbers in the message must not split the group');
  assert.deepStrictEqual(tts.locations, ['main/voice.js:32', 'main/main.js:212']);
  assert.deepStrictEqual(rest.find((g) => g.event.startsWith('ui:')).locations, ['renderer/js/chat.js:88']);
});

test('respects the time window', () => {
  assert.strictEqual(analyze(LOG, { now, sinceMs: 10 * 24 * 3600000 }).length, 4);
  assert.strictEqual(analyze(LOG, { now, sinceMs: 60000 }).length, 0);
});
