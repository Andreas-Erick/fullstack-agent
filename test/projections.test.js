// What each audience sees of a chat message or event (main/projections.js): the window (no raw provider
// data; the start event's message without its running attempt) and a paired device (tool names only, an
// attempt as its outcome, attachments as names, no paths in error and notice text, no internal events).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const projections = require(path.join(ROOT, 'main/projections.js'));
const worldcore = require(path.join(ROOT, 'main/worldcore.js'));
const { messageFor, messagesFor, eventFor, reachesDevices, deviceText } = projections;

const IDS = { requestId: 'r1', conversationId: 'c1' };
const RAW = { provider: 'anthropic', blocks: [{ type: 'thinking', text: 'secret reasoning' }] };
const WIN_PATH = "EPERM: operation not permitted, rename 'C:\\Users\\Anna Berg\\AppData\\Roaming\\Siren Assistant\\conversations\\c1.json.tmp' -> 'C:\\Users\\Anna Berg\\x.json'";

const userMsg = { id: 'u1', role: 'user', content: 'hello', createdAt: 1, spoken: true, attempt: { outcome: 'running', at: 1 } };
const assistantMsg = {
  id: 'a1',
  role: 'assistant',
  content: 'Done.',
  toolCalls: [{ name: 'vault_search', input: { query: 'private words' }, result: 'a note’s text', ok: true }],
  raw: RAW,
  model: 'sonnet',
  provider: 'claude-code',
  createdAt: 2,
};
const { raw: _raw, ...assistantNoRaw } = assistantMsg;
const { attempt: _attempt, ...userNoAttempt } = userMsg;
const work = (name) => {
  const { place, label } = worldcore.workFor(name);
  return { place, label };
};

// ------------------------------------------------------------- events
// [name, event as the turn emits it, window view, what a device gets (the window's view, trimmed)]
const EVENTS = [
  ['start', { type: 'start', userMessage: userMsg, title: 'Hi' }, { type: 'start', userMessage: userNoAttempt, title: 'Hi' }, { type: 'start', title: 'Hi', userMessage: userNoAttempt }],
  ['start (run again)', { type: 'start', userMessage: userMsg, title: 'Hi', replaces: 'u0' }, { type: 'start', userMessage: userNoAttempt, title: 'Hi', replaces: 'u0' }, { type: 'start', title: 'Hi', userMessage: userNoAttempt, replaces: 'u0' }],
  ['text', { type: 'text', delta: 'Hel' }, { type: 'text', delta: 'Hel' }, { type: 'text', delta: 'Hel' }],
  ['retract', { type: 'retract', chars: 12 }, { type: 'retract', chars: 12 }, { type: 'retract', chars: 12 }],
  [
    'tool_start',
    { type: 'tool_start', id: 't1', name: 'vault_search', input: { query: 'private words' } },
    { type: 'tool_start', id: 't1', name: 'vault_search', input: { query: 'private words' } },
    { type: 'tool_start', id: 't1', name: 'vault_search', work: work('vault_search') },
  ],
  [
    'tool_end',
    { type: 'tool_end', id: 't1', name: 'vault_search', ok: true, result: 'a note’s text' },
    { type: 'tool_end', id: 't1', name: 'vault_search', ok: true, result: 'a note’s text' },
    { type: 'tool_end', id: 't1', name: 'vault_search', ok: true },
  ],
  [
    'notice (with tools)',
    { type: 'notice', message: 'Already done by the earlier attempt (not undone): vault write.', tools: ['vault_write'], cut: [] },
    { type: 'notice', message: 'Already done by the earlier attempt (not undone): vault write.', tools: ['vault_write'], cut: [] },
    { type: 'notice', message: 'Already done by the earlier attempt (not undone): vault write.' },
  ],
  [
    'notice (a path in it)',
    { type: 'notice', message: 'Model "C:\\Users\\Anna\\models\\x.gguf" can\'t see images', toast: true },
    { type: 'notice', message: 'Model "C:\\Users\\Anna\\models\\x.gguf" can\'t see images', toast: true },
    { type: 'notice', message: "Model … can't see images" },
  ],
  ['done', { type: 'done', message: assistantMsg }, { type: 'done', message: assistantNoRaw }, { type: 'done', message: { id: 'a1', role: 'assistant', content: 'Done.', model: 'sonnet', provider: 'claude-code', createdAt: 2, toolCalls: [{ name: 'vault_search', ok: true }] } }],
  ['error', { type: 'error', message: WIN_PATH }, { type: 'error', message: WIN_PATH }, { type: 'error', message: 'EPERM: operation not permitted, rename … -> …' }],
  ['error (only a path)', { type: 'error', message: 'C:\\x' }, { type: 'error', message: 'C:\\x' }, { type: 'error', message: 'The reply failed on the computer' }],
  ['error (no message)', { type: 'error' }, { type: 'error' }, { type: 'error', message: 'The reply failed on the computer' }],
  ['aborted', { type: 'aborted', message: 'Stopped' }, { type: 'aborted', message: 'Stopped' }, { type: 'aborted', message: 'Stopped' }],
  // Internal events stay on the window.
  ['persona_switched', { type: 'persona_switched', persona: 'Vega' }, { type: 'persona_switched', persona: 'Vega' }, null],
  ['settings_changed', { type: 'settings_changed', patch: { voice: {} } }, { type: 'settings_changed', patch: { voice: {} } }, null],
  ['tool_progress', { type: 'tool_progress', id: 't1', text: 'C:\\Users\\Anna\\x' }, { type: 'tool_progress', id: 't1', text: 'C:\\Users\\Anna\\x' }, null],
];

