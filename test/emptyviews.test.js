// Empty views offer a first step (spec #17, ONB-11, user stories 51-54): Calendar, Documents, Library and
// "Changes Siren made to itself" each say in one sentence what belongs there and offer one action
// (renderer/js/firststep.js), like Notes, Memories and Skills; a notes library that is off is turned on, or
// its folder picked, right in the view instead of a trip to Settings. These are source contracts: the views
// only exist in the DOM, and the smoke check walks every view for clipped text and unnamed controls.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const firststep = read('renderer/js/firststep.js');
const calendar = read('renderer/js/calendar.js');
const knowledge = read('renderer/js/knowledge.js');
const docs = read('renderer/js/docs.js');
const evolution = read('renderer/js/evolution.js');
const html = read('renderer/index.html');

// The body of a top-level function in a source file.
const fn = (src, name) => {
  const at = src.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(at >= 0, `${name}() exists`);
  const end = src.indexOf('\n}\n', at);
  return src.slice(at, end + 2);
};

test('the notes library action turns it on, or picks its folder, in place', () => {
  const action = fn(firststep, 'libraryAction');
  assert.match(action, /status\?\.enabled === false/, 'off and folder-missing are told apart');
  assert.match(action, /saveSettings\(\{ obsidian: \{ enabled: true \} \}\)/, 'off: one click turns it on');
  assert.match(action, /api\.dialog\.pickFolder\(/, 'folder missing: the folder picker opens directly');
  assert.match(action, /vaultPath: dir/, 'the picked folder becomes the library');
  assert.match(action, /if \(!dir\) return;/, 'a cancelled picker saves nothing');
  assert.match(action, /emit\('status-refresh'\)/, 'the title-bar lights follow');
  assert.doesNotMatch(firststep, /switchView\('settings'/, 'never a trip to Settings');
});

test('Calendar: nothing in range offers Add an event and something to say; off states act in place', () => {
  const planned = fn(calendar, 'nothingPlanned');
  assert.match(planned, /'Nothing planned yet'/);
  assert.match(planned, /＋ Add an event/);
  assert.match(planned, /editor\(/, 'the button opens the entry editor');
  assert.match(planned, /ask: \{ label: '“remind me Friday at 3”'/, 'an example sentence to say');
  assert.match(calendar, /nothingIn\(from, to\) \? nothingPlanned\('cal-first'\)/, 'month and week show it above the grid');
  assert.match(fn(calendar, 'agendaView'), /nothingPlanned\(/, 'the agenda too');
  const nothing = fn(calendar, 'nothingIn');
  assert.match(nothing, /cal\.events\.length/, 'events in range count');
  assert.match(nothing, /tasksOn\(d\)/, 'tasks from the to-do apps count');
  const off = fn(calendar, 'offPanel');
  assert.match(off, /saveSettings\(\{ calendar: \{ enabled: true \} \}\)/, 'a calendar that is off is turned on here');
  assert.match(off, /libraryAction\(library, refresh\)/, 'the library off: its action, then the view refreshes');
  assert.doesNotMatch(calendar, /switchView\('settings'/, 'no Open settings detour');
});

test('Library: the library off gets a plain explanation and the action, not "Vault disabled"', () => {
  const refresh = fn(knowledge, 'refresh');
  assert.match(refresh, /firstStep\(/);
  assert.match(refresh, /libraryAction\(st, refresh\)/);
  assert.match(refresh, /libraryOffText\(st,/);
  assert.doesNotMatch(knowledge, /Vault disabled|Vault settings|switchView\('settings'/);
});

test('Documents: the empty viewer says what opens there and has Open a file…', () => {
  const empty = html.slice(html.indexOf('<div class="doc-empty">'), html.indexOf('</div>\n            </div>', html.indexOf('<div class="doc-empty">')));
  assert.match(empty, /class="first-step"/);
  assert.match(empty, /PDF, Word document/);
  assert.match(empty, /<button class="btn primary" id="docOpenEmpty">📂 Open a file…<\/button>/);
  assert.match(docs, /\$\('#docOpenEmpty'\)\.onclick = pick;/, 'the same picker as the header button');
  assert.match(docs, /\$\('#docOpen'\)\.onclick = pick;/);
});

test('Changes Siren made to itself: "No changes yet" says what will appear and how to ask', () => {
  const at = evolution.indexOf('if (!log.length)');
  const line = evolution.slice(at, evolution.indexOf('\n', at));
  assert.match(line, /firstStep\(\{/);
  assert.match(line, /'No changes yet'/);
  assert.match(line, /appears here/, 'one sentence saying what will appear');
  assert.match(line, /ask: \{/, 'something to ask for, prefilled in the box');
});

test('the first step prefills the message box, never sends', () => {
  const prefill = fn(firststep, 'prefillChat');
  assert.match(prefill, /input\.value = text/);
  assert.doesNotMatch(prefill, /send\(|submit|requestSubmit|dispatchEvent\(new KeyboardEvent/);
});

test('the first step uses theme tokens only', () => {
  const css = read('renderer/styles.css');
  const rules = css.split('\n').filter((l) => /^\.(first-step|cal-first|cal-agenda-first|evo-first)/.test(l));
  assert.ok(rules.length >= 5);
  for (const r of rules) assert.doesNotMatch(r, /#[0-9a-f]{3,8}\b|rgba?\(\d/i, `no hard-coded colour: ${r}`);
});
