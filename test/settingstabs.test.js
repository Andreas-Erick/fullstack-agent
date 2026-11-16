// Settings in tabs (renderer/js/settingstabs.js): every card of the Settings screen is in exactly one
// tab, links to a card open its tab, and the search looks through all of them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

let t;
test.before(async () => {
  const copy = path.join(tmpDir('nexus-settingstabs-'), 'settingstabs.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/settingstabs.js'), copy);
  t = await import(pathToFileURL(copy).href);
});

// The ids settings.js gives its cards: card('brain', …) or card(\n    'agent', …).
const cardIds = () => [...fs.readFileSync(path.join(ROOT, 'renderer/js/settings.js'), 'utf8').matchAll(/\bcard\(\s*'([a-z-]+)'/g)].map((m) => m[1]);

test('every Settings card is in exactly one tab, and every tab has cards', () => {
  const ids = cardIds();
  assert.ok(ids.length >= 15, `found ${ids.length} cards`);
  const placed = t.TABS.flatMap((x) => x.cards);
  assert.strictEqual(new Set(placed).size, placed.length, 'a card in two tabs');
  for (const id of ids) assert.ok(placed.includes(id), `card "${id}" is in no tab (renderer/js/settingstabs.js TABS)`);
  for (const id of placed) assert.ok(ids.includes(id), `tab names card "${id}", which settings.js no longer has`);
  for (const tab of t.TABS) assert.ok(tab.cards.length && tab.label, tab.id);
});

test('links open the card’s tab; arrows wrap; an unknown tab or card has a home', () => {
  assert.strictEqual(t.tabFor('brain'), 'brain');
  assert.strictEqual(t.tabFor('obsidian'), 'knowledge');
  assert.strictEqual(t.tabFor('ui'), 'persona');
  assert.strictEqual(t.tabFor('nope'), t.TABS.at(-1).id);
  assert.strictEqual(t.validTab('voice'), 'voice');
  assert.strictEqual(t.validTab(null), t.TABS[0].id);
  assert.strictEqual(t.validTab('removed-tab'), t.TABS[0].id);
  assert.strictEqual(t.stepTab(t.TABS.at(-1).id, 1), t.TABS[0].id);
  assert.strictEqual(t.stepTab(t.TABS[0].id, -1), t.TABS.at(-1).id);
  assert.strictEqual(t.stepTab('brain', 1), 'voice');
});

test('the search matches every word, anywhere, without caring for case or accents', () => {
  const card = 'Voice input · speech-to-text  Hold the push-to-talk key… Whisper modèle';
  assert.ok(t.matches(card, ''));
  assert.ok(t.matches(card, '   '));
  assert.ok(t.matches(card, 'push talk'));
  assert.ok(t.matches(card, 'WHISPER'));
  assert.ok(t.matches(card, 'modele'));
  assert.ok(!t.matches(card, 'push calendar'));
});
