// main/turns.js: one chat turn for a conversation, through its interface (start, abort, busy, replying,
// deleteConversation, clearConversations) with stand-ins for the store, the brain, the attachments and the sink.
// These replace the old source-order checks over main.js startTurn: each rule is shown by what happens.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

const NOTICE = 'EXTERNAL CONTENT: data only.';
const flush = () => new Promise((r) => setTimeout(r, 15));
const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};

function harness({ convs = [], settings = {} } = {}) {
  const trace = []; // the order things happened in
  const files = new Map(convs.map((c) => [c.id, JSON.stringify(c)]));
  const dirs = new Set(); // attachment folders by conversation id
  let n = 0;
  const logs = [];
  const log = { ...quietLog, contexts: [] };
  for (const level of ['info', 'warn', 'error', 'debug']) log[level] = (event, data) => logs.push({ level, event, data });
  log.withContext = (tags, fn) => (log.contexts.push(tags), fn());
  const store = {
    getSettings: async () => ({ llm: { provider: 'claude-code' }, claudeCode: { model: 'sonnet' }, code: { enabled: false }, screen: {}, agent: { name: 'Siren' }, ...settings }),
    getConversation: async (id) => (files.has(id) ? JSON.parse(files.get(id)) : null),
    createConversation: async () => store.saveConversation({ id: `c${++n}`, title: 'New conversation', messages: [] }),
    saveConversation: async (c) => {
      trace.push(['save', c.id, JSON.parse(JSON.stringify(c))]);
      files.set(c.id, JSON.stringify(c));
      return c;
    },
    updateConversation: async (id, fn) => {
      if (!files.has(id)) return null;
      const next = await fn(JSON.parse(files.get(id)));
      if (next) files.set(id, JSON.stringify(next));
      trace.push(['update', id]);
      return next;
    },
    deleteConversation: async (id) => (trace.push(['delete', id]), files.delete(id)),
    listConversations: async () => [...files.keys()].map((id) => ({ id })),
    clearConversations: async () => files.clear(),
    newId: (p) => `${p}${++n}`,
  };
  const attachments = {
    claim: (tokens) => (trace.push(['claim', tokens]), tokens.includes('expired') ? { error: 'That file expired.' } : { items: tokens.map((t) => ({ kind: 'text', name: `${t}.md`, size: 10, chars: 5, text: `text of ${t}` })) }),
    unclaim: (tokens) => trace.push(['unclaim', tokens]),
    save: async (id, items) => (trace.push(['attachments.save', id]), dirs.add(id), items),
    release: (tokens) => trace.push(['release', tokens]),
    removeFor: async (id) => (trace.push(['removeFor', id]), dirs.delete(id)),
    removeAll: async () => dirs.clear(),
  };
  const llm = { runTurn: async (o) => (trace.push(['runTurn', o]), { text: 'Sure.', model: 'm' }) };
  // The conversation's Claude session (claudesession.js, tested in claudeforget.test.js): what turns.js and
  // redo.js tell it is traced; every way it ends a session counts as a forget.
  const claudesession = {
    forget: (id) => trace.push(['forget', id]),
    deleted: (id) => trace.push(['forget', id]),
    withdraw: (c) => (trace.push(['forget', c.id]), { claudeSessionId: null, claudeTokens: 0 }),
    hasSession: (c) => Boolean(c?.claudeSessionId),
    afterTurn: async (before, after, conv) => trace.push(['afterTurn', conv.id]),
  };
  const skills = { fromSlash: async () => null, instructions: () => '' };
  const screenshare = { state: () => ({ active: false }), capture: async () => ({ url: 'data:image/jpeg;base64,x' }) };
  const selfchange = { touchedBy: () => null, noteTouched() {}, forgetTurn() {}, fingerprint: async () => null, root: async () => null, dirtyFiles: async () => [] };
  stub({
    electron: { app: { getPath: () => '' }, safeStorage: { isEncryptionAvailable: () => false } },
    './store': store,
    './logger': log,
    './llm': llm,
    './claudesession': claudesession,
    './skills': skills,
    './screenshare': screenshare,
    './selfchange': selfchange,
    './attachments': attachments,
    './innerworld': { noteTool: (name) => trace.push(['noteTool', name]) },
    './tools/common': { UNTRUSTED_NOTICE: NOTICE },
    './tools': { TOOLS: [{ name: 'calendar_add_event' }, { name: 'github_push' }] },
  });
  const sent = [];
  const windowOnly = [];
  const turns = load('main/turns.js').create({
    send: (channel, payload) => (trace.push(['sink', channel, payload?.type]), sent.push({ channel, ...payload })),
    toWindow: (channel, payload) => windowOnly.push({ channel, ...payload }),
  });
  const stored = (id) => (files.has(id) ? JSON.parse(files.get(id)) : null);
  const index = (pred) => trace.findIndex(pred);
  return { turns, trace, files, dirs, logs, log, store, attachments, llm, claudesession, skills, screenshare, sent, windowOnly, stored, index };
}

