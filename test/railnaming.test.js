// The rail and the names (spec #17, "Navigation and naming"): the everyday places on the rail, the rest
// one click away under More, each place called by one name (the rail label, its aria-label and the view's
// title agree), the builder words gone from what people read, and the HUD's codes only at the full level.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const html = read('renderer/index.html');

const RAIL = ['Chat', 'Notes', 'Calendar', 'Memories', 'Documents', 'More', 'Settings'];
const MORE = [['face', 'Face'], ['skills', 'Skills & routines'], ['world', 'Inner World'], ['knowledge', 'Library'], ['arch', 'How Siren works'], ['evolution', 'Changes Siren made to itself']];

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const block = (open, close) => {
  const at = html.indexOf(open);
  assert.ok(at >= 0, `${open} is in index.html`);
  return html.slice(at, html.indexOf(close, at));
};
const rail = block('<nav class="rail"', '</nav>');
const menu = block('id="moreMenu"', '</div>');
// Every button of the rail or the More menu: its attributes and the visible label (the <span>).
const buttons = (src) => [...src.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, body]) => {
  const attr = (n) => {
    const m = new RegExp(`\\s${n}="([^"]*)"`).exec(attrs);
    return m ? decode(m[1]) : null;
  };
  return { view: attr('data-view'), aria: attr('aria-label'), title: attr('title'), role: attr('role'), id: attr('id'), attrs, label: decode((/<span>([^<]*)<\/span>/.exec(body) || [])[1] || '') };
});

test('the rail holds the everyday places, More and Settings, in that order', () => {
  const top = buttons(rail);
  assert.deepStrictEqual(top.map((b) => b.label), RAIL);
  assert.deepStrictEqual(top.map((b) => b.view), ['chat', 'notes', 'calendar', 'memory', 'docs', null, 'settings']);
  assert.ok(top.length <= 7, 'at most seven places');
});

test('More is a menu button whose popover lists every other place, one click away', () => {
  const more = buttons(rail).find((b) => b.label === 'More');
  assert.strictEqual(more.id, 'railMore');
  assert.match(more.attrs, /aria-haspopup="menu"/);
  assert.match(more.attrs, /aria-expanded="false"/);
  assert.match(more.attrs, /aria-controls="moreMenu"/);
  assert.match(menu, /role="menu"/);
  const items = buttons(menu);
  assert.deepStrictEqual(items.map((b) => [b.view, b.label]), MORE);
  for (const b of items) assert.strictEqual(b.role, 'menuitem', `${b.label} is a menu item`);
  // Every view is reachable: from the rail or from More.
  const views = [...html.matchAll(/<section class="view[^"]*" id="view-(\w+)"/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual([...buttons(rail), ...items].map((b) => b.view).filter(Boolean).sort(), views);
});

test('the More menu opens and closes like a menu: arrow keys, Esc returns the focus, a choice closes it', () => {
  const src = read('renderer/js/moremenu.js');
  for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape']) assert.match(src, new RegExp(`'?${k}'?`), k);
  assert.match(src, /aria-expanded/);
  assert.match(src, /\.focus\(\)/);
  assert.match(read('renderer/js/app.js'), /initMoreMenu/);
  // The More button is marked while one of its places is open.
  assert.match(read('renderer/js/nav.js'), /railMore/);
});

test('each place has one name: the visible label, its aria-label, the tooltip and the view\'s title agree', () => {
  const kb = read('renderer/js/knowledge.js');
  assert.doesNotMatch(kb, /kbTitle'\)\.textContent/, 'the Library keeps its title');
  for (const b of [...buttons(rail), ...buttons(menu)]) {
    assert.strictEqual(b.aria, b.label, `${b.label}: aria-label`);
    assert.ok(b.title && b.title.startsWith(b.label), `${b.label}: the tooltip starts with the name (${b.title})`);
    if (!b.view) continue;
    const view = block(`id="view-${b.view}"`, '</section>');
    const h2 = /<h2[^>]*>([^<]*)<\/h2>/.exec(view);
    if (b.view === 'chat' || b.view === 'face') continue; // the chat's title is the conversation's; the face has none
    assert.ok(h2, `${b.label} has a title`);
    assert.strictEqual(decode(h2[1]), b.label, `${b.view}: the title matches the rail`);
  }
});

test('the Library browses: notes are written in Notes, so it has no New-note button', () => {
  const lib = block('id="view-knowledge"', '</section>');
  assert.doesNotMatch(lib, /New note|id="kbNew"/);
  assert.doesNotMatch(read('renderer/js/knowledge.js'), /kbNew/);
});

// Strings people read in the window: the page, the views' scripts and the phone client. Comments don't count.
// renderer/js/settings/ (ticket #23) and the wizard (ticket #19) reword their own cards and steps.
const LATER = new Set(['renderer/js/onboarding.js', 'renderer/js/settings']);
const files = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
  const rel = `${dir}/${d.name}`;
  if (LATER.has(rel)) return [];
  if (d.isDirectory()) return files(rel);
  return /\.(m?js|html)$/.test(d.name) ? [rel] : [];
});
const uncommented = (src) => src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('no builder words for places: Config, Configuration, Memory vault, Knowledge base', () => {
  const found = [];
  for (const rel of ['renderer/index.html', ...files('renderer/js'), ...files('renderer/remote')]) {
    const src = uncommented(read(rel));
    for (const word of [/\bConfig\b(?![.:(\w])/, /\bConfiguration\b/, /memory vault/i, /knowledge base/i, /vault[’']s bin/i]) {
      const m = word.exec(src);
      if (m) found.push(`${rel}: ${src.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepStrictEqual(found, []);
});

test('the HUD\'s system codes ("SYS.03 //") show only at the full HUD level', () => {
  const css = read('renderer/hud.css');
  assert.doesNotMatch(css, /fx-subtle\)? \[data-hud-code\]/, 'the subtle level shows no code');
  assert.match(css, /\.fx-hud \[data-hud-code\]::before/);
  const hud = read('renderer/js/hud.js');
  const codes = hud.slice(hud.indexOf('function systemCodes'));
  assert.match(codes.slice(0, 600), /fxLevel\(\) === 'hud'/);
  assert.match(codes.slice(0, 600), /delete title\.dataset\.hudCode/);
  // Re-applied when the effects level changes.
  assert.match(hud.slice(hud.indexOf('function applyFx'), hud.indexOf('function rest')), /systemCodes\(\)/);
});

test('the keyboard reference and the feature guide use the new names and numbers', () => {
  const kb = read('docs/KEYBOARD.md');
  assert.match(kb, /Ctrl\+1 … Ctrl\+5 \| Chat, Notes, Calendar, Memories, Documents/);
  assert.match(kb, /Ctrl\+9/);
  assert.doesNotMatch(kb, /Vault →/);
  const guide = read('main/guide.js');
  assert.doesNotMatch(guide, /Memory vault|Knowledge base|\bConfig\b|Evolution view|Architecture view|the Vault view/i);
});
