// Settings: typed values wait and are saved once, into the persona whose cards they were typed in
// (renderer/js/settingsave.js); a value typed for one persona never lands in another after a switch
// elsewhere. Plus what settings.js itself must keep (it needs the window, so its source is read):
// every card in one parallel render, the studio saving before its own switches, the Safety copy, the
// acknowledgments. And Evolution's Record and Discard (renderer/js/evolution.js, run against stand-ins):
// once at a time, "Nothing left to record." when clean, "discarded" only when it worked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir, settingsSource } = require('./helpers');

let m;
const ESM = tmpDir('nexus-settingsave-');
test.before(async () => {
  const copy = path.join(ESM, 'settingsave.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/settingsave.js'), copy);
  fs.copyFileSync(path.join(ROOT, 'renderer/js/personafields.mjs'), path.join(ESM, 'personafields.mjs'));
  m = await import(pathToFileURL(copy).href);
});
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

// A clock the test moves: timers run in order when advance() passes them. No real waits.
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const list = [];
  return {
    set: (fn, ms) => {
      const t = { at: now + ms, fn, id: ++seq };
      list.push(t);
      return t;
    },
    clear: (t) => {
      const i = list.indexOf(t);
      if (i >= 0) list.splice(i, 1);
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        list.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!list.length || list[0].at > until) break;
        const t = list.shift();
        now = t.at;
        t.fn();
      }
      now = until;
    },
    get waiting() {
      return list.length;
    },
  };
}

// The persona fields' home: like main/personacore.js sync, a save lands in the persona active when it is
// saved; like settings.js save(), a persona-synced value typed for another persona is dropped.
function world(active = 'A') {
  const w = { active, stored: {}, saves: [], dropped: 0 };
  w.save = (p, value, persona) => {
    if (m.stale(p, persona, w.active)) return (w.dropped++, false);
    (w.stored[w.active] ||= {})[p] = value;
    w.saves.push([p, value]);
    return true;
  };
  return w;
}

test('ten keystrokes in one tick: one save, 400 ms after the last, with the last value', () => {
  const timers = fakeTimers();
  const w = world();
  const s = m.createSaves({ save: w.save, timers });
  for (let i = 0; i < 10; i++) s.queue('agent.personality', `A:${i}`, 'A');
  assert.strictEqual(timers.waiting, 1, 'one timer per path');
  timers.advance(399);
  assert.deepStrictEqual(w.saves, []);
  timers.advance(1);
  assert.deepStrictEqual(w.saves, [['agent.personality', 'A:9']]);
  assert.strictEqual(s.size(), 0);
});

test('two paths wait side by side and save twice', () => {
  const timers = fakeTimers();
  const w = world();
  const s = m.createSaves({ save: w.save, timers });
  s.queue('agent.name', 'A:Nova', 'A');
  s.queue('voice.speed', 1.25, 'A');
  timers.advance(400);
  assert.deepStrictEqual(w.saves.sort(), [['agent.name', 'A:Nova'], ['voice.speed', 1.25]]);
});

test('flushAll saves at once; the timer that fires later and a second flush save nothing more', async () => {
  const timers = fakeTimers();
  const w = world();
  const s = m.createSaves({ save: w.save, timers });
  s.queue('agent.personality', 'A:typed', 'A');
  s.queue('appearance.greeting', 'A:hi', 'A');
  const results = await s.flushAll();
  assert.deepStrictEqual(results, [true, true]);
  assert.strictEqual(w.saves.length, 2);
  assert.strictEqual(timers.waiting, 0, 'the timers were cleared');
  timers.advance(5000);
  assert.deepStrictEqual(await s.flushAll(), []);
  assert.strictEqual(w.saves.length, 2);
  assert.strictEqual(s.size(), 0);
});

test('flushAll answers what each save said (false: dropped), and waits for slow saves', async () => {
  const timers = fakeTimers();
  let release;
  const slow = new Promise((r) => (release = r));
  const s = m.createSaves({ save: (p) => (p === 'voice.speed' ? slow.then(() => true) : false), timers });
  s.queue('voice.speed', 1, 'A');
  s.queue('agent.name', 'x', 'A');
  const all = s.flushAll();
  assert.strictEqual(s.size(), 0, 'nothing waits once the flush started');
  release();
  assert.deepStrictEqual(await all, [true, false]);
});

// Regression: a save whose 400 ms had passed was out of the waiting list while save() still asked main
// (staleNow → settings:get), so flushAll() returned at once, and the Persona studio's switch reached main
// before that save: the value was filed under the persona switched to.
test('flushAll also waits for a save already on its way', async () => {
  const timers = fakeTimers();
  let release;
  const asking = new Promise((r) => (release = r));
  const saved = [];
  const s = m.createSaves({ save: async (p, v) => (await asking, saved.push([p, v]), true), timers });
  s.queue('agent.name', 'typed for A', 'A');
  timers.advance(400);
  assert.strictEqual(s.size(), 0, 'its time came: no longer waiting');
  let done = false;
  const flushed = s.flushAll().then((r) => ((done = true), r));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(done, false, 'the flush waits for it');
  release();
  assert.deepStrictEqual(await flushed, [], 'it answers for what waited (nothing); the running save still finished first');
  assert.deepStrictEqual(saved, [['agent.name', 'typed for A']]);
  // A save that fails on its way doesn't fail the flush.
  const s2 = m.createSaves({ save: async () => Promise.reject(new Error('IPC down')), timers });
  s2.queue('agent.name', 'x', 'A');
  timers.advance(400);
  await assert.doesNotReject(s2.flushAll());
});

