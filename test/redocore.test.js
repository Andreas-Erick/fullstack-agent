// Running the latest message again (renderer/js/redocore.mjs, shared by main/redo.js and the chat): which
// message, what is dropped, when the Claude session starts fresh, what the new turn is told, and what asks first.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');
const core = require('../renderer/js/redocore.mjs');

const user = (id, content, extra = {}) => ({ id, role: 'user', content, createdAt: 1, ...extra });
const reply = (id, content, extra = {}) => ({ id, role: 'assistant', content, createdAt: 2, ...extra });
const failed = (extra = {}) => ({ outcome: 'failed', at: 5, error: 'LLM error 429', tools: [], output: false, ...extra });
const answered = (extra = {}) => [user('u1', 'hi'), reply('a1', 'hello'), user('u2', 'What is on today?'), reply('a2', 'Nothing.', extra)];
const readOnly = (n) => /search|^Read$|_get_|list/.test(n);
const harmless = (n) => n === 'daily_note_log';
const tainting = (n) => ['web_fetch', 'WebFetch'].includes(n);
const opts = (extra = {}) => ({ readOnly, harmless, tainting, ...extra });

test('latest and actions: answered, unanswered, stopped; nothing for others’ messages, busy or setup', () => {
  assert.deepStrictEqual(core.actions(answered()), { again: 'u2', edit: 'u2', reply: 'a2', state: 'answered', certain: true });
  const open = [user('u1', 'hi', { attempt: failed() })];
  assert.deepStrictEqual(core.actions(open), { again: 'u1', edit: 'u1', reply: null, state: 'unanswered', certain: true });
  assert.strictEqual(core.actions([user('u1', 'x'), reply('a1', '*(stopped)*')]).state, 'stopped');
  assert.strictEqual(core.actions([user('u1', 'x'), reply('a1', 'half a sent', { stopped: true })]).state, 'stopped');
  const none = { again: null, edit: null, reply: null, state: null, certain: true };
  assert.deepStrictEqual(core.actions(answered(), { busy: true }), none, 'a reply is being written there');
  assert.deepStrictEqual(core.actions(answered(), { setup: true }), none);
  for (const extra of [{ routine: 'r1' }, { auto: 'tasks' }, { hidden: true }, { display: core.TASKS_SYNC_DISPLAY }]) {
    assert.deepStrictEqual(core.actions([user('u1', 'x', extra)]), none, JSON.stringify(extra));
  }
  assert.deepStrictEqual(core.actions([{ role: 'user', content: 'old import' }]), none, 'no id: nothing to point at');
  assert.deepStrictEqual(core.actions([]), none);
  assert.deepStrictEqual(core.actions(undefined), none);
  // How sure the app is about what an unanswered attempt did.
  assert.strictEqual(core.latest([user('u1', 'x')]).certain, false, 'no attempt (old data, a crash)');
  assert.strictEqual(core.latest([user('u1', 'x', { attempt: { outcome: 'running', at: 1 } })]).certain, false, 'the app closed mid-turn');
  assert.strictEqual(core.latest([user('u1', 'x', { attempt: failed({ partial: true }) })]).certain, false);
  assert.strictEqual(core.latest([user('u1', 'x', { attempt: { outcome: 'stopped', at: 1, tools: [] } })]).certain, true);
});

test('plan refuses an older message, a stale view, an empty or huge edit, and others’ messages', () => {
  const list = answered();
  assert.deepStrictEqual(core.plan(list, { kind: 'again', messageId: 'u1' }, opts()), { ok: false, error: 'Only your latest message can be sent again.' });
  const stale = core.plan(list, { kind: 'again', messageId: 'u2', expectLast: 'u2' }, opts());
  assert.strictEqual(stale.changed, true);
  assert.match(stale.error, /changed since you opened it/);
  assert.strictEqual(core.plan(list, { kind: 'again', messageId: 'u2', expectLast: 'a2' }, opts()).ok, true);
  assert.strictEqual(core.plan(list, { kind: 'edit', messageId: 'u2', text: '   ' }, opts()).error, 'The message is empty.');
  const withFile = [user('u1', 'FILE BLOCKS what is this', { display: 'what is this', attachments: [{ kind: 'pdf', name: 'a.pdf' }] })];
  assert.strictEqual(core.plan(withFile, { kind: 'edit', messageId: 'u1', text: '' }, opts()).ok, true, 'a message with files may lose its words');
  const withPicture = [user('u1', 'x', { display: 'x', attachments: [{ kind: 'image', name: 'a.png' }] })];
  assert.strictEqual(core.plan(withPicture, { kind: 'edit', messageId: 'u1', text: '' }, opts()).ok, false);
  assert.strictEqual(core.plan(list, { kind: 'edit', messageId: 'u2', text: 'x'.repeat(20001) }, opts()).error, 'The message is too long.');
  assert.strictEqual(core.plan([user('u1', 'x', { routine: 'r1' })], { kind: 'again', messageId: 'u1' }, opts()).ok, false);
});

