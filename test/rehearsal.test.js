// Rehearsals: the spec, who speaks when, private goals staying private (rehearsalcore.js), and a run
// through rehearsal.js with a scripted model.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');
const core = require('../main/rehearsalcore');

const SPEC = {
  title: 'Raise talk',
  scenario: 'A 1:1 with my manager about a raise after a strong year.',
  user_role: 'a backend developer',
  user_approach: 'Lead with impact numbers, then ask for a specific figure.',
  characters: [
    { name: 'Dana', role: 'engineering manager', goal: 'Keep the budget for a new hire', style: 'friendly, deflects' },
    { name: 'Lee', role: 'HR partner', goal: 'Avoid setting a precedent', style: 'formal' },
  ],
};

test('validate: required parts, unique names, bounded size', () => {
  assert.throws(() => core.validate({ characters: SPEC.characters }), /Describe the scene/);
  assert.throws(() => core.validate({ scenario: 'x', characters: [] }), /at least one character/);
  const s = core.validate({ ...SPEC, characters: [...SPEC.characters, { name: 'dana', role: 'dup' }, { name: 'You', role: 'reserved' }] });
  assert.deepStrictEqual(s.characters.map((c) => c.name), ['Dana', 'Lee']);
  assert.strictEqual(s.rounds, 4);
  const big = core.validate({ ...SPEC, rounds: 6, characters: ['A', 'B', 'C', 'D', 'E'].map((n) => ({ name: n, role: 'r', goal: 'g' })) });
  assert.strictEqual(big.characters.length, core.MAX_CHARACTERS);
  assert.ok(core.order(big).length <= core.MAX_CALLS, 'never more turns than the cap');
});

test('order: the opener first, then everyone, each round', () => {
  assert.deepStrictEqual(core.order(core.validate({ ...SPEC, rounds: 2 })), ['Dana', 'You', 'Lee', 'Dana', 'You', 'Lee']);
  assert.deepStrictEqual(core.order(core.validate({ ...SPEC, rounds: 1, opener: 'user' })), ['You', 'Dana', 'Lee']);
});

test('each character knows only its own goal; the debrief knows all', () => {
  const s = core.validate(SPEC);
  const p = core.characterPrompt(s, 'Dana', [{ who: 'You', text: 'Thanks for the time.' }]);
  assert.match(p, /Keep the budget for a new hire/);
  assert.ok(!p.includes('Avoid setting a precedent'), "Lee's goal stays hidden from Dana");
  assert.match(p, /You: Thanks for the time\./);
  const y = core.standInPrompt(s, []);
  assert.ok(!y.includes('Keep the budget') && !y.includes('precedent'), 'the stand-in sees no hidden goals');
  assert.match(y, /Lead with impact numbers/);
  const d = core.debriefPrompt(s, []);
  assert.ok(d.includes('Keep the budget') && d.includes('precedent'));
});

test('parseTurn strips speaker prefixes and quotes, and sees the end', () => {
  assert.strictEqual(core.parseTurn('Dana: "Let\'s talk numbers."', 'Dana'), "Let's talk numbers.");
  assert.strictEqual(core.parseTurn('**Dana:** Sure.', 'Dana'), 'Sure.');
  assert.strictEqual(core.parseTurn('[DONE]', 'Dana'), null);
  assert.strictEqual(core.parseTurn('', 'Dana'), null);
});

// ------------------------------------------------------------- a run with a scripted model
const dir = tmpDir('nexus-rehearsal-');
const notes = new Map();
const recorded = [];
const streamed = [];
let turn = 0;
stub({
  './store': fileStore(dir, { getSettings: async () => ({ llm: { provider: 'anthropic' } }) }),
  './logger': quietLog,
  './obsidian': { vaultPath: async () => dir, ymd: () => '2026-10-26', writeNote: async (rel, text) => notes.set(rel, text) },
  './llm': {
    complete: async (_s, prompt) => {
      if (/sharp, kind coach/.test(prompt)) return '{"outcome":"Dana agreed to revisit in Q1","summary":"Numbers landed.","worked":["impact first"],"risks":["no figure named"],"objections":["budget"],"lines":["I am asking for 8%."],"next":"Name the figure earlier."}';
      turn++;
      return turn > 4 ? '[DONE]' : `Line ${turn}`;
    },
  },
  './persona': { extractJson: (t) => JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)) },
  './innerworld': { recordRehearsal: async (e) => recorded.push(e) },
  './stream': { USER: {}, enabled: async () => true, add: async (_loc, items) => streamed.push(...items) },
});
const rehearsal = load('main/rehearsal.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a run plays until everyone is done, debriefs, saves and records it', async () => {
  const seen = [];
  const r = await rehearsal.run(SPEC, { onTurn: (l) => seen.push(l) });
  assert.strictEqual(r.transcript.length, 4);
  assert.deepStrictEqual(r.transcript.map((l) => l.who), ['Dana', 'You', 'Lee', 'Dana']);
  assert.strictEqual(seen.length, 4);
  assert.strictEqual(r.debrief.outcome, 'Dana agreed to revisit in Q1');
  assert.strictEqual(r.note, 'Inner World/Rehearsals/2026-10-26 Raise talk.md');
  assert.match(notes.get(r.note), /## Debrief[\s\S]*I am asking for 8%[\s\S]*Keep the budget/);
  assert.strictEqual(recorded[0].title, 'Raise talk');
  assert.match(streamed[0].text, /Rehearsed "Raise talk"/);
});
