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
    'Habits.md': ['notes'], // an ordinary note now
    'Schedule.md': ['notes', 'sched', 'today'],
    'Memory/likes-tea.md': ['memory', 'notes'],
    'Stream/2026-10.md': ['memory', 'notes'],
    'Languages/Spanish.md': ['learn', 'notes', 'today'],
    'Languages/media/hola.png': ['learn', 'today'], // not a note
    'Learning/Calculus.md': ['learn', 'notes', 'today'],
    'Inner World/Chronicle.md': ['notes', 'world'],
    'Inner World/Residents/Ada.md': ['notes', 'world'],
    'Active Priorities.md': ['notes', 'today'],
    'Where We Left Off.md': ['notes', 'today'],
    'Notes/Shopping.md': ['notes'],
    'Daily/2026-10-31.md': ['notes'],
    'Notes/photo.png': [], // not a note, and in no folder a screen shows
  };
  for (const [rel, want] of Object.entries(cases)) assert.deepStrictEqual(sync.topicsForVault(rel).sort(), want, rel);
});

test('vault paths: Windows separators and case are understood; hidden folders and nothing are ignored', () => {
  assert.deepStrictEqual(sync.topicsForVault('Memory\\x.md').sort(), ['memory', 'notes']);
  assert.deepStrictEqual(sync.topicsForVault('schedule.md').sort(), ['notes', 'sched', 'today']);
  assert.deepStrictEqual(sync.topicsForVault('/Schedule.md').sort(), ['notes', 'sched', 'today']);
  for (const rel of ['', null, undefined, '.obsidian/workspace.json', '.trash/old.md', '.git/HEAD']) assert.deepStrictEqual(sync.topicsForVault(rel), [], String(rel));
  // A folder only *starting* like a known one is just a note.
  assert.deepStrictEqual(sync.topicsForVault('Memoryless/x.md'), ['notes']);
  assert.deepStrictEqual(sync.topicsForVault('Notes/Schedule.md'), ['notes']);
});

test('events: vault changes and the agent’s own change events; anything else touches nothing', () => {
  assert.deepStrictEqual(sync.topicsForEvent('vault:changed', 'Schedule.md').sort(), ['notes', 'sched', 'today']);
  assert.deepStrictEqual(sync.topicsForEvent('vault:changed', { rel: 'Memory/a.md' }).sort(), ['memory', 'notes']);
  assert.deepStrictEqual(sync.topicsForEvent('chat:event', { type: 'start' }), ['conversations']);
  assert.deepStrictEqual(sync.topicsForEvent('chat:event', { type: 'skills_changed' }), ['skills']);
  assert.deepStrictEqual(sync.topicsForEvent('chat:event', { type: 'calendar_changed' }).sort(), ['sched', 'today']);
  for (const type of ['text', 'tool_start', 'tool_end', 'done', 'error', 'settings_changed', 'self_changed', 'thinking', 'habits_changed', 'nonsense']) assert.deepStrictEqual(sync.topicsForEvent('chat:event', { type }), [], type);
  for (const ch of ['approval:request', 'system:stats', 'claude:usage', 'info:changed', 'data:changed']) assert.deepStrictEqual(sync.topicsForEvent(ch, {}), [], ch);
  assert.deepStrictEqual(sync.topicsForEvent('chat:event', null), []);
});

test('every topic names a phone screen (or the schedule, or the conversation list)', () => {
  const titles = /export const TITLES = \{([^}]*)\}/.exec(read('renderer/remote/screens.js'))[1];
  const screens = new Set([...titles.matchAll(/(\w+):/g)].map((m) => m[1]));
  for (const t of sync.TOPICS) assert.ok(screens.has(t) || t === 'sched' || t === 'conversations', `${t} is not a phone screen`);
  // …and everything the rules or the change events produce is a known topic.
  const produced = new Set([...sync.VAULT_RULES.flatMap(([, t]) => t), 'notes']);
  for (const type of ['start', 'calendar_changed', 'memory_changed', 'skills_changed', 'world_changed']) for (const t of sync.topicsForEvent('chat:event', { type })) produced.add(t);
  for (const t of produced) assert.ok(sync.TOPICS.includes(t), t);
});