test('Try again and Regenerate: the same words, the same voice, and a fresh Claude session only when needed', () => {
  const p = core.plan(answered({ provider: 'claude-code' }), { kind: 'again', messageId: 'u2' }, opts());
  assert.strictEqual(p.cut, 2);
  assert.strictEqual(p.text, 'What is on today?');
  assert.strictEqual(p.voice, false);
  assert.strictEqual(p.replaces, 'u2');
  assert.strictEqual(p.replyDropped, true);
  assert.strictEqual(p.resetSession, true, 'a Claude reply that is withdrawn must leave the session');
  assert.strictEqual(core.plan(answered({ provider: 'anthropic' }), { kind: 'again', messageId: 'u2' }, opts()).resetSession, false);
  assert.strictEqual(core.plan(answered({ provider: 'openai' }), { kind: 'again', messageId: 'u2' }, opts({ hasSession: true })).resetSession, false);
  assert.strictEqual(core.plan(answered(), { kind: 'again', messageId: 'u2' }, opts({ hasSession: true })).resetSession, true, 'no provider stored: the session decides');
  assert.strictEqual(core.plan(answered(), { kind: 'again', messageId: 'u2' }, opts()).resetSession, false);
  // A /skill as typed, a message with files as typed; spoken stays spoken.
  const skill = [user('u1', 'EXPANDED STEPS', { display: '/study physics', skill: 'study', spoken: true, attempt: failed() })];
  const s = core.plan(skill, { kind: 'again', messageId: 'u1' }, opts());
  assert.strictEqual(s.text, '/study physics');
  assert.strictEqual(s.voice, true);
  const files = [user('u1', '<file blocks> what is this', { display: 'what is this', attachments: [{ kind: 'pdf' }], attempt: failed() })];
  assert.strictEqual(core.plan(files, { kind: 'again', messageId: 'u1' }, opts()).text, 'what is this');
  // A failure keeps the session (it only holds that attempt), unless it can't be resumed or is too long.
  const fail = (error) => core.plan([user('u1', 'x', { attempt: failed({ error }) })], { kind: 'again', messageId: 'u1' }, opts({ hasSession: true })).resetSession;
  assert.strictEqual(fail('LLM error 429'), false);
  assert.strictEqual(fail('No conversation found with session ID: x'), true);
  assert.strictEqual(fail('Prompt is too long'), true);
  // A stopped Claude reply goes too.
  const stopped = [user('u1', 'x'), reply('a1', 'half', { stopped: true, provider: 'claude-code' })];
  assert.strictEqual(core.plan(stopped, { kind: 'again', messageId: 'u1' }, opts()).resetSession, true);
  assert.strictEqual(core.plan(stopped, { kind: 'again', messageId: 'u1' }, opts()).replyDropped, false);
});

test('Edit: the same words after normalizing are Try again; new words are typed (not spoken)', () => {
  const list = answered({ provider: 'claude-code' });
  list[2].spoken = true;
  const same = core.plan(list, { kind: 'edit', messageId: 'u2', text: '  what is ON today ' }, opts());
  assert.strictEqual(same.kind, 'again');
  assert.strictEqual(same.text, 'What is on today?');
  assert.strictEqual(same.voice, true);
  const edit = core.plan(list, { kind: 'edit', messageId: 'u2', text: 'What is on tomorrow?' }, opts());
  assert.strictEqual(edit.kind, 'edit');
  assert.strictEqual(edit.text, 'What is on tomorrow?');
  assert.strictEqual(edit.voice, false);
  assert.strictEqual(edit.resetSession, true);
  // An unanswered message: a fresh session only when the failed attempt wrote something.
  const open = (attempt) => core.plan([user('u1', 'x', { attempt })], { kind: 'edit', messageId: 'u1', text: 'y' }, opts({ hasSession: true })).resetSession;
  assert.strictEqual(open(failed()), false);
  assert.strictEqual(open(failed({ output: true })), true);
});