const userMsg = (id, content, extra = {}) => ({ id, role: 'user', content, createdAt: 1, ...extra });
const FAILED = { outcome: 'failed', at: 5, error: 'LLM error 429', tools: [], output: false };

test('a turn: claimed, saved with its running attempt, released, run, and the reply stored without the attempt', async () => {
  const h = harness();
  const r = await h.turns.start({ text: 'Read these', requestId: 'req000001', attachments: ['f1'] });
  await flush();
  const at = (name) => h.index((e) => e[0] === name && (name !== 'save' || e[2].messages.length)); // not the new chat's empty save
  const order = ['claim', 'attachments.save', 'save', 'release', 'runTurn'].map(at);
  assert.ok(order.every((i) => i >= 0), String(order));
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'claim, save the files, store, release, then the turn');
  const first = h.trace.find((e) => e[0] === 'save' && e[2].messages.length)[2];
  assert.strictEqual(first.messages[0].attempt.outcome, 'running', 'the running attempt rides on the first save');
  assert.match(first.messages[0].content, /text of f1/, 'the files are composed into the message');
  assert.match(first.messages[0].content, new RegExp(NOTICE), 'with the outside-content notice');
  const start = h.sent.find((e) => e.type === 'start');
  assert.ok(start.userMessage && !('attempt' in start.userMessage), 'no attempt in the start event');
  const run = h.trace.find((e) => e[0] === 'runTurn')[1];
  assert.ok(run.taint.length >= 1, 'the attachment taints the turn');
  const conv = h.stored(r.conversationId);
  assert.deepStrictEqual(conv.messages.map((m) => m.role), ['user', 'assistant']);
  assert.ok(!('attempt' in conv.messages[0]), 'answered: the attempt is gone');
  assert.strictEqual(h.turns.busy(r.conversationId), false);
});

test('an expired token stores nothing; files on a turn that isn’t the user’s own are refused and given back', async () => {
  const h = harness();
  assert.deepStrictEqual(await h.turns.start({ text: 'x', requestId: 'r1', attachments: ['expired'] }), { refused: 'That file expired.' });
  assert.ok(!h.trace.some((e) => e[0] === 'save'), 'nothing stored');
  for (const opts of [{ routine: 'rt1' }, { auto: 'tasks' }, { hidden: true }, { remote: 'Phone' }]) {
    await assert.rejects(h.turns.start({ text: 'x', requestId: 'r2', attachments: ['f1'], ...opts }), /only go with your own messages|setup/);
  }
  assert.strictEqual(h.trace.filter((e) => e[0] === 'unclaim').length, 4, 'the chips come back each time');
  assert.ok(!h.trace.some((e) => e[0] === 'attachments.save'));
  assert.strictEqual(h.turns.busy('c1'), false);
});

test('busy is set before the first await after the gates; a second redo meanwhile is refused', async () => {
  const conv = { id: 'cb', title: 'Plan', messages: [userMsg('u1', 'Plan it', { attempt: FAILED })] };
  const h = harness({ convs: [conv] });
  const hold = gate();
  h.skills.fromSlash = () => hold.p;
  const first = h.turns.start({ conversationId: 'cb', text: '', requestId: 'r1', redo: { kind: 'again', messageId: 'u1' } });
  await flush();
  assert.strictEqual(h.turns.busy('cb'), true, 'busy while the skill lookup is awaited');
  await assert.rejects(h.turns.start({ conversationId: 'cb', text: '', requestId: 'r2', redo: { kind: 'again', messageId: 'u1' } }), /Wait for the current reply/);
  // The same message sent again from another device doesn't supersede it either: it's a new message.
  hold.open(null);
  await first;
  await flush();
  assert.strictEqual(h.turns.busy('cb'), false);
});

