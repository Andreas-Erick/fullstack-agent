// Claude Code sessions (main/claudecode.js): stopping a reply keeps the process warm (the CLI's interrupt
// request), its late end never ends the next turn, and a restart says what changed.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

stub({
  './store': { getSettings: async () => ({}) },
  './bridge': {},
  './github': {},
  './logger': quietLog,
  './approvals': { gate: async () => ({ allow: true }), markTainted: () => {} },
});
const claudecode = load('main/claudecode.js');

function session() {
  const sess = new claudecode.Session('c1');
  const writes = [];
  sess.child = { exitCode: null, stdin: { write: (s) => writes.push(JSON.parse(s)) }, once() {}, pid: 1 };
  sess.dead = false;
  sess.spec = { idleMinutes: 20 };
  return { sess, writes };
}
const result = (text) => JSON.stringify({ type: 'result', subtype: 'success', result: text, session_id: 's1' });

test('stopping a reply interrupts the turn without killing the process', async () => {
  const { sess, writes } = session();
  const ac = new AbortController();
  const first = sess.send('long story', { emit() {}, signal: ac.signal, ctx: {} });
  ac.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.deepStrictEqual(writes.map((w) => w.type), ['user', 'control_request']);
  assert.strictEqual(writes[1].request.subtype, 'interrupt');
  assert.ok(sess.alive(), 'the process keeps running');
  assert.ok(sess.interrupting, 'the next turn waits for the interrupted one to end');

  // The interrupted turn's end arrives; it is swallowed, and the next turn gets its own answer.
  sess.onLine(result(''));
  await sess.interrupting;
  assert.strictEqual(sess.interrupting, null);
  const second = sess.send('hi', { emit() {}, signal: new AbortController().signal, ctx: {} });
  sess.onLine(result('second'));
  assert.strictEqual((await second).text, 'second');
  clearTimeout(sess.idleTimer);
});

test('an interrupt that is never confirmed releases the next turn when the process ends', async () => {
  const { sess } = session();
  const ac = new AbortController();
  const p = sess.send('x', { emit() {}, signal: ac.signal, ctx: {} });
  ac.abort();
  await assert.rejects(p);
  const waiting = sess.interrupting;
  sess.onExit(1);
  await waiting; // resolved, not hanging
  clearTimeout(sess.idleTimer);
});

test('a session restart names what changed', () => {
  const before = { config: 'a', tools: ['x', 'y'], effort: 'default' };
  assert.strictEqual(claudecode.changedParts(before, { config: 'a', tools: ['x', 'z'], effort: 'high' }), 'tools +z -y; effort');
  assert.strictEqual(claudecode.changedParts(before, before), '');
});