test('what already happened: acting tools listed, harmless ones not asked about, capped; uncertain attempts', () => {
  const calls = [
    { name: 'calendar_add_event', input: { title: 'Dentist', when: 'tomorrow 9:30' }, ok: true },
    { name: 'memory_save', input: { text: 'x' }, ok: false },
    { name: 'memory_search', input: { query: 'x' }, ok: true },
    { name: 'daily_note_log', input: { text: 'y' }, ok: true },
  ];
  const p = core.plan(answered({ toolCalls: calls }), { kind: 'again', messageId: 'u2' }, opts());
  assert.deepStrictEqual(p.acted.map((t) => t.name), ['calendar_add_event', 'daily_note_log'], 'failed and read-only calls did nothing');
  assert.deepStrictEqual(p.ask.map((t) => t.name), ['calendar_add_event']);
  assert.deepStrictEqual(p.acted[0].input, { title: 'Dentist', when: 'tomorrow 9:30' }, 'the window shows the input');
  // An attempt's tools: their brief is the input; a call that never reported back counts.
  const attempt = failed({ tools: [{ name: 'Edit', ok: null, brief: 'main/x.js' }, { name: 'Read', ok: true, brief: 'a.js' }] });
  const q = core.plan([user('u1', 'x', { attempt })], { kind: 'again', messageId: 'u1' }, opts());
  assert.deepStrictEqual(q.acted, [{ name: 'Edit', ok: null, input: 'main/x.js' }]);
  assert.strictEqual(q.uncertain, false);
  const many = Array.from({ length: 15 }, (_, i) => ({ name: `vault_write_note`, input: { path: `n${i}.md` }, ok: true }));
  const m = core.plan(answered({ toolCalls: many }), { kind: 'again', messageId: 'u2' }, opts());
  assert.strictEqual(m.acted.length, 12);
  assert.strictEqual(m.ask.length, 12);
  assert.match(m.note, /…and 7 more/, 'the note counts them all');
  for (const a of [undefined, { outcome: 'running', at: 1 }, failed({ partial: true })]) {
    assert.strictEqual(core.plan([user('u1', 'x', { attempt: a })], { kind: 'again', messageId: 'u1' }, opts()).uncertain, true);
  }
  // Actions past the record's limit: counted in the plan and the note, never named.
  const full = failed({ tools: Array.from({ length: 20 }, (_, i) => ({ name: 'daily_note_log', ok: true, brief: `${i}` })), more: 4 });
  const f = core.plan([user('u1', 'x', { attempt: full })], { kind: 'again', messageId: 'u1' }, opts());
  assert.strictEqual(f.more, 4);
  assert.deepStrictEqual(f.ask, []);
  assert.strictEqual(f.uncertain, false, 'the outcome is known');
  assert.match(f.note, /…and 16 more/);
  assert.strictEqual(core.plan(answered(), { kind: 'again', messageId: 'u2' }, opts()).more, 0);
});

test('taint only when the session is kept; the title; pictures that can’t be sent again', () => {
  const read = [{ name: 'WebFetch', input: { url: 'https://x' }, ok: true }];
  assert.strictEqual(core.plan([user('u1', 'x', { attempt: failed({ tools: [{ name: 'web_fetch', ok: true, brief: 'https://x' }] }) })], { kind: 'again', messageId: 'u1' }, opts()).taint, true);
  assert.strictEqual(core.plan(answered({ provider: 'claude-code', toolCalls: read }), { kind: 'again', messageId: 'u2' }, opts()).taint, false, 'a fresh session never saw it');
  assert.strictEqual(core.plan(answered({ provider: 'anthropic', toolCalls: read }), { kind: 'again', messageId: 'u2' }, opts()).taint, true);
  // The attempt read outside content (a read: not in its tools, noted as tainted).
  assert.strictEqual(core.plan([user('u1', 'x', { attempt: failed({ tainted: true }) })], { kind: 'again', messageId: 'u1' }, opts()).taint, true);
  assert.strictEqual(core.plan([user('u1', 'x', { attempt: failed({ tainted: true }) })], { kind: 'again', messageId: 'u1' }, opts()).ask.length, 0);
  assert.strictEqual(core.plan([user('u1', 'x', { attempt: failed({ tainted: true, error: 'Prompt is too long' }) })], { kind: 'again', messageId: 'u1' }, opts()).taint, false, 'a fresh session never saw it');
  const first = [user('u1', 'Plan my week please', { attempt: failed() })];
  const title = (t, list = first) => core.plan(list, { kind: 'edit', messageId: 'u1', text: 'Plan my month' }, opts({ title: t })).keepTitle;
  assert.strictEqual(title('Plan my week please'), false, 'still the automatic title: it follows the new words');
  assert.strictEqual(title('Week planning'), true, 'renamed by the user');
  assert.strictEqual(title('x', [user('u1', 'EXPANDED', { display: '/plan', skill: 'plan' })]), true);
  assert.strictEqual(core.plan(answered(), { kind: 'again', messageId: 'u2' }, opts({ title: 'What is on today?' })).keepTitle, true, 'not the first message');
  assert.strictEqual(core.plan([user('u1', 'x', { screen: true })], { kind: 'again', messageId: 'u1' }, opts()).hadImages, true);
  assert.strictEqual(core.plan([user('u1', 'x', { display: 'x', attachments: [{ kind: 'image' }] })], { kind: 'again', messageId: 'u1' }, opts()).hadImages, true);
  assert.strictEqual(core.plan(answered(), { kind: 'again', messageId: 'u2' }, opts()).hadImages, false);
});