test('a refused redo builds nothing, stores nothing, and gives the files back', async () => {
  const conv = { id: 'cr', title: 'Plan', messages: [userMsg('u1', 'Plan it', { attempt: FAILED })] };
  const h = harness({ convs: [conv] });
  let slashed = 0;
  h.skills.fromSlash = async () => (slashed++, null);
  await assert.rejects(h.turns.start({ conversationId: 'cr', text: '', requestId: 'r1', redo: { kind: 'again', messageId: 'nope' } }));
  await assert.rejects(h.turns.start({ conversationId: 'cr', text: '', requestId: 'r2', remote: 'Phone', redo: { kind: 'again', messageId: 'u1' } }), /Only the computer/);
  assert.strictEqual(slashed, 0, 'the gates come before anything is built');
  assert.ok(!h.trace.some((e) => e[0] === 'save'));
  assert.strictEqual(h.turns.busy('cr'), false, 'a failure before the turn runs is no longer busy');
});

test('a failed save frees the turn and the files', async () => {
  const h = harness();
  h.store.saveConversation = async () => {
    throw new Error('disk full');
  };
  h.store.createConversation = async () => ({ id: 'cs', title: 'New', messages: [] });
  await assert.rejects(h.turns.start({ text: 'hi', requestId: 'r1', attachments: ['f1'] }), /disk full/);
  assert.strictEqual(h.turns.busy('cs'), false);
  assert.ok(h.trace.some((e) => e[0] === 'unclaim'));
  assert.ok(!h.trace.some((e) => e[0] === 'release'), 'released only once the message is stored');
});

test('Regenerate forgets the session in the gates and once more after the cut is saved', async () => {
  const conv = { id: 'cg', title: 'Plan', claudeSessionId: 's1', messages: [userMsg('u1', 'Plan it'), { id: 'a1', role: 'assistant', content: 'Done.', createdAt: 2 }] };
  const h = harness({ convs: [conv] });
  await h.turns.start({ conversationId: 'cg', text: '', requestId: 'r1', redo: { kind: 'again', messageId: 'u1' } });
  const forgets = h.trace.map((e, i) => [e, i]).filter(([e]) => e[0] === 'forget' && e[1] === 'cg').map(([, i]) => i);
  const save = h.index((e) => e[0] === 'save' && e[1] === 'cg');
  assert.strictEqual(forgets.length, 2, String(forgets));
  assert.ok(forgets[0] < save && save < forgets[1], 'one in redo.prepare, one after the save');
  assert.strictEqual(h.trace.find((e) => e[0] === 'save')[2].claudeSessionId, null);
});

test('a failure is emitted to the sink before the attempt is stored', async () => {
  const h = harness();
  h.llm.runTurn = async ({ emit }) => {
    emit({ type: 'tool_start', id: 't1', name: 'calendar_add_event', input: { title: 'Dentist' } });
    emit({ type: 'tool_end', id: 't1', ok: true });
    throw new Error('LLM error 500');
  };
  const finished = [];
  const r = await h.turns.start({ text: 'Add it', requestId: 'r1', onFinish: (x) => finished.push(x) });
  await flush();
  const updates = h.trace.map((e, i) => [e, i]).filter(([e]) => e[0] === 'update').map(([, i]) => i);
  const error = h.index((e) => e[0] === 'sink' && e[2] === 'error');
  assert.strictEqual(updates.length, 2, 'the running record at the first action, the failed one after');
  assert.ok(updates[0] < error && error < updates[1], 'the window hears it first');
  const user = h.stored(r.conversationId).messages[0];
  assert.strictEqual(user.attempt.outcome, 'failed');
  assert.deepStrictEqual(user.attempt.tools.map((t) => t.name), ['calendar_add_event']);
  assert.deepStrictEqual(finished, [{ ok: false, error: 'LLM error 500', conversationId: r.conversationId }]);
  assert.ok(h.logs.some((l) => l.level === 'error' && l.event === 'turn failed'));
  assert.ok(h.trace.some((e) => e[0] === 'noteTool' && e[1] === 'calendar_add_event'), 'the Inner World hears the work');
});

