// The memory stream: the line format (streamcore.js), retrieval by recency + importance + relevance,
// reflection with evidence, and the vault I/O in stream.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');
const core = require('../main/streamcore');

const HOUR = 3600000;
const rec = (id, text, { importance = 5, at = Date.now(), kind = 'observation', evidence = [] } = {}) => ({ id, text, importance, at, kind, evidence });

test('records survive a round trip through the note format', () => {
  const at = new Date('2026-10-26T14:02:00').getTime();
  const records = [rec('r-1', 'Got stuck on epsilon-delta, the picture helped', { importance: 7, at }), rec('r-2', 'They like short answers', { kind: 'reflection', evidence: ['r-1'], at: at + 60000, importance: 8 })];
  const text = core.serialize(records, { title: 'Stream' });
  assert.match(text, /^# Stream/);
  assert.match(text, /- 2026-10-26 14:02 · ★7 · Got stuck/);
  const back = core.parse(text);
  assert.deepStrictEqual(
    back.map((r) => [r.id, r.kind, r.importance, r.text, r.evidence]),
    [
      ['r-1', 'observation', 7, 'Got stuck on epsilon-delta, the picture helped', []],
      ['r-2', 'reflection', 8, 'They like short answers', ['r-1']],
    ],
  );
  assert.strictEqual(back[0].at, at);
});

test('hand-written and damaged lines still count; other lines are ignored', () => {
  const text = ['# Heading', 'Some prose.', '- 2026-10-20 09:15 · wrote this myself', '- 2026-10-21 10:00 · ★12 · too important <!-- rec {broken -->', '- not a record'].join('\n');
  const r = core.parse(text);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].importance, 5, 'no stars: importance 5');
  assert.match(r[0].id, /^u-/, 'a stable id from the line');
  assert.strictEqual(core.parse(text)[0].id, r[0].id);
  assert.strictEqual(r[1].importance, 10, 'clamped to 10');
  assert.strictEqual(r[1].kind, 'observation');
});

test('text cannot break out of its line or comment', () => {
  const line = core.formatLine(rec('r-9', 'multi\nline --> <!-- sneaky', { at: Date.now() }));
  assert.ok(!line.includes('\n'));
  assert.strictEqual((line.match(/<!--/g) || []).length, 1);
  assert.strictEqual(core.parse(line)[0].text, 'multi line sneaky');
});

test('retrieval: relevance, importance and recency all count', () => {
  const now = Date.now();
  const records = [
    rec('a', 'Went for a long run in the rain, felt great', { importance: 3, at: now - 2 * HOUR }),
    rec('b', 'Struggled with linear algebra eigenvalues again', { importance: 5, at: now - 48 * HOUR }),
    rec('c', 'Decided to apply for the master program in Zurich', { importance: 9, at: now - 300 * HOUR }),
    rec('d', 'Had coffee', { importance: 1, at: now - 1 * HOUR }),
  ];
  const top = core.retrieve(records, 'help me with eigenvalues of this matrix', { now, k: 4 });
  assert.strictEqual(top[0].id, 'b', 'the relevant one first');
  const noQuery = core.retrieve(records, '', { now, k: 4 });
  assert.notStrictEqual(noQuery[0].id, 'd', 'a mundane recent record does not beat important ones');
  // Recalling a record refreshes its recency.
  const plain = core.retrieve(records, 'zurich', { now, k: 4 });
  assert.strictEqual(plain[0].id, 'c');
  assert.strictEqual(core.retrieve([], 'x').length, 0);
  // Stemming: "runs" finds "run".
  assert.strictEqual(core.retrieve(records, 'runs', { now, k: 1 })[0].id, 'a');
});