// Regression: a message that was only a picture (no words, no files) was sent again as an empty message:
// pictures aren't kept, so nothing was left (the stored copy and the model's turn were '').
test('a message with nothing left to send is never run again: only a picture, or an edit to the same nothing', () => {
  const picture = (extra = {}) => [user('u1', '<attachment index="1" kind="image" name="photo.png" />\n\n[NO MESSAGE]', { display: '', attachments: [{ kind: 'image', name: 'photo.png' }], attempt: failed(), ...extra })];
  const PICTURE = 'This message was only a picture, and pictures aren’t kept: attach it again and send it.';
  assert.deepStrictEqual(core.plan(picture(), { kind: 'again', messageId: 'u1' }, opts()), { ok: false, error: PICTURE }, 'Try again');
  const answeredPicture = [...picture({ attempt: undefined }), reply('a1', 'A cat on a sofa.')];
  assert.deepStrictEqual(core.plan(answeredPicture, { kind: 'again', messageId: 'u1' }, opts()), { ok: false, error: PICTURE }, 'Regenerate');
  assert.strictEqual(core.plan(picture(), { kind: 'edit', messageId: 'u1', text: '?' }, opts()).error, PICTURE, 'an edit that normalizes to nothing is Try again');
  assert.strictEqual(core.plan(picture(), { kind: 'edit', messageId: 'u1', text: '' }, opts()).error, 'The message is empty.');
  const words = core.plan(picture(), { kind: 'edit', messageId: 'u1', text: 'What breed is it?' }, opts());
  assert.strictEqual(words.ok, true, 'new words can go (the picture can’t)');
  assert.strictEqual(words.text, 'What breed is it?');
  assert.strictEqual(words.hadImages, true);
  // A picture with words, or with a file, still has something to send.
  assert.strictEqual(core.plan(picture({ display: 'Is this right?' }), { kind: 'again', messageId: 'u1' }, opts()).text, 'Is this right?');
  assert.strictEqual(core.plan(picture({ attachments: [{ kind: 'image', name: 'photo.png' }, { kind: 'pdf', name: 'a.pdf' }] }), { kind: 'again', messageId: 'u1' }, opts()).ok, true);
  // Old data with no words at all.
  assert.deepStrictEqual(core.plan([user('u1', '   ', { attempt: failed() })], { kind: 'again', messageId: 'u1' }, opts()), { ok: false, error: 'The message is empty.' });
  assert.strictEqual(core.supersedes(picture(), '', opts()), null);
});

