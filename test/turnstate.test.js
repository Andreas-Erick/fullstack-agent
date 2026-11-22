// The open conversation and the replies being written in it (renderer/js/turnstate.js), shared by the
// desktop's chat and the phone client: recorded event sequences replayed through the module's interface.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir, phoneClientSource } = require('./helpers');

const ESM = tmpDir('nexus-turnstate-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
for (const f of ['turnstate.js', 'chatcore.js', 'braintable.mjs']) fs.copyFileSync(path.join(ROOT, 'renderer/js', f), path.join(ESM, f));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));

let ts;
let redo;
let chatcore;
test.before(async () => {
  ts = await import(pathToFileURL(path.join(ESM, 'turnstate.js')).href);
  chatcore = await import(pathToFileURL(path.join(ESM, 'chatcore.js')).href);
  redo = await import(pathToFileURL(path.join(ROOT, 'renderer/js/redocore.mjs')).href);
});

const C = 'c1';
const user = (id, content, extra = {}) => ({ id, role: 'user', content, display: content, createdAt: 1, ...extra });
const reply = (id, content, extra = {}) => ({ id, role: 'assistant', content, createdAt: 2, ...extra });
const desk = () => ts.createChat({ redo }); // the desktop passes the redo rules; the phone passes none
const replay = (chat, events) => events.map((ev) => chat.apply(ev));

test('own reply: start stores the message, text streams, tools count, done stores the reply and ends the turn', () => {
  const chat = desk();
  chat.open({ id: C, messages: [user('u0', 'hi'), reply('a0', 'hello')] });
  const t = chat.begin({ requestId: 'r1', view: { tag: 'mine' } });
  assert.strictEqual(chat.own, t);
  const steps = replay(chat, [
    { type: 'start', requestId: 'r1', conversationId: C, title: 'Chat', userMessage: user('u1', 'add the dentist') },
    { type: 'tool_start', requestId: 'r1', conversationId: C, id: 't1', name: 'calendar_add_event', input: { title: 'Dentist' } },
    { type: 'text', requestId: 'r1', conversationId: C, delta: 'Adding' },
  ]);
  assert.deepStrictEqual(steps.map((s) => s.type), ['start', 'tool_start', 'text']);
  assert.ok(steps.every((s) => s.mine && s.turn === t));
  assert.strictEqual(steps[0].title, 'Chat');
  assert.deepStrictEqual(chat.messages.map((m) => m.id), ['u0', 'a0', 'u1'], 'the stored message is known at start (its id for Edit)');
  assert.deepStrictEqual(chat.activity({ ownOnly: true }), { generating: true, toolsRunning: 1, streamingText: true });
  assert.strictEqual(chat.actions().again, null, 'nothing to do to the latest exchange while it runs');
  const end = chat.apply({ type: 'tool_end', requestId: 'r1', conversationId: C, id: 't1', name: 'calendar_add_event', ok: true, preview: 'added' });
  assert.deepStrictEqual({ ...end.tool }, { id: 't1', name: 'calendar_add_event', input: { title: 'Dentist' }, ok: true, preview: 'added' }, 'the input stays with the call');
  assert.strictEqual(end.known, true);
  const done = chat.apply({ type: 'done', requestId: 'r1', conversationId: C, message: reply('a1', 'Added.') });
  assert.strictEqual(done.type, 'done');
  assert.strictEqual(t.outcome, 'done');
  assert.strictEqual(chat.own, null, 'ended before the client draws, so the buttons it draws see a settled exchange');
  assert.deepStrictEqual(chat.messages.map((m) => m.id), ['u0', 'a0', 'u1', 'a1']);
  // The finished reply is known before the buttons are set: Regenerate and Edit on it (one busy rule).
  assert.deepStrictEqual(chat.actions(), { again: 'u1', edit: 'u1', reply: 'a1', state: 'answered', certain: true });
  assert.deepStrictEqual(chat.activity({ ownOnly: true }), { generating: false, toolsRunning: 0, streamingText: false });
});