test('the studio’s switches after a flush, with saves slow on their way: a persona only ever holds its own values', async () => {
  const PATHS = ['agent.personality', 'agent.name', 'appearance.greeting', 'voice.speed'];
  const PERSONAS = ['A', 'B', 'C'];
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = mulberry32(seed);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const timers = fakeTimers();
    const w = { main: 'A', stored: {} };
    let rendered = 'A';
    let n = 0;
    const gap = () => new Promise((r) => setImmediate(r));
    // As settings.js save(): a moment on the wire, then main saves it inside its queue only while that
    // persona is still active (settings:set { persona } → persona.saveFor), and answers dropped otherwise.
    const save = async (p, value, persona) => {
      await gap();
      if (m.PERSONA_PATHS.has(p) && w.main !== persona) return false;
      (w.stored[w.main] ||= {})[p] = value;
      return true;
    };
    const s = m.createSaves({ save, timers });
    for (let step = 0; step < 50; step++) {
      const action = pick(['type', 'type', 'type', 'advance', 'studio', 'phone']);
      if (action === 'type') s.queue(pick(PATHS), `${rendered}:${++n}`, rendered);
      else if (action === 'advance') timers.advance(Math.floor(rnd() * 901));
      else if (action === 'studio') {
        await s.flushAll(); // settings.js personaBar: flushSaves(), then the switch
        w.main = rendered = pick(PERSONAS);
      } else w.main = pick(PERSONAS); // the phone, the watch, a routine: whenever
      await gap();
      for (const [persona, fields] of Object.entries(w.stored)) {
        for (const [p, v] of Object.entries(fields)) {
          if (m.PERSONA_PATHS.has(p)) assert.ok(String(v).startsWith(`${persona}:`), `seed ${seed} step ${step} (${action}): ${persona} holds ${p} = ${v}`);
        }
      }
    }
    await s.flushAll();
  }
});

test('the default timers save the last value on flushAll', async () => {
  const saved = [];
  const s = m.createSaves({ save: (p, v) => saved.push([p, v]) });
  s.queue('voice.speed', 1.5, null);
  s.queue('voice.speed', 1.75, null);
  await s.flushAll();
  assert.deepStrictEqual(saved, [['voice.speed', 1.75]]);
  // In the window, setTimeout passed on as an object's method throws "Illegal invocation" (Node allows
  // it, so only the source can say): the defaults call it through arrow functions.
  const src = read('renderer/js/settingsave.js');
  assert.match(src, /timers = \{ set: \(fn, ms\) => setTimeout\(fn, ms\), clear: \(t\) => clearTimeout\(t\) \}/);
  assert.doesNotMatch(src, /set: setTimeout|clear: clearTimeout/);
});

test('typed for A, switched to B before the save: nothing lands in B; other settings still save', async () => {
  const timers = fakeTimers();
  const w = world('A');
  const s = m.createSaves({ save: w.save, timers });
  s.queue('agent.personality', 'A:my long master prompt', 'A');
  s.queue('voice.speed', 1.3, 'A');
  w.active = 'B'; // the title bar, the agent or the phone switched
  timers.advance(400);
  assert.strictEqual(w.stored.B?.['agent.personality'], undefined, 'A’s prompt never lands in B');
  assert.strictEqual(w.stored.B?.['voice.speed'], 1.3, 'a setting that isn’t the persona’s is saved');
  assert.strictEqual(w.dropped, 1);

  // A → B → A before the save: A is active again, so it is A's.
  s.queue('appearance.greeting', 'A:hello', 'A');
  w.active = 'B';
  w.active = 'A';
  await s.flushAll();
  assert.strictEqual(w.stored.A['appearance.greeting'], 'A:hello');
});

test('stale: only persona fields, only with a known persona, only when another one is active', () => {
  for (const p of m.PERSONA_PATHS) {
    assert.strictEqual(m.stale(p, 'A', 'B'), true, p);
    assert.strictEqual(m.stale(p, 'A', 'A'), false, p);
  }
  // The wizard and other callers don't know the persona: never dropped.
  for (const persona of [null, undefined, '']) assert.strictEqual(m.stale('agent.personality', persona, 'B'), false, String(persona));
  for (const p of ['voice.speed', 'llm.provider', 'personas.active', '', 'agent', 'agent.personality.extra', '__proto__.x']) assert.strictEqual(m.stale(p, 'A', 'B'), false, p);
  assert.strictEqual(m.stale('agent.name', 'A', undefined), true, 'no active persona known: not A');
});

