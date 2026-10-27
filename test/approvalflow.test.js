// The permission gate (main/approvals.js) under odd use: answers that come twice, late or never, several
// questions at once, answers to ids that don't exist, "Always allow…" sent with a no, and the window
// missing. Each case must end in a clear yes or no, never hang and never answer the wrong question.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

let settings = { safety: { permissionMode: 'ask', taintGuard: true, approvalTimeoutSec: 1 } };
stub({ './logger': quietLog, './store': { getSettings: async () => settings } });
const approvals = load('main/approvals.js');

const sent = [];
let answer = null; // (payload) => void: how the "window" answers; null = it never does
approvals.setSender((channel, payload) => {
  sent.push({ channel, payload });
  if (channel === 'approval:request' && answer) setImmediate(() => answer(payload));
});

test('a double click answers once; the second answer is refused', async () => {
  let second;
  answer = (p) => {
    assert.strictEqual(approvals.respond(p.id, true), true);
    second = approvals.respond(p.id, false, 'too late');
  };
  const r = await approvals.gate(approvals.newTurn(), 'delete', 'Delete a note');
  assert.strictEqual(r.allow, true);
  assert.strictEqual(second, false, 'the second click finds nothing to answer');
});

test('no answer: a no after the timeout, and the window is told to close the dialog', async () => {
  answer = null;
  sent.length = 0;
  const started = Date.now();
  const r = await approvals.gate(approvals.newTurn(), 'delete', 'Delete a note');
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /No answer within 1 seconds/);
  assert.ok(Date.now() - started >= 900);
  assert.ok(sent.some((s) => s.channel === 'approval:cancel'), 'the dialog closes');
  assert.strictEqual(approvals.respond(sent[0].payload.id, true), false, 'a click after the timeout changes nothing');
});

test('several questions at once each get their own answer', async () => {
  answer = (p) => approvals.respond(p.id, p.title.includes('yes'));
  const turn = approvals.newTurn();
  const rs = await Promise.all(['a yes', 'b no', 'c yes', 'd no'].map((t) => approvals.gate(turn, 'invite', t)));
  assert.deepStrictEqual(rs.map((r) => r.allow), [true, false, true, false]);
});

test('answers to unknown or malformed ids are ignored', () => {
  for (const id of ['', 'nope', null, undefined, 42, {}, '../../etc']) assert.strictEqual(approvals.respond(id, true), false);
});

test('"Always allow…" counts only with a yes, and only as text', async () => {
  answer = (p) => approvals.respond(p.id, false, 'no', 'read');
  const no = await approvals.gate(approvals.newTurn(), 'connector', 'Use X', '', { remember: [{ level: 'read', label: 'x' }] });
  assert.strictEqual(no.allow, false);
  assert.strictEqual(no.remember, undefined, 'a no never carries a level');
  answer = (p) => approvals.respond(p.id, true, '', { level: 'all' });
  const odd = await approvals.gate(approvals.newTurn(), 'connector', 'Use X');
  assert.strictEqual(odd.allow, true);
  assert.strictEqual(odd.remember, undefined, 'an object is not a level');
  answer = (p) => approvals.respond(p.id, true, '', 'write');
  assert.strictEqual((await approvals.gate(approvals.newTurn(), 'connector', 'Use X')).remember, 'write');
});

test('one yes covers a kind for the turn, except the each-time kinds', async () => {
  let asked = 0;
  answer = (p) => (asked++, approvals.respond(p.id, true));
  const turn = approvals.newTurn();
  await approvals.gate(turn, 'delete', 'one');
  await approvals.gate(turn, 'delete', 'two');
  assert.strictEqual(asked, 1);
  await approvals.gate(turn, 'connector', 'one');
  await approvals.gate(turn, 'connector', 'two');
  await approvals.gate(turn, 'connector_trust', 'one');
  await approvals.gate(turn, 'connector_trust', 'two');
  assert.strictEqual(asked, 5, 'connector and connector_trust ask every time');
  await approvals.gate(null, 'delete', 'no turn at all');
  assert.strictEqual(asked, 6, 'a gate without a turn still asks, and does not throw');
});

test('auto mode never skips the always-ask kinds, and a tainted turn asks for a self-change', async () => {
  settings = { safety: { permissionMode: 'auto', taintGuard: true, approvalTimeoutSec: 1 } };
  const asked = [];
  answer = (p) => (asked.push(p.kind), approvals.respond(p.id, true));
  for (const k of approvals.ALWAYS_ASK) await approvals.gate(approvals.newTurn(), k, k);
  assert.deepStrictEqual(asked.sort(), [...approvals.ALWAYS_ASK].sort());
  asked.length = 0;
  await approvals.gate(approvals.newTurn(), 'settings', 'theme');
  assert.deepStrictEqual(asked, []);
  const turn = approvals.newTurn();
  approvals.markTainted(turn, 'a web page');
  answer = (p) => (asked.push(p.tainted), approvals.respond(p.id, true));
  await approvals.gate(turn, 'self_modify', 'edit');
  assert.deepStrictEqual(asked, [true], 'the dialog says the turn read outside content');
  settings = { safety: { permissionMode: 'ask', taintGuard: true, approvalTimeoutSec: 1 } };
});

test('taint keeps only the first few sources, and a missing turn is fine', () => {
  const turn = approvals.newTurn();
  for (let i = 0; i < 50; i++) approvals.markTainted(turn, `src ${i}`);
  assert.strictEqual(turn.taintSources.length, 5);
  assert.doesNotThrow(() => approvals.markTainted(null, 'x'));
});

test('no window open: a clear no at once, not a hang', async () => {
  approvals.setSender(null);
  const r = await approvals.gate(approvals.newTurn(), 'delete', 'x');
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /No app window/);
});