test('a routine whose brain isn’t ready (or is offline) logs WARN turn not ready; a chat logs ERROR turn failed', async () => {
  for (const [opts, msg, level, event] of [
    [{ routine: 'rt1' }, 'getaddrinfo ENOTFOUND api.anthropic.com', 'warn', 'turn not ready'],
    [{}, 'getaddrinfo ENOTFOUND api.anthropic.com', 'error', 'turn failed'],
    [{ routine: 'rt1' }, 'Something else broke', 'error', 'turn failed'],
  ]) {
    const h = harness();
    h.llm.runTurn = async () => {
      throw new Error(msg);
    };
    await h.turns.start({ text: 'Run', requestId: 'r1', ...opts });
    await flush();
    const line = h.logs.find((l) => l.event === 'turn not ready' || l.event === 'turn failed');
    assert.deepStrictEqual([line.level, line.event], [level, event], JSON.stringify(opts) + msg);
  }
});

test('a stopped turn logs turn interrupted and tells the sink aborted', async () => {
  const h = harness();
  h.llm.runTurn = ({ signal }) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const r = await h.turns.start({ text: 'Long one', requestId: 'r1' });
  assert.deepStrictEqual([...h.turns.replying()], [r.conversationId], 'the handoff note sees it running');
  h.turns.abort('r1');
  await flush();
  assert.ok(h.sent.some((e) => e.type === 'aborted'));
  assert.ok(h.logs.some((l) => l.event === 'turn interrupted'));
  assert.strictEqual(h.stored(r.conversationId).messages[0].attempt.outcome, 'stopped');
  assert.strictEqual(h.turns.replying().size, 0);
});

test('setup turns go to the window only; others to the window and devices', async () => {
  const h = harness({ convs: [{ id: 'setup1', title: 'Setup', setup: true, messages: [] }] });
  await h.turns.start({ conversationId: 'setup1', text: 'Hi', requestId: 'r1' });
  await flush();
  assert.ok(h.windowOnly.some((e) => e.channel === 'chat:event' && e.type === 'done'));
  assert.ok(!h.sent.some((e) => e.channel === 'chat:event'), 'nothing reaches paired devices');
  await assert.rejects(h.turns.start({ conversationId: 'setup1', text: 'Hi', requestId: 'r2', remote: 'Phone' }), /only be used on the desktop/);
  await h.turns.start({ text: 'Hi', requestId: 'r3' });
  await flush();
  assert.ok(h.sent.some((e) => e.channel === 'chat:event' && e.type === 'done'));
});

test('a delete during the save leaves no stored conversation and no attachments folder', async () => {
  const h = harness();
  const hold = gate();
  const realSave = h.attachments.save;
  h.attachments.save = async (id, items) => {
    const r = await realSave(id, items);
    await hold.p;
    return r;
  };
  h.store.createConversation = async () => ({ id: 'cd', title: 'New', messages: [] }); // not on disk yet
  const turn = h.turns.start({ text: 'Read this', requestId: 'r1', attachments: ['f1'] });
  await flush();
  assert.ok(h.dirs.has('cd'), 'the copy is saved');
  await h.turns.deleteConversation('cd');
  hold.open();
  await assert.rejects(turn, /The conversation was deleted/);
  await flush();
  assert.strictEqual(h.stored('cd'), null, 'nothing stored');
  assert.ok(!h.dirs.has('cd'), 'the copies just saved go too');
  assert.strictEqual(h.turns.busy('cd'), false);
  assert.ok(h.trace.some((e) => e[0] === 'forget' && e[1] === 'cd'), 'its session ends');
  assert.ok(!h.trace.some((e) => e[0] === 'endSession'));
  assert.strictEqual(h.turns.pendingDeletes(), 0, 'remembered only while a turn could see it');
});

