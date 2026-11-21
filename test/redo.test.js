// Running a message again, the main side (main/redo.js): which tools count as doing something, the gates
// every redo passes (prepare), the attempt records, what the window sees, and store.updateConversation.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog } = require('./helpers');

const dir = tmpDir('nexus-redo-');
const KEY = 0x5a;
const flip = (buf) => Buffer.from(buf.map((b) => b ^ KEY));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => flip(Buffer.from(s, 'utf8')), decryptString: (b) => flip(b).toString('utf8') };
const withdrawn = [];
stub({
  electron: { app: { getPath: () => dir }, safeStorage },
  './logger': quietLog,
  './tools': { TOOLS: [{ name: 'web_fetch', untrusted: true }, { name: 'memory_search' }, { name: 'calendar_add_event' }] },
  // The conversation's Claude session (claudesession.js, its own tests in claudeforget.test.js): withdraw recorded.
  './claudesession': {
    hasSession: (c) => Boolean(c?.claudeSessionId),
    withdraw: (c) => (withdrawn.push([c.id, c.claudeSessionId]), { claudeSessionId: null, claudeTokens: 0 }),
  },
});
const redo = load('main/redo.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const user = (id, content, extra = {}) => ({ id, role: 'user', content, createdAt: 1, ...extra });
const reply = (id, content, extra = {}) => ({ id, role: 'assistant', content, createdAt: 2, ...extra });
const conv = (messages, extra = {}) => ({ id: 'c1', title: 'Chat', messages, ...extra });
const failedAttempt = (extra = {}) => ({ outcome: 'failed', at: 1, error: 'boom', tools: [], output: false, ...extra });

test('read-only tools: the app’s, Claude Code’s, and connectors by their action alone', () => {
  for (const n of ['memory_search', 'calendar_get_events', 'Read', 'Glob', 'Grep', 'ToolSearch', 'mcp__claude_ai_Todoist__find-tasks']) assert.ok(redo.readOnly(n), n);
  for (const n of ['memory_save', 'calendar_add_event', 'Edit', 'Bash', 'Write', 'mcp__claude_ai_Todoist__add-tasks', 'a_tool_nobody_knows']) assert.ok(!redo.readOnly(n), n);
  // "search" is the server's name here, not what the tool does: it sends.
  assert.ok(!redo.readOnly('mcp__plugin_search_x__send_email'));
  assert.ok(redo.harmless('daily_note_log') && !redo.harmless('memory_save'));
});

test('tools whose results are outside content taint a kept session', () => {
  assert.ok(redo.tainting('web_fetch'));
  assert.ok(redo.tainting('WebFetch'));
  assert.ok(redo.tainting('WebSearch'));
  assert.ok(redo.tainting('mcp__claude_ai_Gmail__search_threads'));
  assert.ok(!redo.tainting('memory_search'));
});

test('check: a missing conversation, the setup one and a running reply are refused; a remembered attempt counts', () => {
  assert.deepStrictEqual(redo.check(null, {}), { ok: false, error: 'Conversation not found' });
  assert.match(redo.check(conv([user('u1', 'x')], { setup: true }), { kind: 'again', messageId: 'u1' }).error, /setup conversation/);
  assert.match(redo.check(conv([user('u1', 'x')]), { kind: 'again', messageId: 'u1' }, { busy: true }).error, /Wait for the current reply/);
  assert.strictEqual(redo.check(conv([user('u1', 'x')]), { kind: 'nonsense', messageId: 'u1' }).error, 'Bad request');
  // Stored as running (the app closed? no: the catch hasn't written yet), remembered as failed: certain.
  const c = conv([user('u1', 'x', { attempt: { outcome: 'running', at: 1 } })]);
  assert.strictEqual(redo.check(c, { kind: 'again', messageId: 'u1' }).uncertain, true);
  redo.remember('c1', 'u1', failedAttempt({ tools: [{ name: 'calendar_add_event', ok: true, brief: 'Dentist' }] }));
  const p = redo.check(c, { kind: 'again', messageId: 'u1' });
  assert.strictEqual(p.uncertain, false);
  assert.deepStrictEqual(p.ask, [{ name: 'calendar_add_event', ok: true, input: 'Dentist' }]);
  redo.remember('c1', null);
  assert.strictEqual(redo.check(c, { kind: 'again', messageId: 'u1' }).uncertain, true);
});

test('prepare: desktop only, confirmed when it must be; the old exchange goes and a Claude session that held it ends', () => {
  const forgotten = withdrawn; // the session is taken out through claudesession.withdraw (stubbed above)
  forgotten.length = 0;
  const base = () => conv([user('u0', 'hi'), reply('a0', 'hello', { provider: 'claude-code' }), user('u1', 'Add the dentist', { spoken: true }), reply('a1', 'Added.', { provider: 'claude-code', toolCalls: [{ name: 'calendar_add_event', input: { title: 'Dentist' }, ok: true }] })], { claudeSessionId: 's-old', claudeTokens: 90000, journaledUpTo: 4 });
  const req = { kind: 'again', messageId: 'u1' };
  assert.throws(() => redo.prepare({ conv: base(), redo: req, remote: 'Phone' }), /Only the computer can send a message again/);
  assert.throws(() => redo.prepare({ conv: base(), redo: req }), /Confirm first/);
  assert.throws(() => redo.prepare({ conv: conv([user('u1', 'x')]), redo: req }), /Confirm first/, 'an uncertain attempt asks too');
  assert.throws(() => redo.prepare({ conv: base(), redo: { ...req, messageId: 'u0', confirmed: true } }), /Only your latest message/);
  assert.throws(() => redo.prepare({ conv: base(), redo: { ...req, expectLast: 'u1', confirmed: true } }), (err) => err.changed === true);
  assert.strictEqual(forgotten.length, 0);

  const c = base();
  const r = redo.prepare({ conv: c, redo: { ...req, confirmed: true }, text: '' });
  assert.deepStrictEqual(c.messages.map((m) => m.id), ['u0', 'a0']);
  assert.deepStrictEqual(forgotten, [['c1', 's-old']]);
  assert.strictEqual(c.claudeSessionId, null);
  assert.strictEqual(c.claudeTokens, 0);
  assert.strictEqual(c.journaledUpTo, 2);
  assert.strictEqual(r.text, 'Add the dentist');
  assert.strictEqual(r.voice, true, 'its own spoken flag');
  assert.strictEqual(r.again.kind, 'regenerate');
  assert.strictEqual(r.again.replaces, 'u1');
  assert.strictEqual(r.again.fresh, true);
  assert.strictEqual(r.again.keepTitle, true);
  assert.deepStrictEqual(r.again.acted.map((a) => a.name), ['calendar_add_event']);
  assert.match(r.again.again.note, /calendar_add_event/);

  // A failure on the API path: the session (none) stays, nothing to forget.
  forgotten.length = 0;
  const f = conv([user('u1', 'x', { attempt: failedAttempt() })]);
  const g = redo.prepare({ conv: f, redo: { kind: 'again', messageId: 'u1' }, text: '' });
  assert.strictEqual(g.again.kind, 'again');
  assert.strictEqual(g.again.fresh, false);
  assert.deepStrictEqual(forgotten, []);
  assert.deepStrictEqual(f.messages, []);
});

test('the same message sent again: replaces the unanswered copy with its own voice, never for others’ turns or while busy', () => {
  const open = () => conv([user('u1', 'Add the dentist!', { attempt: failedAttempt() })]);
  const r = redo.prepare({ conv: open(), text: 'add the dentist', voice: true, remote: 'Watch' });
  assert.strictEqual(r.again.replaces, 'u1');
  assert.strictEqual(r.text, 'add the dentist', 'the new message’s own words');
  assert.strictEqual(r.voice, true, 'and its own voice flag');
  for (const extra of [{ routine: 'r1' }, { auto: 'tasks' }, { hidden: true }, { busy: true }]) {
    const c = open();
    assert.strictEqual(redo.prepare({ conv: c, text: 'add the dentist', ...extra }).again, null, JSON.stringify(extra));
    assert.strictEqual(c.messages.length, 1);
  }
  assert.strictEqual(redo.prepare({ conv: { ...open(), setup: true }, text: 'add the dentist' }).again, null);
  assert.strictEqual(redo.prepare({ conv: open(), text: 'add the dentist on friday' }).again, null);
});

test('attempt records: running (partial), stopped, failed; output from text or tools', () => {
  const ran = new Map([['t1', { name: 'Edit', ok: null, input: { file_path: 'main/x.js' } }]]);
  const running = redo.attemptFrom({ running: true, ran, firstTextMs: null });
  assert.strictEqual(running.outcome, 'running');
  assert.strictEqual(running.partial, true);
  assert.deepStrictEqual(running.tools, [{ name: 'Edit', ok: null, brief: 'main/x.js' }]);
  assert.strictEqual(running.output, true, 'a tool ran');
  const stopped = redo.attemptFrom({ aborted: true, err: new Error('AbortError'), ran: new Map(), firstTextMs: 300 });
  assert.strictEqual(stopped.outcome, 'stopped');
  assert.strictEqual(stopped.error, undefined);
  assert.strictEqual(stopped.output, true, 'it wrote something');
  const failed = redo.attemptFrom({ err: new Error('LLM error 500'), ran: new Map(), firstTextMs: null });
  assert.strictEqual(failed.outcome, 'failed');
  assert.strictEqual(failed.error, 'LLM error 500');
  assert.strictEqual(failed.output, false);
});

test('the window sees the plan’s summary, nothing else', () => {
  const p = redo.check(conv([user('u1', 'x', { attempt: failedAttempt() })]), { kind: 'again', messageId: 'u1' });
  assert.deepStrictEqual(Object.keys(redo.forWindow(p)).sort(), ['acted', 'ask', 'fresh', 'kind', 'more', 'ok', 'replyDropped', 'text', 'uncertain', 'voice']);
  assert.deepStrictEqual(redo.forWindow({ ok: false, error: 'no', changed: true }), { ok: false, error: 'no', changed: true });
});
// The start event's message without its running attempt: main/projections.js, test/projections.test.js.

// The order of a turn (the gates first, busy before the first await, a second forget once the cut is saved,
// the failure heard before it is recorded) is shown through main/turns.js in test/turns.test.js.

// The warm-up's epoch, taken before the conversation is read (a Regenerate's save racing a chat being opened),
// is claudesession.warm's own rule now: shown by behaviour in test/claudeforget.test.js.

// Regression: the record kept the first 20 calls in order, reads too, so after 20 reads an action (and
// a call that brought in outside content) was lost: Try again neither asked nor re-tainted the session.
test('a long run of reads never hides what the attempt did', () => {
  const ran = new Map();
  for (let i = 0; i < 22; i++) ran.set(`r${i}`, { name: 'Read', ok: true, input: { file_path: `f${i}.js` } });
  ran.set('a', { name: 'calendar_add_event', ok: true, input: { title: 'Dentist' } });
  ran.set('w', { name: 'WebFetch', ok: true, input: { url: 'https://example.com' } });
  const attempt = redo.attemptFrom({ err: new Error('LLM error 500'), ran, firstTextMs: 10 });
  assert.deepStrictEqual(attempt.tools, [{ name: 'calendar_add_event', ok: true, brief: 'Dentist' }]);
  assert.strictEqual(attempt.tainted, true);
  const c = conv([user('u1', 'Plan it', { attempt })], { claudeSessionId: 's1' });
  const p = redo.check(c, { kind: 'again', messageId: 'u1' });
  assert.deepStrictEqual(p.ask.map((t) => t.name), ['calendar_add_event']);
  assert.strictEqual(p.resetSession, false, 'the session is kept…');
  assert.strictEqual(p.taint, true, '…so what it read still taints the turn');
  assert.throws(() => redo.prepare({ conv: c, redo: { kind: 'again', messageId: 'u1' } }), /Confirm first/);

  // More actions than the record holds: the rest are counted, and asked about even when the listed ones are harmless.
  const busy = new Map();
  for (let i = 0; i < 24; i++) busy.set(`d${i}`, { name: 'daily_note_log', ok: true, input: { text: `${i}` } });
  busy.set('e', { name: 'Edit', ok: true, input: { file_path: 'main/x.js' } });
  const full = redo.attemptFrom({ err: new Error('LLM error 500'), ran: busy, firstTextMs: null });
  assert.strictEqual(full.tools.length, 20);
  assert.strictEqual(full.more, 5);
  const q = redo.check(conv([user('u1', 'Log it', { attempt: full })]), { kind: 'again', messageId: 'u1' });
  assert.deepStrictEqual(q.ask, []);
  assert.strictEqual(q.more, 5);
  assert.strictEqual(redo.forWindow(q).more, 5);
  assert.match(q.note, /…and 17 more/, '8 named of the 20 recorded, plus the 5 past the record');
  assert.throws(() => redo.prepare({ conv: conv([user('u1', 'Log it', { attempt: full })]), redo: { kind: 'again', messageId: 'u1' } }), /Confirm first/);
});

test('store.updateConversation: sealed like any save, inside the write queue; null leaves it; the index follows', async () => {
  const store = load('main/store.js');
  await store.getSettings();
  const c = await store.createConversation('Dentist');
  c.messages.push(user('u1', 'Add the dentist'));
  await store.saveConversation(c);
  const file = path.join(dir, 'conversations', `${c.id}.json`);
  const before = fs.readFileSync(file, 'utf8');
  assert.strictEqual(await store.updateConversation(c.id, () => null), null);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'null: untouched');
  const saved = await store.updateConversation(c.id, (x) => redo.withAttempt(x, 'u1', failedAttempt()));
  assert.strictEqual(saved.messages[0].attempt.outcome, 'failed');
  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /"sealed":"v1"/);
  assert.ok(!raw.includes('dentist'), 'sealed, not readable on disk');
  assert.strictEqual((await store.getConversation(c.id)).messages[0].attempt.error, 'boom');
  assert.strictEqual(saved.updatedAt, c.updatedAt, 'not moved up the list');
  // In order with a save queued at the same moment: neither is lost.
  c.title = 'Renamed';
  await Promise.all([store.saveConversation(c), store.updateConversation(c.id, (x) => ((x.messages[0].content = 'changed'), x))]);
  const after = await store.getConversation(c.id);
  assert.strictEqual(after.title, 'Renamed');
  assert.strictEqual(after.messages[0].content, 'changed');
  assert.strictEqual(await store.updateConversation('c-missing', (x) => x), null, 'a missing file');
  // The index follows a change made by an update alone.
  const count = (await store.listConversations()).find((x) => x.id === c.id).count;
  await store.updateConversation(c.id, (x) => (x.messages.push(reply('a1', 'Added.')), x));
  assert.strictEqual((await store.listConversations()).find((x) => x.id === c.id).count, count + 1);
});
