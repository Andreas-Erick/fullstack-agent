// ✨ Polish (main/polishcore.js, main/notebook.js polish): which notes are offered as links, the rules the
// model gets, and the checks on its answer: no invented links, the user's own links kept, nothing
// offered when most of the note went missing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog } = require('./helpers');
const core = require('../main/polishcore');

const notes = [
  { title: 'PID tuning', snippet: 'Ziegler-Nichols first, then hand-tune Kd', text: 'Ziegler-Nichols first, then hand-tune Kd. #control', tags: ['control'] },
  { title: 'Robot arm kinematics', snippet: 'Closed-form IK for the 2-link arm', text: 'Closed-form IK for the 2-link arm, elbow up and down', tags: ['robotics'] },
  { title: 'Groceries', snippet: 'eggs milk bread', text: 'eggs milk bread' },
  { title: 'Lab demo', snippet: 'the arm sorts blocks', text: 'the arm sorts blocks by colour' },
];
const note = { title: 'Lab demo', body: 'arm sorts blocks, need pid tuning for the joint controller, ik for 2-link arm. see [[Groceries]] lol' };

test('candidates: related notes first by shared words, never itself, already-linked ones kept', () => {
  const c = core.candidates(note, notes).map((x) => x.title);
  assert.ok(!c.includes('Lab demo'), 'not the note itself');
  assert.deepStrictEqual(c.slice(0, 1), ['Groceries'], 'a note it already links comes first');
  assert.ok(c.includes('PID tuning') && c.includes('Robot arm kinematics'));
  assert.strictEqual(core.candidates({ title: 'x', body: 'zzz qqq' }, notes).length, 0, 'nothing in common: nothing offered');
});

test('the prompt keeps the user’s words, offers only the listed notes and asks for a Related section', () => {
  const p = core.prompt(note, core.candidates(note, notes));
  for (const rule of [/Keep every fact/, /Add no information/, /Keep existing \[\[links\]\] exactly/, /## Related/, /Never link a note that isn't in the list/, /Return only the note's new Markdown text/]) assert.match(p, rule);
  assert.match(p, /- PID tuning — Ziegler-Nichols/);
  assert.match(p, /NOTE TITLE: Lab demo/);
  assert.match(core.prompt({ title: 'x', body: 'y' }, []), /OTHER NOTES[^\n]*\n\(none\)/);
});

test('clean: links only to notes that exist, the user’s own links kept, fences and title lines off', () => {
  const reply = '```markdown\n# Lab demo\n## Plan\nThe arm sorts blocks by colour. It still needs [[PID tuning]] for the joint controller and [[Inverse Kinematics Bible]] for the 2-link arm. See [[Groceries]].\n\n## Related\n- [[PID tuning]] — the joint controller\n- [[Robot arm kinematics]] — the IK\n- [[Made Up Note|made up]] — nope\n```';
  const r = core.clean(reply, note, notes.map((n) => n.title));
  assert.ok(r.body.startsWith('## Plan'), 'no fence, no repeated title');
  assert.strictEqual(core.clean(String.raw`## Lab demo` + '\nThe arm sorts blocks.', note, []).body, 'The arm sorts blocks.\n', 'the title as a subheading too');
  assert.match(r.body, /\[\[PID tuning\]\]/);
  assert.match(r.body, /for the 2-link arm/);
  assert.doesNotMatch(r.body, /\[\[Inverse Kinematics Bible\]\]/, 'an invented note becomes plain text');
  assert.match(r.body, /Inverse Kinematics Bible for the 2-link arm/);
  assert.doesNotMatch(r.body, /made up/, 'an invented entry in Related goes entirely');
  assert.match(r.body, /## Related\n- \[\[PID tuning\]\] — the joint controller\n- \[\[Robot arm kinematics\]\] — the IK\n$/);
  assert.match(r.body, /\[\[Groceries\]\]/, 'the user’s own link stays');
  assert.deepStrictEqual(r.added.sort(), ['PID tuning', 'Robot arm kinematics']);
});

test('clean: a Related section of invented links goes; an answer that lost the note is refused', () => {
  const body = 'word '.repeat(80);
  const onlyFake = `${body}\n\n## Related\n- [[Nope]] — nope\n- [[Also nope]] — no`;
  assert.doesNotMatch(core.clean(onlyFake, { title: 'T', body }, ['PID tuning']).body, /## Related/);
  assert.throws(() => core.clean('Short summary.', { title: 'T', body: 'Long note with many words. '.repeat(20) }, []), /left out too much/);
  assert.throws(() => core.clean('   ', note, []), /returned nothing/);
  assert.strictEqual(core.clean('---\ntype: note\n---\nHi there.', { title: 'T', body: 'hi there' }, []).body, 'Hi there.\n', 'frontmatter is the note’s own');
});

test('polish reads the note, asks the everyday model, writes nothing', async () => {
  const vault = tmpDir('nexus-polish-');
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Notes', 'Lab demo.md'), note.body);
  fs.writeFileSync(path.join(vault, 'Notes', 'PID tuning.md'), 'Ziegler-Nichols first, then hand-tune Kd');
  let asked = null;
  stub({
    './logger': quietLog,
    './obsidian': { vaultPath: async () => vault },
    './store': { getSettings: async () => ({ llm: { provider: 'claude-code', modelMode: 'default' } }) },
    './llm': { complete: async (settings, prompt) => ((asked = { settings, prompt }), 'The arm sorts blocks. It needs [[PID tuning]] for the joint controller and IK for the 2-link arm; see [[Groceries]].') },
  });
  const nb = load('main/notebook.js');
  const r = await nb.polish('Notes/Lab demo.md');
  assert.strictEqual(asked.settings.llm.modelMode, 'normal');
  assert.match(asked.prompt, /- PID tuning/);
  assert.deepStrictEqual(r.added, ['PID tuning']);
  assert.strictEqual(fs.readFileSync(path.join(vault, 'Notes', 'Lab demo.md'), 'utf8'), note.body, 'the note itself is untouched');
  await assert.rejects(nb.polish('Memory/x.md'), /not one of your notes/);
  fs.writeFileSync(path.join(vault, 'Notes', 'Empty.md'), '  ');
  await assert.rejects(nb.polish('Notes/Empty.md'), /empty/);
});