test('a delete mid-reply ends it in the window, never comes back, records no attempt and warms nothing', async () => {
  const h = harness();
  const hold = gate();
  h.llm.runTurn = async () => (await hold.p, { text: 'Late reply', model: 'm' });
  let prewarmed = 0;
  h.claudesession.afterTurn = async () => prewarmed++;
  const finished = [];
  const r = await h.turns.start({ text: 'Hi', requestId: 'r1', onFinish: (x) => finished.push(x) });
  await h.turns.deleteConversation(r.conversationId);
  assert.strictEqual(h.turns.pendingDeletes(), 1, 'kept while the turn that started before it runs');
  hold.open();
  await flush();
  assert.ok(h.sent.some((e) => e.type === 'aborted'), 'the window leaves "generating"');
  assert.deepStrictEqual(finished, [{ ok: false, error: 'The conversation was deleted', conversationId: r.conversationId }]);
  assert.strictEqual(h.stored(r.conversationId), null);
  assert.strictEqual(prewarmed, 0);
  assert.strictEqual(h.turns.pendingDeletes(), 0, 'pruned once that turn settled');
});

test('Clear all aborts every turn, forgets every session and removes every folder', async () => {
  const h = harness({ convs: [{ id: 'x1', title: 'a', messages: [] }, { id: 'x2', title: 'b', messages: [] }] });
  h.dirs.add('x1');
  h.llm.runTurn = ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ text: '', model: 'm' })));
  await h.turns.start({ conversationId: 'x1', text: 'Hi', requestId: 'r1' });
  await h.turns.clearConversations();
  await flush();
  assert.deepStrictEqual(h.trace.filter((e) => e[0] === 'forget').map((e) => e[1]).sort(), ['x1', 'x2']);
  assert.strictEqual(h.files.size, 0);
  assert.strictEqual(h.dirs.size, 0);
  assert.ok(h.sent.some((e) => e.type === 'aborted'));
  assert.strictEqual(h.turns.pendingDeletes(), 0);
});

test('Try again after a stop names the cut-off call as cut off, never as done', async () => {
  const attempt = { outcome: 'stopped', at: 1, output: true, tools: [{ name: 'calendar_add_event', ok: true, brief: 'Dentist' }, { name: 'github_push', ok: null, brief: 'main' }] };
  const h = harness({ convs: [{ id: 'cn', title: 'Push', messages: [userMsg('u1', 'push and add', { attempt })] }] });
  await h.turns.start({ conversationId: 'cn', text: '', requestId: 'r1', redo: { kind: 'again', messageId: 'u1', confirmed: true } });
  const notice = h.sent.find((e) => e.type === 'notice');
  assert.deepStrictEqual(notice.tools, ['calendar_add_event']);
  assert.deepStrictEqual(notice.cut, ['github_push']);
  assert.match(notice.message, /Already done by the earlier attempt \(not undone\): calendar add event\./);
  assert.match(notice.message, /Cut off before it reported back \(check before repeating\): github push\./);
  assert.ok(h.sent.findIndex((e) => e.type === 'start') < h.sent.indexOf(notice), 'after the start');
});

