// Formatting in the Notes editor (renderer/js/notesedit.js): titles, lists, checklists, quotes, bold and
// italic, links, lists that continue on Enter, indenting, and where a click on the rendered note lands.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

let e;
test.before(async () => {
  const copy = path.join(tmpDir('nexus-notesedit-'), 'notesedit.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/notesedit.js'), copy);
  e = await import(pathToFileURL(copy).href);
});

const apply = (text, ed) => ({ text: text.slice(0, ed.from) + ed.insert + text.slice(ed.to), start: ed.start, end: ed.end });
const at = (text, caret) => ({ text, start: caret, end: caret });

test('titles and subtitles: set, switch level, take off; the caret stays on its word', () => {
  const t = 'intro\nMy idea\nmore';
  let r = apply(t, e.heading(at(t, 9), 1));
  assert.strictEqual(r.text, 'intro\n# My idea\nmore');
  assert.strictEqual(r.start, 11);
  r = apply(r.text, e.heading(at(r.text, 11), 2));
  assert.strictEqual(r.text, 'intro\n## My idea\nmore', 'another level replaces it');
  r = apply(r.text, e.heading(at(r.text, 12), 2));
  assert.strictEqual(r.text, 'intro\nMy idea\nmore', 'the same level again takes it off');
  assert.strictEqual(apply('- item', e.heading(at('- item', 3), 1)).text, '# item', 'a list item becomes a heading');
});

test('bullets, numbers and checklists on several lines; again takes them off', () => {
  const t = 'eggs\nmilk\n\nbread';
  const sel = { text: t, start: 0, end: t.length };
  assert.strictEqual(apply(t, e.list(sel, 'bullet')).text, '- eggs\n- milk\n\n- bread');
  assert.strictEqual(apply(t, e.list(sel, 'number')).text, '1. eggs\n2. milk\n\n3. bread');
  assert.strictEqual(apply(t, e.list(sel, 'task')).text, '- [ ] eggs\n- [ ] milk\n\n- [ ] bread');
  const numbered = '1. eggs\n2. milk';
  assert.strictEqual(apply(numbered, e.list({ text: numbered, start: 0, end: numbered.length }, 'number')).text, 'eggs\nmilk');
  assert.strictEqual(apply(numbered, e.list({ text: numbered, start: 0, end: numbered.length }, 'bullet')).text, '- eggs\n- milk', 'numbers become bullets');
  assert.strictEqual(apply('a', e.list(at('a', 1), 'bullet')).text, '- a');
  assert.strictEqual(apply('', e.list(at('', 0), 'bullet')).text, '- ', 'on an empty line: ready to type');
});

test('Enter continues a list, counts up, empties checkboxes, ends on an empty item', () => {
  let t = '- eggs';
  let r = apply(t, e.enter(at(t, t.length)));
  assert.deepStrictEqual([r.text, r.start], ['- eggs\n- ', 9]);
  r = apply(r.text, e.enter(at(r.text, r.text.length)));
  assert.strictEqual(r.text, '- eggs\n', 'an empty item ends the list');
  t = '1. first';
  assert.strictEqual(apply(t, e.enter(at(t, t.length))).text, '1. first\n2. ');
  t = '  - [x] done';
  assert.strictEqual(apply(t, e.enter(at(t, t.length))).text, '  - [x] done\n  - [ ] ', 'nested, unchecked');
  assert.strictEqual(apply('> said', e.enter(at('> said', 6))).text, '> said\n> ');
  assert.strictEqual(e.enter(at('plain', 5)), null, 'not a list: just Enter');
  assert.strictEqual(e.enter(at('- x', 1)), null, 'caret inside the marker');
  assert.strictEqual(e.enter({ text: '- abc', start: 2, end: 4 }), null, 'a selection');
});

test('Tab indents list items; other lines keep Tab for leaving the editor', () => {
  assert.strictEqual(apply('- a', e.indent(at('- a', 3))).text, '  - a');
  assert.strictEqual(apply('  - a', e.indent(at('  - a', 5), true)).text, '- a');
  assert.strictEqual(e.indent(at('text', 2)), null);
});

test('bold, italic, quote and links', () => {
  let r = apply('make it bold', e.wrap({ text: 'make it bold', start: 8, end: 12 }, '**'));
  assert.deepStrictEqual([r.text, r.start, r.end], ['make it **bold**', 10, 14]);
  r = apply(r.text, e.wrap({ text: r.text, start: 10, end: 14 }, '**'));
  assert.strictEqual(r.text, 'make it bold', 'again: off');
  assert.strictEqual(apply('one word', e.wrap(at('one word', 6), '*')).text, 'one *word*', 'the word at the caret');
  assert.strictEqual(apply('a b', e.quote({ text: 'a b', start: 0, end: 3 })).text, '> a b');
  assert.strictEqual(apply('> a b', e.quote(at('> a b', 3))).text, 'a b');
  r = apply('see PID tuning', e.link({ text: 'see PID tuning', start: 4, end: 14 }));
  assert.strictEqual(r.text, 'see [[PID tuning]]');
  r = apply('see ', e.link(at('see ', 4)));
  assert.deepStrictEqual([r.text, r.start], ['see [[', 6]);
});

test('a checkbox ticked in the rendered note is ticked in the text', () => {
  const t = '- [ ] eggs\n- [x] milk\n  - [ ] oat\ntext [ ] not a task';
  assert.strictEqual(e.toggleTask(t, 0), '- [x] eggs\n- [x] milk\n  - [ ] oat\ntext [ ] not a task');
  assert.strictEqual(e.toggleTask(t, 1), '- [ ] eggs\n- [ ] milk\n  - [ ] oat\ntext [ ] not a task');
  assert.strictEqual(e.toggleTask(t, 2), '- [ ] eggs\n- [x] milk\n  - [x] oat\ntext [ ] not a task');
  assert.strictEqual(e.toggleTask(t, 9), t);
});

test('the toolbar knows the line; a click on the rendered note finds its place in the text', () => {
  assert.deepStrictEqual(e.formatsAt('# T\n1. x', 6), { heading: 0, list: 'number', quote: false });
  assert.deepStrictEqual(e.formatsAt('## T', 2), { heading: 2, list: '', quote: false });
  const src = '# Plan\n\nChapter 2 needs the IK derivation. Link it later.\n\n- Finish related work by Friday';
  assert.strictEqual(e.sourceOffset(src, 'Chapter 2 needs the IK derivation. Link it later.', 8), src.indexOf('Chapter 2') + 8);
  assert.strictEqual(e.sourceOffset(src, 'Finish related work by Friday', 6), src.indexOf('Finish') + 6);
  assert.strictEqual(e.sourceOffset(src, 'Finish related work by Friday', 999), src.length, 'never past its line');
  assert.strictEqual(e.sourceOffset(src, 'not in there at all', 0), -1);
});
