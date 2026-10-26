// The permission gate (main/approvals.js): in auto mode ordinary actions pass silently, but a
// self-change always asks (audit #12), as do commands and what reaches other people or services.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

let mode = 'auto';
stub({ './logger': quietLog, './store': { getSettings: async () => ({ safety: { permissionMode: mode, taintGuard: true, approvalTimeoutSec: 5 } }) } });
const approvals = load('main/approvals.js');

// The "window": records what was asked and answers yes.
const asked = [];
approvals.setSender((channel, payload) => {
  if (channel !== 'approval:request') return;
  asked.push(payload.kind);
  setImmediate(() => approvals.respond(payload.id, true));
});

test('auto mode: settings changes pass without asking', async () => {
  asked.length = 0;
  const r = await approvals.gate(approvals.newTurn(), 'settings', 'Change the theme');
  assert.strictEqual(r.allow, true);
  assert.deepStrictEqual(asked, []);
});

test('auto mode: a self-change asks, even in a clean turn', async () => {
  asked.length = 0;
  const turn = approvals.newTurn();
  assert.strictEqual((await approvals.gate(turn, 'self_modify', 'Edit main/llm.js')).allow, true);
  assert.deepStrictEqual(asked, ['self_modify']);
  // One yes covers the rest of that change in the same turn.
  await approvals.gate(turn, 'self_modify', 'Edit main/prompt.js');
  assert.deepStrictEqual(asked, ['self_modify']);
});

test('self-changes are in the always-ask set', () => {
  assert.ok(approvals.ALWAYS_ASK.has('self_modify'));
  assert.ok(approvals.ALWAYS_ASK.has('command'));
});
