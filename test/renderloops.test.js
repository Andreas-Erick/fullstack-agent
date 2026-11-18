// Render loops that rest and code that lets go, where the code needs the DOM (pinned by its source): the
// room inside a building stops outside the World view, the village gates every frame (followed residents
// too) and eases the follow by time, a live chart plays at 30 fps and only while shown, the chat renders a
// streamed reply once per frame (only what the Face layout shows), opens the chat asked for last, the
// document viewer disposes of the document it replaces, and a call cut off before it reported back is
// worded as such in the window and main. The pure parts are tested in perf, livedoc, docview, redocore.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, quietLog, tmpDir } = require('./helpers');

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
function slice(file, from, to) {
  const src = read(file);
  const a = src.indexOf(from);
  assert.ok(a >= 0, `${file} has: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `${file} has ${to} after ${from}`);
  return src.slice(a, b);
}
const at = (body, s) => {
  const i = body.indexOf(s);
  assert.ok(i >= 0, `has: ${s}`);
  return i;
};

// Regression (canvas-2): leaving the World view while inside a building kept the room drawing.
test('roomview: the room draws only in the World view, gated by capFrame, and restarts with refreshRoom', () => {
  const file = 'renderer/js/roomview.js';
  assert.match(read(file), /import \{ currentView \} from '\.\/nav\.js';/);
  assert.match(read(file), /import \{ capFrame \} from '\.\/faces\/common\.js';/);
  const loop = slice(file, 'function loop() {', '\n}\n');
  assert.strictEqual(loop.split("if (!open || document.hidden || currentView !== 'world') return;").length, 3, 'loop and its step both stop outside the view');
  assert.match(loop, /const d = capFrame\(due, now, 1000 \/ src\.frameMs\(\)\);\n\s+if \(d === null\) return;\n\s+due = d;/);
  assert.ok(!/lastDraw/.test(read(file)), 'the old gate is gone');
  const refresh = slice(file, 'export function refreshRoom() {', '\n}\n');
  assert.ok(at(refresh, 'render();') < at(refresh, 'loop();'), 'back in the view: it moves again');
  assert.match(read(file), /addEventListener\('visibilitychange', \(\) => open && !document\.hidden && currentView === 'world' && loop\(\)\)/);
});

// Regression (canvas-4, canvas-8): the village ignored the voice cap and fx-rest; a followed resident bypassed
// the frame gate and eased per frame; the `every - 4` gate gave ~72 fps for a 60 cap on 144 Hz.
test('innerworld: every frame but a flight or glide goes through capFrame at villageFps(); the follow eases by time', () => {
  const file = 'renderer/js/innerworld.js';
  const src = read(file);
  assert.match(src, /import \{ canvasFps \} from '\.\/perfcore\.js';/);
  assert.match(src, /const villageFps = \(\) => canvasFps\(\{ chosen: state\.settings\?\.innerWorld\?\.fps, balanced: lite\(\), voiceWorking: state\.voiceWorking, resting: document\.body\.classList\.contains\('fx-rest'\) \}\);/);
  assert.match(src, /const frameMs = \(\) => 1000 \/ villageFps\(\);/, 'the room uses the same rate');
  const step = slice(file, 'const step = (now = performance.now()) => {', '\n  };\n');
  assert.match(step, /if \(!\(flight \|\| glide\)\) \{\n\s+const d = now - lastDrawAt < 4 \? null : capFrame\(due, now, villageFps\(\)\);/);
  assert.ok(!/const moving = flight \|\| glide \|\| follow/.test(step), 'a followed resident no longer skips the gate');
  assert.ok(at(step, 'draw();') < at(step, 'lastDrawAt = now;'));
  const draw = slice(file, 'function draw() {', '\n}\n');
  assert.match(draw, /if \(!ctx \|\| !size\.w \|\| !data\?\.places\) return;\n\s+lastDrawAt = performance\.now\(\);/, 'a handler’s draw counts as the frame');
  const move = slice(file, 'function moveCamera(people) {', '\n}\n');
  assert.match(move, /const k = 1 - Math\.exp\(-Math\.min\(100, followAt \? t - followAt : 16\.7\) \/ 120\);/);
  assert.match(move, /followAt = t;/);
  for (const fn of ['function followResident(name) {', 'function stopFollowing() {']) assert.match(slice(file, fn, '\n}\n'), /followAt = 0;/, fn);
});

// Regression (canvas-3): a live chart re-rendered every display frame forever, also in a hidden view.
test('livedoc: a playing chart draws through playDue (shown, 30 fps), one tick chain at a time', () => {
  const file = 'renderer/js/livedoc.js';
  const tick = slice(file, 'const tick = (now) => {', '\n  };\n');
  assert.ok(at(tick, 'raf = requestAnimationFrame(tick);') < at(tick, 'if (!playDue(lastDraw, now, plot.offsetParent !== null)) return;'));
  assert.ok(at(tick, 'lastDraw = now;') < at(tick, 'r.set(playValue(playing, now - started + r.offset));'));
  assert.match(slice(file, 'function stop() {', '\n  }\n'), /cancelAnimationFrame\(raf\);/);
});

// Regression (perf-1): each streamed frame rendered the reply twice in the Face layout (bubble + card) and laid out the hidden bubble.
test('chat: a streamed frame renders once, and in the Face layout only what the card shows', () => {
  const file = 'renderer/js/chat.js';
  const render = slice(file, 'function renderActive() {', '\n}\n');
  assert.ok(at(render, 'if (face && !toCard) return;') < at(render, 'renderMarkdown('), 'nothing rendered when nothing shows it');
  assert.strictEqual(render.split('renderMarkdown(').length, 2, 'one render a frame');
  assert.match(render, /if \(toCard\) showCard\(active\.text, \{ follow: true, html \}\);/);
  assert.match(slice(file, 'function showCard(', '\n}\n'), /body\.innerHTML = html \?\? \(md \? renderMarkdown\(md, \{ wikilinks: 'open' \}\) : ''\);/);
  // Leaving the Face layout mid-reply fills the bubble it left behind, at once (Open in chat scrolls next).
  const init = slice(file, 'function initReplyCard() {', '\n}\n');
  assert.match(init, /if \(active\?\.behind\) \{\n\s+active\.behind = false;\n\s+active\.bubble\.innerHTML = renderMarkdown\(active\.text, \{ wikilinks: 'open' \}\);/);
  // …and scrolled once the new layout applies (app.js hears 'settings' after chat.js), not measured in the old one.
  assert.match(init, /requestAnimationFrame\(\(\) => active && scrollToBottom\(true\)\);/);
  assert.ok(!/active\.bubble\.innerHTML = renderMarkdown\(active\.text, \{ wikilinks: 'open' \}\);\n\s+scrollToBottom\(true\);/.test(init), 'not in the same task');
  const app = read('renderer/js/app.js');
  assert.ok(at(app, 'initChat();') < at(app, "on('settings', applySettings)"), 'the order the next frame waits out');
  assert.match(render, /active\.behind = face;/);
  // The end of a reply still renders its bubble in every layout.
  assert.match(slice(file, "case 'done': {", "case 'error':"), /active\.bubble\.innerHTML = renderMarkdown\(m\.content \|\| '', \{ wikilinks: 'open' \}\);/);
});

// Regression (io-8, states-desktop-3): an older load could replace the newer one; a chat that couldn't be
// read silently became an empty "New conversation" (and newChat() stopped a reply just sent).
test('chat: the last chat asked for wins; one that can’t be opened says so and the open one stays', () => {
  const file = 'renderer/js/chat.js';
  const open = slice(file, 'export async function openConversation(', '\n}\n');
  assert.ok(at(open, 'const seq = ++openSeq;') < at(open, 'await api.conv.get(id)'));
  assert.ok(at(open, 'if (seq !== openSeq || active) return;') < at(open, 'if (!conv) {'), 'checked before the result is used');
  assert.ok(at(open, 'if (!conv) {') < at(open, 'hideCard();'));
  assert.match(open, /if \(quiet\) return newChat\(\);/);
  assert.match(open, /couldn’t be opened/);
  assert.ok(at(slice(file, 'export function newChat(', '\n}\n'), 'openSeq++;') < at(slice(file, 'export function newChat(', '\n}\n'), 'if (active) stop();'));
  assert.match(read(file), /if \(c\) openConversation\(c\.id, \{ quiet: true \}\);/, 'only the launch is quiet');
  assert.strictEqual(read(file).split('quiet: true').length, 2);
});

// Regression (gap-stop-cancellation-4): Try again after a stop called a cut-off call "done".
test('the window and main word a cut-off call as cut off, never as done', () => {
  const file = 'renderer/js/chat.js';
  const notice = slice(file, "case 'notice': {", 'break;');
  assert.match(notice, /ev\.cut\?\.length \? `Cut off before it reported back \(check before repeating\): \$\{label\(ev\.cut\)\}\.` : ''/);
  assert.match(notice, /const text = `⚠ \$\{said \|\| ev\.message\}`;/);
  const again = slice(file, 'async function runAgain(', '\n}\n');
  assert.match(again, /ask\.filter\(\(t\) => !redo\.cutOff\(t\)\)/);
  assert.match(again, /ask\.filter\(redo\.cutOff\)/);
  assert.match(again, /may or may not have happened/);
  const main = slice('main/main.js', 'if (again?.acted.length || again?.uncertain) {', '\n  }\n');
  assert.match(main, /const cut = again\.unsure \|\| \[\];/);
  assert.match(main, /const done = again\.acted\.filter\(\(a\) => !cut\.includes\(a\)\);/);
  assert.match(main, /tools: done\.map\(\(a\) => a\.name\), cut: cut\.map\(\(a\) => a\.name\)/);
  assert.match(main, /Cut off before it reported back \(check before repeating\): \$\{names\(cut\)\}\./);
});

test('redo.apply hands the cut-off calls on with the rest (main.js words the notice from them)', () => {
  const dir = tmpDir('nexus-renderloops-');
  stub({
    electron: { app: { getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => false } },
    './logger': quietLog,
    './tools': { TOOLS: [{ name: 'calendar_add_event' }, { name: 'github_push' }] },
  });
  const redo = load('main/redo.js');
  const conv = { id: 'c1', title: 'Chat', messages: [{ id: 'u1', role: 'user', content: 'push and add', createdAt: 1, attempt: { outcome: 'stopped', at: 1, output: true, tools: [{ name: 'calendar_add_event', ok: true, brief: 'Dentist' }, { name: 'github_push', ok: null, brief: 'main' }] } }] };
  const p = redo.check(conv, { kind: 'again', messageId: 'u1' });
  assert.strictEqual(p.ok, true);
  const again = redo.apply(conv, p);
  assert.deepStrictEqual(again.unsure.map((a) => a.name), ['github_push']);
  assert.ok(again.unsure.every((a) => again.acted.includes(a)), 'the same objects, so main can tell them apart');
  assert.deepStrictEqual(again.acted.filter((a) => !again.unsure.includes(a)).map((a) => a.name), ['calendar_add_event']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Regression (perf-3, cleanup-1): the viewer kept every replaced document (listeners, observers, pdf.js workers).
test('docview: each document is disposed by the next; listeners go with it; viewer.js disposes before it loads', () => {
  const file = 'renderer/js/docview.js';
  const render = slice(file, 'export async function renderDocument(', '\n}\n');
  assert.match(render, /^export async function renderDocument\([^)]*\) \{\n {2}disposeDocument\(viewer\);/);
  assert.match(render, /\{ passive: false, signal \}/);
  assert.match(render, /parts\.task\?\.destroy\(\)\.catch\(\(\) => \{\}\);/, 'the pdf.js document and its worker');
  const pdf = slice(file, 'async function showPdf(', '\n}\n');
  assert.ok(at(pdf, 'if (signal.aborted) return null; // nothing of it') < at(pdf, 'viewer.append(pages);'), 'nothing appended before the check');
  assert.match(pdf, /\{ signal \},\n\s+\);/, 'the scroll listener goes with the document');
  const pages = slice(file, 'async function renderPages(', '\n}\n');
  assert.ok(at(pages, 'parts.observer?.disconnect();') < at(pages, 'parts.observer = new IntersectionObserver('), 'one observer after a zoom');
  assert.match(pages, /c\.width = c\.height = 0;/, 'a page far from view gives its bitmap back');
  const show = slice('renderer/js/viewer.js', 'async function show(path) {', '\n}\n');
  assert.ok(at(show, 'disposeDocument(viewer);') < at(show, 'await '), 'before the first await');
  assert.ok(at(show, 'if (seq !== showSeq) return;') < at(show, 'document.title = doc.name;'), 'a slower load never lands under the next');
});