test('retract after text: the last characters go (a provider fallback took the reply back)', () => {
  const chat = desk();
  chat.open({ id: C });
  chat.begin({ requestId: 'r1' });
  replay(chat, [
    { type: 'text', requestId: 'r1', conversationId: C, delta: 'Hello there' },
    { type: 'retract', requestId: 'r1', conversationId: C, chars: 6 },
  ]);
  assert.strictEqual(chat.own.text, 'Hello');
  chat.apply({ type: 'retract', requestId: 'r1', conversationId: C, chars: 99 });
  assert.strictEqual(chat.own.text, '', 'never below nothing');
  assert.strictEqual(chat.activity({ ownOnly: true }).streamingText, false, 'nothing streaming any more: thinking again');
  chat.apply({ type: 'text', requestId: 'r1', conversationId: C, delta: 'Hi' });
  assert.strictEqual(chat.own.text, 'Hi');
});

test('stopped in the middle of a tool: the turn ends, its tools stop counting, the attempt is recorded', () => {
  const chat = desk();
  chat.open({ id: C, messages: [user('u0', 'hi'), reply('a0', 'hello')] });
  const t = chat.begin({ requestId: 'r1' });
  replay(chat, [
    { type: 'start', requestId: 'r1', conversationId: C, userMessage: user('u1', 'push it') },
    { type: 'tool_start', requestId: 'r1', conversationId: C, id: 't1', name: 'github_push', input: {} },
  ]);
  const s = chat.apply({ type: 'aborted', requestId: 'r1', conversationId: C, message: 'Stopped' });
  assert.strictEqual(s.type, 'stopped');
  assert.strictEqual(t.outcome, 'stopped');
  assert.strictEqual(t.running, 0);
  assert.strictEqual(chat.own, null);
  assert.strictEqual(chat.messages.at(-1).attempt.outcome, 'stopped', 'the window marks it as main stored it');
  assert.deepStrictEqual({ again: chat.actions().again, state: chat.actions().state, certain: chat.actions().certain }, { again: 'u1', state: 'unanswered', certain: true });
  assert.deepStrictEqual(chat.failure(), { kind: 'stopped', error: '' });
  // A failure records its error, and the line under it says so.
  const chat2 = desk();
  chat2.open({ id: C });
  chat2.begin({ requestId: 'r2' });
  chat2.apply({ type: 'start', requestId: 'r2', conversationId: C, userMessage: user('u2', 'hello') });
  const f = chat2.apply({ type: 'error', requestId: 'r2', conversationId: C, message: '429 rate limit' });
  assert.deepStrictEqual([f.type, f.error], ['failed', '429 rate limit']);
  assert.deepStrictEqual(chat2.failure(), { kind: 'failed', error: '429 rate limit' });
  assert.deepStrictEqual(chat2.failedCard(Date.now()), { failed: true, error: '429 rate limit' });
  assert.strictEqual(chat2.failedCard(Date.now() + 2 * 86400000), null, 'older than a day: not on the card');
});

test('events before the requestId is known are held, then applied in order (the phone)', () => {
  const chat = ts.createChat();
  chat.open({ id: C });
  const t = chat.begin({ view: {} }); // the send is in flight
  assert.deepStrictEqual(chat.apply({ type: 'start', requestId: 'rP', conversationId: C, userMessage: user('u1', 'yo') }), { type: 'held' });
  assert.deepStrictEqual(chat.apply({ type: 'text', requestId: 'rP', conversationId: C, delta: 'Hey' }), { type: 'held' });
  // A reply from elsewhere in the conversation is held too (it may be this one): order is kept.
  assert.strictEqual(chat.apply({ type: 'start', requestId: 'rX', conversationId: C, userMessage: user('uX', 'other') }).type, 'held');
  const held = chat.sent('rP');
  assert.strictEqual(t.requestId, 'rP');
  const steps = replay(chat, held);
  assert.deepStrictEqual(steps.map((s) => [s.type, s.mine]), [['start', true], ['text', true], ['start', false]]);
  assert.strictEqual(t.text, 'Hey');
  assert.strictEqual(chat.others.length, 1);
  assert.deepStrictEqual(chat.sent('again'), [], 'handed over once');
  // A send that failed: the turn ends unsent, the held events still come back (nothing is lost).
  const chat2 = ts.createChat();
  chat2.open({ id: C });
  const t2 = chat2.begin();
  chat2.apply({ type: 'start', requestId: 'rY', conversationId: C, userMessage: user('uY', 'there') });
  chat2.end(t2, 'unsent');
  assert.strictEqual(t2.outcome, 'unsent');
  assert.strictEqual(chat2.own, null);
  assert.deepStrictEqual(replay(chat2, chat2.sent(null)).map((s) => [s.type, s.mine]), [['start', false]]);
});

