// Sending a message with attachments (renderer/js/chat.js, js/attach.js, main/main.js startTurn): what Enter
// does while files are still being read (attachcore.sendPlan), and the contracts that keep attachments to the
// user's own messages in the window: never a device, a routine, the app's own turns or a hidden message.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, load } = require('./helpers');

const core = load('main/attachcore.js');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// The text of one top-level function, from its line to the next top-level one.
function fn(src, name) {
  const start = src.search(new RegExp(`^(export )?(async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `${name} exists`);
  const rest = src.slice(start + 1);
  const end = rest.search(/^(export |async |function |const |let |\/\/ -)/m);
  return src.slice(start, end < 0 ? undefined : start + 1 + end);
}

test('sendPlan: what Enter does with the composer', () => {
  const plan = (o) => core.sendPlan({ text: '', files: 0, reading: false, active: false, waiting: false, ...o });
  // A send already waits for its files: a second Enter (or anything else) does nothing.
  assert.strictEqual(plan({ waiting: true }), 'hold');
  assert.strictEqual(plan({ waiting: true, text: 'hi', files: 2, reading: true, active: true }), 'hold');
  assert.strictEqual(plan({}), 'none');
  assert.strictEqual(plan({ text: '   ' }), 'none');
  assert.strictEqual(plan({ files: 1, reading: true }), 'wait');
  assert.strictEqual(plan({ text: 'hi', files: 1, reading: true }), 'wait', 'the words wait in the box');
  assert.strictEqual(plan({ text: 'hi', files: 1, reading: true, active: true }), 'wait', 'read first, then interrupt');
  assert.strictEqual(plan({ text: 'hi', active: true }), 'queue');
  assert.strictEqual(plan({ files: 1, active: true }), 'queue', 'files alone interrupt too');
  assert.strictEqual(plan({ text: 'hi' }), 'send');
  assert.strictEqual(plan({ files: 1 }), 'send', 'files without words');
});

test('devices never send attachments: the companion server starts turns without them', () => {
  const src = read('main/companion.js');
  const calls = [...src.matchAll(/hooks\.startTurn\(\{([^}]*)\}\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.ok(!/attachments/.test(c), c);
});

// The turn's own rules (claimed before anything is stored, refused for turns that aren't the user's own, the
// order claim → save → compose → store → release → run, the taint) are shown in test/turns.test.js.
test('only chat:send hands a turn tokens: routines and the app’s own turns never pass them', () => {
  const main = read('main/main.js');
  assert.ok(!/(?<!\.)startTurn\(\{/.test(main), 'turns start through turns.start');
  const callers = [...main.matchAll(/turns\.start\(\{([^}]*)\}\)/g)].map((m) => m[1]).filter((c) => !/attachments: Array\.isArray\(tokens\)/.test(c));
  assert.ok(callers.length >= 1, 'the other callers are checked');
  for (const c of callers) assert.ok(!/attachments/.test(c), c);
});

// What Enter, spoken words, a redo and a suggestion do (the wait for files, the queue behind a reply being
// stopped, the tray only for the user's own words, words and files given back) is shown through the outbox's
// interface in test/outbox.test.js. chat.js only has to route every source through it.
test('chat.js: every message goes through the outbox, which alone decides with sendPlan', () => {
  const src = read('renderer/js/chat.js');
  assert.ok(!/sendPlan|waitingFiles\s*=|queued\s*=|editing\s*=/.test(src), 'no send state or plan of its own');
  assert.ok(!/takeAttachments|restoreAttachments|attachmentsReading|attachmentCount/.test(src), 'the tray reaches chat.js only through the outbox');
  assert.match(src, /e\.key === 'Enter'[\s\S]{0,120}outbox\.typed\(\);/, 'Enter');
  assert.match(src, /\$\('#sendBtn'\)\.onclick = \(\) => outbox\.typed\(\);/, 'the send button');
  assert.match(fn(src, 'sendVoice'), /outbox\.spoken\(text, \{ autoSend: state\.settings\.stt\.autoSend \}\)/, 'spoken words');
  assert.match(fn(src, 'send'), /await outbox\.submit\(text, opts\);/, 'suggestions, skill runs, setup, redo');
  assert.match(fn(src, 'finish'), /outbox\.replyEnded\(\);/, 'the queued message goes after the reply');
  // deliver sends what the outbox handed it: the tokens it took, never the tray itself.
  assert.match(fn(src, 'deliver'), /attachments: files\.tokens/);
  assert.match(fn(src, 'startEdit'), /if \(!outbox\.startEdit\(id, m \? redo\.sentText\(m\) : null\)\) return;/);
  const outbox = read('renderer/js/outbox.js');
  assert.strictEqual(outbox.split('sendPlan(').length, 2, 'one sendPlan call, for every source');
  // Suggestions, skill runs, the Arch and Inner World views and setup call send() without attach.
  for (const rel of ['renderer/js/skills.js', 'renderer/js/archmap.js', 'renderer/js/innerworld.js', 'renderer/js/setup.js']) assert.ok(!/attach:\s*true/.test(read(rel)), rel);
});

test('the window hands main bytes, never a path', () => {
  const src = read('renderer/js/attach.js');
  assert.ok(!/getPathForFile|\.path\b/.test(src.replace(/c\.path|meta\.path/g, '')), 'no file paths read from the system');
  assert.match(src, /api\.chat\.attach\(\{ name: file\.name, type: file\.type \|\| '', bytes: new Uint8Array\(await file\.arrayBuffer\(\)\) \}\)/);
  const preload = read('preload.js');
  assert.match(preload, /chat: \[[^\]]*'attach'/);
});