test('the vault names in the rules are the ones the modules write', () => {
  const constant = (rel, name) => new RegExp(`const ${name} = '([^']+)'`).exec(read(rel))?.[1];
  const names = [
    constant('main/calendar.js', 'FILE'),
    constant('main/handoff.js', 'VAULT_NOTE'),
    `${constant('main/learning.js', 'LANGUAGES')}/x.md`,
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
  c.add(['habits', 'sched', 'today']); // 'habits' is no topic any more
  c.add(['today', 'learn', 'secret/path.md', 42]);
  c.add([]);
  c.add('notes');
  assert.deepStrictEqual(sent, []);
  timers.tick(599);
  assert.deepStrictEqual(sent, []);
  timers.tick(1);
  assert.deepStrictEqual(sent, [['learn', 'notes', 'sched', 'today']]);
  // Nothing pending: no timer, no message.
  c.add(['nonsense']);
  assert.strictEqual(timers.pending, 0);
  c.add(['memory']);
  c.cancel();
  timers.tick(1000);
  assert.strictEqual(sent.length, 1, 'cancelled (the server stopped)');
  // A long burst still goes out after the first wait, not never.
  for (let i = 0; i < 50; i++) (c.add(['learn']), timers.tick(100));
  assert.ok(sent.length >= 2 && sent.at(-1).includes('learn'));
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
  assert.deepStrictEqual(refreshPlan(['learn', 'today'], { view: 'learn' }), { screen: true, schedule: false, conversations: false });
  assert.strictEqual(refreshPlan(['learn'], { view: 'today' }).screen, false, 'another screen');
  assert.strictEqual(refreshPlan(['notes'], { view: 'notes', busy: true }).screen, false, 'reading a note');
  assert.strictEqual(refreshPlan(['world'], { view: 'world' }).screen, false, 'live canvas');
  assert.strictEqual(refreshPlan(['notes'], { view: 'chat' }).screen, false);
  assert.deepStrictEqual(refreshPlan(['sched'], { view: 'sched' }), { screen: false, schedule: true, conversations: false }, 'the schedule has its own redraw');
  assert.strictEqual(refreshPlan(['conversations'], { view: 'chat' }).conversations, true);
  assert.deepStrictEqual(refreshPlan(undefined, {}), { screen: false, schedule: false, conversations: false });
  assert.deepStrictEqual(refreshPlan('learn', { view: 'learn' }), { screen: false, schedule: false, conversations: false }, 'not a list');
});

test('after a reconnect: the own reply ends if it finished meanwhile, stays if running or unsent; others are followed', async () => {
  // The rule lives with the conversation's state (renderer/js/turnstate.js), shared with the desktop;
  // test/turnstate.test.js drives it through createChat().reconcile.
  const dir = tmpDir('nexus-sync-turns-');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const f of ['turnstate.js', 'chatcore.js', 'braintable.mjs']) fs.copyFileSync(path.join(ROOT, 'renderer/js', f), path.join(dir, f));
  const { reconcile } = await import(pathToFileURL(path.join(dir, 'turnstate.js')).href);
  assert.ok(!('reconcile' in (await client())), 'one copy of the rule');
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
  add(['learn']);
  timers.tick(200);
  add(['today', 'learn']);
  add('nope');
  add([1, null]);
  timers.tick(299);
  assert.deepStrictEqual(out, []);
  timers.tick(1);
  assert.deepStrictEqual(out, [['learn', 'today']]);
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
  for (const n of ['today', 'learn', 'memories', 'notes', 'skills', 'routines', 'note', 'arch']) assert.ok(found.has(n), `the test no longer sees the phone's call to ${n}`);
  for (const m of calls) {
    const name = m[1].replace(/\/$/, '');
    const post = /method: 'POST'/.test(m[2]);
    assert.ok(post ? posts.has(name) : gets.has(name), `${post ? 'POST' : 'GET'} /api/data/${name} has no route`);
  }
  // The data routes are read-only: the phone posts to none, and the server takes no POST there.
  assert.deepStrictEqual(calls.filter((m) => /method: 'POST'/.test(m[2])).map((m) => m[1]), [], 'the phone writes through a data route');
  assert.deepStrictEqual([...posts], []);
  assert.match(companion, /req\.method === 'GET' && Object\.hasOwn\(DATA_GET, name\)/, 'data routes answer GET only');
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
  for (const rel of ['Memory/my bank pin.md', 'Notes/Diary 2026.md', 'Languages/Private.md']) for (const t of sync.topicsForVault(rel)) assert.ok(sync.TOPICS.includes(t), t);
  assert.deepStrictEqual(sync.clean(['Memory/my bank pin.md', 'memory', { rel: 'x' }]), ['memory']);
  assert.deepStrictEqual(sync.clean('notes'), ['notes']);
});

