// Settings in tabs (renderer/js/settingstabs.js): every card of the Settings screen is in exactly one
// tab, links to a card open its tab, and the search looks through all of them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir, settingsSource } = require('./helpers');

let t;
test.before(async () => {
  const copy = path.join(tmpDir('nexus-settingstabs-'), 'settingstabs.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/settingstabs.js'), copy);
  t = await import(pathToFileURL(copy).href);
});

// The ids settings.js gives its cards: card('brain', …) or card(\n    'agent', …).
const cardIds = () => [...settingsSource().matchAll(/\bcard\(\s*'([a-z-]+)'/g)].map((m) => m[1]);

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

// ------------------------------------------------ Simple / Advanced (renderer/js/settingsmode.js)
let mode;
test.before(async () => {
  const copy = path.join(tmpDir('nexus-settingsmode-'), 'settingsmode.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/settingsmode.js'), copy);
  mode = await import(pathToFileURL(copy).href);
});
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

test('ui.settingsAdvanced: off by default, and only the user changes it (never SETTABLE)', () => {
  const ui = /\n {2}ui: \{([\s\S]*?)\n {2}\},/.exec(read('main/store.js'))[1];
  assert.match(ui, /\bsettingsAdvanced: false\b/);
  const tools = read('main/tools.js');
  assert.ok(!/settingsAdvanced/.test(/const SETTABLE = \{([\s\S]*?)\n\};/.exec(tools)[1]), 'settingsAdvanced must not be in SETTABLE');
  assert.ok(!/settingsAdvanced/.test(/const SETUP_SETTABLE = \[([\s\S]*?)\];/.exec(tools)[1]), 'nor during setup');
});

test('an advanced field shows in Advanced mode, and in Simple mode only when a search finds it', () => {
  assert.strictEqual(mode.advancedShown({ advancedMode: true, searching: false, matched: false }), true);
  assert.strictEqual(mode.advancedShown({ advancedMode: true, searching: true, matched: false }), true);
  assert.strictEqual(mode.advancedShown({ advancedMode: false, searching: false, matched: true }), false);
  assert.strictEqual(mode.advancedShown({ advancedMode: false, searching: true, matched: false }), false);
  assert.strictEqual(mode.advancedShown({ advancedMode: false, searching: true, matched: true }), true);
  // Revealed by a search in Simple mode, it says it is an advanced setting; in Advanced mode there is no note.
  assert.strictEqual(mode.advancedNote({ advancedMode: false, searching: true, matched: true }), 'Advanced setting');
  assert.strictEqual(mode.advancedNote({ advancedMode: true, searching: true, matched: true }), '');
  assert.strictEqual(mode.advancedNote({ advancedMode: false, searching: false, matched: false }), '');
});

test('VoiceStudio fields only when VoiceStudio is the voice', () => {
  assert.strictEqual(mode.voiceStudioShown('voicestudio'), true);
  for (const e of ['local', 'cloud', '', undefined]) assert.strictEqual(mode.voiceStudioShown(e), false, String(e));
});