// Regression: autoTitle read `display || content`, and a message of files has display '' (main.js startTurn),
// so it read the file blocks: the automatic '📎 …' title counted as renamed and an Edit never retitled the chat.
test('autoTitle follows startTurn for a message with files: its typed words, else the files’ names', () => {
  const files = (display, attachments) => user('u1', '<attachment index="1" kind="pdf" name="a.pdf" size="4 KB">…</attachment>\n\n[NO MESSAGE]', { display, attachments, attempt: failed() });
  const pdf = { kind: 'pdf', name: 'a.pdf' };
  const png = { kind: 'image', name: 'photo.png' };
  assert.strictEqual(core.autoTitle(files('', [pdf])), '📎 a.pdf');
  assert.strictEqual(core.autoTitle(files('', [png])), '📎 photo.png');
  assert.strictEqual(core.autoTitle(files('', [pdf, png])), '📎 a.pdf, photo.png', 'the pictures named too, as compose titles them');
  assert.strictEqual(core.autoTitle(files('Explain   page two', [pdf])), 'Explain page two');
  assert.strictEqual(core.autoTitle(files('', [{ kind: 'pdf', name: `${'long name '.repeat(10)}.pdf` }])).length, 60);
  assert.strictEqual(core.autoTitle(user('u1', 'Plan my week please')), 'Plan my week please', 'without files: as before');
  assert.strictEqual(core.autoTitle(user('u1', 'EXPANDED', { display: '/plan x', skill: 'plan', attachments: [pdf] })), null);
  const edit = (m, title) => core.plan([m], { kind: 'edit', messageId: 'u1', text: 'Summarise it' }, opts({ title })).keepTitle;
  assert.strictEqual(edit(files('', [pdf]), '📎 a.pdf'), false, 'files only: the automatic title follows the new words');
  assert.strictEqual(edit(files('', [png]), '📎 photo.png'), false, 'a picture only, too');
  assert.strictEqual(edit(files('', [pdf, png]), '📎 a.pdf, photo.png'), false);
  assert.strictEqual(edit(files('', [pdf]), 'Lecture notes'), true, 'renamed by the user');
});

test('the same text sent again after a failure replaces the unanswered copy, and only then', () => {
  const open = [user('u0', 'hi'), reply('a0', 'hello'), user('u1', 'Add the dentist, tomorrow at 9!', { attempt: failed() })];
  const p = core.supersedes(open, 'add the dentist tomorrow at 9', opts());
  assert.strictEqual(p.replaces, 'u1');
  assert.strictEqual(p.cut, 2);
  assert.strictEqual(core.supersedes([...open.slice(0, 2), user('u1', 'x'), reply('a1', '*(stopped)*')], 'X', opts()).replaces, 'u1', 'a stopped one too');
  assert.strictEqual(core.supersedes(open, 'add the dentist on friday', opts()), null);
  assert.strictEqual(core.supersedes(answered(), 'What is on today?', opts()), null, 'answered: a real second question');
  assert.strictEqual(core.supersedes([user('u1', 'x', { routine: 'r1' })], 'x', opts()), null);
  assert.strictEqual(core.supersedes([user('u1', 'FILES x', { display: 'x', attachments: [{ kind: 'pdf' }] })], 'x', opts()), null, 'never drops a message with files');
  assert.strictEqual(core.supersedes(open, '', opts()), null);
});

test('marks after a cut: the journal mark comes down; a summary past the cut is rebuilt', () => {
  assert.deepStrictEqual(core.clampMarks({ journaledUpTo: 10 }, 6), { journaledUpTo: 6 });
  assert.deepStrictEqual(core.clampMarks({ journaledUpTo: 4 }, 6), {});
  assert.deepStrictEqual(core.clampMarks({}, 6), {});
  assert.deepStrictEqual(core.clampMarks({ summaryUpTo: 8, summary: 's' }, 6), { summary: '', summaryUpTo: 0 });
  assert.deepStrictEqual(core.clampMarks({ summaryUpTo: 4, summary: 's' }, 6), {});
});