test('event → window / device, for every chat event type', () => {
  for (const [name, ev, win, dev] of EVENTS) {
    const full = { ...IDS, ...ev };
    assert.deepStrictEqual(eventFor('window', full), { ...IDS, ...win }, `window: ${name}`);
    // companion.js receives the window's view (main.js send) and trims it for devices.
    assert.deepStrictEqual(eventFor('device', eventFor('window', full)), dev && { ...IDS, ...dev }, `device: ${name}`);
    // Trimmed straight from the turn's event: the same, except that a start's attempt shows as its outcome.
    const direct = name.startsWith('start') ? { ...IDS, ...dev, userMessage: { ...dev.userMessage, attempt: { outcome: 'running' } } } : dev && { ...IDS, ...dev };
    assert.deepStrictEqual(eventFor('device', full), direct, `device, direct: ${name}`);
  }
  // Every type a device gets is in the table (a new one needs a row and a phone handler).
  const covered = new Set(EVENTS.filter((e) => e[3]).map((e) => e[1].type));
  assert.deepStrictEqual([...projections.DEVICE_EVENTS].sort(), [...covered].sort());
});

test('no event leaks a tool’s input or result, raw provider data or a path to a device', () => {
  for (const [name, ev] of EVENTS) {
    const out = JSON.stringify(eventFor('device', { ...IDS, ...ev }));
    assert.doesNotMatch(out, /private words|a note’s text|secret reasoning|Anna|Users/, name);
  }
});

test('the projections never change what the producer holds', () => {
  const ev = { ...IDS, type: 'done', message: { ...assistantMsg } };
  const copy = structuredClone(ev);
  eventFor('window', ev);
  eventFor('device', ev);
  assert.deepStrictEqual(ev, copy);
});

test('bad input: an unknown audience throws, a missing event is nothing', () => {
  assert.throws(() => eventFor('log', { type: 'text' }), /Unknown audience/);
  assert.throws(() => messageFor('phone', {}), /Unknown audience/);
  assert.strictEqual(eventFor('device', null), null);
  assert.strictEqual(eventFor('window', undefined), null);
  assert.deepStrictEqual(eventFor('device', { ...IDS, type: 'start', title: 'x' }), { ...IDS, type: 'start', title: 'x', userMessage: undefined });
});