test('own and foreign replies interleaved: each keeps its own text; only the open conversation is followed', () => {
  const chat = desk();
  chat.open({ id: C, messages: [user('u0', 'hi'), reply('a0', 'hello')] });
  chat.begin({ requestId: 'rD' });
  const steps = replay(chat, [
    { type: 'start', requestId: 'rD', conversationId: C, userMessage: user('u1', 'desk') },
    { type: 'start', requestId: 'rP', conversationId: C, userMessage: user('u2', 'phone', { remote: 'Phone' }) },
    { type: 'text', requestId: 'rD', conversationId: C, delta: 'A' },
    { type: 'text', requestId: 'rP', conversationId: C, delta: 'B' },
    { type: 'tool_start', requestId: 'rP', conversationId: C, id: 'x', name: 'web_search', input: { query: 'q' } },
    { type: 'text', requestId: 'rD', conversationId: C, delta: 'A' },
    { type: 'start', requestId: 'rZ', conversationId: 'other', userMessage: user('u9', 'routine') },
    { type: 'text', requestId: 'rZ', conversationId: 'other', delta: 'nope' },
  ]);
  assert.deepStrictEqual(steps.map((s) => s && [s.type, s.mine]), [['start', true], ['start', false], ['text', true], ['text', false], ['tool_start', false], ['text', true], null, null]);
  const phone = chat.others[0];
  assert.strictEqual(chat.own.text, 'AA');
  assert.strictEqual(phone.text, 'B');
  assert.strictEqual(phone.mine, false);
  assert.deepStrictEqual(chat.activity({ ownOnly: true }), { generating: true, toolsRunning: 0, streamingText: true }, 'the desktop face: its own reply only');
  assert.deepStrictEqual(chat.activity(), { generating: true, toolsRunning: 1, streamingText: true }, 'the phone face: every reply here');
  chat.apply({ type: 'done', requestId: 'rD', conversationId: C, message: reply('a1', 'AA') });
  assert.strictEqual(chat.busy(), true, 'the phone’s reply still runs');
  assert.strictEqual(chat.actions().again, null);
  chat.apply({ type: 'done', requestId: 'rP', conversationId: C, message: reply('a2', 'B') });
  assert.strictEqual(chat.busy(), false);
  assert.deepStrictEqual(chat.messages.map((m) => m.id), ['u0', 'a0', 'u1', 'u2', 'a1', 'a2']);
  // A turn of this client passes even before its conversation is known (a new one gets its id at start).
  const fresh = desk();
  fresh.open({});
  fresh.begin({ requestId: 'rN' });
  assert.strictEqual(fresh.apply({ type: 'start', requestId: 'rN', conversationId: 'c-new', userMessage: user('n1', 'new') }).type, 'start');
  assert.strictEqual(fresh.convId, 'c-new');
  assert.strictEqual(fresh.apply({ type: 'start', requestId: 'rQ', conversationId: undefined }), null, 'never a foreign turn without a conversation');
});