test('a redo of a message with files keeps them (recomposed) and is titled by them; a lost picture is said', async () => {
  const attachcore = require('../main/attachcore');
  const item = { kind: 'text', name: 'notes.md', size: 900, chars: 43, text: 'Aliasing happens below twice the bandwidth.' };
  const image = { kind: 'image', name: 'circuit.png', type: 'image/png', width: 10, height: 10, dataUrl: 'data:image/png;base64,iVBORw0KGgo=', thumb: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' };
  const composed = attachcore.compose({ prompt: '', typed: '', items: [item, image], notice: NOTICE });
  const user = userMsg('u1', composed.content, { display: composed.display, attachments: composed.meta, attempt: FAILED });
  const h = harness({ convs: [{ id: 'cf', title: composed.title.replace(/\s+/g, ' ').slice(0, 60), messages: [user] }] });
  await h.turns.start({ conversationId: 'cf', text: '', requestId: 'r1', redo: { kind: 'edit', messageId: 'u1', text: 'Only the second paragraph' } });
  await flush();
  const saved = h.stored('cf').messages[0];
  assert.match(saved.content, /Aliasing happens below twice the bandwidth\./, 'the file’s text is still there');
  assert.strictEqual(saved.display, 'Only the second paragraph');
  assert.strictEqual(h.stored('cf').title, 'Only the second paragraph', 'the automatic title gives way to the new words');
  const start = h.sent.findIndex((e) => e.type === 'start');
  const lost = h.sent.findIndex((e) => e.type === 'notice' && /pictures aren’t kept/.test(e.message));
  assert.ok(start >= 0 && lost > start, 'the lost picture is said once the start is out');
  assert.ok(h.trace.find((e) => e[0] === 'runTurn')[1].taint.length >= 1, 'the kept file taints the turn again');
});

test('a message of files only is titled by them; a shared screen goes with the message and taints it', async () => {
  const h = harness();
  h.screenshare.state = () => ({ active: true });
  const r = await h.turns.start({ text: '', requestId: 'r1', attachments: ['f1'] });
  await flush();
  assert.match(h.stored(r.conversationId).title, /f1\.md/);
  const run = h.trace.find((e) => e[0] === 'runTurn')[1];
  assert.deepStrictEqual(run.images, ['data:image/jpeg;base64,x']);
  assert.ok(run.taint.includes('the shared screen'));
  assert.strictEqual(h.stored(r.conversationId).messages[0].screen, true);
  // A device never sends one.
  const remote = await h.turns.start({ text: 'hi', requestId: 'r2', remote: 'Phone' });
  await flush();
  assert.ok(!h.stored(remote.conversationId).messages[0].screen);
});

test('every log line of the turn runs under its tag, the one routines are told (tagFor)', async () => {
  const { tagFor } = require('../main/turns');
  const h = harness();
  const r = await h.turns.start({ text: 'Hi', requestId: 'rt1700000000abcdef' });
  await flush();
  assert.strictEqual(tagFor('rt1700000000abcdef'), 'abcdef');
  assert.deepStrictEqual(h.log.contexts.at(-1), { turn: 'abcdef', conv: r.conversationId.slice(-6) });
  const fs = require('fs');
  const main = fs.readFileSync(require('path').join(__dirname, '..', 'main', 'main.js'), 'utf8');
  assert.ok(main.includes('onTurn?.(tagFor(requestId));'), 'startRoutines reports the same tag');
});

// Which fields a Claude session keeps (and that a rolled-over one keeps none to resume) is claudesession.js's
// rule (test/claudeforget.test.js); turns.js stores what the brain hands back and then lets it warm.
test('the reply stores the brain’s convPatch, then the session hears the turn ended; only the user’s own message gets an attempt', async () => {
  const h = harness();
  h.llm.runTurn = async () => ({ text: 'Hi', model: 'm', convPatch: { claudeSessionId: 's9', claudeFreshTokens: 40000, claudeTokens: 52000 } });
  const r = await h.turns.start({ text: 'Hi', requestId: 'r1' });
  await flush();
  const c = h.stored(r.conversationId);
  assert.deepStrictEqual([c.claudeSessionId, c.claudeFreshTokens, c.claudeTokens], ['s9', 40000, 52000]);
  const saved = h.index((e) => e[0] === 'save' && e[1] === r.conversationId && e[2].messages.length === 2);
  const after = h.index((e) => e[0] === 'afterTurn' && e[1] === r.conversationId);
  assert.ok(saved >= 0 && after > saved, 'afterTurn gets the stored conversation, once it is saved');
  for (const opts of [{ routine: 'rt1' }, { auto: 'tasks' }, { hidden: true }]) {
    const t = await h.turns.start({ text: 'x', requestId: 'r3', ...opts });
    const first = h.trace.filter((e) => e[0] === 'save' && e[1] === t.conversationId && e[2].messages.length)[0][2];
    assert.ok(!('attempt' in first.messages.at(-1)), JSON.stringify(opts));
  }
});

test('a reply’s line in the log carries lengths, not words', async () => {
  const h = harness();
  await h.turns.start({ text: 'Secret words', requestId: 'r1' });
  await flush();
  const reply = h.logs.find((l) => l.event === 'reply');
  assert.strictEqual(reply.level, 'info');
  assert.strictEqual(reply.data.chars, 'Sure.'.length);
  assert.ok(!('text' in reply.data));
});