// ------------------------------------------------------------- messages
const ATTACH = [
  { kind: 'pdf', name: 'Lecture 03.pdf', size: 1234, path: 'C:\\Users\\Anna\\x.pdf', thumb: 'data:image/jpeg;base64,xx' },
  { kind: 'image', name: 'b.png', width: 10, height: 10 },
];
// [name, stored message, window view, device view]
const MESSAGES = [
  ['plain user', { id: 'u', role: 'user', content: 'hi', createdAt: 1 }, { id: 'u', role: 'user', content: 'hi', createdAt: 1 }, { id: 'u', role: 'user', content: 'hi', createdAt: 1 }],
  ['assistant with raw and tools', assistantMsg, assistantNoRaw, { id: 'a1', role: 'assistant', content: 'Done.', model: 'sonnet', provider: 'claude-code', createdAt: 2, toolCalls: [{ name: 'vault_search', ok: true }] }],
  ['assistant, no tools', { id: 'a', role: 'assistant', content: 'x', toolCalls: [], raw: RAW }, { id: 'a', role: 'assistant', content: 'x', toolCalls: [] }, { id: 'a', role: 'assistant', content: 'x' }],
  ['a /skill', { id: 'u', role: 'user', content: 'EXPANDED SKILL STEPS', display: '/study physics', skill: 'study' }, { id: 'u', role: 'user', content: 'EXPANDED SKILL STEPS', display: '/study physics', skill: 'study' }, { id: 'u', role: 'user', content: '/study physics', skill: 'study' }],
  [
    'typed words + files',
    { id: 'u', role: 'user', content: '<attachment …>FILE TEXT</attachment>\n\nexplain', display: 'explain', attachments: ATTACH },
    { id: 'u', role: 'user', content: '<attachment …>FILE TEXT</attachment>\n\nexplain', display: 'explain', attachments: ATTACH },
    { id: 'u', role: 'user', content: 'explain', attachments: [{ kind: 'pdf', name: 'Lecture 03.pdf' }, { kind: 'image', name: 'b.png' }] },
  ],
  [
    'files only',
    { id: 'u', role: 'user', content: '<attachment …>FILE TEXT</attachment>', attachments: [ATTACH[0]] },
    { id: 'u', role: 'user', content: '<attachment …>FILE TEXT</attachment>', attachments: [ATTACH[0]] },
    { id: 'u', role: 'user', content: '', attachments: [{ kind: 'pdf', name: 'Lecture 03.pdf' }] },
  ],
  [
    'a failed attempt',
    { id: 'u', role: 'user', content: 'do it', attempt: { outcome: 'failed', error: 'C:\\Users\\Anna\\x', tools: [{ name: 'vault_write', input: { path: 'x' } }] } },
    { id: 'u', role: 'user', content: 'do it', attempt: { outcome: 'failed', error: 'C:\\Users\\Anna\\x', tools: [{ name: 'vault_write', input: { path: 'x' } }] } },
    { id: 'u', role: 'user', content: 'do it', attempt: { outcome: 'failed' } },
  ],
  ['an attempt without outcome', { id: 'u', role: 'user', content: 'x', attempt: {} }, { id: 'u', role: 'user', content: 'x', attempt: {} }, { id: 'u', role: 'user', content: 'x' }],
  ['a routine run', { id: 'u', role: 'user', content: 'LONG ROUTINE PROMPT', display: '⏰ Morning', routine: 'r1' }, { id: 'u', role: 'user', content: 'LONG ROUTINE PROMPT', display: '⏰ Morning', routine: 'r1' }, { id: 'u', role: 'user', content: '⏰ Morning', routine: 'r1' }],
];

test('message → window / device, for every message shape', () => {
  for (const [name, m, win, dev] of MESSAGES) {
    assert.deepStrictEqual(messageFor('window', m), win, `window: ${name}`);
    assert.deepStrictEqual(messageFor('device', m), dev, `device: ${name}`);
  }
  assert.strictEqual(messageFor('device', null), null);
  assert.strictEqual(messageFor('window', undefined), undefined);
});

test('a conversation’s messages: the window keeps hidden ones, devices never get them', () => {
  const list = [{ id: 'h', role: 'user', content: 'setup step', hidden: true }, assistantMsg];
  assert.deepStrictEqual(messagesFor('window', list), [list[0], assistantNoRaw]);
  assert.deepStrictEqual(
    messagesFor('device', list).map((m) => m.id),
    ['a1'],
  );
  assert.deepStrictEqual(messagesFor('device', undefined), []);
});

