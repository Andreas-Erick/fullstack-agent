// Visible buttons for gestures and icons (spec #17, "Discoverability"): what used to need a double-click,
// F2 or a guess at an icon has a button with words. The pure rules (renderer/js/composerhints.js: the
// one-time "keep holding" hint after a short tap on the mic, the "Saved on this PC" chip and its tooltip),
// plus the source contracts of the markup and views that draw them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ESM = tmpDir('nexus-visiblebuttons-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
fs.copyFileSync(path.join(ROOT, 'renderer/js/composerhints.js'), path.join(ESM, 'composerhints.js'));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));
const core = () => import(pathToFileURL(path.join(ESM, 'composerhints.js')).href);

test('a short tap on the mic shows the hold hint once', async () => {
  const { tapHint, TAP_MS } = await core();
  assert.strictEqual(TAP_MS, 400);
  assert.strictEqual(tapHint(120, false, true), 'Keep holding while you speak.');
  assert.strictEqual(tapHint(399, false, true), 'Keep holding while you speak.');
  assert.strictEqual(tapHint(120, true, true), null, 'only the first time');
  assert.strictEqual(tapHint(400, false, true), null, 'a real hold needs no hint');
  assert.strictEqual(tapHint(3000, false, true), null);
  assert.strictEqual(tapHint(NaN, false, true), null, 'no measurement, no hint');
  // Review of spec #17: with voice input off (or the press refused) nothing recorded, so the one-time hint waits.
  assert.strictEqual(tapHint(120, false, false), null, 'no recording started, no hint');
});

test('the saved chip names the notes folder in its tooltip', async () => {
  const { savedChip } = await core();
  const on = savedChip({ ok: true, path: 'C:\\Users\\Anna\\Documents\\Siren Vault' });
  assert.strictEqual(on.text, 'Saved on this PC');
  assert.match(on.title, /C:\\Users\\Anna\\Documents\\Siren Vault/);
  assert.match(on.title, /this computer/);
  for (const st of [{ ok: false }, {}, null, undefined, { ok: true, path: '' }]) {
    const off = savedChip(st);
    assert.strictEqual(off.text, 'Saved on this PC');
    assert.match(off.title, /this computer/);
    assert.doesNotMatch(off.title, /undefined|null/);
  }
});

const html = read('renderer/index.html');

test('the chat ⋯ menu offers Rename, and ⋯ says More', () => {
  const menu = html.slice(html.indexOf('id="chatMenu"'), html.indexOf('</div>', html.indexOf('id="chatMenu"')));
  assert.match(menu, /<button data-act="rename" role="menuitem">Rename this chat…<\/button>/);
  assert.match(html, /id="chatMore"[^>]*>⋯ More<\/button>/);
  assert.match(html, /id="memMore"[^>]*>⋯ More<\/button>/);
  const chat = read('renderer/js/chat.js');
  assert.match(chat, /\[data-act="rename"\]/, 'chat.js binds the menu item to renameCurrent');
  // The gestures stay.
  assert.match(chat, /\$\('#chatTitle'\)\.ondblclick = renameCurrent/);
  assert.match(chat, /e\.key !== 'F2'/);
});

test('History\'s ＋ says New chat', () => {
  assert.match(html, /id="newChatBtn"[^>]*>＋ New chat<\/button>/);
});

test('the mic says Hold to talk under it, and the composer has the saved chip', () => {
  assert.match(html, /id="micBtn"[^>]*aria-label="Hold to talk"/);
  assert.match(html, /class="mic-cap"[^>]*>Hold to talk<\/span>/);
  assert.match(html, /id="savedChip"[^>]*>[^<]*Saved on this PC<\/span>/);
  const app = read('renderer/js/app.js');
  assert.match(app, /tapHint\(/, 'app.js shows the tap hint');
  assert.match(app, /started = startListening\(\);[\s\S]{0,400}started\.then\(\(ok\) => showTapHint\(held, ok\)/, 'the press keeps whether a recording started');
  const voice = read('renderer/js/voice.js').replace(/\r\n/g, '\n');
  const start = voice.slice(voice.indexOf('export async function startListening'), voice.indexOf('let pttLimit'));
  assert.match(start, /Voice input is disabled in Settings\.'\)\);\n\s*return false;/, 'disabled voice input started nothing');
  assert.match(start, /input\.micStarted\(p\.id, recorder\.startedAt\);[\s\S]*return true;/, 'a started microphone says so');
  assert.match(app, /savedChip\(/, 'app.js fills the chip tooltip');
});

test('a calendar day has a ＋ that opens the editor, the double-click stays', () => {
  const cal = read('renderer/js/calendar.js');
  assert.match(cal, /class: 'cal-add'/);
  assert.match(cal, /ondblclick: \(\) => editor\(\{ date: ymd\(day\) \}\)/);
  const css = read('renderer/styles.css');
  assert.match(css, /\.cal-cell:is\(:hover, :focus-within\) \.cal-add/);
});

test('the Inner World place panel has Step inside', () => {
  assert.match(read('renderer/js/innerworld.js'), /'🚪 Step inside'/);
});

test('the note\'s ◆ button carries a word', () => {
  assert.match(read('renderer/js/notes.js'), /'◆ Obsidian'/);
});
