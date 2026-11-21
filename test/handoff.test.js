// "Where we left off" (main/handoff.js): the note on closing (about the user's own chat), its fallbacks,
// one write at a time, Skip, and how it is offered.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

const dir = tmpDir('nexus-handoff-');
const now = Date.now();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const convs = {
  setup: { id: 'setup', title: 'Setup', setup: true, updatedAt: now, messages: [{ role: 'user', content: 'my name is X' }] },
  a: { id: 'a', title: 'Fix calendar sync', updatedAt: now - 1000, messages: [{ role: 'user', content: 'Why does the iCal feed fail?' }, { role: 'assistant', content: 'The URL returns 403.' }] },
  b: { id: 'b', title: 'Older chat', updatedAt: now - 5000, messages: [{ role: 'user', content: 'hi' }] },
};
let llmImpl = async () => '';
let llmCalls = 0;
const vaultWrites = [];
stub({
  './store': fileStore(dir, {
    getSettings: async () => ({ llm: { provider: 'anthropic' }, obsidian: { enabled: true } }),
    // c.index: what store.js's index adds (lastOwnAt, routine); entries without it are as older stubs wrote them.
    listConversations: async () => Object.values(convs).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length, ...(c.setup ? { setup: true } : {}), ...c.index })).sort((x, y) => y.updatedAt - x.updatedAt),
    getConversation: async (id) => convs[id] || null,
    TASKS_SYNC_DISPLAY: '🔄 Sync my tasks for the calendar',
  }),
  './logger': quietLog,
  './llm': { complete: (...a) => (llmCalls++, llmImpl(...a)) },
  './persona': { extractJson: (t) => require('../main/jsonrepair').parseLoose(t), jsonWithRetry: (t, ask) => require('../main/jsonrepair').withRetry(t, ask) },
  './obsidian': { vaultPath: async () => dir, writeNote: async (rel, text) => vaultWrites.push({ rel, text }) },
});
const handoff = load('main/handoff.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('writes an AI note for the latest real conversation', async () => {
  llmImpl = async (_s, prompt) => {
    assert.ok(prompt.includes('iCal feed') && !prompt.includes('my name is X'), 'transcript of the latest non-setup conversation');
    return 'Sure: {"topic":"Calendar sync","summary":"The iCal URL returns 403.","openThreads":["Why 403?"],"nextSteps":["Regenerate the link","Test again"]}';
  };
  const note = await handoff.write();
  assert.strictEqual(note.source, 'ai');
  assert.strictEqual(note.conversationId, 'a');
  assert.ok(note.others.some((o) => o.id === 'b'));
  assert.strictEqual(vaultWrites[0].rel, 'Where We Left Off.md');
  const block = await handoff.promptBlock();
  assert.ok(block.includes('Where you left off') && block.includes('- Test again'));
});



test('nothing new since the last note: kept, no model call', async () => {
  llmCalls = 0;
  const before = await handoff.read();
  const again = await handoff.write();
  assert.strictEqual(llmCalls, 0);
  assert.strictEqual(again.at, before.at);
});

test('Skip and model errors fall back to a basic note', async () => {
  convs.a.updatedAt = Date.now() + 10;
  convs.a.messages.push({ role: 'user', content: 'ok, regenerate it please' });
  llmImpl = () => new Promise(() => {});
  const t0 = Date.now();
  const pending = handoff.write({ interrupted: true });
  setTimeout(() => handoff.skip(), 100);
  const note = await pending;
  assert.strictEqual(note.source, 'basic');
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(note.summary.includes('regenerate it please') && note.summary.includes('still running'));

  convs.a.updatedAt = Date.now() + 20;
  llmImpl = async () => {
    throw new Error('rate limited');
  };
  assert.strictEqual((await handoff.write()).source, 'basic');
});