test('the setup conversation never reaches devices', () => {
  assert.strictEqual(reachesDevices({ id: 's', setup: true }), false);
  assert.strictEqual(reachesDevices({ id: 'c' }), true);
});

// ------------------------------------------------------------- path scrubbing (deviceText)
test('error text reaches devices without paths from this computer', () => {
  const f = (message) => deviceText({ message }, 'FALLBACK');
  assert.strictEqual(f('spawn C:\\Users\\anna\\AppData\\Roaming\\npm\\claude.cmd ENOENT'), 'spawn … ENOENT');
  assert.strictEqual(f('spawn C:\\Users\\Anna Berg\\npm\\claude.cmd ENOENT'), 'spawn … ENOENT');
  // A folder name of three words, or with two spaces in a row (a Windows profile): all of it goes.
  assert.strictEqual(f('spawn C:\\Users\\Anna Maria Berg\\AppData\\Roaming\\npm\\claude.cmd ENOENT'), 'spawn … ENOENT');
  assert.strictEqual(f('Cannot find module C:\\Users\\Jo Ann Lee\\x.js'), 'Cannot find module …');
  assert.strictEqual(f('spawn C:\\Users\\Anna  Berg\\npm\\claude.cmd ENOENT'), 'spawn … ENOENT');
  assert.strictEqual(f('open /Users/Anna Maria Berg/Library/x.md failed'), 'open … failed');
  assert.strictEqual(f('spawn C:\\Users\\Anna (Work)\\npm\\claude.cmd ENOENT'), 'spawn … ENOENT');
  assert.strictEqual(f('spawn C:\\Program Files (x86)\\Claude\\claude.exe ENOENT'), 'spawn … ENOENT');
  assert.strictEqual(f('Error (at C:\\x\\y.js:1:2) in the tool'), 'Error (at …) in the tool', 'a ")" right after a path ends it');
  assert.strictEqual(f('open C:\\x.md failed: try again later'), 'open … failed: try again later', 'words after a path stay when no slash follows them');
  assert.strictEqual(f('open \\\\server\\share\\x.md failed'), 'open … failed');
  assert.strictEqual(f('cannot read /home/anna/x'), 'cannot read …');
  assert.strictEqual(f('ENOENT: /Users/anna/Library/x.md'), 'ENOENT: …');
  assert.strictEqual(f("open 'C:\\Users\\O'Brien\\n.md'"), 'open …');
  // Bare paths keep their apostrophes too (Node's spawn ENOENT and "Cannot find module" name them unquoted).
  assert.strictEqual(f("spawn C:\\Users\\O'Brien\\AppData\\Roaming\\npm\\claude.cmd ENOENT"), 'spawn … ENOENT');
  assert.strictEqual(f("spawn C:\\Users\\Anna O'Brien\\npm\\claude.cmd ENOENT"), 'spawn … ENOENT');
  assert.strictEqual(f("spawn /Users/o'brien/bin/claude ENOENT"), 'spawn … ENOENT');
  assert.strictEqual(f("open C:\\x.md failed: it's busy"), "open … failed: it's busy", 'an apostrophe after the path’s end stays');
  assert.strictEqual(f('open "D:/Siren Vault/Notes/a b.md": EBUSY'), 'open …: EBUSY');
  for (const keep of ['You’ve hit your usage limit · resets 8pm', "You've hit your usage limit · resets 8pm", 'nothing answers at localhost:11434', 'https://api.example.com/x failed', 'LLM error 429: rate limited', 'مرحبا بالعالم']) assert.strictEqual(f(keep), keep);
  for (const empty of ['', '   ', 'C:\\x', '"C:\\Users\\x"', '\\\\server\\share']) assert.strictEqual(f(empty), 'FALLBACK', JSON.stringify(empty));
  assert.strictEqual(deviceText(null, 'FALLBACK'), 'FALLBACK');
  // Pathological input returns at once and short (the patterns don't backtrack; only 2,000 characters are read).
  const worst = f("'C:\\".repeat(50000));
  assert.ok(worst.length <= 300);
  assert.ok(f('C:\\a '.repeat(20000)).length <= 300);
  assert.strictEqual(f(`C:\\x ${'word '.repeat(20000)}`), `… ${'word '.repeat(20000)}`.slice(0, 300).trim(), 'slash-less words after a path stay');
  const rtl = 'مرحبا'.repeat(2000);
  assert.strictEqual(f(rtl), rtl.slice(0, 300));
  assert.ok(f('👨‍👩‍👧‍👦 C:\\Users\\x\\y '.repeat(500)).length <= 300);
});