test('the voice shortcut is recorded from the keys pressed, saved as an Electron accelerator', () => {
  const k = (code, mods = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  assert.deepStrictEqual(mode.accelerator(k('Space', { ctrlKey: true, altKey: true })), { accel: 'CommandOrControl+Alt+Space' });
  assert.deepStrictEqual(mode.accelerator(k('KeyJ', { ctrlKey: true, shiftKey: true })), { accel: 'CommandOrControl+Shift+J' });
  assert.deepStrictEqual(mode.accelerator(k('Digit5', { altKey: true })), { accel: 'Alt+5' });
  assert.deepStrictEqual(mode.accelerator(k('F9')), { accel: 'F9' }, 'a function key alone is fine');
  assert.deepStrictEqual(mode.accelerator(k('ArrowUp', { ctrlKey: true })), { accel: 'CommandOrControl+Up' });
  assert.deepStrictEqual(mode.accelerator(k('KeyK', { metaKey: true }), { mac: true }), { accel: 'CommandOrControl+K' });
  assert.deepStrictEqual(mode.accelerator(k('KeyK', { metaKey: true })), { accel: 'Super+K' });
  // Not done yet: only modifiers so far, or a plain letter (it would fire while typing anywhere).
  assert.deepStrictEqual(mode.accelerator(k('ControlLeft', { ctrlKey: true })), { waiting: true });
  assert.deepStrictEqual(mode.accelerator(k('ShiftRight', { shiftKey: true })), { waiting: true });
  assert.deepStrictEqual(mode.accelerator(k('KeyA')), { waiting: true, why: 'Add Ctrl or Alt' });
  assert.deepStrictEqual(mode.accelerator(k('KeyA', { shiftKey: true })), { waiting: true, why: 'Add Ctrl or Alt' });
  // Esc gives up, Backspace/Delete turns the shortcut off.
  assert.deepStrictEqual(mode.accelerator(k('Escape')), { cancel: true });
  assert.deepStrictEqual(mode.accelerator(k('Backspace')), { accel: '' });
  assert.deepStrictEqual(mode.accelerator(k('Delete')), { accel: '' });
});

test('a shortcut reads as keys, not as an accelerator', () => {
  assert.strictEqual(mode.acceleratorLabel('CommandOrControl+Alt+Space'), 'Ctrl + Alt + Space');
  assert.strictEqual(mode.acceleratorLabel('CommandOrControl+Alt+Space', { mac: true }), '⌘ + Alt + Space');
  assert.strictEqual(mode.acceleratorLabel('Super+K'), 'Win + K');
  assert.strictEqual(mode.acceleratorLabel(''), 'Off');
});

// The fields the spec puts behind "Show advanced" (except Remote access, which has its own ticket): every
// builder call for the key carries advanced: true.
const ADVANCED_KEYS = [
  'llm.baseUrl', 'llm.apiKey', 'llm.temperature', 'llm.maxTokens', 'llm.fastModel', 'llm.deepModel', 'llm.compactPrompt',
  'claudeCode.effort', 'claudeCode.fastModel', 'claudeCode.deepModel', 'claudeCode.cliPath',
  'anthropic.effort', 'anthropic.fastModel', 'anthropic.deepModel', 'anthropic.fallbacks',
  'voice.baseUrl', 'voice.apiKey', 'voice.voice', 'voice.model', 'voice.format',
  'stt.remoteUrl', 'stt.remoteKey', 'stt.remoteModel', 'stt.localModel',
];
test('every field the spec calls advanced is built with advanced: true', () => {
  const src = settingsSource();
  for (const key of ADVANCED_KEYS) {
    const calls = [...src.matchAll(new RegExp(`\\b(?:text|select|toggle|area|folder)\\(\\s*'${key.replace('.', '\\.')}'[^\\n]*`, 'g'))].map((x) => x[0]);
    assert.ok(calls.length, `no field for ${key}`);
    for (const c of calls) assert.match(c, /advanced: true/, `${key} is not advanced: ${c.slice(0, 120)}`);
  }
  // The builders mark it, the view hides it by mode and reveals it by search.
  assert.match(src, /data-advanced/);
  assert.match(src, /advancedShown\(/);
  assert.match(read('renderer/styles.css'), /\[data-advanced\]/);
});

test('VoiceStudio’s fields are drawn only for that engine', () => {
  const src = read('renderer/js/settings/voice.js');
  const vs = /voiceStudioShown\([^)]*\)\s*\?\s*\[([\s\S]*?)\]\s*:\s*\[\]/.exec(src);
  assert.ok(vs, 'the VoiceStudio fields sit behind voiceStudioShown(engine)');
  for (const key of ['voice.baseUrl', 'voice.apiKey', 'voice.voice', 'voice.model']) {
    assert.ok(vs[1].includes(`'${key}'`), `${key} inside the VoiceStudio block`);
    assert.strictEqual(src.split(`text('${key}'`).length - 1, 1, `${key}’s field only once in voice.js`);
  }
});

test('plain labels: no engineer words in the brain, voice and safety cards', () => {
  const src = settingsSource();
  for (const gone of ['Bearer token', 'not found on PATH', "'Temperature'", "'Max output tokens'", "'Effort'", "'Language code'", "'Permission mode'"]) assert.ok(!src.includes(gone), `still says ${gone}`);
  for (const word of ['How hard it thinks', 'Quick answers', 'Careful answers', 'Creativity', 'Longest answer', 'Access key', 'Server address', 'Claude Code isn’t installed on this PC', 'Extra caution after reading websites or files (recommended)', 'Ask before acting?']) assert.ok(src.includes(word), `missing “${word}”`);
  // The safety switch: a short label, the long explanation as its hint.
  assert.match(src, /toggle\(\s*'safety\.taintGuard',\s*'Extra caution after reading websites or files \(recommended\)',\s*\{[^}]*hint: /);
  assert.match(src, /select\(\s*'stt\.language'/, 'the language is picked from a list');
  assert.match(src, /accelerator\(/, 'the voice shortcut is recorded from the keys');
  assert.match(src, /'ui\.settingsAdvanced'/, 'the Show advanced switch is bound');
});
