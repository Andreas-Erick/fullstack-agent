// Keeping paired devices in step with the computer: which screens a change touches (main/synccore.js),
// what the phone does about it (renderer/remote/sync.js), and the contracts between the two sides that
// a sync bug would break: every streamed event has a handler on the phone, every data route the phone
// calls exists, every module it loads is served, the vault names match what the modules write.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const sync = require('../main/synccore');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// The client module is an ES module in a CommonJS package: loaded from an .mjs copy, as chatcore's test does.
let clientModule = null;
const client = async () => {
  if (clientModule) return clientModule;
  const copy = path.join(tmpDir('nexus-sync-'), 'sync.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/remote/sync.js'), copy);
  return (clientModule = await import(pathToFileURL(copy).href));
};

// Timers the test moves by hand.
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const due = new Map();
  return {
    setTimeout: (fn, ms) => (due.set(++seq, { fn, at: now + ms }), seq),
    clearTimeout: (id) => due.delete(id),
    tick(ms) {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) (due.delete(id), t.fn());
    },
    get pending() {
      return due.size;
    },
  };
}

// ------------------------------------------------------------------ main/synccore.js
test('vault notes map to the screens that show them', () => {
  const cases = {
    'Habits.md': ['habits', 'notes', 'today', 'tree'],
    'Schedule.md': ['notes', 'sched', 'today'],
    'Skill Tree.md': ['notes', 'tree'],
    'Memory/likes-tea.md': ['memory', 'notes'],
    'Stream/2026-10.md': ['memory', 'notes'],
    'Flashcards/Biology.md': ['cards', 'notes', 'today', 'tree'],
    'Flashcards/media/Biology/cell.png': ['cards', 'today', 'tree'], // media: not a note
    'Languages/Spanish.md': ['cards', 'learn', 'notes', 'today', 'tree'],
    'Learning/Calculus.md': ['learn', 'notes', 'today', 'tree'],
    'Inner World/Chronicle.md': ['notes', 'world'],
    'Inner World/Residents/Ada.md': ['notes', 'world'],
    'Active Priorities.md': ['notes', 'today'],
    'Where We Left Off.md': ['notes', 'today'],
    'Notes/Shopping.md': ['notes'],
    'Daily/2026-10-31.md': ['notes'],
  };
  for (const [rel, want] of Object.entries(cases)) assert.deepStrictEqual(sync.topicsForVault(rel).sort(), want, rel);
});

test('vault paths: Windows separators and case are understood; hidden folders and nothing are ignored', () => {
  assert.deepStrictEqual(sync.topicsForVault('Memory\\x.md').sort(), ['memory', 'notes']);
  assert.deepStrictEqual(sync.topicsForVault('habits.md').sort(), ['habits', 'notes', 'today', 'tree']);
  assert.deepStrictEqual(sync.topicsForVault('/Schedule.md').sort(), ['notes', 'sched', 'today']);
  for (const rel of ['', null, undefined, '.obsidian/workspace.json', '.trash/old.md', '.git/HEAD']) assert.deepStrictEqual(sync.topicsForVault(rel), [], String(rel));
  // A folder only *starting* like a known one is just a note.
  assert.deepStrictEqual(sync.topicsForVault('Memoryless/x.md'), ['notes']);
  assert.deepStrictEqual(sync.topicsForVault('Notes/Habits.md'), ['notes']);
});

test('events: vault changes and the agent’s own change events; anything else touches nothing', () => {
  assert.deepStrictEqual(sync.topicsForEvent('vault:changed', 'Habits.md').sort(), ['habits', 'notes', 'today', 'tree']);
  assert.deepStrictEqual(sync.topicsForEvent('vault:changed', { rel: 'Memory/a.md' }).sort(), ['memory', 'notes']);
  assert.deepStrictEqual(sync.topicsForEvent('chat:event', { type: 'start' }), ['conversations']);
  assert.deepStrictEqual(sync.topicsForEvent('chat:event', { type: 'skills_changed' }), ['skills']);
  assert.deepStrictEqual(sync.topicsForEvent('chat:event', { type: 'calendar_changed' }).sort(), ['sched', 'today']);
  for (const type of ['text', 'tool_start', 'tool_end', 'done', 'error', 'settings_changed', 'self_changed', 'thinking', 'nonsense']) assert.deepStrictEqual(sync.topicsForEvent('chat:event', { type }), [], type);
  for (const ch of ['approval:request', 'system:stats', 'claude:usage', 'info:changed', 'data:changed']) assert.deepStrictEqual(sync.topicsForEvent(ch, {}), [], ch);
  assert.deepStrictEqual(sync.topicsForEvent('chat:event', null), []);
});