test('regression: a reply still running on another device reads as running, not "This message got no reply."', () => {
  const chat = desk();
  chat.open({ id: C, messages: [user('u0', 'hi'), reply('a0', 'hello')] });
  chat.apply({ type: 'start', requestId: 'rP', conversationId: C, userMessage: user('u1', 'from the phone') });
  // Before: the desktop ignored the phone's events, so u1 looked unanswered and offered Try again.
  assert.strictEqual(chat.failure(), null);
  assert.strictEqual(chat.actions().again, null, 'Try again, Edit and Regenerate wait for it');
  assert.strictEqual(chat.others[0].outcome, 'running');
  chat.apply({ type: 'done', requestId: 'rP', conversationId: C, message: reply('a1', 'answered there') });
  assert.strictEqual(chat.actions().reply, 'a1', 'then it is the latest exchange like any other');
  // A reply whose start went by (the chat was opened after it began): followed from its next event, as running.
  const j = chat.apply({ type: 'text', requestId: 'rJ', conversationId: C, delta: 'half' });
  assert.deepStrictEqual([j.type, j.mine, j.joined], ['text', false, true]);
  assert.strictEqual(chat.busy(), true);
  assert.strictEqual(chat.apply({ type: 'text', requestId: 'rJ', conversationId: C, delta: ' more' }).joined, undefined, 'joined once');
  assert.strictEqual(j.turn.text, 'half more');
  chat.apply({ type: 'done', requestId: 'rJ', conversationId: C, message: reply('a2', 'whole') });
  assert.strictEqual(chat.busy(), false);
  // Its end seen without anything before: 'unknown', for the client to read the conversation again.
  assert.deepStrictEqual(chat.apply({ type: 'done', requestId: 'rLate', conversationId: C, message: reply('a3', 'x') }).type, 'unknown');
  assert.strictEqual(chat.apply({ type: 'memory_changed', requestId: 'rLate2', conversationId: C }).type, 'unknown', 'side events never start following');
});

test('sent again elsewhere (replaces): the old exchange leaves the open conversation', () => {
  const chat = desk();
  chat.open({ id: C, messages: [user('u0', 'hi'), reply('a0', 'hello'), user('u1', 'yes')] });
  const s = chat.apply({ type: 'start', requestId: 'rP', conversationId: C, replaces: 'u1', userMessage: user('u2', 'yes') });
  assert.strictEqual(s.drop, 'u1');
  assert.deepStrictEqual(chat.messages.map((m) => m.id), ['u0', 'a0', 'u2']);
  // Own Try again: the module drops it too (idempotent with the client's dropFrom before the send).
  chat.apply({ type: 'done', requestId: 'rP', conversationId: C, message: reply('a2', 'ok') });
  chat.begin({ requestId: 'r2' });
  chat.dropFrom('u2');
  const own = chat.apply({ type: 'start', requestId: 'r2', conversationId: C, replaces: 'u2', userMessage: user('u3', 'yes!') });
  assert.strictEqual(own.drop, 'u2');
  assert.deepStrictEqual(chat.messages.map((m) => m.id), ['u0', 'a0', 'u3']);
});

test('a reconnect: own reply kept while running or unsent, ended when it finished; others followed once', () => {
  const chat = ts.createChat();
  chat.open({ id: C });
  const t = chat.begin({ requestId: 'r1' });
  let r = chat.reconcile(['r1', 'rD']);
  assert.strictEqual(r.keepOwn, true);
  assert.strictEqual(r.ended, null);
  assert.deepStrictEqual(r.follow.map((x) => x.requestId), ['rD']);
  assert.deepStrictEqual(chat.reconcile(['r1', 'rD']).follow, [], 'already followed: no second view');
  r = chat.reconcile(['rD']);
  assert.strictEqual(r.ended, t, 'the bug: finished while the link was down, the composer stayed busy');
  assert.strictEqual(chat.own, null);
  // Still being sent (no requestId): kept.
  chat.begin();
  assert.strictEqual(chat.reconcile([]).keepOwn, true);
  // The pure rule (as the old sync.js reconcile).
  assert.deepStrictEqual(ts.reconcile({ requestId: 'r1' }, []), { keepActive: false, endActive: true, follow: [] });
  // Opening a conversation again forgets the followed replies (their nodes went with the old list), keeps own.
  const own = chat.own;
  chat.open({ id: C, messages: [] });
  assert.deepStrictEqual(chat.others, []);
  assert.strictEqual(chat.own, own);
});