test('reflection is due once enough importance has piled up since the last one', () => {
  const now = Date.now();
  const many = Array.from({ length: 9 }, (_, i) => rec(`o${i}`, `obs ${i}`, { importance: 7, at: now - (20 - i) * HOUR }));
  assert.strictEqual(core.pending(many).due, true);
  const withReflection = [...many, rec('r', 'insight', { kind: 'reflection', at: now - 5 * HOUR }), rec('late', 'after', { importance: 9, at: now })];
  const p = core.pending(withReflection);
  assert.strictEqual(p.due, false);
  assert.deepStrictEqual(p.fresh.map((r) => r.id), ['late']);
});

test('reflections must cite records that exist', () => {
  const records = [rec('a', 'one'), rec('b', 'two'), rec('c', 'three')];
  const prompt = core.reflectionPrompt(records, { subject: 'Sam' });
  assert.match(prompt, /1\. \[.*\] one/);
  const out = core.parseReflections({ insights: [{ text: 'Patterns', importance: 20, because: [1, 3, 3] }, { text: 'No evidence', because: [] }, { text: 'Out of range', because: [99] }, { because: [1] }] }, records);
  assert.deepStrictEqual(out, [{ text: 'Patterns', importance: 10, evidence: ['a', 'c'] }]);
  assert.deepStrictEqual(core.parseReflections(null, records), []);
});

// ------------------------------------------------------------- stream.js against an in-memory vault
const dir = tmpDir('nexus-stream-');
const notes = new Map();
let settings = { agent: { name: 'Nexus' }, llm: { provider: 'anthropic' }, memory: { stream: true, reflect: true } };
let llmImpl = async () => '{"insights":[]}';
stub({
  './store': fileStore(dir, { getSettings: async () => settings }),
  './logger': quietLog,
  './obsidian': {
    vaultPath: async () => dir,
    readOptional: async (rel) => notes.get(rel) || '',
    writeNote: async (rel, text) => notes.set(rel, text),
  },
  './llm': { complete: (...a) => llmImpl(...a) },
  './persona': { extractJson: (t) => JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)) },
});
const stream = load('main/stream.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('observe writes this month\'s note; recall finds it; reflection cites it', async () => {
  let reflected;
  const done = new Promise((r) => (reflected = r));
  llmImpl = async (_s, prompt) => {
    reflected(prompt);
    return 'Here: {"insights":[{"text":"Pictures unlock proofs for them","importance":8,"because":[1,2]}]}';
  };
  // Importance is capped at 10: two notes are not enough to reflect on, eight are.
  await stream.observe([{ text: 'The picture made the epsilon-delta proof click', importance: 30 }, { text: 'Asked for a diagram before the algebra', importance: 9 }]);
  const rel = stream.USER.current();
  assert.match(rel, /^Stream\/\d{4}-\d{2}\.md$/);
  assert.match(notes.get(rel), /type: memory-stream/);
  assert.strictEqual((await stream.readAll(stream.USER))[0].importance, 10);
  await stream.observe(Array.from({ length: 6 }, (_, i) => ({ text: `Worked through exercise ${i + 1}`, importance: 7 })));
  assert.match(await done, /epsilon-delta/);
  await new Promise((r) => setTimeout(r, 50));
  const all = await stream.readAll(stream.USER);
  const insight = all.find((r) => r.kind === 'reflection');
  assert.ok(insight, 'a reflection was saved');
  assert.deepStrictEqual(insight.evidence, all.filter((r) => r.kind === 'observation').slice(0, 2).map((r) => r.id));
  const block = await stream.promptBlock('another proof please, with a diagram');
  assert.match(block, /Recalled from your memory stream/);
  assert.match(block, /insight: Pictures unlock proofs/);
});

test('nothing in the prompt when the stream is off', async () => {
  settings = { ...settings, memory: { stream: false } };
  assert.strictEqual(await stream.promptBlock('anything'), '');
  settings = { ...settings, memory: { stream: true, reflect: true } };
});

test('observe refuses empty input', async () => {
  await assert.rejects(stream.observe([{ text: '  ' }]), /Nothing to record/);
});
