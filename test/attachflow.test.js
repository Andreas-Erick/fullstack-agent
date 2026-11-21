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

// send() takes the tray only for the user's own words; the merged send() (ORDER.md §3.1) adds actions' `!again`.
const WITH_FILES = /const withFiles = attach && !hidden && (?:!again && )?!state\.setupMode && attachmentCount\(\) > 0;/;

test('the source check of send() also passes on the merged line', () => {
  assert.match('  const withFiles = attach && !hidden && !again && !state.setupMode && attachmentCount() > 0;', WITH_FILES);
  assert.match('  const withFiles = attach && !hidden && !state.setupMode && attachmentCount() > 0;', WITH_FILES);
  assert.doesNotMatch('  const withFiles = attach && !state.setupMode && attachmentCount() > 0;', WITH_FILES, 'a hidden message never takes the tray');
});

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

test('chat.js: Enter follows sendPlan; only the user’s own words take the tray; speech waits in the box', () => {
  const src = read('renderer/js/chat.js');
  const sendFromInput = fn(src, 'sendFromInput');
  assert.match(sendFromInput, /attachcore\.sendPlan\(/);
  assert.match(sendFromInput, /if \(plan === 'wait'\) return waitForFiles\(sendFromInput\)/);
  assert.match(sendFromInput, /send\(text, \{ attach: true \}\)/);
  // Regression: a message queued behind the reply being stopped, then a second one waiting for a dropped
  // file, went out in reverse order and the earlier one interrupted the later one's reply.
  assert.match(sendFromInput, /waiting: Boolean\(waitingFiles \|\| queued\)/);
  const send = fn(src, 'send');
  assert.match(send, WITH_FILES);
  assert.match(send, /const files = withFiles \? takeAttachments\(\) : \{ tokens: \[\], meta: \[\] \}/);
  assert.match(send, /attachments: files\.tokens/);
  assert.match(send, /restoreAttachments\(files\)/, 'a failed send gives the chips back');
  const voice = fn(src, 'sendVoice');
  // …and so do they while a message is queued behind the reply being stopped (they never take its place).
  assert.match(voice, /if \(waitingFiles \|\| queued\) \{[\s\S]*input\.value = \(input\.value \? `\$\{input\.value\} ` : ''\) \+ text;[\s\S]*return;/);
  assert.match(voice, /send\(text, \{ voice: true, attach: true \}\)/);
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