test('a notice keeps up to 2,000 characters (an error 300), both read in linear time', () => {
  const long = `Already done: ${'tool name, '.repeat(100)}`.trim();
  assert.strictEqual(eventFor('device', { ...IDS, type: 'notice', message: long }).message, long.slice(0, 2000));
  assert.ok(eventFor('device', { ...IDS, type: 'error', message: long }).message.length <= 300);
  const started = Date.now();
  const out = eventFor('device', { ...IDS, type: 'notice', message: "'C:\\".repeat(50000) }).message;
  assert.ok(out.length <= 2000);
  assert.ok(Date.now() - started < 2000);
  assert.strictEqual(eventFor('device', { ...IDS, type: 'notice', message: 'C:\\x' }).message, 'Notice from the computer');
});

test('seeded: a path in an error message never reaches a device, quoted or bare, whatever its folder names', () => {
  function rng(seed) {
    let x = seed >>> 0 || 1;
    return () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), (x >>> 0) / 2 ** 32);
  }
  const seed = 20261118;
  const rand = rng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const words = ['EBUSY:', 'open', 'failed', 'resource busy', 'spawn', 'ENOENT', 'at', 'reading', '·', 'مرحبا', '👨‍👩‍👧‍👦', 'x=1', 'https://api.example.com/v1', 'localhost:3001'];
  const roots = ['C:\\', 'D:/', 'c:\\', '\\\\nas\\', '/Users/', '/home/', '/tmp/', '/var/'];
  for (let i = 0; i < 300; i++) {
    const secret = `Zq${i}x`;
    const quoted = rand() < 0.5;
    // Bare paths: a folder name may have spaces (several words, two in a row) when a slash follows, and
    // apostrophes (O'Brien); quoted ones also spaces anywhere and apostrophes inside a word, never the closing
    // quote followed by a gap. A spaced folder after the name is cut too; a spaced file name at the end may
    // leave its last word.
    const bare = [secret, `${secret} Berg`, `Anna ${secret}`, `${secret} Maria Berg`, `Jo ${secret} Lee`, `Anna  ${secret}`, `${secret} van der Berg`, `Anna (${secret})`, `(${secret}) Berg`, `O'${secret}`, `${secret}'s files`, `D'${secret} Berg`];
    const name = quoted ? pick([secret, `${secret} Berg`, `O'${secret}`, `${secret}'s files`, `${secret} Maria Berg`]) : pick(bare);
    const sep = rand() < 0.5 ? '\\' : '/';
    const tail = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(['AppData', 'Siren Vault', 'npm', 'Notes', 'a.md', 'x y', 'Program Files (x86)']));
    let p = `${pick(roots)}${name}${sep}${tail.join(sep) || 'f.md'}`;
    if (quoted) {
      const q = pick(["'", '"', '`']);
      p = `${q}${p}${q}`;
    }
    const message = [pick(words), pick(words), p, pick(['', ',', ':', ';', '.'])].join(' ').replace(/ ([,:;.])$/, '$1') + (rand() < 0.5 ? ` ${pick(words)}` : '');
    const where = (out) => `seed ${seed} case ${i}: ${JSON.stringify(message)} → ${JSON.stringify(out)}`;
    // Errors and notices: the same cutting.
    for (const type of ['error', 'notice']) {
      const out = eventFor('device', { ...IDS, type, message }).message;
      assert.ok(!out.includes(secret), `${type} ${where(out)}`);
    }
    const out = deviceText({ message }, 'FALLBACK');
    assert.ok(!out.includes(secret), where(out));
    assert.ok(out.length <= 300, where(out));
  }
});
