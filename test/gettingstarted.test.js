// The getting-started card in the empty chat (renderer/js/gettingstartedcore.js, drawn by gettingstarted.js):
// each event ticks exactly its step, once; Hide puts the card away for good; the card goes once every step
// is done; anything stored that isn't a state reads as a fresh one. Plus the host's contracts: storage in
// try/catch, Try only fills the box, the card in CASCADE and the resting entrance list.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const ESM = tmpDir('nexus-gettingstarted-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
fs.copyFileSync(path.join(ROOT, 'renderer/js/gettingstartedcore.js'), path.join(ESM, 'gettingstartedcore.js'));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));

let gs;
test.before(async () => {
  gs = await import(pathToFileURL(path.join(ESM, 'gettingstartedcore.js')).href);
});

const EVENTS = { 'reply-done': 'ask', 'tool:calendar_add_event': 'event', 'note-saved': 'note', 'spoken-turn': 'voice' };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('four steps in order: ask, calendar, note, voice; every one but voice has an example to put in the box', () => {
  assert.deepStrictEqual(gs.STEPS.map((s) => s.id), ['ask', 'event', 'note', 'voice']);
  for (const s of gs.STEPS) assert.ok(s.title && s.text, s.id);
  for (const s of gs.STEPS.filter((x) => x.id !== 'voice')) assert.ok(s.example.length > 5, `${s.id} has an example`);
});

test('each event ticks exactly its step, with the time it happened', () => {
  for (const [ev, id] of Object.entries(EVENTS)) {
    const s = gs.step(gs.initial(), ev, 1000);
    for (const k of ['ask', 'event', 'note', 'voice', 'hidden']) assert.strictEqual(s[k], k === id ? 1000 : 0, `${ev} → ${k}`);
  }
});

test('events are idempotent: the first time is kept and the same state object comes back', () => {
  const once = gs.step(gs.initial(), 'reply-done', 1000);
  const twice = gs.step(once, 'reply-done', 2000);
  assert.strictEqual(twice, once);
  assert.strictEqual(twice.ask, 1000);
});

test('unknown events change nothing', () => {
  const s0 = gs.initial();
  for (const ev of ['', 'done', 'tool:calendar_delete_event', 'tool:quick_note', 'HIDE', 'toString', '__proto__', null, undefined, 42]) assert.strictEqual(gs.step(s0, ev, 5), s0, String(ev));
});

test('hide hides for good: visible stays false whatever happens next', () => {
  let s = gs.step(gs.initial(), 'hide', 10);
  assert.strictEqual(gs.visible(s), false);
  for (const ev of Object.keys(EVENTS)) s = gs.step(s, ev, 20);
  s = gs.step(s, 'hide', 30);
  assert.strictEqual(s.hidden, 10);
  assert.strictEqual(gs.visible(s), false);
  assert.strictEqual(gs.visible(gs.fromStored(JSON.parse(JSON.stringify(s)))), false, 'also after a reload');
});

test('progress counts the steps done; the card goes once all four are done', () => {
  let s = gs.initial();
  assert.deepStrictEqual([gs.progress(s).done, gs.progress(s).total, gs.visible(s)], [0, 4, true]);
  Object.keys(EVENTS).forEach((ev, i) => {
    s = gs.step(s, ev, 100 + i);
    const p = gs.progress(s);
    assert.strictEqual(p.done, i + 1);
    assert.strictEqual(p.complete, i === 3);
    assert.strictEqual(gs.visible(s), i < 3, `visible after ${i + 1}`);
    assert.ok(p.steps.find((x) => x.id === EVENTS[ev]).done);
  });
  assert.strictEqual(gs.visible(gs.fromStored(JSON.parse(JSON.stringify(s)))), false, 'finished stays finished after a reload');
});

test('fromStored: anything that isn’t a state reads as the initial one; good fields are kept', () => {
  for (const raw of [null, undefined, 'x', 3, [], [1, 2], { ask: 'yes' }, { ask: -1, hidden: NaN }, { ask: Infinity }]) assert.deepStrictEqual(gs.fromStored(raw), gs.initial(), JSON.stringify(raw));
  assert.deepStrictEqual(gs.fromStored({ ask: 5, note: 7, junk: 1 }), { ask: 5, event: 0, note: 7, voice: 0, hidden: 0 });
  assert.strictEqual(gs.visible(undefined), true);
});

test('eventForTool: calendar_add_event and the note-writing tools, with or without the Claude Code prefix; failures count for nothing', () => {
  assert.strictEqual(gs.eventForTool('calendar_add_event', true), 'tool:calendar_add_event');
  assert.strictEqual(gs.eventForTool('mcp__nexus__calendar_add_event', undefined), 'tool:calendar_add_event');
  assert.strictEqual(gs.eventForTool('mcp__nexus_more__quick_note', true), 'note-saved');
  assert.strictEqual(gs.eventForTool('vault_write_note', true), 'note-saved');
  assert.strictEqual(gs.eventForTool('calendar_add_event', false), null);
  for (const n of ['calendar_list', 'mcp__claude_ai_Google_Calendar__create_event', 'mcp__other__calendar_add_event', '', null]) assert.strictEqual(gs.eventForTool(n, true), null, String(n));
});

test('the host: storage in try/catch, Try fills the box through the outbox, the card replaces the chips', () => {
  const host = read('renderer/js/gettingstarted.js');
  for (const fn of ['load', 'store']) {
    const at = host.indexOf(`function ${fn}()`);
    assert.ok(at >= 0, fn);
    const body = host.slice(at, host.indexOf('\n}\n', at));
    assert.match(body, /try \{[\s\S]*localStorage[\s\S]*\} catch/, `${fn} reads/writes storage inside try/catch`);
  }
  assert.strictEqual((host.match(/localStorage\./g) || []).length, 2, 'storage only in load and store');
  assert.doesNotMatch(host, /\bsend\(|chat\.send|outbox\.(typed|submit|spoken)/, 'Try never sends');
  const chat = read('renderer/js/chat.js');
  assert.match(chat, /gettingStartedCard\(\{ prefill: \(text\) => outbox\.prefill\(text\)/);
  assert.match(chat, /chips\.classList\.add\('hidden'\)/);
  for (const sig of ["note('reply-done')", "note('spoken-turn')", 'noteTool(step.tool.name']) assert.ok(chat.includes(sig), sig);
  assert.match(read('renderer/js/notes.js'), /emit\('note-saved'\)/);
});

test('the card joins the HUD cascade and the resting entrance list, and has no motion under reduce motion', () => {
  assert.match(read('renderer/js/hud.js'), /const CASCADE = '[^']*\.gs-card/);
  assert.match(read('renderer/hud.css'), /\.hud-cascade :is\([^)]*\.gs-card\)/);
  const css = read('renderer/styles.css');
  assert.match(css, /body\.fx-rest :is\([^)]*\.gs-card[^)]*\)[^{]*\{ animation-play-state: running/);
  assert.match(css, /body\.fx-still :is\(\.gs-card/);
  for (const r of css.split('\n').filter((l) => l.startsWith('.gs-'))) assert.doesNotMatch(r, /#[0-9a-f]{3,8}\b|rgba?\(\d/i, `theme tokens only: ${r}`);
});
