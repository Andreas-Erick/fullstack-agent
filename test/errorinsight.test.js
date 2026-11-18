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

// Regression: logger.js collapses repeats into a marker line, which was INFO and never counted, so a
// warning repeated 40 times was one occurrence in analyze_errors, Health and problem reports.
test('a repeat marker adds its count to the line it follows', () => {
  const log = [
    '2026-10-24T11:00:00.000Z WARN  (previous line repeated 5 more times)', // nothing above it: ignored
    '2026-10-24T11:01:00.000Z WARN  vault slow {"ms":5200}',
    '2026-10-24T11:01:09.000Z WARN  (previous line repeated 39 more times)',
    '2026-10-24T11:02:00.000Z ERROR turn failed {"error":{"message":"boom"}}',
    '2026-10-24T11:02:01.000Z INFO  (previous line repeated 1 more time)', // an older log's marker: not a count
    '2026-10-24T11:03:00.000Z INFO  heartbeat {"rss":1}',
    '2026-10-24T11:03:00.000Z INFO  (previous line repeated 3 more times)',
  ].join('\n');
  const groups = analyze(log, { now, sinceMs: 24 * 3600000 });
  assert.deepStrictEqual(groups.map((g) => [g.event, g.count]), [['turn failed', 1], ['vault slow', 40]]);
  assert.strictEqual(groups[1].last, '2026-10-24T11:01:09.000Z', 'the last repeat is the last time it happened');
});

test('a window\'s text line with a different id each time is one problem', () => {
  const log = [
    '2026-10-24T11:00:00.000Z ERROR ui: reply failed No conversation found with session ID: 8f96d0f9-ca86-468f-af99-86ce12ab0f16',
    '2026-10-24T11:05:00.000Z ERROR ui: reply failed No conversation found with session ID: 1b2c3d4e-5f60-4a7b-9c8d-e0f1a2b3c4d5',
  ].join('\n');
  const groups = analyze(log, { now, sinceMs: 24 * 3600000 });
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].count, 2);
});

test('a routine waiting for its brain or for the network is a warning, not an error to report', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main', 'main.js'), 'utf8');
  const failed = src.slice(src.indexOf("log.info('turn interrupted'") - 400, src.indexOf("log.info('turn interrupted'") + 500);
  assert.match(failed, /const rc = require\('\.\/routinecore'\);/);
  assert.match(failed, /routine && \(rc\.brainNotReady\(err\) \|\| rc\.offline\(err\)\)/);
  assert.match(failed, /notReady \? 'warn' : 'error'\]\(notReady \? 'turn not ready' : 'turn failed'/);
});