test('latest-exchange actions: one busy rule (own reply, a reply elsewhere, a message waiting for its files), none in setup', () => {
  const chat = desk();
  chat.open({ id: C, messages: [user('u1', 'hi'), reply('a1', 'hello')] });
  assert.deepStrictEqual(chat.actions(), { again: 'u1', edit: 'u1', reply: 'a1', state: 'answered', certain: true });
  chat.setWaiting(true);
  assert.strictEqual(chat.actions().again, null, 'a message waiting for its files goes first');
  assert.strictEqual(chat.busy(), true);
  chat.setWaiting(false);
  chat.begin({ requestId: 'r2' });
  assert.strictEqual(chat.actions().edit, null, 'a reply being written');
  chat.apply({ type: 'start', requestId: 'r2', conversationId: C, userMessage: user('u2', 'again') });
  chat.apply({ type: 'error', requestId: 'r2', conversationId: C, message: 'fetch failed' });
  assert.deepStrictEqual({ ...chat.actions() }, { again: 'u2', edit: 'u2', reply: null, state: 'unanswered', certain: true }, 'after a failure: Try again and Edit');
  // ✎ Edit: the client drops the exchange and sends the new words; the turn's start brings the new message.
  chat.dropFrom('u2');
  chat.begin({ requestId: 'r3' });
  chat.apply({ type: 'start', requestId: 'r3', conversationId: C, replaces: 'u2', userMessage: user('u3', 'edited') });
  chat.apply({ type: 'done', requestId: 'r3', conversationId: C, message: reply('a3', 'fine') });
  assert.deepStrictEqual(chat.actions(), { again: 'u3', edit: 'u3', reply: 'a3', state: 'answered', certain: true });
  // The setup conversation offers nothing; neither does a client without the redo rules (the phone).
  chat.continueIn(C);
  assert.strictEqual(chat.actions().again, null);
  assert.strictEqual(ts.createChat().actions().again, null);
  // A reloaded conversation whose message got no reply and no attempt record: uncertain.
  const old = desk();
  old.open({ id: C, messages: [user('u1', 'hi', { createdAt: Date.now() })] });
  assert.deepStrictEqual(old.failure(), { kind: 'noreply', error: '' });
  assert.deepStrictEqual(old.failedCard(), { text: 'This message got no reply.' });
});

test('notices: tools an earlier attempt ran are named as the chips name them; cut-off calls are never called done', () => {
  assert.strictEqual(ts.noticeText({ message: 'Switched to Gemini.' }), '⚠ Switched to Gemini.');
  const said = ts.noticeText({ message: 'raw', tools: ['calendar_add_event'], cut: ['github_push'] });
  assert.strictEqual(said, '⚠ Already done by the earlier attempt or reply (not undone): 📅 Added to schedule. Cut off before it reported back (check before repeating): 🐙 Pushed to GitHub.');
  assert.strictEqual(ts.noticeText({ message: 'raw', cut: ['github_push'] }), '⚠ Cut off before it reported back (check before repeating): 🐙 Pushed to GitHub.');
  const chat = desk();
  chat.open({ id: C });
  chat.begin({ requestId: 'r1' });
  const s = chat.apply({ type: 'notice', requestId: 'r1', conversationId: C, message: 'x', tools: ['vault_write_note'], toast: true });
  assert.deepStrictEqual([s.type, s.toast], ['notice', true]);
  assert.match(s.text, /✍ Wrote note/);
  assert.deepStrictEqual(chat.own.notices, [s.text]);
});

