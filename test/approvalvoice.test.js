// Answering approvals by voice: every request carries `tainted` and its voice policy (any | key | click), and
// the window's answer rules (commandcore.js approvalAnswer/approvalHint) read each one; a spoken "no, …" goes
// back to the model as the reason while its words stay out of the log (approvals.reasonForLog/declineForLog).
const test = require('node:test');
const assert = require('node:assert');
const fx = require('./appfixture')('approvalvoice');
const { store, approvals, read, esm, decide, allTools } = fx;
const { quietLog } = require('./helpers');

test('every request carries tainted and voice, and the window’s answer rules read each voice policy', async (t) => {
  t.after(() => store.setSettings({ safety: { permissionMode: 'ask', taintGuard: true } }));
  const cc = await esm('renderer/js/commandcore.js');
  const cases = [
    { kind: 'calendar', tainted: false, voice: 'any' },
    { kind: 'github_publish', tainted: false, voice: 'key' },
    { kind: 'command', tainted: true, voice: 'click' },
    { kind: 'self_modify', tainted: true, voice: 'click' },
    { kind: 'endpoint', tainted: true, voice: 'key' },
  ];
  for (const c of cases) {
    const { payload } = await decide(c.kind, { mode: 'ask', tainted: c.tainted });
    assert.strictEqual(payload.tainted, c.tainted, c.kind);
    assert.strictEqual(payload.voice, c.voice, c.kind);
    const shownAt = 100;
    const openMic = cc.approvalAnswer('yes', { voice: payload.voice, source: 'open', startedAt: 200, shownAt });
    const key = cc.approvalAnswer('yes', { voice: payload.voice, source: 'ptt', startedAt: 200, shownAt });
    assert.strictEqual(openMic, { any: 'yes', key: 'needs-key', click: 'needs-click' }[c.voice], `${c.kind}: an open-microphone yes`);
    assert.strictEqual(key, { any: 'yes', key: 'yes', click: 'needs-click' }[c.voice], `${c.kind}: a yes through the talk key`);
    assert.strictEqual(cc.approvalAnswer('yes', { voice: payload.voice, source: 'ptt', startedAt: 50, shownAt }), 'early', `${c.kind}: speech that began before the dialog`);
    const hint = cc.approvalHint(payload, { pttKey: 'F9', handsFree: true });
    if (c.voice === 'click') assert.match(hint, /^Click Approve or Deny/);
    else assert.match(hint, c.voice === 'key' ? /^Hold F9 and say “yes”/ : /^Say “yes”/);
  }
});

// Spoken answers (approval.js: a sentence other than yes declines and goes back as the reason) and the rule
// for the log: transcripts' words only with Detailed logging on (the 'heard' line has lengths).
test('a spoken “no, …” reaches the model as the reason, but its words stay out of the log', async (t) => {
  const said = 'no wait, my bank PIN is 4417, do not put that in the calendar';
  const lines = [];
  const saved = { info: quietLog.info, warn: quietLog.warn, error: quietLog.error };
  for (const level of ['info', 'warn', 'error']) quietLog[level] = (event, data) => lines.push({ level, event, data });
  t.after(() => Object.assign(quietLog, saved));
  approvals.setSender((channel, p) => channel === 'approval:request' && setImmediate(() => approvals.respond(p.id, false, said))); // approval.js answer(false, text) → approval:respond
  const r = await approvals.gate(approvals.newTurn(), 'calendar', 'Add “Dentist” on Friday', '');
  assert.deepStrictEqual(r, { allow: false, reason: said }, 'the model hears what the user said');
  assert.ok(lines.some((l) => l.event === 'approval'), 'the answer is logged');
  const logged = JSON.stringify(lines);
  assert.ok(!logged.includes('4417') && !logged.includes('bank PIN'), `the user’s spoken words are in nexus.log at ${lines.find((l) => JSON.stringify(l).includes('4417'))?.level}: ${logged.slice(0, 300)}`);
  assert.strictEqual(lines.find((l) => l.event === 'approval').data.reasonChars, said.length, 'the log keeps how long the answer was');

  // The same words come back in the declined call's message, which both tool paths log at info: the app's
  // own tools (tools.js 'tool declined') and Claude Code's (claudecode.js logToolError). Only the model reads them.
  assert.strictEqual(approvals.declineForLog(`Not approved by the user: ${said}`), `Not approved by the user (${said.length} characters said)`);
  assert.strictEqual(approvals.declineForLog(`User did not approve: ${said}`), `User did not approve (${said.length} characters said)`);
  for (const own of ['The user clicked Deny.', 'The user pressed Esc.', 'The user said no.', 'The reply was stopped.', 'No answer within 75 seconds — treated as no.', 'The user said no (on Anna’s Pixel).', 'declined']) {
    assert.strictEqual(approvals.declineForLog(`Not approved by the user: ${own}`), `Not approved by the user: ${own}`, own);
    assert.deepStrictEqual(approvals.reasonForLog(own), { reason: own });
  }
  assert.deepStrictEqual(approvals.reasonForLog(''), { reason: '' }, 'an allowed answer');
  assert.strictEqual(approvals.declineForLog('Not approved by the user (the page redirected to another site): The user clicked Deny.'), 'Not approved by the user (the page redirected to another site): The user clicked Deny.');
  await store.setSettings({ safety: { permissionMode: 'ask', taintGuard: true } }); // routine_save asks in Ask mode
  lines.length = 0;
  approvals.setSender((channel, p) => channel === 'approval:request' && setImmediate(() => approvals.respond(p.id, false, said)));
  const out = await allTools().execute('routine_save', { name: 'Dentist reminder', schedule: { kind: 'daily', time: '08:00' }, instructions: 'Remind me of the dentist.' }, { turn: approvals.newTurn(), emit() {} });
  assert.strictEqual(out.ok, false);
  assert.match(JSON.stringify(out), /bank PIN is 4417/, 'the model still hears what the user said');
  assert.ok(lines.some((l) => l.event === 'tool declined'), JSON.stringify(lines).slice(0, 300));
  assert.ok(!JSON.stringify(lines).includes('4417'), `tools.js logs the words: ${JSON.stringify(lines).slice(0, 300)}`);
  assert.match(read('main/claudecode.js'), /preview: \(declined \? approvals\.declineForLog\(preview\) : preview\)\.slice\(0, 500\)/, 'claudecode.js logToolError trims a declined call’s text the same way');
});