// ------------------------------------------------------------------ Android Back, deadlines, unsent messages
// A small seeded generator (mulberry32): a failing case names its seed and index, so it can be replayed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PHONE_TABS = ['chat', 'today', 'notes', 'learn', 'more'];

test('Android Back: the top layer first, then the screen, then the chat; nothing at the top', async () => {
  const { backPlan } = await client();
  const at = (s) => backPlan({ tabs: PHONE_TABS, ...s });
  assert.strictEqual(at({ offline: true }), 'offline');
  assert.strictEqual(at({ drawerOpen: true }), 'drawer');
  assert.strictEqual(at({ faceFull: true }), 'face');
  assert.strictEqual(at({ screenBack: true, view: 'notes' }), 'screen');
  assert.strictEqual(backPlan({}), null, 'the bare chat: the app goes to the background');
  assert.strictEqual(backPlan(), null);
  assert.strictEqual(at({ view: 'today' }), 'chat', 'a tab goes back to the chat');
  assert.strictEqual(at({ view: 'today', wide: true }), null, 'on a tablet the chat is already beside it');
  assert.strictEqual(at({ view: 'world' }), 'more', 'a screen from the More menu goes back to More');
  assert.strictEqual(at({ view: 'world', wide: true }), 'more');
  assert.strictEqual(at({ view: 'sched' }), 'chat', 'the schedule was opened from the chat');
  assert.strictEqual(at({ view: 'sched', wide: true }), 'chat');
  for (const view of ['', 'xyz']) assert.strictEqual(at({ view }), 'more', `unknown view "${view}"`);
  for (const view of ['today', 'notes', 'learn', 'more', 'world']) assert.strictEqual(backPlan({ view, tabs: [] }), 'more', `${view} without tabs`);
  assert.strictEqual(backPlan({ view: 'chat', tabs: [] }), null);
  assert.strictEqual(backPlan({ view: 'sched', tabs: [] }), 'chat');
});