test('side events and a persona switch: kept on the turn for the client', () => {
  const chat = desk();
  chat.open({ id: C });
  chat.begin({ requestId: 'r1' });
  const s = chat.apply({ type: 'persona_switched', requestId: 'r1', conversationId: C, greeting: 'Hi, Nova here.' });
  assert.strictEqual(s.type, 'other');
  assert.strictEqual(chat.own.greeting, 'Hi, Nova here.', 'spoken in the new voice after the reply');
  assert.strictEqual(chat.apply({ type: 'vault_changed', requestId: 'r1', conversationId: C, path: 'a.md' }).ev.path, 'a.md');
  assert.strictEqual(chat.apply(null), null);
  assert.strictEqual(chat.apply('text'), null);
});

test('talking over the agent mutes the rest of its reply, unless the words answer an approval or were nothing', () => {
  const chat = desk();
  assert.doesNotThrow(() => (chat.bargeIn(), chat.bargeInOver()), 'no reply streaming: nothing to do');
  chat.open({ id: C });
  chat.begin({ requestId: 'r1' });
  chat.bargeIn({ approvalPending: true });
  assert.strictEqual(chat.own.muted, false, 'answering an approval by voice keeps the reply speaking');
  chat.bargeIn();
  assert.strictEqual(chat.own.muted, true, 'the rest of the reply is not spoken');
  chat.bargeInOver();
  assert.strictEqual(chat.own.muted, false, 'nothing was said after all: it speaks again');
});

test('the face: one rule for the desktop and the phone', () => {
  const f = ts.faceState;
  assert.strictEqual(f(), 'idle');
  assert.strictEqual(f({ demo: 'happy', recording: true }), 'happy', 'a demo wins');
  assert.strictEqual(f({ recording: true, playing: true, generating: true }), 'listening');
  assert.strictEqual(f({ playing: true, generating: true }), 'speaking');
  assert.strictEqual(f({ transcribing: true, generating: true }), 'thinking');
  assert.strictEqual(f({ generating: true }), 'thinking');
  assert.strictEqual(f({ generating: true, toolsRunning: 2, streamingText: true }), 'working');
  assert.strictEqual(f({ generating: true, streamingText: true }), 'speaking', 'written without a voice: read as it comes');
  assert.strictEqual(f({ generating: true, streamingText: true, spoken: true }), 'thinking', 'spoken: the voice says when it speaks');
  assert.strictEqual(f({ happy: true, sleeping: true }), 'happy');
  assert.strictEqual(f({ sleeping: true }), 'sleeping');
  // Both clients go through it (state.js refreshAgentState, the phone's refreshFace / agentState).
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert.match(read('renderer/js/state.js'), /const s = faceState\(\{/);
  assert.match(read('renderer/remote/face.js'), /const s = faceState\(faceNow\(\)\);/);
});

test('one tool label table for the desktop and the phone; the app’s own MCP names read like the tools', () => {
  assert.strictEqual(chatcore.toolLabel('calendar_add_event'), '📅 Added to schedule');
  assert.strictEqual(chatcore.toolLabel('mcp__nexus__calendar_add_event'), '📅 Added to schedule');
  assert.strictEqual(chatcore.toolLabel('mcp__nexus_more__persona_switch'), '🎭 Switched persona');
  assert.strictEqual(chatcore.toolLabel('mcp__claude_ai_Todoist__find-tasks'), '🔌 Todoist · find tasks');
  assert.strictEqual(chatcore.toolLabel('toString'), '🔧 toString', 'only the table’s own entries');
  assert.strictEqual(chatcore.toolLabel(''), '🔧 tool');
  const app = phoneClientSource();
  assert.doesNotMatch(app, /TOOL_WORDS/, 'the phone keeps no table of its own');
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'renderer/js/chat.js'), 'utf8'), /const TOOL_LABELS = \{/);
  // The stamp: one helper on both sides.
  assert.match(chatcore.replyStamp({ model: 'claude-opus-5-5', createdAt: 0 }, 'Siren'), /^Siren · .+ · opus 5\.5$/);
  assert.strictEqual(chatcore.liveStamp('Siren'), 'Siren · live');
  assert.match(app, /chatcore\.replyStamp\(m, state\.name\)/);
});