test('the note: nothing to say, the wordings, and the actions it names', () => {
  assert.strictEqual(core.noteFor({}), '');
  assert.strictEqual(core.noteFor({ kind: 'edit' }), '', 'a fresh session never saw the old version');
  assert.match(core.noteFor({ replyDropped: true }), /asked for a new reply to this message; your earlier reply to it was withdrawn/);
  assert.match(core.noteFor({ kind: 'edit', replyDropped: true }), /edited this message after your reply/);
  assert.strictEqual(core.noteFor({ failed: true }), 'Your earlier attempt at this message did not finish.');
  assert.match(core.noteFor({ failed: true, uncertain: true }), /cut off \(the app closed or restarted\).*Check before repeating anything/);
  assert.match(core.noteFor({ kind: 'edit', sameSession: true, failed: true }), /rewrote their previous message, which got no reply; answer only this version/);
  const acted = Array.from({ length: 11 }, (_, i) => ({ name: 'vault_write_note', input: { path: `n${i}.md`, content: 'x'.repeat(400) } }));
  const note = core.noteFor({ failed: true, acted });
  const lines = note.split('\n');
  assert.ok(lines.includes('These actions from it already happened and were not undone:'));
  assert.strictEqual(lines.filter((l) => l.startsWith('- vault_write_note')).length, 8);
  assert.ok(lines.filter((l) => l.startsWith('- ')).every((l) => l.length <= 160), 'inputs cut to 160');
  assert.ok(lines.includes('…and 3 more'));
  assert.strictEqual(lines.at(-1), "Don't do them again unless the user asks.");
  assert.match(core.noteFor({ uncertain: true, acted: [{ name: 'Edit', input: 'main/x.js' }] }), /These are known to have happened; there may be more:\n- Edit main\/x\.js/);
  assert.match(core.noteFor({ failed: true, acted: [{ name: 'Edit', input: 'a.js' }], more: 3 }), /- Edit a\.js\n…and 3 more\nDon't do them again/);
});

test('attempt records are bounded; set and removed by message id', () => {
  const ran = Array.from({ length: 25 }, (_, i) => ({ name: 'Edit', ok: i % 2 ? true : undefined, input: { file_path: `src/${'deep/'.repeat(50)}f${i}.js` } }));
  const a = core.attemptRecord({ outcome: 'failed', at: 7, error: 'e'.repeat(500), ran, output: true });
  assert.strictEqual(a.outcome, 'failed');
  assert.strictEqual(a.tools.length, 20);
  assert.strictEqual(a.more, 5, 'the actions past the limit are counted');
  assert.ok(a.tools.every((t) => t.brief.length <= 160));
  assert.strictEqual(a.tools[0].ok, null, 'no tool_end: unknown');
  assert.strictEqual(a.error.length, 300);
  assert.strictEqual(a.output, true);
  assert.strictEqual(core.attemptRecord({ outcome: 'stopped', error: 'x' }).error, undefined, 'only a failure keeps its error');
  assert.strictEqual(core.attemptRecord({ outcome: 'running', partial: true }).partial, true);
  assert.strictEqual(core.attemptRecord({ ran: [] }).more, undefined);
  // Only actions are listed, so reads before them can't push them out; outside content is noted apart.
  const reads = Array.from({ length: 30 }, (_, i) => ({ name: 'Read', ok: true, input: { file_path: `f${i}.js` } }));
  const mixed = [...reads, { name: 'memory_save', ok: false, input: { text: 'x' } }, { name: 'calendar_add_event', ok: true, input: { title: 'Dentist' } }, { name: 'web_fetch', ok: true, input: { url: 'https://x' } }];
  const r = core.attemptRecord({ ran: mixed, readOnly, tainting });
  assert.deepStrictEqual(r.tools, [{ name: 'calendar_add_event', ok: true, brief: 'Dentist' }, { name: 'web_fetch', ok: true, brief: 'https://x' }], 'reads and a failed call left out');
  assert.strictEqual(r.tainted, true);
  assert.strictEqual(r.more, undefined);
  assert.strictEqual(core.attemptRecord({ ran: reads, readOnly, tainting }).tainted, undefined);
  assert.strictEqual(core.attemptRecord({ ran: [{ name: 'WebFetch', ok: true }], readOnly: () => true, tainting }).tainted, true, 'a read that brought in outside content');
  assert.strictEqual(core.briefOf({ title: 'Dentist', when: 'x' }), 'Dentist');
  assert.strictEqual(core.briefOf({ when: 'x' }), '{"when":"x"}');
  assert.strictEqual(core.briefOf({}), '');

  const conv = { messages: [user('u1', 'x'), reply('a1', 'y'), user('u2', 'z')] };
  assert.strictEqual(core.withAttempt(conv, 'u2', a).messages[2].attempt, a);
  assert.strictEqual(core.withAttempt(conv, 'u1', a), null, 'already answered');
  assert.strictEqual(core.withAttempt(conv, 'gone', a), null);
  assert.strictEqual(core.stripAttempt(conv, 'u2').messages[2].attempt, undefined);
  assert.deepStrictEqual(core.withoutAttempt({ id: 'x', attempt: a }), { id: 'x' });
});

test('the tasks sync’s marker is the store’s own', () => {
  const store = fs.readFileSync(path.join(ROOT, 'main/store.js'), 'utf8');
  assert.ok(store.includes(`const TASKS_SYNC_DISPLAY = '${core.TASKS_SYNC_DISPLAY}';`));
});