test('every topic names a phone screen (or the schedule, or the conversation list)', () => {
  const titles = /export const TITLES = \{([^}]*)\}/.exec(read('renderer/remote/screens.js'))[1];
  const screens = new Set([...titles.matchAll(/(\w+):/g)].map((m) => m[1]));
  for (const t of sync.TOPICS) assert.ok(screens.has(t) || t === 'sched' || t === 'conversations', `${t} is not a phone screen`);
  // …and everything the rules or the change events produce is a known topic.
  const produced = new Set([...sync.VAULT_RULES.flatMap(([, t]) => t), 'notes']);
  for (const type of ['start', 'habits_changed', 'calendar_changed', 'memory_changed', 'skills_changed', 'skilltree_changed', 'world_changed']) for (const t of sync.topicsForEvent('chat:event', { type })) produced.add(t);
  for (const t of produced) assert.ok(sync.TOPICS.includes(t), t);
});

test('the vault names in the rules are the ones the modules write', () => {
  const constant = (rel, name) => new RegExp(`const ${name} = '([^']+)'`).exec(read(rel))?.[1];
  const names = [
    constant('main/habits.js', 'NOTE'),
    constant('main/calendar.js', 'FILE'),
    constant('main/skilltree.js', 'NOTE'),
    constant('main/handoff.js', 'VAULT_NOTE'),
    `${constant('main/flashcards.js', 'FOLDER')}/x.md`,
    `${constant('main/flashcards.js', 'LANGUAGES')}/x.md`,
    `${constant('main/learning.js', 'LEARNING')}/x.md`,
    constant('main/innerworld.js', 'CHRONICLE'),
    'Active Priorities.md',
  ];
  for (const n of names) {
    assert.ok(n, 'a constant was renamed: update this test and synccore.VAULT_RULES');
    assert.ok(sync.topicsForVault(n).some((t) => t !== 'notes'), `${n} reaches no screen but Notes`);
  }
  assert.match(read('main/obsidian.js'), /'Active Priorities\.md'/);
  assert.match(read('main/stream.js'), /`Stream\//);
  assert.match(read('main/memory.js'), /path\.join\(vault, 'Memory'\)/);
});

test('the coalescer: many changes, one message, each topic once, sorted; unknown topics dropped', () => {
  const timers = fakeTimers();
  const sent = [];
  const c = sync.coalescer((t) => sent.push(t), { waitMs: 600, timers });
  c.add(['habits', 'today']);
  c.add(['today', 'tree', 'secret/path.md', 42]);
  c.add([]);
  c.add('notes');
  assert.deepStrictEqual(sent, []);
  timers.tick(599);
  assert.deepStrictEqual(sent, []);
  timers.tick(1);
  assert.deepStrictEqual(sent, [['habits', 'notes', 'today', 'tree']]);
  // Nothing pending: no timer, no message.
  c.add(['nonsense']);
  assert.strictEqual(timers.pending, 0);
  c.add(['memory']);
  c.cancel();
  timers.tick(1000);
  assert.strictEqual(sent.length, 1, 'cancelled (the server stopped)');
  // A long burst still goes out after the first wait, not never.
  for (let i = 0; i < 50; i++) (c.add(['cards']), timers.tick(100));
  assert.ok(sent.length >= 2 && sent.at(-1).includes('cards'));
});

test('running turns: followed per conversation until they end; a lost end does not last forever', () => {
  let now = 0;
  const r = sync.runningTurns({ maxAgeMs: 1000, now: () => now });
  r.note({ requestId: 'a', conversationId: 'c1', type: 'start' });
  r.note({ requestId: 'b', conversationId: 'c1', type: 'start' });
  r.note({ requestId: 'c', conversationId: 'c2', type: 'start' });
  r.note({ requestId: 'a', conversationId: 'c1', type: 'text' });
  r.note({ type: 'start', conversationId: 'c1' }); // no requestId: ignored
  r.note(null);
  assert.deepStrictEqual(r.in('c1'), ['a', 'b']);
  assert.deepStrictEqual(r.in('c2'), ['c']);
  assert.deepStrictEqual(r.in('nope'), []);
  r.note({ requestId: 'a', type: 'done' });
  r.note({ requestId: 'c', type: 'error' });
  assert.deepStrictEqual(r.in('c1'), ['b']);
  assert.deepStrictEqual(r.in('c2'), []);
  now = 2000;
  assert.deepStrictEqual(r.in('c1'), [], 'b never reported its end');
  r.note({ requestId: 'd', conversationId: 'c1', type: 'start' });
  r.note({ requestId: 'd', type: 'aborted' });
  assert.strictEqual(r.size, 0);
});

// ------------------------------------------------------------------ renderer/remote/sync.js
test('a silent stream is dead after two missed pings, never while disconnected', async () => {
  const { streamStale, STALE_MS } = await client();
  assert.ok(STALE_MS > 2 * 25000 && STALE_MS < 120000, 'between two missed server pings and two minutes');
  assert.strictEqual(streamStale(0, STALE_MS + 1, true), true);
  assert.strictEqual(streamStale(0, STALE_MS, true), false);
  assert.strictEqual(streamStale(0, 10 * STALE_MS, false), false, 'already reconnecting');
  assert.strictEqual(streamStale(undefined, 10 * STALE_MS, true), false, 'never opened');
});

test('what a change redraws: the screen on show, unless busy or a live canvas', async () => {
  const { refreshPlan } = await client();
  assert.deepStrictEqual(refreshPlan(['habits', 'today'], { view: 'habits' }), { screen: true, schedule: false, conversations: false });
  assert.strictEqual(refreshPlan(['habits'], { view: 'today' }).screen, false, 'another screen');
  assert.strictEqual(refreshPlan(['cards'], { view: 'cards', busy: true }).screen, false, 'studying a card');
  assert.strictEqual(refreshPlan(['world'], { view: 'world' }).screen, false, 'live canvas');
  assert.strictEqual(refreshPlan(['notes'], { view: 'chat' }).screen, false);
  assert.deepStrictEqual(refreshPlan(['sched'], { view: 'sched' }), { screen: false, schedule: true, conversations: false }, 'the schedule has its own redraw');
  assert.strictEqual(refreshPlan(['conversations'], { view: 'chat' }).conversations, true);
  assert.deepStrictEqual(refreshPlan(undefined, {}), { screen: false, schedule: false, conversations: false });
  assert.deepStrictEqual(refreshPlan('habits', { view: 'habits' }), { screen: false, schedule: false, conversations: false }, 'not a list');
});

test('after a reconnect: the own reply ends if it finished meanwhile, stays if running or unsent; others are followed', async () => {
  const { reconcile } = await client();
  // The bug this fixes: the reply finished while the link was down, so "done" never came and the
  // composer stayed busy forever.
  assert.deepStrictEqual(reconcile({ requestId: 'r1' }, []), { keepActive: false, endActive: true, follow: [] });
  assert.deepStrictEqual(reconcile({ requestId: 'r1' }, ['r1']), { keepActive: true, endActive: false, follow: [] });
  assert.deepStrictEqual(reconcile({ requestId: null }, []), { keepActive: true, endActive: false, follow: [] }, 'still being sent');
  assert.deepStrictEqual(reconcile({ requestId: 'r1' }, ['r0', 'r1', 'r2']), { keepActive: true, endActive: false, follow: ['r0', 'r2'] });
  assert.deepStrictEqual(reconcile(null, ['rD']), { keepActive: false, endActive: false, follow: ['rD'] }, 'a reply from the desktop, joined mid-way');
  assert.deepStrictEqual(reconcile(null, undefined), { keepActive: false, endActive: false, follow: [] }, 'an older computer without `running`');
  assert.deepStrictEqual(reconcile(null, [null, 3, '', 'ok']).follow, ['ok']);
});

test('the open conversation against a fresh list: renamed, listed, or to be checked', async () => {
  const { convCheck } = await client();
  const list = [{ id: 'a', title: 'Trip' }, { id: 'b', title: '' }];
  assert.deepStrictEqual(convCheck(list, 'a'), { listed: true, title: 'Trip' });
  assert.deepStrictEqual(convCheck(list, 'b'), { listed: true, title: null });
  assert.deepStrictEqual(convCheck(list, 'gone'), { listed: false, title: null });
  assert.deepStrictEqual(convCheck(list, null), { listed: true, title: null }, 'a new conversation is nothing to check');
  assert.deepStrictEqual(convCheck(null, 'a'), { listed: true, title: null }, 'no list: assume nothing');
});

test('the phone batches change messages too', async () => {
  const { batcher } = await client();
  const timers = fakeTimers();
  const out = [];
  const add = batcher((t) => out.push(t.sort()), 300, timers);
  add(['habits']);
  timers.tick(200);
  add(['today', 'habits']);
  add('nope');
  add([1, null]);
  timers.tick(299);
  assert.deepStrictEqual(out, []);
  timers.tick(1);
  assert.deepStrictEqual(out, [['habits', 'today']]);
});

// ------------------------------------------------------------------ contracts between the two sides
test('every event the server streams has a handler on the phone, and the Android service ignores what it does not know', () => {
  const companion = read('main/companion.js');
  const streamed = [...new Set(/const STREAMED = new Set\(\[([^\]]*)\]/.exec(companion)[1].match(/'[^']+'/g).map((s) => s.slice(1, -1)))];
  const app = read('renderer/remote/app.js');
  const handled = new Set([...app.matchAll(/event === '([\w.]+)'/g)].map((m) => m[1]));
  for (const ch of streamed) assert.ok(handled.has(ch.replace(':', '.')), `the phone has no handler for ${ch}`);
  const service = read('android/app/src/main/java/com/nexusagent/android/ConnectionService.java');
  assert.match(service, /else if \(event\.equals\("info\.changed"\)\)[^\n]*\n\s*\} catch/, 'unknown events fall through to nothing');
});

test('every data route the phone calls exists on the server', () => {
  const companion = read('main/companion.js');
  const gets = new Set([...(/const DATA_GET = \{([\s\S]*?)\n\};/.exec(companion)[1]).matchAll(/^\s*'?([\w/]+)'?:/gm)].map((m) => m[1]));
  const posts = new Set([...companion.matchAll(/req\.method === 'POST' && name === '([\w/]+)'/g)].map((m) => m[1]));
  const screens = read('renderer/remote/screens.js');
  // Up to the call's first ")": a POST's options come before it, and two calls on one line stay apart.
  const calls = [...screens.matchAll(/api\([`']\/api\/data\/([a-z/]+?)(?:[?`'$]|\/\$)([^)]*)/g)];
  const found = new Set(calls.map((m) => m[1].replace(/\/$/, '')));
  for (const n of ['today', 'habits', 'habits/log', 'skills', 'routines', 'flashcards', 'flashcards/mix', 'note', 'arch']) assert.ok(found.has(n), `the test no longer sees the phone's call to ${n}`);
  for (const m of calls) {
    const name = m[1].replace(/\/$/, '');
    const post = /method: 'POST'/.test(m[2]);
    // Built from a variable: `flashcards/${what === 'undo' ? 'undo' : 'answer'}` and the mix's twin.
    const names = /\$\{/.test(m[0]) && /'undo' : 'answer'/.test(m[0]) ? [`${name}/undo`, `${name}/answer`] : [name];
    for (const n of names) assert.ok(post ? posts.has(n) : gets.has(n) || posts.has(n), `${post ? 'POST' : 'GET'} /api/data/${n} has no route`);
  }
});