test('dismissed and old notes', async () => {
  await handoff.dismiss();
  assert.strictEqual((await handoff.read()).dismissed, true);
  const f = path.join(dir, 'handoff.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), at: Date.now() - 15 * 24 * 3600000 }));
  assert.strictEqual(await handoff.read(), null);
  assert.strictEqual(await handoff.promptBlock(), '');
});

// A note that said "who I am … as Siren" went into every persona's prompt, and the Ringmaster then
// answered "I'm Siren, speaking as myself". The note names no persona; reading it, the active one stays itself.
test('the note never decides who the next persona is', async () => {
  let asked = '';
  llmImpl = async (_s, prompt) => ((asked = prompt), '{"topic":"Persona chat","summary":"We talked about who I am as Siren."}');
  convs.a.updatedAt = Date.now() + 1000;
  await handoff.write();
  assert.match(asked, /call yourself "the assistant", never by a persona's name/);
  assert.match(asked, /leave out who you are, which persona spoke and any switching/);
  const block = await handoff.promptBlock('Ringmaster');
  assert.match(block, /the handoff note the assistant wrote/);
  assert.match(block, /not who you are: you are Ringmaster, whatever its "I" or any name in it says/);
  assert.doesNotMatch(await handoff.promptBlock(), /you are Ringmaster/);
});

// 2026-11-16: the morning routine ran after the user's last chat, and the note (and with it the launch
// greeting, "last time we were on…") was about the routine's run.
test('the note is about the user’s own chat, not a routine or tasks run that came later', async () => {
  convs.r = { id: 'r', title: '⏰ Morning briefing', updatedAt: Date.now() + 60000, index: { routine: true, lastOwnAt: 0 }, messages: [{ role: 'user', content: 'Brief me on today', display: '⏰ Morning briefing', routine: 'rt1' }, { role: 'assistant', content: 'Three meetings today.' }] };
  // An entry without the index's fields (as before version 2): its messages decide. The first sync ran
  // before the auto marker existed and carries only its display.
  convs.t = {
    id: 't',
    title: '🔄 Sync my tasks for the calendar',
    updatedAt: Date.now() + 50000,
    messages: [
      { role: 'user', content: 'Fetch my tasks', display: '🔄 Sync my tasks for the calendar' },
      { role: 'assistant', content: 'Saved 3 tasks.' },
      { role: 'user', content: 'Fetch my tasks', display: '🔄 Sync my tasks for the calendar', auto: 'tasks' },
      { role: 'assistant', content: 'Saved 4 tasks.' },
    ],
  };
  // The routine also ran in the user's own chat: the last thing they asked is still theirs.
  convs.a.messages.push({ role: 'user', content: 'Brief me on today', display: '⏰ Morning briefing', routine: 'rt1' }, { role: 'assistant', content: 'Three meetings today.' });
  convs.a.updatedAt = Date.now() + 2000;
  let asked = '';
  llmImpl = async (_s, prompt) => ((asked = prompt), '{"topic":"Calendar sync","summary":"The iCal URL returns 403."}');
  const note = await handoff.write();
  assert.strictEqual(note.conversationId, 'a');
  assert.ok(asked.includes('CONVERSATION ("Fix calendar sync")'));
  assert.ok(!note.others.some((o) => o.id === 'r'), 'a routine’s chat is not listed as touched either');

  convs.a.updatedAt = Date.now() + 3000;
  llmImpl = async () => {
    throw new Error('offline');
  };
  const basic = await handoff.write();
  assert.strictEqual(basic.source, 'basic');
  assert.match(basic.summary, /The last thing you asked: “ok, regenerate it please”/);

  // Nothing of the user's own anywhere: no note about a routine.
  const saved = { ...convs };
  for (const id of Object.keys(convs)) if (!['setup', 'r', 't'].includes(id)) delete convs[id];
  assert.strictEqual(await handoff.write(), null);
  Object.assign(convs, saved);
  delete convs.r;
  delete convs.t;
});

test('two writes at once make one model call', async () => {
  convs.a.updatedAt = Date.now() + 5;
  llmCalls = 0;
  llmImpl = () => new Promise((resolve) => setTimeout(() => resolve('{"topic":"Calendar sync","summary":"The link was regenerated."}'), 50));
  const [one, two] = await Promise.all([handoff.write(), handoff.write()]);
  assert.strictEqual(llmCalls, 1);
  assert.strictEqual(one.source, 'ai');
  assert.strictEqual(two.at, one.at, 'the second found nothing new');
});

// A second launch while the hidden window writes its note (main.js second-instance) calls skip().
test('skip() cuts every write already asked for, even one that hasn’t reached the model yet', async () => {
  convs.a.updatedAt = Date.now() + 10;
  llmCalls = 0;
  llmImpl = () => new Promise(() => {});
  let t0 = Date.now();
  const first = handoff.write({ interrupted: true }); // interrupted: never the "nothing new" shortcut
  const second = handoff.write({ interrupted: true }); // waits for the first
  setTimeout(() => handoff.skip(), 100);
  const notes = await Promise.all([first, second]);
  assert.deepStrictEqual(notes.map((n) => n.source), ['basic', 'basic']);
  assert.strictEqual(llmCalls, 1, 'the waiting one never asked');
  assert.ok(Date.now() - t0 < 2000);

  // Skipped at once, before the summary started.
  convs.a.updatedAt = Date.now() + 10;
  llmCalls = 0;
  t0 = Date.now();
  const pending = handoff.write();
  handoff.skip();
  assert.strictEqual((await pending).source, 'basic');
  assert.strictEqual(llmCalls, 0);
  assert.ok(Date.now() - t0 < 2000);

  // A later write is not affected.
  convs.a.updatedAt = Date.now() + 10;
  llmImpl = async () => '{"topic":"Calendar sync","summary":"Done."}';
  assert.strictEqual((await handoff.write()).source, 'ai');
});

// The user closed while the 18:00 routine (or the tasks sync) was still replying in its own conversation:
// the note about the user's chat said "a reply was still running", and the model was asked again.
test('only a reply still running in the note’s own conversation makes it interrupted', async () => {
  convs.a.updatedAt = Date.now() + 1;
  await wait(5);
  llmImpl = async () => '{"topic":"Calendar sync","summary":"Done."}';
  const fresh = await handoff.write({ replying: new Set() });
  assert.strictEqual(fresh.source, 'ai');

  llmCalls = 0;
  const kept = await handoff.write({ replying: new Set(['r-evening']) });
  assert.strictEqual(kept.at, fresh.at, 'nothing new in the user’s chat: the note is kept');
  assert.strictEqual(kept.interrupted, false);
  assert.strictEqual(llmCalls, 0, 'and no model call for a routine running elsewhere');

  let asked = '';
  llmImpl = async (_s, prompt) => ((asked = prompt), '{"topic":"Calendar sync","summary":"Done."}');
  const cut = await handoff.write({ replying: new Set(['r-evening', 'a']) });
  assert.strictEqual(cut.interrupted, true);
  assert.match(asked, /Your last reply was still running/);
  assert.match(await handoff.promptBlock(), /cut off by the app closing/);
});

// A relaunch during the close (skip), a timeout or a failing model leaves a basic note; the next close
// tries the model again even with nothing new, and a card the user dismissed stays dismissed.
test('a basic note is summarized on the next close; an AI one with nothing new is kept', async () => {
  convs.a.updatedAt = Date.now() + 1;
  await wait(5);
  llmImpl = () => new Promise(() => {});
  const pending = handoff.write();
  handoff.skip();
  assert.strictEqual((await pending).source, 'basic');
  await handoff.dismiss();

  llmCalls = 0;
  llmImpl = async () => '{"topic":"Calendar sync","summary":"The link was regenerated."}';
  const ai = await handoff.write();
  assert.strictEqual(ai.source, 'ai');
  assert.strictEqual(ai.dismissed, true, 'the same note, now summarized: still dismissed');
  assert.strictEqual((await handoff.write()).at, ai.at);
  assert.strictEqual(llmCalls, 1);
});

test('closing hides the window before the note, and asking for it meanwhile brings it back (main/main.js)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  const from = (start) => {
    const s = src.slice(src.indexOf(start));
    return s.slice(0, s.indexOf('\n}'));
  };
  const close = from('async function closeWithHandoff');
  assert.ok(close.indexOf('hideForClose()') > 0 && close.indexOf('hideForClose()') < close.indexOf('handoff.write('), 'hidden first');
  assert.ok(close.indexOf('if (reopenRequested) return;') > 0 && close.indexOf('if (reopenRequested) return;') < close.indexOf('hideForClose()'), 'asked for again during the settings read: never hidden');
  assert.match(close, /handoff\.write\(\{ replying: turns\.replying\(\) \}\)/, 'the running conversations (a Set, test/turns.test.js), not a count');
  assert.match(close, /if \(reopenRequested\) reopenAfterClose\(\)/);
  assert.match(from('function hideForClose'), /setAudioMuted\(true\)[\s\S]*\.hide\(\)/);
  const show = from('function showMain');
  assert.match(show, /if \(closing && !handoffDone\) \{[^}]*reopenRequested = true;[^}]*handoff\.skip\(\);[^}]*return;/);
  assert.match(show, /if \(win\.isMinimized\(\)\) win\.restore\(\);\s*win\.show\(\);\s*win\.focus\(\);/);
  assert.match(from('function reopenAfterClose'), /setAudioMuted\(false\)[\s\S]*showMain\(/);
  assert.match(src, /app\.on\('second-instance', \(\) => showMain\(\)\)/);
  assert.match(src, /app\.on\('activate', \(\) => \{\s*if \(closing && !handoffDone\) showMain\(\)/, 'the macOS dock too');
  // The voice shortcut and the notifications' clicks once showed the hidden window, which the finished
  // note then closed under the user: every way back goes through showMain.
  const rest = src.replace(show, '').replace("win.once('ready-to-show', () => !smoke.active && win.show());", '');
  assert.doesNotMatch(rest, /\bwin\.(show|focus)\(\)/);
  assert.doesNotMatch(src, /app:closing/, 'no closing screen');
  assert.doesNotMatch(src, /handoff:skip/, 'skip is main-only');
});