// The window's copy of the active persona lags behind a switch made on the phone, the watch or by a
// routine (the window hears of it only when it reads the settings again): main's is asked before a
// persona field is written. Without that, the next keystroke wrote persona A's prompt into B.
test('staleNow: a switch only main knows of is caught before a persona field is written', async () => {
  let asked = 0;
  const main = (active) => async () => (asked++, active);
  assert.strictEqual(await m.staleNow('agent.personality', 'A', 'A', main('B')), true, 'the window says A, main says B');
  assert.strictEqual(asked, 1);
  assert.strictEqual(await m.staleNow('agent.personality', 'A', 'A', main('A')), false, 'both say A');
  assert.strictEqual(await m.staleNow('agent.personality', 'A', 'B', main('A')), true, 'the window already knows: dropped');
  assert.strictEqual(asked, 2, 'main isn’t asked when the window already knows');
  assert.strictEqual(await m.staleNow('voice.speed', 'A', 'A', main('B')), false, 'not a persona field: saved wherever');
  for (const persona of [null, undefined, '']) assert.strictEqual(await m.staleNow('agent.personality', persona, 'A', main('B')), false, `persona ${persona}`);
  assert.strictEqual(asked, 2, 'main is asked only for a persona field the window counts as current');
  assert.strictEqual(await m.staleNow('appearance.scene', 'A', 'A', main(undefined)), true, 'main knows no active persona: not A');
  await assert.rejects(m.staleNow('agent.name', 'A', 'A', async () => {
    throw new Error('settings:get failed');
  }), /settings:get failed/, 'a failed read is the caller’s to show, never a silent save');
});

test('the window’s copy lags main: random switches on the phone never let a persona hold another’s values', async () => {
  const PATHS = ['agent.personality', 'agent.aesthetic', 'appearance.greeting', 'voice.speed', 'ui.zoom'];
  const PERSONAS = ['A', 'B', 'C'];
  let caughtByMain = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = mulberry32(seed);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const timers = fakeTimers();
    const w = { main: 'A', seen: 'A', stored: {} }; // main's active persona, and this window's copy of it
    let rendered = 'A';
    let n = 0;
    // As settings.js save(): main decides inside its queue (dropped when the persona isn't active) and
    // answers with its settings either way, which bring the window's copy up to date.
    const save = async (p, value, persona) => {
      const seen = w.seen;
      w.seen = w.main; // settings:set answers with main's settings, saved or dropped
      if (m.PERSONA_PATHS.has(p) && w.main !== persona) {
        if (!m.stale(p, persona, seen)) caughtByMain++;
        return false;
      }
      (w.stored[w.main] ||= {})[p] = value;
      return true;
    };
    const s = m.createSaves({ save, timers });
    const settle = () => new Promise((r) => setImmediate(r));
    for (let step = 0; step < 60; step++) {
      const action = pick(['type', 'type', 'type', 'phone', 'titlebar', 'redraw', 'advance', 'flush']);
      if (action === 'type') s.queue(pick(PATHS), `${rendered}:${++n}`, rendered);
      else if (action === 'phone') w.main = pick(PERSONAS); // the window isn't told
      else if (action === 'titlebar') w.main = w.seen = pick(PERSONAS);
      else if (action === 'redraw') rendered = w.seen;
      else if (action === 'advance') timers.advance(Math.floor(rnd() * 901));
      else await s.flushAll();
      await settle();
      for (const [persona, fields] of Object.entries(w.stored)) {
        for (const [p, v] of Object.entries(fields)) {
          if (m.PERSONA_PATHS.has(p)) assert.ok(String(v).startsWith(`${persona}:`), `seed ${seed} step ${step} (${action}): ${persona} holds ${p} = ${v}`);
        }
      }
    }
    await s.flushAll();
    assert.strictEqual(s.size(), 0, `seed ${seed}: something still waits after the last flush`);
  }
  assert.ok(caughtByMain > 0, 'the walk reaches a switch only main knew of');
});

test('edge values are saved exactly as typed', async () => {
  const edge = ['', '   ', 'x'.repeat(10000), 'مرحبا بالعالم שלום', '👨‍👩‍👧‍👦', '<script>alert(1)</script>', '\u0000', '{"__proto__":{"polluted":1}}'];
  for (const value of edge) {
    const w = world();
    const s = m.createSaves({ save: w.save, timers: fakeTimers() });
    s.queue('agent.personality', value, 'A');
    await s.flushAll();
    assert.strictEqual(w.stored.A['agent.personality'], value, JSON.stringify(value.slice(0, 20)));
  }
  assert.strictEqual({}.polluted, undefined);
});

// mulberry32: a small seeded generator, so a failure names its seed and step.
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random typing, switching, redrawing and saving: a persona only ever holds its own values', async () => {
  const PATHS = ['agent.personality', 'agent.name', 'appearance.greeting', 'voice.speed'];
  const PERSONAS = ['A', 'B', 'C'];
  let droppedTotal = 0;
  let savedTotal = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = mulberry32(seed);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const timers = fakeTimers();
    const w = world('A');
    let rendered = 'A'; // the persona the cards on screen were drawn for
    let n = 0;
    const s = m.createSaves({ save: w.save, timers });
    for (let step = 0; step < 60; step++) {
      const action = pick(['type', 'type', 'type', 'switch', 'redraw', 'advance', 'flush']);
      if (action === 'type') s.queue(pick(PATHS), `${rendered}:${++n}`, rendered);
      else if (action === 'switch') w.active = pick(PERSONAS);
      else if (action === 'redraw') rendered = w.active;
      else if (action === 'advance') timers.advance(Math.floor(rnd() * 901));
      else await s.flushAll();
      for (const [persona, fields] of Object.entries(w.stored)) {
        for (const [p, v] of Object.entries(fields)) {
          if (m.PERSONA_PATHS.has(p)) assert.ok(String(v).startsWith(`${persona}:`), `seed ${seed} step ${step} (${action}): ${persona} holds ${p} = ${v}`);
        }
      }
    }
    await s.flushAll();
    assert.strictEqual(s.size(), 0, `seed ${seed}: something still waits after the last flush`);
    assert.strictEqual(timers.waiting, 0, `seed ${seed}: a timer still runs after the last flush`);
    droppedTotal += w.dropped;
    savedTotal += w.saves.length;
  }
  assert.ok(droppedTotal > 0, 'the walk reaches a value typed for another persona');
  assert.ok(savedTotal > droppedTotal, 'and saves plenty');
});