test('every module the phone client loads is served, and the offline shell caches only served files', () => {
  const companion = read('main/companion.js');
  const served = new Set([...(/const STATIC = \{([\s\S]*?)\n\};/.exec(companion)[1]).matchAll(/'(\/[^']*)':/g)].map((m) => m[1]));
  for (const file of ['renderer/remote/app.js', 'renderer/remote/screens.js']) {
    const src = read(file);
    for (const m of src.matchAll(/(?:from|import\()\s*'(\.\/[\w./-]+|\/[\w./-]+)'/g)) {
      const p = m[1].replace(/^\.\//, '/');
      assert.ok(served.has(p), `${file} loads ${p}, which the server does not serve`);
    }
  }
  const sw = read('renderer/remote/sw.js');
  const shell = [...sw.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]);
  for (const p of shell) assert.ok(served.has(p), `the service worker caches ${p}, which is not served`);
  assert.ok(shell.includes('/sync.js'));
});

test('the server tells devices what changed but never which note or what it says', () => {
  // Only the fixed vocabulary leaves: a path (or anything else) handed to clean() is dropped.
  for (const rel of ['Memory/my bank pin.md', 'Notes/Diary 2026.md', 'Flashcards/Private.md']) for (const t of sync.topicsForVault(rel)) assert.ok(sync.TOPICS.includes(t), t);
  assert.deepStrictEqual(sync.clean(['Memory/my bank pin.md', 'memory', { rel: 'x' }]), ['memory']);
  assert.deepStrictEqual(sync.clean('notes'), ['notes']);
});