test('Android Back: any mix of layers and views follows the same order (seeded)', async () => {
  const { backPlan } = await client();
  const oracle = (s) => {
    if (s.offline) return 'offline';
    if (s.drawerOpen) return 'drawer';
    if (s.faceFull) return 'face';
    if (s.screenBack) return 'screen';
    if (s.view === 'chat') return null;
    if (s.view === 'sched') return 'chat';
    if (!s.tabs.includes(s.view)) return 'more';
    return s.wide ? null : 'chat';
  };
  const VIEWS = ['chat', 'sched', 'today', 'notes', 'learn', 'more', 'world', 'arch', 'memory', 'skills', '', 'xyz'];
  const ALLOWED = new Set(['offline', 'drawer', 'face', 'screen', 'chat', 'more', null]);
  const seed = 20261118;
  const rnd = mulberry32(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const flag = () => pick([true, false, false, false, undefined]);
  for (let i = 0; i < 200; i++) {
    const s = { offline: flag(), drawerOpen: flag(), faceFull: flag(), screenBack: flag(), view: pick(VIEWS), tabs: rnd() < 0.8 ? PHONE_TABS : PHONE_TABS.filter(() => rnd() < 0.5), wide: flag() };
    const got = backPlan(s);
    assert.ok(ALLOWED.has(got), `seed ${seed} case ${i}: ${JSON.stringify(got)} for ${JSON.stringify(s)}`);
    assert.strictEqual(got, oracle(s), `seed ${seed} case ${i}: ${JSON.stringify(s)}`);
  }
});

test('"Try again now": a hanging attempt is given up, a wait ends, a live link is left alone', async () => {
  const { retryAction } = await client();
  assert.strictEqual(retryAction({ connected: true }), 'none');
  assert.strictEqual(retryAction({ connected: true, connecting: true }), 'none');
  assert.strictEqual(retryAction({ connecting: true }), 'abort');
  assert.strictEqual(retryAction({ connected: false, connecting: false }), 'wake');
  assert.strictEqual(retryAction({}), 'wake');
  assert.strictEqual(retryAction(), 'wake');
});

test('deadlines: a send, a pairing and a connection give up; a transcription waits for its length, capped', async () => {
  const { DEADLINES, transcribeDeadline } = await client();
  assert.deepStrictEqual(DEADLINES, { chat: 30000, pair: 20000, connect: 15000 });
  for (const v of [0, -1, NaN, undefined, null, -Infinity, '', 'abc']) assert.strictEqual(transcribeDeadline(v), 65000, String(v));
  assert.strictEqual(transcribeDeadline(32), 65001, 'one millisecond of audio');
  assert.strictEqual(transcribeDeadline('64'), 65002);
  assert.strictEqual(transcribeDeadline(120 * 32000), 185000, 'two minutes, the longest recording');
  for (const v of [600 * 32000, Infinity, Number.MAX_SAFE_INTEGER]) assert.strictEqual(transcribeDeadline(v), 185000, `${v}: capped, never an endless timer`);
  for (let b = 0; b <= 120 * 32000; b += 100003) {
    const ms = transcribeDeadline(b);
    assert.ok(Number.isInteger(ms) && ms >= 65000 && ms <= 185000, `${b} bytes → ${ms}`);
  }
});

test('a message the phone could not send: shown again after a reload, dropped once the computer has it', async () => {
  const { unsentPlan } = await client();
  const failed = { convId: 'c1', sentText: 'Add the dentist', priorUsers: 0 };
  const user = (content, extra = {}) => ({ role: 'user', content, ...extra });
  assert.strictEqual(unsentPlan(null, 'c1', []), 'skip');
  assert.strictEqual(unsentPlan(undefined, 'c1', []), 'skip');
  assert.strictEqual(unsentPlan(failed, 'c2', [user('Add the dentist')]), 'skip', 'another conversation is shown');
  assert.strictEqual(unsentPlan(failed, null, []), 'skip', 'a new conversation is shown');
  // A message sent in a new conversation belongs to the new conversation (null, undefined and '' alike).
  for (const id of [null, undefined, '']) assert.strictEqual(unsentPlan({ convId: null, sentText: 'Hi' }, id, []), 'show', String(id));
  assert.strictEqual(unsentPlan({ sentText: 'Hi' }, undefined, []), 'show');
  for (const messages of [undefined, null, [], 'x', 42, [null, {}]]) assert.strictEqual(unsentPlan(failed, 'c1', messages), 'show', JSON.stringify(messages));
  assert.strictEqual(unsentPlan(failed, 'c1', [user('Add the dentist')]), 'drop', 'the computer has it: only the answer was lost');
  assert.strictEqual(unsentPlan(failed, 'c1', [user('Add the dentist  \n')]), 'drop', 'trailing whitespace on the stored side');
  assert.strictEqual(unsentPlan({ ...failed, sentText: '  Add the dentist\n' }, 'c1', [user('Add the dentist')]), 'drop', 'and on the sent side');
  assert.strictEqual(unsentPlan(failed, 'c1', [user('/remind x', { display: 'Add the dentist' })]), 'drop', 'what the bubble shows counts over the content');
  assert.strictEqual(unsentPlan(failed, 'c1', [user('Add the dentist', { display: 'something else' })]), 'show');
  assert.strictEqual(unsentPlan(failed, 'c1', [user('Add the dentist'), { role: 'assistant', content: 'Added.' }]), 'drop', 'a user message counts, not the last message');
  assert.strictEqual(unsentPlan(failed, 'c1', [user('Add the dentist'), { role: 'assistant', content: 'Done' }, user('And the vet')]), 'drop', 'stored, then a newer message from elsewhere: still the computer has it');
  const texts = ['x'.repeat(10000), 'مرحبا، أضف موعد طبيب الأسنان', '👨‍👩‍👧‍👦 family dinner', '<script>alert(1)</script>', "' OR 1=1 --"];
  for (const text of texts) {
    assert.strictEqual(unsentPlan({ ...failed, sentText: text }, 'c1', [user(text)]), 'drop', text.slice(0, 30));
    const other = text.slice(0, -1) + (text.endsWith('a') ? 'b' : 'a');
    assert.strictEqual(unsentPlan({ ...failed, sentText: text }, 'c1', [user(other)]), 'show', `${text.slice(0, 30)}: one character different`);
  }
  assert.strictEqual(unsentPlan({ ...failed, sentText: '👨‍👩‍👧‍👦' }, 'c1', [user('👨‍👩‍👧')]), 'show', 'a ZWJ family is not its first members');
  assert.strictEqual(unsentPlan({ ...failed, sentText: '' }, 'c1', [user('', { attachments: [{ name: 'a.pdf' }] })]), 'show', 'files sent without a word are not an empty message of the phone');
});

test('a short reply said again ("yes" after "yes") is still unsent: only a newer copy on the computer is it', async () => {
  const { unsentPlan } = await client();
  const user = (content) => ({ role: 'user', content });
  const reply = (content) => ({ role: 'assistant', content });
  // The phone showed "Add it?" … "yes" (answered), then a second "yes" failed while out of reach.
  const yes = { convId: 'c1', sentText: 'yes', priorUsers: 2 };
  const before = [user('Add the dentist on Friday'), reply('At 9?'), user('yes'), reply('Added it.')];
  assert.strictEqual(unsentPlan(yes, 'c1', before), 'show', 'the earlier "yes" is not this one');
  assert.strictEqual(unsentPlan(yes, 'c1', [...before, user('yes')]), 'drop', 'the computer stored it after all (the send timed out after reaching it)');
  assert.strictEqual(unsentPlan(yes, 'c1', [...before, user('yes'), reply('Done.'), user('thanks')]), 'drop', 'stored, and something newer came from elsewhere');
  assert.strictEqual(unsentPlan(yes, 'c1', [...before, user('no')]), 'show', 'something else was said after it');
  assert.strictEqual(unsentPlan(yes, 'c1', before.slice(0, 2)), 'show', 'fewer messages than the phone saw (some went on the computer)');
  // Without a usable count the message is always shown: a duplicate with Try again, never a lost message.
  for (const priorUsers of [undefined, null, NaN, -1, 1.5, '2', Infinity, {}]) assert.strictEqual(unsentPlan({ convId: 'c1', sentText: 'yes', priorUsers }, 'c1', [...before, user('yes')]), 'show', String(priorUsers));
  assert.strictEqual(unsentPlan({ convId: 'c1', sentText: 'yes', priorUsers: 99 }, 'c1', [...before, user('yes')]), 'show', 'a count past the conversation');
});

// Regression: a conversation opened while the computer was out of reach draws nothing (loadConversation
// cleared the list and returned on NetError, keeping convId), so a "yes" sent then counted 0 earlier messages,
// and once the conversation loaded an earlier "yes" in it was taken for this one: the unsent message and its
// Try again disappeared.
test('a message sent while its conversation isn’t drawn is never taken for an earlier one with the same words', async () => {
  const { priorUsersFor, unsentPlan } = await client();
  assert.strictEqual(priorUsersFor({ shownConv: undefined, convId: 'c1', count: 0 }), null, 'opened while out of reach, or still loading');
  assert.strictEqual(priorUsersFor({ shownConv: 'c0', convId: 'c1', count: 3 }), null, 'another conversation’s messages are on screen');
  assert.strictEqual(priorUsersFor({ shownConv: 'c1', convId: 'c1', count: 2 }), 2, 'drawn: counted');
  assert.strictEqual(priorUsersFor({ shownConv: null, convId: null, count: 0 }), 0, 'a new conversation');
  assert.strictEqual(priorUsersFor({ shownConv: null, convId: undefined, count: 1 }), 1);
  assert.strictEqual(priorUsersFor({ shownConv: undefined, convId: null, count: 0 }), null, 'nothing drawn yet at all');
  const earlier = [{ role: 'user', content: 'Add the dentist?' }, { role: 'assistant', content: 'At 9?' }, { role: 'user', content: 'yes' }, { role: 'assistant', content: 'Added.' }];
  const failed = { convId: 'c1', sentText: 'yes', priorUsers: priorUsersFor({ shownConv: undefined, convId: 'c1', count: 0 }) };
  assert.strictEqual(unsentPlan(failed, 'c1', earlier), 'show', 'the earlier "yes" is not this one');
  assert.strictEqual(unsentPlan({ ...failed, priorUsers: 0 }, 'c1', earlier), 'drop', 'what counting the empty screen did');

  // app.js: the count goes through priorUsersFor, and only a load that drew the messages marks them shown.
  const app = fs.readFileSync(path.join(ROOT, 'renderer/remote/app.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(app, /const priorUsers = priorUsersFor\(\{ shownConv: state\.shownConv, convId: state\.convId, count: /);
  const load = app.slice(app.indexOf('async function loadConversation(id) {'), app.indexOf('\nfunction keepUnsent('));
  assert.match(load, /for \(const m of conv\.messages\) addMessage\(m\);\n\s*state\.shownConv = id;/);
  assert.match(load, /\$\('#messages'\)\.innerHTML = '';\n\s*state\.shownConv = undefined;/);
  const offline = load.slice(load.indexOf('} catch (err) {'));
  assert.ok(offline.indexOf('if (err instanceof NetError) return updateEmpty();') < offline.indexOf('state.shownConv'), 'out of reach: still nothing drawn');
});

test('unsent messages: any conversation the phone saw keeps the message; one more stored copy drops it (seeded)', async () => {
  const { unsentPlan } = await client();
  const WORDS = ['yes', 'no', 'ok', 'continue', ' yes ', 'Yes', '👍', ''];
  const seed = 7311;
  const rnd = mulberry32(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  for (let i = 0; i < 300; i++) {
    const sent = pick(WORDS.filter(Boolean));
    const seen = [];
    const users = Math.floor(rnd() * 6);
    for (let u = 0; u < users; u++) {
      seen.push({ role: 'user', content: pick(WORDS) });
      if (rnd() < 0.7) seen.push({ role: 'assistant', content: pick(['Done.', 'Sure', '']) });
    }
    const failed = { convId: 'c', sentText: sent, priorUsers: users };
    assert.strictEqual(unsentPlan(failed, 'c', seen), 'show', `seed ${seed} case ${i}: what the phone saw never contains this message: ${JSON.stringify({ sent, seen })}`);
    const stored = [...seen, { role: 'user', content: rnd() < 0.5 ? sent : `${sent}  ` }];
    if (rnd() < 0.5) stored.push({ role: 'assistant', content: 'Done.' }, { role: 'user', content: pick(WORDS) });
    assert.strictEqual(unsentPlan(failed, 'c', stored), 'drop', `seed ${seed} case ${i}: stored after what the phone saw: ${JSON.stringify({ sent, stored })}`);
    assert.strictEqual(unsentPlan(failed, 'other', stored), 'skip', `seed ${seed} case ${i}: another conversation`);
  }
});

// ------------------------------------------------------------------ the Android side (source contracts)
const javaBody = (src, from) => {
  const open = src.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced braces');
};
// The body of the first method named `name` (with `params` starting its parameter list, if given).
const javaMethod = (src, name, params = '') => {
  const m = new RegExp(`\\s${name}\\(${params.replace(/[()]/g, '\\$&')}[^)]*\\)\\s*\\{`).exec(src);
  assert.ok(m, `no method ${name}(${params}…)`);
  return javaBody(src, m.index);
};
const ANDROID = 'android/app/src/main/java/com/nexusagent/android/';
const KEYED = ['setToken', 'clearToken', 'changeServer', 'setBackground', 'setLock', 'moveTo', 'lookChanged', 'openAppSettings'];
const KEYLESS = ['hello', 'appVersion', 'backgroundEnabled', 'lockAvailable', 'lockEnabled', 'backTarget'];

test('the bridge: what changes something takes the key first; everything else is read-only or a no-op', () => {
  const src = read(`${ANDROID}MainActivity.java`);
  const methods = [...src.matchAll(/@JavascriptInterface\s+public\s+(?:synchronized\s+)?[\w<>]+\s+(\w+)\(([^)]*)\)\s*\{/g)].map((m) => ({ name: m[1], params: m[2].trim(), body: javaBody(src, m.index).trim() }));
  assert.strictEqual(methods.length, (src.match(/@JavascriptInterface/g) || []).length, 'the test sees every bridge method');
  for (const m of methods) {
    if (m.params.startsWith('String key')) {
      assert.ok(KEYED.includes(m.name), `${m.name} takes a key but isn't in the keyed list: classify it`);
      assert.ok(m.body.startsWith('if (!trusted(key)) return;'), `${m.name} checks the key first`);
    } else if (m.name === 'hello') {
      assert.match(m.body, /if \(claimed\) return "";\s*claimed = true;[^\n]*\s*if \(!ours\(\)\) return "";/, 'hello: once, and only to our own page');
    } else if (KEYLESS.includes(m.name)) {
      assert.match(m.body, /\btrusted\(\)/, `${m.name} answers only our own page`);
    } else if (m.name === 'changeServer') {
      // An older computer's page (it never asks for the key) can still reach the setup screen: its offline
      // screen, served from the cache, has no other way there. Once the page has the key, nothing.
      assert.match(m.body, /^if \(handedOut \|\| !trusted\(\)\) return;\s*runOnUiThread\(\(\) -> showSetup\(null, null\)\);$/, 'the keyless changeServer only opens the setup screen, for a page without the key');
    } else {
      // The signatures before 2.7.25 (an older computer's page still calls them) must change nothing.
      assert.ok(KEYED.includes(m.name), `${m.name} is a new bridge method: classify it here (keyed or read-only)`);
      assert.strictEqual(m.body, '', `${m.name}(${m.params}) without a key must do nothing`);
    }
  }
  for (const name of KEYED) assert.ok(methods.some((m) => m.name === name && m.params.startsWith('String key')), `${name} has a keyed version`);
  for (const name of KEYLESS) assert.ok(methods.some((m) => m.name === name), `${name} is on the bridge`);
  // The key: random, compared in constant time, handed out once per WebView.
  assert.match(src, /new SecureRandom\(\)\.nextBytes/);
  assert.match(src, /MessageDigest\.isEqual\(/);
  assert.match(src, /bridge = new Bridge\(\);\s*web\.addJavascriptInterface\(bridge, "NexusAndroid"\);/, 'a new bridge (and key) for every WebView');
  assert.match(javaMethod(src, 'hello'), /handedOut = true;\s*return key;/);
});

test('the bridge offers its key only until the page has started: a face never picks up an unclaimed key', () => {
  const src = read(`${ANDROID}MainActivity.java`);
  // The page asks first thing; any other call, or our page's finished load, ends the offer. A page from
  // before 2.7.25 never asks (its first call is backgroundEnabled), so a face mounted later found the key.
  assert.match(javaMethod(src, 'endOffer'), /^\s*claimed = true;\s*$/);
  assert.match(src, /synchronized void endOffer\(\)/, 'under the same lock as hello');
  assert.match(javaMethod(src, 'trusted'), /^\s*endOffer\(\);\s*return ours\(\);\s*$/, 'every call but hello ends the offer');
  assert.match(javaMethod(src, 'trusted', 'String k'), /return trusted\(\) &&/, 'the keyed check goes through trusted() too');
  assert.match(javaMethod(src, 'onPageFinished'), /if \(loaded\) bridge\.endOffer\(\);/, 'our page loaded: no key left on offer');
  const app = read('renderer/remote/app.js');
  const first = app.search(/\bandroid(\?)?\.\w+\(/);
  assert.ok(first >= 0 && app.slice(first).startsWith('android.hello()'), `the page's first bridge call is hello (found: ${app.slice(first, first + 30)})`);
});

test('the app lock stays over every screen rebuilt while locked', () => {
  const src = read(`${ANDROID}MainActivity.java`);
  assert.match(javaMethod(src, 'lock'), /locked = true;\s*cover\(\);\s*promptUnlock\(\);/);
  const methods = [...src.matchAll(/(?:private|public|protected)\s+[\w<>.]+\s+(\w+)\(([^)]*)\)\s*\{/g)].map((m) => ({ name: m[1], body: javaBody(src, m.index) }));
  const rebuilders = methods.filter((m) => m.body.includes('root.removeAllViews()'));
  assert.deepStrictEqual(rebuilders.map((m) => m.name).sort(), ['hudPanel', 'showWeb'], 'every method that empties the screen is checked here');
  for (const m of rebuilders) {
    // removeAllViews() takes the lock view away too: what is added after it must go under the lock again.
    const cover = m.body.lastIndexOf('if (locked) cover();');
    assert.ok(cover > m.body.lastIndexOf('root.addView('), `${m.name} covers its new screen when locked (after its last root.addView)`);
  }
});

test('Android Back and Change the address: the page decides, nothing is lost', () => {
  const src = read(`${ANDROID}MainActivity.java`);
  assert.doesNotMatch(javaMethod(src, 'onBackPressed'), /goBack|super\.onBackPressed/, 'Back never goes to a sign-in page or destroys the WebView');
  assert.match(src, /nexusBack/, 'Back asks the page');
  assert.match(src, /registerOnBackInvokedCallback/);
  assert.doesNotMatch(javaMethod(src, 'changeServer', 'String key'), /setBackground\(|setToken\(|ConnectionService\.stop/, 'checking the address keeps the notifications, the token and the connection');
  // Connect stops the background connection exactly when it forgets the token (another computer, a pairing link).
  assert.match(src, /if \(!o\.equals\(Prefs\.server\(this\)\) \|\| isLink\) \{\s*Prefs\.setToken\(this, null, null\);[^\n]*\n\s*ConnectionService\.stop\(this\);/);
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:enableOnBackInvokedCallback="true"/);
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.match(manifest, /android:allowBackup="false"/);
  const rules = read('android/app/src/main/res/xml/data_extraction_rules.xml');
  for (const section of ['cloud-backup', 'device-transfer']) {
    const body = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`).exec(rules)?.[1] || '';
    assert.match(body, /<exclude domain="root" path="\." \/>/, `${section} leaves the app's storage (the WebView's included) out`);
    assert.doesNotMatch(body, /<include/, `${section} includes nothing`);
  }
});

test('the device token goes only to the computer that issued it', () => {
  for (const file of ['ConnectionService.java', 'WearRelayService.java', 'ApprovalReceiver.java']) {
    const src = read(`${ANDROID}${file}`);
    assert.match(src, /Prefs\.tokenFor\(/, file);
    assert.doesNotMatch(src, /Prefs\.token\(/, `${file} sends the token: only through tokenFor`);
  }
  const prefs = read(`${ANDROID}Prefs.java`);
  assert.match(javaMethod(prefs, 'setToken'), /putString\("tokenOrigin", server\(c\)\)/, 'a new token is bound to the address it came from');
  assert.match(javaMethod(prefs, 'tokenFor'), /server\.equals\(bound\) \? token\(c\) : null/);
});

test('the watch keeps waiting for an answer while its screen is off', () => {
  const link = read('android/wear/src/main/java/com/nexusagent/android/wear/Link.java');
  assert.match(javaMethod(link, 'request'), /postDelayed\(\(\) -> \{\s*if \(waiting\.remove\(key, onResult\)\)/, 'a timer ends only its own request');
  assert.match(javaMethod(link, 'fail'), /waiting\.remove\(key, cb\)/, 'a failure ends only its own request');
  const watch = read('android/wear/src/main/java/com/nexusagent/android/wear/WatchActivity.java');
  const pause = javaMethod(watch, 'onPause');
  for (const gone of ['link.stop()', 'busy = false', 'stopPlayer()', 'voiceId = null', 'unregisterChannelCallback']) assert.ok(!pause.includes(gone), `onPause must not run ${gone}`);
  assert.match(javaMethod(watch, 'onCreate'), /link\.start\(\);/);
  assert.match(javaMethod(watch, 'onCreate'), /registerChannelCallback\(voiceChannel\)/);
  assert.doesNotMatch(javaMethod(watch, 'onResume'), /link\.start\(\)|registerChannelCallback/, 'never added twice');
  assert.match(javaMethod(watch, 'onDestroy'), /link\.stop\(\);/);
  assert.match(javaMethod(watch, 'onDestroy'), /unregisterChannelCallback\(voiceChannel\)/);
  assert.match(javaMethod(watch, 'button'), /dp\(48\)/, 'the buttons are 48 dp touch targets');
});

test('the phone page calls what changes something only through the key', () => {
  const app = read('renderer/remote/app.js');
  assert.match(app, /const bridgeKey = .*android\.hello\(\)/);
  assert.match(app, /window\.nexusBack = /);
  for (const name of KEYED) assert.doesNotMatch(app, new RegExp(`android(\\?)?\\.${name}(\\?\\.)?\\(`), `${name} is called around the key`);
  assert.match(app, /bridge\('setToken'/);
});
