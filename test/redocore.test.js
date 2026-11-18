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

// Regression (gap-stop-cancellation-4): a call of a stopped or failed attempt that never reported back
// (ok: null: a push waiting for approval when Stop came) was called done: the confirm said "already did
// this, and it isn't undone", the notice "Already done", and the model was told not to repeat it.
const CUT_HEAD = 'These were cut off before they reported back; check whether they happened (the schedule, the repository, the service) before doing them again:';
const DONE_HEADS = ['These actions from it already happened and were not undone:', 'These are known to have happened; there may be more:'];
const DONT = "Don't do them again unless the user asks.";

/** The note's lines grouped under their headings: { heading: [lines] }. */
function sections(note) {
  const out = {};
  let head = null;
  for (const line of String(note).split('\n')) {
    if (line === CUT_HEAD || DONE_HEADS.includes(line)) out[(head = line)] = [];
    else if (head && (line.startsWith('- ') || line.startsWith('…and '))) out[head].push(line);
    else head = null;
  }
  return out;
}

test('a call cut off before it reported back is asked about, but never called done', () => {
  const stopped = (tools) => [user('u1', 'push it', { attempt: { outcome: 'stopped', at: 1, tools, output: true } })];
  const p = core.plan(stopped([{ name: 'github_push', ok: null, brief: 'main' }]), { kind: 'again', messageId: 'u1' }, opts());
  assert.deepStrictEqual(p.acted.map((t) => t.name), ['github_push']);
  assert.deepStrictEqual(p.ask.map((t) => t.name), ['github_push'], 'still asked before a possible repeat');
  assert.deepStrictEqual(p.unsure, [p.acted[0]], 'the same object as in acted');
  assert.strictEqual(core.cutOff(p.unsure[0]), true);
  const s = sections(p.note);
  assert.deepStrictEqual(s[CUT_HEAD], ['- github_push main']);
  for (const h of DONE_HEADS) assert.strictEqual(s[h], undefined, 'no "already happened" heading');
  assert.ok(!p.note.includes(DONT));

  const done = core.plan(stopped([{ name: 'github_push', ok: true, brief: 'main' }]), { kind: 'again', messageId: 'u1' }, opts());
  assert.deepStrictEqual(done.unsure, []);
  assert.deepStrictEqual(sections(done.note)[DONE_HEADS[0]], ['- github_push main']);
  assert.ok(!done.note.includes(CUT_HEAD));

  // A failed call never reaches the record (attemptRecord), so it is never listed at all.
  const rec = core.attemptRecord({ outcome: 'failed', ran: [{ name: 'github_push', ok: false, input: { title: 'main' } }], readOnly });
  const f = core.plan([user('u1', 'push it', { attempt: rec })], { kind: 'again', messageId: 'u1' }, opts());
  assert.deepStrictEqual([f.acted, f.ask, f.unsure], [[], [], []]);
  assert.ok(!f.note.includes('github_push'));

  // A run that was still going (the app closed): its unreported calls under the cut-off line, the rest as known.
  const running = core.attemptRecord({ outcome: 'running', partial: true, ran: [{ name: 'calendar_add_event', ok: true, input: { title: 'Dentist' } }, { name: 'github_push', ok: null, input: { title: 'main' } }], readOnly });
  const r = core.plan([user('u1', 'do both', { attempt: running })], { kind: 'again', messageId: 'u1' }, opts());
  assert.strictEqual(r.uncertain, true);
  const rs = sections(r.note);
  assert.deepStrictEqual(rs['These are known to have happened; there may be more:'], ['- calendar_add_event Dentist']);
  assert.deepStrictEqual(rs[CUT_HEAD], ['- github_push main']);
  assert.deepStrictEqual(r.unsure.map((t) => t.name), ['github_push']);
});

