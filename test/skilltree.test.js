// Skill tree (main/skilltreecore.js): the note format, prerequisites without loops, progress from the
// learning tracker, decks and habits, lock/unlock states, and the constellation layout.
const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./helpers');

const core = load('main/skilltreecore.js');

function sample() {
  return core.upsert(core.parse(''), [
    { name: 'Calculus', area: 'Math', manual: 1 },
    { name: 'Real Analysis', area: 'Math', description: 'rigorous calculus', needs: ['Calculus'], from: [{ type: 'learning', name: 'Real Analysis' }] },
    { name: 'Measure Theory', area: 'Math', needs: ['Real Analysis'], from: [{ type: 'learning', name: 'Measure Theory' }] },
    { name: 'Spanish B1', area: 'Languages', from: [{ type: 'deck', name: 'Spanish', target: 400 }] },
    { name: 'Deep work', area: 'Mind', needs: ['Meditation'], from: [{ type: 'habit', name: 'Focus block' }] },
  ]).tree;
}

test('the note round-trips and keeps hand-written text', () => {
  const tree = sample();
  const text = core.serialize(tree);
  assert.match(text, /- \*\*Real Analysis\*\* — rigorous calculus <!-- skill \{"area":"Math","needs":\["Calculus"\],"from":\[\{"type":"learning","name":"Real Analysis"\}\]\} -->/);
  const again = core.parse(text.replace('## Skills', '## Skills\n\nMy notes.'));
  assert.deepStrictEqual(again.skills, tree.skills);
  assert.ok(core.serialize(again).includes('My notes.'));
  assert.ok(tree.skills.some((s) => s.name === 'Meditation'), 'a missing prerequisite is created');
});

test('prerequisites never form a loop; updates merge', () => {
  const tree = sample();
  assert.throws(() => core.upsert(tree, [{ name: 'Calculus', needs: ['Measure Theory'] }]), /loop/);
  const { tree: t2 } = core.upsert(tree, [{ name: 'real analysis', description: 'epsilons everywhere' }]);
  const ra = t2.skills.find((s) => s.name === 'Real Analysis');
  assert.deepStrictEqual([ra.description, ra.needs], ['epsilons everywhere', ['Calculus']], 'only what was given changes');
  const t3 = core.remove(t2, 'Calculus');
  assert.deepStrictEqual(t3.skills.find((s) => s.name === 'Real Analysis').needs, []);
});

test('progress and states from the evidence', () => {
  const skills = core.compute(sample(), {
    learning: [{ topic: 'Real Analysis', understood: 6, shakyCount: 2, questionCount: 2 }],
    decks: [{ language: 'Spanish', mature: 100, total: 450 }],
    habits: [{ name: 'Focus block', rate28: 0.5, streak: 2, streakUnit: 'weeks' }],
  });
  const get = (n) => skills.find((s) => s.name === n);
  assert.deepStrictEqual([get('Calculus').progress, get('Calculus').state], [1, 'mastered']);
  assert.deepStrictEqual([get('Real Analysis').progress, get('Real Analysis').state], [0.5, 'growing'], '6 of max(12, 10)');
  assert.deepStrictEqual([get('Measure Theory').state, get('Measure Theory').blockers], ['locked', ['Real Analysis']], 'Real Analysis is below 60%');
  assert.strictEqual(get('Spanish B1').progress, 0.25);
  assert.match(get('Spanish B1').sources[0].detail, /100 of 400 cards mature/);
  assert.strictEqual(get('Deep work').state, 'growing', 'already practicing: growing even before its prerequisite is done');
  assert.strictEqual(get('Meditation').state, 'ready');
});

test('constellation layout: columns by depth, edges from prerequisites', () => {
  const skills = core.compute(sample(), {});
  const { pos, edges, depth } = core.layout(skills);
  assert.strictEqual(depth, 2);
  assert.deepStrictEqual([pos.Calculus.x, pos['Real Analysis'].x, pos['Measure Theory'].x], [0, 0.5, 1]);
  assert.ok(edges.some((e) => e.from === 'Calculus' && e.to === 'Real Analysis'));
  for (const p of Object.values(pos)) assert.ok(p.y >= 0 && p.y <= 1);
});

test('the feature guide covers every area and finds one by topic', async () => {
  const { stub, load: fresh } = require('./helpers');
  stub({
    './store': { getSettings: async () => ({ voice: { ttsEnabled: true }, stt: { enabled: true, micMode: 'ptt', pttKey: 'F8' }, personas: { list: [{ name: 'Nexus' }] }, agent: { name: 'Nexus' }, learning: {}, calendar: { enabled: true }, claudeCode: { connectors: false }, documents: { workspace: '' }, web: { enabled: true }, code: { allowSelfModify: true }, remote: { enabled: false }, safety: { permissionMode: 'ask' } }) },
    './obsidian': { vaultPath: async () => null },
    './routines': { list: async () => [{ enabled: true }, { enabled: false }] },
    './skills': { list: async () => [1, 2, 3] },
  });
  const g = fresh('main/guide.js');
  const all = await g.guide();
  const ids = all.features.map((f) => f.id);
  for (const id of ['talk', 'personas', 'memory', 'learning', 'languages', 'coaching', 'skilltree', 'routines', 'schedule', 'connectors', 'documents', 'skills', 'web-code', 'remote', 'safety']) assert.ok(ids.includes(id), id);
  assert.ok(all.features.every((f) => f.status && f.status !== 'unknown'), 'every status renders');
  assert.match(all.features.find((f) => f.id === 'routines').status, /2 routines \(1 on\)/);
  assert.match(all.features.find((f) => f.id === 'connectors').status, /^off/);
  const one = await g.guide('how do routines work');
  assert.strictEqual(one.topic, 'Routines (things I do on a schedule)');
  assert.ok(one.try.length && one.where);
});