test('one field list: main/personacore.js and the window read renderer/js/personafields.mjs', () => {
  const shared = require(path.join(ROOT, 'renderer/js/personafields.mjs'));
  const { FIELDS } = require(path.join(ROOT, 'main/personacore.js'));
  assert.strictEqual(FIELDS, shared.FIELDS, 'personacore keeps no copy of its own');
  assert.ok(Object.isFrozen(FIELDS) && FIELDS.every(Object.isFrozen), 'nobody can change it for everyone');
  const fields = new Set(FIELDS.map(([section, key]) => `${section}.${key}`));
  assert.deepStrictEqual([...m.PERSONA_PATHS].sort(), [...fields].sort());
  assert.deepStrictEqual([...shared.PERSONA_PATHS].sort(), [...fields].sort());
  assert.match(read('renderer/js/settingsave.js'), /import \{ PERSONA_PATHS \} from '\.\/personafields\.mjs';/, 'settingsave keeps no copy either');
});

// settings.js needs the window: what it must keep is checked in its source.
test('settings.js renders every card at once and swaps them in only for the latest render', () => {
  const src = settingsSource();
  const block = /const CARDS = \[([\s\S]*?)\n\];/.exec(src);
  assert.ok(block, 'settings.js has a CARDS list');
  const listed = [...block[1].matchAll(/\['([a-z-]+)', '[^']+', \w+\]/g)].map((x) => x[1]);
  const cards = [...src.matchAll(/\bcard\(\s*'([a-z-]+)'/g)].map((x) => x[1]);
  assert.strictEqual(listed.length, 19);
  assert.strictEqual(new Set(listed).size, listed.length, 'a card listed twice');
  assert.deepStrictEqual([...new Set(listed)].sort(), [...new Set(cards)].sort(), 'CARDS names every card() id, no more');

  const start = src.indexOf('async function render({ reload = false } = {}) {');
  assert.ok(start > 0, 'settings.js has render({ reload })');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /renderGen/);
  assert.match(body, /replaceChildren\(\.\.\.cards\)/);
  assert.doesNotMatch(body, /innerHTML = ''/, 'the page never goes empty while it redraws');
  assert.match(body, /Promise\.all\(CARDS\.map/);
  assert.match(src, /async function safeCard\(id, title, build\) \{\s*try \{\s*return await build\(\);/);
  assert.doesNotMatch(src, /async function githubCard/, 'the GitHub check never holds up the page');
  // While the new cards are built the old ones can't be edited (a value typed then was shown older in the
  // new cards and saved over), and what waits to be saved goes in before the cards read the settings.
  const at = (s) => body.indexOf(s);
  assert.ok(at('root.inert = true;') > 0 && at('root.inert = true;') < at('await flushSaves();'), 'inert before the flush');
  assert.ok(at('await flushSaves();') < at('Promise.all(CARDS.map'), 'flushed before the cards are built');
  assert.ok(at('if (reload) await loadSettings()') > at('await flushSaves();') && at('if (reload) await loadSettings()') < at('Promise.all(CARDS.map'), 'read again before the cards are built');
  assert.ok(at('root.inert = false;') > at('root.replaceChildren(...cards);'), 'editable again once the new cards are in');
  assert.match(body, /finally \{\s*if \(mine === renderGen\) \(root\.inert = false\), root\.removeAttribute\('aria-busy'\);/, 'the latest render always ends the wait');
  // Opening Settings reads the settings again (a persona switched on the phone never reached the window).
  assert.match(src, /render\(\{ reload: true \}\)/);
  // The field builders mark their control, so a redraw gives the keyboard focus back to the same setting.
  for (const name of ['text', 'area', 'toggle', 'select', 'folder']) {
    const i = src.indexOf(`function ${name}(`);
    assert.match(src.slice(i, src.indexOf('\n}\n', i)), /'data-setting': p/, `${name}() marks its control`);
  }
  assert.match(body, /refocus\?\.persona === persona/, 'never into another persona’s cards');
});

test('a check before a model call is awaited, and only model calls are checked before (main decides every save)', () => {
  const src = settingsSource();
  const calls = [...src.matchAll(/(\S+\s)?switchedAway\(/g)].map((x) => x[1] || '');
  assert.strictEqual(calls.length, 3, 'defined once, used by Generate look & feel and Draw the scene');
  for (const before of calls) assert.ok(/^(\(?await |function )$/.test(before), `switchedAway( after “${before}”`);
  assert.doesNotMatch(src, /\bdropped\(|liveActive|PERSONA_PATHS/, 'no second check of its own before a save');
  assert.strictEqual(src.split("'Not saved: the persona changed meanwhile.'").length - 1, 1, 'one wording');
});

test('the Persona studio saves what was typed before its own switch, New, Duplicate, Template and Delete', () => {
  const src = settingsSource();
  const part = (name) => {
    const i = src.indexOf(`function ${name}(`);
    return src.slice(i, src.indexOf('\n}\n', i));
  };
  const studio = part('personaBar') + part('pickTemplate');
  assert.ok(studio.split('flushSaves()').length - 1 >= 5, 'every persona action flushes first');
  assert.doesNotMatch(studio, /\brender\(\)/, 'the new active persona redraws the studio (the settings listener)');
  assert.match(src, /on\('settings', \(s\) => currentView === 'settings' && s\?\.personas\?\.active !== drawingFor && render\(\)\);/);
  // Reset the theme and Remove the scene: the persona on screen at the click (taken before their confirm).
  assert.match(part('themeEditor'), /onclick: \(\) => saveFromClick\(\{ appearance: \{ theme: null \} \}, renderedPersona, \[/);
  assert.match(part('sceneRow'), /onclick: \(\) => saveFromClick\(\{ appearance: \{ scene: null \} \}, renderedPersona, \[/);
  // The theme editor: the persona taken at the edit, edits one after another (two quick ones both read the
  // same theme and the second saved over the first).
  assert.match(part('themeEditor'), /const update = \(mutate\) => \{\s*const persona = renderedPersona;\s*themeEdits = themeEdits\.then\(/);
  const agent = part('agentCard');
  // Generate look & feel: checked before the minute-long model call, and the persona's voice is saved in
  // the same call as its theme (a switch between two saves put this voice into the next persona).
  assert.ok(agent.indexOf("if (await switchedAway('appearance.theme', persona)) return;") < agent.indexOf('api.persona.generate('), 'checked before the model is asked');
  assert.match(agent, /await saveForPersona\(\{ appearance: \{ theme, personaNotes: res\.personaNotes, greeting: res\.greeting \}, \.\.\.\(voice \? \{ voice: \{ voice \} \} : \{\}\) \}, persona\)/);
  assert.doesNotMatch(agent, /saveSettings\(\{ voice:/, 'no separate voice save');
  assert.ok(part('drawScene').indexOf('switchedAway(') < part('drawScene').indexOf('api.persona.scene('), 'the scene: checked before the model is asked');
  assert.doesNotMatch(src, /saveSettings\(\{ (appearance|agent|ui: \{ face)\b/, 'every persona field goes through saveForPersona');
  assert.match(part('summaryRow'), /api\.persona\.setSummary\(textBox\.value, persona\)/);
  // Main answers whether it saved; a dropped change re-applies nothing.
  assert.match(read('main/main.js'), /handle\('settings:set', async \(patch, opts\) => \{[^}]*persona\.saveFor\(opts\.persona, patch\)[\s\S]{0,200}?return \{ settings: r\.settings, saved: r\.saved, dropped: !r\.saved \};/);
});

// state.js on stand-ins: what the window does with main's answer.
async function stateModule(answer) {
  const dir = tmpDir('nexus-state-');
  evoDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'util.js'), `export const calls = { set: [], emitted: [] };
export let answer = null;
export const setAnswer = (fn) => (answer = fn);
export const api = { settings: { set: async (...args) => (calls.set.push(args), answer(...args)), get: async () => answer({}).settings } };
export const emit = (name, v) => calls.emitted.push([name, v]);
`);
  fs.writeFileSync(path.join(dir, 'turnstate.js'), 'export const faceState = () => \'idle\';\n');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/state.js'), path.join(dir, 'state.js'));
  const u = await import(pathToFileURL(path.join(dir, 'util.js')).href);
  u.setAnswer(answer);
  const st = await import(pathToFileURL(path.join(dir, 'state.js')).href);
  return { st, u };
}

test('state.js: a persona save names the persona and passes on main’s answer; a plain save returns the settings', async () => {
  const main = { personas: { active: 'B' }, agent: { name: 'Bea' } };
  // Main as persona.saveFor answers: dropped when the persona named is not active, its settings either way.
  const { st, u } = await stateModule((patch, opts) => (opts?.persona && opts.persona !== main.personas.active
    ? { settings: main, saved: false, dropped: true }
    : { settings: { ...main, ...patch }, saved: true, dropped: false }));
  const r = await st.savePersonaSettings({ agent: { name: 'Ann' } }, 'A');
  assert.deepStrictEqual(u.calls.set[0], [{ agent: { name: 'Ann' } }, { persona: 'A' }]);
  assert.strictEqual(r.dropped, true);
  assert.strictEqual(st.state.settings, main, 'the window takes main’s settings, so the studio redraws for B');
  assert.deepStrictEqual(u.calls.emitted.at(-1), ['settings', main]);
  const ok = await st.savePersonaSettings({ agent: { name: 'Bee' } }, 'B');
  assert.strictEqual(ok.saved, true);
  assert.strictEqual(st.state.settings.agent.name, 'Bee');
  // No persona known: sent without one (main saves it wherever).
  await st.savePersonaSettings({ ui: { zoom: 1 } }, null);
  assert.deepStrictEqual(u.calls.set.at(-1), [{ ui: { zoom: 1 } }]);
  // saveSettings keeps its old answer for its callers: the settings.
  const s = await st.saveSettings({ ui: { zoom: 1.2 } });
  assert.strictEqual(s.ui.zoom, 1.2);
  assert.strictEqual(s, st.state.settings);
  assert.deepStrictEqual(u.calls.set.at(-1), [{ ui: { zoom: 1.2 } }]);
});

test('the Safety copy says what really asks, in Settings and in the wizard', () => {
  const src = settingsSource();
  for (const old of ['no questions at all', 'anything that reaches other people or services', 'Always ask before self-modification']) assert.ok(!src.includes(old), `settings.js still says “${old}”`);
  for (const now of [
    'Just do it — still asks before code changes, commands, publishing to GitHub, invitations and services you haven’t allowed (and, after reading outside content, before deleting or inviting in your services, opening new websites or saving routines and skills)',
    'After reading outside content (web pages, documents, your services’ data), warn on every approval and ask before changing my code, deleting or inviting through a service, opening a website nobody named, or saving a routine or skill — also in “Just do it” mode and at “Allow everything”',
    'Allow everything: no questions, except that deleting or inviting people asks once a turn has read outside content (Settings → Safety), so only for services where nothing can go wrong.',
  ]) assert.ok(src.includes(now), `settings.js lacks “${now.slice(0, 60)}…”`);
  const wizard = read('renderer/js/onboarding.js');
  assert.ok(!wizard.includes('anything that reaches other people or services'));
  assert.ok(wizard.includes('Still asks before code changes, commands, publishing to GitHub, invitations and services you haven’t allowed.'));
});

test('settings.js acknowledges: failed saves flip back, Test connection runs once, actions say how they went', () => {
  const src = settingsSource();
  const part = (name) => {
    const i = src.indexOf(`function ${name}(`);
    assert.ok(i >= 0, `settings.js has ${name}`);
    return src.slice(i, src.indexOf('\n}\n', i));
  };
  assert.match(part('toggle'), /if \(!\(await save\(p, input\.checked\)\)\) return void \(input\.checked = Boolean\(get\(p\)\)\);\s*onChange/);
  assert.match(part('select'), /if \(!\(await save\(p, s\.value\)\)\) return void \(s\.value = get\(p\) \?\? ''\);\s*onChange/);
  assert.match(part('permissionLevel'), /setLevel\(key, box\.value\)\.catch\(\(err\) => \{\s*box\.value = levelOf\(key\);\s*toastError\(err\);/);
  const brain = part('brainCard');
  assert.match(brain, /if \(test\.disabled\) return;\s*test\.disabled = true;/);
  assert.match(brain, /finally \{\s*test\.disabled = false;/);
  assert.match(brain, /\.catch\(\(e\) => \(\{ state: 'unchecked', claude: \{ installed: true, checked: false, error: e\.message \} \}\)\)/, 'a failed IPC is a failed check, not "not installed"');
  const data = part('dataCard');
  assert.match(data, /const ask = \(\) => \(exportFn \? confirmExportFirst\(title, msg, label, exportFn\) : confirmDialog\(title, msg, label\)\);/);
  assert.match(data, /if \(b\.disabled \|\| !\(await ask\(\)\)\) return;\s*b\.disabled = true;/);
  assert.match(data, /toast\(\(await fn\(\)\) \|\| `\$\{label\}: done\.`\);\s*\} catch \(err\) \{\s*toastError\(err\);/);
  assert.match(data, /exported to \$\{p\}/, 'an export says where the file went');
  assert.match(data, /the setup wizard opens the next time the app starts\. Memories, notes and conversations are kept, and so is a copy of your old settings, in the data folder\./);
  const voice = part('voiceCard');
  assert.match(voice, /const test = engine === 'local' \? '' :/, 'Test voice never asks VoiceStudio for the offline voice');
  assert.match(voice, /\$\{service\} responded in/);
});

// evolution.js with stand-ins for util.js and nav.js: a copy in a folder of type module, so each harness
// is a fresh module (its own selfBusy and refreshGen).
const UTIL_STUB = `export const api = {};
export const calls = { toasts: [], errors: [], actions: [] };
export const answers = { prompt: 'Manual changes', confirm: true };
const box = () => {
  const b = { children: [], append: (...c) => b.children.push(...c.flat()) };
  Object.defineProperty(b, 'innerHTML', { set() { b.children = []; } });
  return b;
};
export const nodes = { '#evoStatus': box(), '#evoList': box(), '#evoDetail': box() };
export const $ = (sel) => nodes[sel];
export const el = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat() });
export const timeAgo = () => 'just now';
export const escapeHtml = (s) => s;
export const on = () => () => {};
export const toast = (m) => calls.toasts.push(m);
export const toastError = (e) => calls.errors.push(e?.message || String(e));
export const toastActions = (m) => calls.actions.push(m);
export const confirmDialog = async () => answers.confirm;
export const promptDialog = async () => answers.prompt;
`;
const evoDirs = [];
test.after(() => evoDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
async function evolution() {
  const dir = tmpDir('nexus-evolution-');
  evoDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'util.js'), UTIL_STUB);
  fs.writeFileSync(path.join(dir, 'nav.js'), 'export const switchView = () => {};\n');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/evolution.js'), path.join(dir, 'evolution.js'));
  const u = await import(pathToFileURL(path.join(dir, 'util.js')).href);
  const evo = await import(pathToFileURL(path.join(dir, 'evolution.js')).href);
  return { evo, u };
}
const tree = (n, out = []) => {
  if (n && typeof n === 'object') {
    out.push(n);
    for (const c of n.children || []) tree(c, out);
  }
  return out;
};
const textOf = (n) => (typeof n === 'string' ? n : n?.children ? n.children.map(textOf).join('') : '');
const evoButton = (u, re) => tree({ children: u.nodes['#evoStatus'].children }).find((n) => n.tag === 'button' && re.test(textOf(n)));
const settle = () => new Promise((r) => setImmediate(r));
const dirtyRepo = (extra = {}) => ({
  status: async () => ({ available: true, enabled: true, isRepo: true, dirty: [{ file: 'main/x.js' }] }),
  verification: async () => null,
  log: async () => [],
  ...extra,
});

test('Evolution: Record clicked ten times runs the checks once and stays off until they finish', async () => {
  const { evo, u } = await evolution();
  let finish;
  let commits = 0;
  u.api.self = dirtyRepo({ commit: () => (commits++, new Promise((r) => (finish = r))) });
  await evo.refresh();
  const record = () => evoButton(u, /^(Record|Checking and testing…)$/);
  const discard = () => evoButton(u, /^(Discard|Discarding…)$/);
  assert.strictEqual(record().attrs.disabled, false);
  const first = record();
  for (let i = 0; i < 10; i++) first.attrs.onclick();
  await settle();
  assert.strictEqual(commits, 1, 'ten clicks, one run of the checks and tests');
  assert.strictEqual(textOf(record()), 'Checking and testing…');
  assert.strictEqual(record().attrs.disabled, true);
  assert.strictEqual(discard().attrs.disabled, true, 'Discard waits too');
  await evo.refresh(); // a view switch meanwhile
  assert.strictEqual(record().attrs.disabled, true, 'a redraw doesn’t offer it again');
  first.attrs.onclick(); // the old, enabled button still on someone's screen
  discard().attrs.onclick();
  await settle();
  assert.strictEqual(commits, 1);
  finish({ ok: true, nothing: true });
  await settle();
  assert.deepStrictEqual(u.calls.toasts, ['Nothing left to record.']);
  assert.deepStrictEqual(u.calls.actions, [], 'nothing recorded is not announced as a change');
  assert.strictEqual(record().attrs.disabled, false);
  assert.strictEqual(textOf(record()), 'Record');
});

test('Evolution: a cancelled prompt records nothing; failed checks and errors are said; the button comes back', async () => {
  const { evo, u } = await evolution();
  const results = [{ ok: false, check: { output: 'lint: 2 problems' } }, new Error('git is busy')];
  let commits = 0;
  u.api.self = dirtyRepo({ commit: async () => (commits++, results[commits - 1] instanceof Error ? Promise.reject(results[commits - 1]) : results[commits - 1]) });
  await evo.refresh();
  const record = () => evoButton(u, /^(Record|Checking and testing…)$/);
  u.answers.prompt = null;
  record().attrs.onclick();
  await settle();
  assert.strictEqual(commits, 0, 'the prompt was cancelled');
  u.answers.prompt = 'Manual changes';
  record().attrs.onclick();
  await settle();
  record().attrs.onclick();
  await settle();
  assert.strictEqual(commits, 2);
  assert.deepStrictEqual(u.calls.errors, ['Checks failed:\nlint: 2 problems', 'git is busy']);
  assert.deepStrictEqual(u.calls.actions, []);
  assert.strictEqual(record().attrs.disabled, false);
});

test('Evolution: Discard says "Changes discarded." only when it worked', async () => {
  const { evo, u } = await evolution();
  let fail = true;
  let runs = 0;
  u.api.self = dirtyRepo({ discard: async () => (runs++, fail ? Promise.reject(new Error('could not reset the working tree')) : true) });
  await evo.refresh();
  const discard = () => evoButton(u, /^(Discard|Discarding…)$/);
  u.answers.confirm = false;
  discard().attrs.onclick();
  await settle();
  assert.strictEqual(runs, 0, 'not confirmed: nothing thrown away');
  u.answers.confirm = true;
  const b = discard();
  for (let i = 0; i < 5; i++) b.attrs.onclick();
  await settle();
  assert.strictEqual(runs, 1, 'five clicks, one discard');
  assert.deepStrictEqual(u.calls.errors, ['could not reset the working tree']);
  assert.deepStrictEqual(u.calls.actions, [], 'a failed discard never says it worked');
  fail = false;
  discard().attrs.onclick();
  await settle();
  assert.deepStrictEqual(u.calls.actions, ['Changes discarded.']);
  assert.strictEqual(discard().attrs.disabled, false);
});

test('Evolution: refreshes that overlap draw once, whatever order their answers come in', async () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = mulberry32(seed);
    const { evo, u } = await evolution();
    const waiting = [];
    const later = (value) => new Promise((r) => waiting.push(() => r(value)));
    u.api.self = {
      status: () => later({ available: true, enabled: true, isRepo: true, dirty: [{ file: 'a.js' }] }),
      verification: () => later({ state: 'ok', subject: 'Fix', short: 'abc1234' }),
      log: () => later([{ sha: '1', short: 'abc1234', subject: 'Fix', date: 0, files: [], kind: 'self' }]),
    };
    const runs = Array.from({ length: 2 + Math.floor(rnd() * 4) }, () => evo.refresh());
    while (waiting.length) {
      waiting.splice(Math.floor(rnd() * waiting.length), 1)[0]();
      await settle();
    }
    await Promise.all(runs);
    const banners = u.nodes['#evoStatus'].children.map((n) => n.attrs.class);
    assert.deepStrictEqual(banners, ['evo-banner', 'evo-banner ok'], `seed ${seed}: ${runs.length} refreshes drew ${banners.join(' | ')}`);
    assert.strictEqual(u.nodes['#evoList'].children.length, 1, `seed ${seed}: the list holds one change`);
  }
});

// Number fields: an empty or half-typed value saves nothing (Number('') was 0: a cleared "Journal after"
// journaled at once, a half-typed port restarted the server); counts take "1,000".
test('number fields: empty, invalid and half-typed values give null; thousands separators are read', () => {
  for (const v of ['', '   ', null, undefined, 'abc', '1.5', '1,5,x', '-', '12a', 'NaN', 'Infinity', '1e3', '٣']) assert.strictEqual(m.parseNumber(v), null, JSON.stringify(v));
  assert.strictEqual(m.parseNumber('15'), 15);
  assert.strictEqual(m.parseNumber(' 0 '), 0, 'a typed 0 is a value');
  assert.strictEqual(m.parseNumber('1,000'), 1000);
  assert.strictEqual(m.parseNumber('1 000'), 1000);
  assert.strictEqual(m.parseNumber('1\u00a0500'), 1500, 'a no-break space');
  assert.strictEqual(m.parseNumber('1_000'), 1000);
  assert.strictEqual(m.parseNumber("1'000"), 1000);
  assert.strictEqual(m.parseNumber('１２'), 12, 'full-width digits');
  assert.strictEqual(m.parseNumber('-5'), -5);
  // Decimal fields (temperature): one comma is the decimal point; a dot stays one.
  assert.strictEqual(m.parseNumber('0,7', { decimal: true }), 0.7);
  assert.strictEqual(m.parseNumber('0.7', { decimal: true }), 0.7);
  assert.strictEqual(m.parseNumber('.5', { decimal: true }), 0.5);
  assert.strictEqual(m.parseNumber('1,000.5', { decimal: true }), 1000.5);
  for (const v of ['', ' ', '1.2.3', '0,7,1x', 'x', '-']) assert.strictEqual(m.parseNumber(v, { decimal: true }), null, JSON.stringify(v));
});

test('paths: one pair of surrounding quotes and the spaces go (Explorer’s "Copy as path")', () => {
  assert.strictEqual(m.cleanPath('"C:\\Users\\Anna\\Vault"'), 'C:\\Users\\Anna\\Vault');
  assert.strictEqual(m.cleanPath("  'C:\\Program Files\\claude.cmd'  "), 'C:\\Program Files\\claude.cmd');
  assert.strictEqual(m.cleanPath(' C:\\x '), 'C:\\x');
  assert.strictEqual(m.cleanPath('"C:\\x'), '"C:\\x', 'an unmatched quote stays');
  assert.strictEqual(m.cleanPath('"'), '"');
  assert.strictEqual(m.cleanPath('""'), '');
  assert.strictEqual(m.cleanPath(''), '');
  assert.strictEqual(m.cleanPath(null), '');
  assert.strictEqual(m.cleanPath('"C:\\Bücher\\Ω"'), 'C:\\Bücher\\Ω');
  assert.strictEqual(m.cleanPath('C:\\a "b" c'), 'C:\\a "b" c', 'quotes inside stay');
});

test('settings.js: number fields never save Number(""), paths are cleaned, "✓ Saved" sits in the sticky tab bar', () => {
  const src = settingsSource();
  const part = (name) => {
    const i = src.indexOf(`function ${name}(`);
    assert.ok(i >= 0, `settings.js has ${name}`);
    return src.slice(i, src.indexOf('\n}\n', i));
  };
  const text = part('text');
  assert.doesNotMatch(text, /Number\(input\.value\)/);
  assert.match(text, /v = parseNumber\(v, \{ decimal \}\);[\s\S]*if \(v === null\) return;/);
  assert.match(text, /addEventListener\('blur'/, 'the last good value comes back on blur');
  assert.match(part('folder'), /cleanPath\(input\.value\)/);
  assert.match(src, /text\('claudeCode\.cliPath', [^\n]*\{ path: true/);
  assert.match(src, /text\('llm\.temperature', 'Creativity', \{ type: 'number', decimal: true,/);
  assert.match(part('drawTabs'), /bar\.replaceChildren\(list, saved, advancedSwitch\(\), search\)/);
  assert.match(read('renderer/index.html'), /<div class="settings-tabs" id="settingsTabs"><span class="save-state" id="saveState">/);
  // Test connection: plain words, the raw text under Details (chatcore.testFailure); the wizard shares it.
  assert.match(part('showFailure'), /testFailure\(plainError\(err\)/);
  assert.match(part('brainCard'), /showFailure\(out, err\)/);
  assert.doesNotMatch(src, /`✕ \$\{p\.name\}: \$\{p\.error\}`/);
  const wizard = read('renderer/js/onboarding.js');
  assert.match(wizard, /testOutcome\(await api\.llm\.test\(\)\)/);
  assert.doesNotMatch(wizard, /onclick: \(\) => api\.claude\.login\(\)/, 'Connect says what to do next (connectClaude)');
  assert.match(part('brainCard'), /Finish signing out in the window that opened, then click Refresh\./);
});