test('noteFor: where "…and N more" goes with done and cut-off calls', () => {
  const both = core.noteFor({ failed: true, acted: [{ name: 'calendar_add_event', input: 'Dentist', ok: true }, { name: 'github_push', input: 'main', ok: null }], more: 2 });
  const s = sections(both);
  assert.deepStrictEqual(s[DONE_HEADS[0]], ['- calendar_add_event Dentist', '…and 2 more'], 'the unnamed ones count with the done ones');
  assert.deepStrictEqual(s[CUT_HEAD], ['- github_push main']);
  assert.ok(both.includes(DONT));
  // more counts reported calls past the record's limit, moreCut cut-off ones (attemptRecord keeps those first).
  const cut = core.noteFor({ failed: true, acted: [{ name: 'github_push', input: 'main', ok: null }], moreCut: 2 });
  assert.deepStrictEqual(sections(cut)[CUT_HEAD], ['- github_push main', '…and 2 more']);
  assert.ok(!cut.includes(DONT), 'nothing is said to be done');
  for (const h of DONE_HEADS) assert.ok(!cut.includes(h));
  const reported = sections(core.noteFor({ failed: true, acted: [{ name: 'github_push', input: 'main', ok: null }], more: 2, moreCut: 1 }));
  assert.deepStrictEqual(reported[DONE_HEADS[0]], ['…and 2 more'], 'the reported ones past the limit are done');
  assert.deepStrictEqual(reported[CUT_HEAD], ['- github_push main', '…and 1 more']);
  // Unnamed ones alone: as before.
  assert.match(core.noteFor({ failed: true, acted: [], more: 3 }), /These actions from it already happened and were not undone:\n…and 3 more\nDon't do them again/);
  assert.strictEqual(core.cutOff({ ok: null }), true);
  for (const t of [{ ok: true }, { ok: false }, {}, { ok: undefined }, null, undefined]) assert.strictEqual(core.cutOff(t), false, JSON.stringify(t));
});

// Regression: every cap took the first n calls, and the call in flight at a stop is the last one started. With
// 9 or more actions it fell into the note's "…and N more" under "already happened … Don't do them again", from
// 13 it left unsure and ask (the confirm and notice said done or nothing), past 20 it went into the record's
// `more`, which every surface calls done.
test('a call cut off after many others is still named as cut off, at every cap', () => {
  const stopped = (ran) => {
    const attempt = core.attemptRecord({ outcome: 'stopped', ran, readOnly, tainting });
    return { attempt, p: core.plan([user('u1', 'do it all', { attempt })], { kind: 'again', messageId: 'u1' }, opts()) };
  };
  const events = (n) => Array.from({ length: n }, (_, i) => ({ name: 'calendar_add_event', ok: true, input: { title: `e${i}` } }));
  const push = { name: 'github_push', ok: null, input: { title: 'main' } };
  const counted = (lines) => Number(((lines || []).find((l) => l.startsWith('…and ')) || '…and 0').match(/\d+/)[0]);
  for (const n of [7, 8, 9, 11, 12, 13, 19, 20, 21, 30]) {
    const { attempt, p } = stopped([...events(n), push]);
    const s = sections(p.note);
    assert.deepStrictEqual(s[CUT_HEAD], ['- github_push main'], `${n} done before it: the push is named as cut off`);
    const done = s[DONE_HEADS[0]];
    assert.ok(!done.includes('- github_push main'), `${n}: never under the done heading`);
    assert.strictEqual(done.filter((l) => l.startsWith('- ')).length + counted(done), n, `${n}: every event named or counted as done`);
    assert.deepStrictEqual(p.unsure.map((t) => t.name), ['github_push'], `${n}: the confirm and the notice name it as cut off`);
    assert.ok(p.ask.includes(p.unsure[0]), `${n}: still asked about`);
    assert.strictEqual(attempt.tools.at(-1).name, 'github_push', `${n}: the record keeps it, in its order`);
    assert.strictEqual(attempt.tools[0].brief, 'e0');
    assert.strictEqual(attempt.moreCut, undefined);
    assert.strictEqual(attempt.more || 0, Math.max(0, n + 1 - 20), `${n}: more counts only reported calls`);
    assert.strictEqual(p.more, attempt.more || 0, `${n}: the window's "N more actions" are reported ones`);
  }
  // The reviewer's case: 22 edits, the last one cut off.
  const edits = Array.from({ length: 22 }, (_, i) => ({ name: 'Edit', ok: i < 21 ? true : null, input: { file_path: `f${i}.js` } }));
  const { attempt: rec, p: q } = stopped(edits);
  assert.strictEqual(rec.more, 2);
  assert.deepStrictEqual(q.unsure.map((t) => t.input), ['f21.js']);
  assert.deepStrictEqual(sections(q.note)[CUT_HEAD], ['- Edit f21.js']);
  assert.strictEqual(counted(sections(q.note)[DONE_HEADS[0]]), 14, '7 named of the 19 recorded, plus the 2 past the record');

  // More cut off than the record holds (a burst of parallel calls at the stop): counted as cut off, never as
  // done, and asked about although the named ones are harmless (their unnamed fellows may not be).
  const burst = Array.from({ length: 25 }, (_, i) => ({ name: 'daily_note_log', ok: null, input: { title: `l${i}` } }));
  const { attempt: b, p: bp } = stopped(burst);
  assert.strictEqual(b.tools.length, 20);
  assert.strictEqual(b.moreCut, 5);
  assert.strictEqual(b.more, undefined);
  const bs = sections(bp.note);
  assert.strictEqual(bs[CUT_HEAD].length, 9);
  assert.strictEqual(bs[CUT_HEAD].at(-1), '…and 17 more', '12 recorded but not named, plus the 5 past the record');
  assert.ok(!bp.note.includes(DONT));
  assert.strictEqual(bp.more, 0);
  assert.strictEqual(bp.ask.length, 12);
  assert.ok(bp.ask.every(core.cutOff));
  // Within the record, harmless calls are still not asked about, cut off or not.
  assert.deepStrictEqual(stopped(burst.slice(0, 5)).p.ask, []);
  const logged = stopped(burst.map((t) => ({ ...t, ok: true })));
  assert.deepStrictEqual(logged.p.ask, []);
  assert.strictEqual(logged.p.more, 5, 'the reported ones past the record are counted, and asked about by number');
});

// Seeded: whatever an attempt ran, past every cap too (the note's 8, the window's 12, the record's 20), an
// unreported call is never said to be done, and every reported action is, named or counted.
test('attempt → plan: cut-off calls are named as cut off, done ones as done (seeded)', () => {
  const LISTED = 12; // redocore's caps: acted/ask handed on, and the attempt record
  const RECORD = 20;
  const NOTE_LINES = 8;
  const seed = 0x2545f491;
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const NAMES = ['github_push', 'calendar_add_event', 'daily_note_log', 'memory_search'];
  const named = (lines) => (lines || []).filter((l) => l.startsWith('- '));
  const counted = (lines) => Number(((lines || []).find((l) => l.startsWith('…and ')) || '…and 0').match(/\d+/)[0]);
  const titles = (list) => list.map((t) => (typeof t.input === 'string' ? t.input : t.input?.title)).sort();
  for (let i = 0; i < 300; i++) {
    const outcome = pick(['stopped', 'failed', 'running']);
    const ran = Array.from({ length: Math.floor(rnd() * 26) }, (_, k) => ({ name: pick(NAMES), ok: pick([true, null, false]), input: { title: `c${i}-${k}` } }));
    // Sometimes a burst of parallel calls was in flight (more than the record holds); usually the last one started.
    if (rnd() < 0.15) for (let k = 0, n = 21 + Math.floor(rnd() * 5); k < n; k++) ran.push({ name: pick(['github_push', 'daily_note_log']), ok: null, input: { title: `c${i}-b${k}` } });
    if (rnd() < 0.5) ran.push({ name: 'github_push', ok: null, input: { title: `c${i}-last` } });
    const attempt = core.attemptRecord({ outcome, partial: outcome === 'running', ran, readOnly, tainting });
    const p = core.plan([user('u1', 'do things', { attempt })], { kind: 'again', messageId: 'u1' }, opts());
    const at = `seed ${seed} case ${i} (${outcome}, ${ran.length} calls: ${JSON.stringify(ran.map((t) => [t.name, t.ok]))})`;
    assert.strictEqual(p.ok, true, at);
    const acting = ran.filter((t) => t.ok !== false && !readOnly(t.name));
    const cutCalls = acting.filter((t) => t.ok === null);
    const doneCalls = acting.filter((t) => t.ok === true);
    // The record: the cut-off calls kept first; what it can't hold is counted by kind.
    const recCut = attempt.tools.filter((t) => t.ok === null).length;
    assert.strictEqual(recCut, Math.min(cutCalls.length, RECORD), `${at}: cut-off calls are recorded first`);
    assert.strictEqual(recCut + (attempt.moreCut || 0), cutCalls.length, `${at}: every cut-off call recorded or counted as cut off`);
    assert.strictEqual(attempt.tools.filter((t) => t.ok === true).length + (attempt.more || 0), doneCalls.length, `${at}: every reported call recorded or counted as reported`);
    // The note: each call under its own heading only, the rest of each kind counted there.
    const sec = sections(p.note);
    const under = (title) => Object.keys(sec).filter((h) => sec[h].some((l) => l.endsWith(` ${title}`)));
    for (const t of ran) {
      const where = under(t.input.title);
      if (t.ok === false || readOnly(t.name)) assert.deepStrictEqual(where, [], `${at}: ${t.input.title} never appears`);
      else if (t.ok === null) assert.ok(where.length <= 1 && where.every((h) => h === CUT_HEAD), `${at}: ${t.input.title} is cut off, never done`);
      else assert.ok(where.length <= 1 && where.every((h) => DONE_HEADS.includes(h)), `${at}: ${t.input.title} is done`);
    }
    const doneHead = DONE_HEADS.find((h) => sec[h]);
    assert.strictEqual(named(sec[CUT_HEAD]).length, Math.min(cutCalls.length, NOTE_LINES), `${at}: the cut-off calls are named first`);
    assert.strictEqual(named(sec[CUT_HEAD]).length + counted(sec[CUT_HEAD]), cutCalls.length, `${at}: each cut-off call named or counted under the cut-off heading`);
    assert.strictEqual(named(sec[doneHead]).length + counted(sec[doneHead]), doneCalls.length, `${at}: each reported call named or counted as done`);
    assert.strictEqual(p.note.includes(DONT), doneCalls.length > 0, `${at}: "don't do them again" only for what happened`);
    // The window and main: unsure is the cut-off calls handed on, first; more (the confirm's "N more
    // actions", worded done) only reported ones.
    assert.ok(p.unsure.every((t) => core.cutOff(t) && p.acted.includes(t)), `${at}: unsure is a part of acted`);
    assert.strictEqual(p.unsure.length, Math.min(cutCalls.length, LISTED), `${at}: the cut-off calls are handed on first`);
    assert.ok(p.acted.length <= LISTED && p.ask.length <= LISTED, at);
    assert.strictEqual(p.more, attempt.more || 0, at);
    const asked = new Set(titles(p.ask));
    const cutToAsk = cutCalls.filter((t) => !harmless(t.name));
    if (cutCalls.length <= RECORD && cutToAsk.length <= LISTED) for (const t of cutToAsk) assert.ok(asked.has(t.input.title), `${at}: ${t.input.title} is asked about`);
    if (acting.length <= RECORD && acting.filter((t) => !harmless(t.name)).length <= LISTED) for (const t of acting.filter((x) => !harmless(x.name))) assert.ok(asked.has(t.input.title), `${at}: ${t.input.title} is asked about`);
    if (attempt.moreCut) assert.ok(p.ask.length > 0, `${at}: unnamed cut-off calls are asked about`);
  }
});

test('the tasks sync’s marker is the store’s own', () => {
  const store = fs.readFileSync(path.join(ROOT, 'main/store.js'), 'utf8');
  assert.ok(store.includes(`const TASKS_SYNC_DISPLAY = '${core.TASKS_SYNC_DISPLAY}';`));
});
