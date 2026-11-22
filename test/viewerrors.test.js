// How views show errors: Settings' card intros are its own HTML (never through the Markdown sanitizer) and a
// card that fails shows its error as text; an unreadable Schedule.md is a warning on the title-bar light;
// the routine and schedule editors ask before discarding changes; the Memory view words main's errors with
// util.js plainError.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { settingsSource } = require('./helpers');
const fx = require('./appfixture')('viewerrors');
const { dir, store, read } = fx;

test('Settings never sends its card intros through the Markdown sanitizer, and a failed card’s error is text', () => {
  const src = settingsSource();
  for (const re of [/\brenderMarkdown\b/, /\bsanitizeHtml\b/, /\bDOMPurify\b/, /\bmarked\s*\.\s*parse\b/]) assert.doesNotMatch(src, re, `settings.js uses ${re.source}`);
  const cardFn = /function card\(id, title, desc, \.\.\.children\) \{\n([\s\S]*?)\n\}/.exec(src);
  assert.ok(cardFn, 'settings.js has card(id, title, desc, ...children)');
  assert.match(cardFn[1], /desc \? el\('p', \{ class: 'desc', html: desc \}\)/, 'the intro is the card’s own HTML');
  // el()'s html is innerHTML as given: the sanitizer is only renderMarkdown's and sanitizeHtml's.
  const util = read('renderer/js/util.js');
  assert.match(util, /else if \(k === 'html'\) node\.innerHTML = v;/);
  const elFn = util.slice(util.indexOf('export function el('), util.indexOf('\n}\n', util.indexOf('export function el(')));
  assert.doesNotMatch(elFn, /sanitize|DOMPurify/);
  // The intros that rely on it still carry their markup.
  assert.match(src, /card\(\s*'github',[\s\S]{0,600}?<b>|card\(\s*'calendar',[\s\S]{0,400}?<b>Schedule\.md<\/b>/);
  // A card that fails to build shows its error as a text child, never as an intro's HTML.
  assert.match(src, /return card\(id, title, '', el\('div', \{ class: 'test-result err', role: 'alert' \}, `This section couldn’t load: \$\{err\?\.message \|\| err\}`\)/);
});

test('a Schedule.md that can’t be read: calendar.status says why, and the title-bar light shows it as a warning', async () => {
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vault, 'Schedule.md'), { recursive: true }); // there, but no file to read
  await store.setSettings({ obsidian: { enabled: true, vaultPath: vault }, calendar: { enabled: true } });
  const st = await require('../main/calendar').status();
  assert.strictEqual(st.enabled, true);
  assert.strictEqual(st.connected, true, 'the tools and the view stay available');
  assert.match(st.unreadable || '', /Couldn't read Schedule\.md/);
  assert.match(read('renderer/js/app.js'), /c\.enabled && c\.unreadable \? setPill\('#pillCal', 'warn', `Schedule\.md couldn’t be read: \$\{c\.unreadable\}`\)/);
});

test('the routine and calendar editors pass a dirty check, which modal() honours', () => {
  assert.match(read('renderer/js/util.js'), /export function modal\(build, \{ dirty = null \} = \{\}\) \{/);
  assert.match(read('renderer/js/util.js'), /const dismiss = \(\) => \(dirty\?\.\(\) \? \(asking \? keep\(\) : ask\(\)\) : close\(null\)\);/);
  assert.match(read('renderer/js/routines.js'), /\{ dirty: \(\) => snapshot\(\) !== start \},\s*\);/);
  assert.match(read('renderer/js/calendar.js'), /\}, \{ dirty: \(\) => JSON\.stringify\(f\) !== start \}\)/);
});

// memory.js had its own copy of util.js plainError (ipcMessage), which made an empty notice
// for an error without a message; plainError says "Something went wrong." then.
test('the Memory view names main’s errors with util.js plainError, never a copy of its own', () => {
  const src = read('renderer/js/memory.js');
  assert.ok(!src.includes('Error invoking remote method'), 'no local copy of the pattern');
  assert.ok(!/\bipcMessage\b/.test(src));
  assert.match(src, /toastError\(plainError\(err\)\); \/\/ e\.g\. "This file isn't a memory export…"/);
  assert.match(src, /Couldn’t read your memories: \$\{plainError\(failed\)\} /);
  assert.match(read('renderer/js/util.js'), /\|\| 'Something went wrong\.';\n\}/, 'plainError never answers with nothing');
});
