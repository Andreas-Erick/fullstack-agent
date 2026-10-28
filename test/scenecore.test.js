// The scene behind the face (main/scenecore.js, persona.generateScene): the SVG is pulled out of the
// model's reply, everything that could run or load is removed, the root gets the app's frame.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load } = require('./helpers');

const core = require('../main/scenecore');

const SCENE = `<!-- caption: a big top at night -->
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <defs><linearGradient id="sky"><stop offset="0" stop-color="#101020"/><stop offset="1" stop-color="#301030"/></linearGradient></defs>
  <g id="far"><rect width="1600" height="900" fill="url(#sky)"/><circle cx="1200" cy="150" r="60" fill="#ffe" /></g>
  <g id="mid"><path d="M200 700 L800 200 L1400 700 Z" fill="#a22"/></g>
  <g id="near"><rect x="0" y="760" width="1600" height="140" fill="#210"/></g>
</svg>`;

test('the SVG is found inside prose and fences, with its caption', () => {
  const r = core.cleanScene(`Here is the scene:\n\`\`\`svg\n${SCENE}\n\`\`\`\nEnjoy.`);
  assert.strictEqual(r.caption, 'a big top at night');
  assert.ok(r.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"'));
  assert.ok(r.svg.endsWith('</svg>'));
  assert.ok(r.layers);
  assert.ok(!r.svg.slice(0, r.svg.indexOf('>')).includes('width='), 'the root has no fixed size');
  assert.ok(!r.svg.includes('<!--'));
  assert.ok(r.svg.includes('fill="url(#sky)"'), 'in-document gradients stay');
});

test('nothing that runs or loads survives', () => {
  const bad = `<svg viewBox="0 0 10 10" onload="alert(1)">
    <script>alert(1)</script>
    <style>@import url(http://x/y.css)</style>
    <image href="http://x/y.png"/>
    <use href="http://x/y.svg#a"/><use href="#ok"/>
    <foreignObject><div>hi</div></foreignObject>
    <a href="javascript:alert(1)"><rect width="5" height="5" fill="url(http://x/g)" filter="url(#f)"/></a>
    <filter id="f"><feGaussianBlur/></filter>
    <circle r="1" style="fill:url(http://evil)" onclick="x()"/>
    <animate attributeName="r" to="5"/>
    <circle r="2"/><circle r="3"/>
  </svg>`;
  const r = core.cleanScene(bad);
  const inside = r.svg.slice(r.svg.indexOf('>')); // after the root tag (which carries the SVG namespace)
  for (const s of ['<script', '<style', '<image', '<use', '<foreignObject', '<a ', '</a>', '<filter', '<animate', 'onload', 'onclick', 'http://', 'javascript:', 'filter=']) assert.ok(!inside.includes(s), `no ${s}`);
  assert.ok(!r.svg.includes('onload'), 'the root lost its handler');
  assert.ok(r.svg.includes('<rect width="5" height="5"'), 'the shapes stay, a link loses only its tags');
  assert.ok(r.svg.includes('<circle r="1"'), 'a shape with a bad style keeps the rest');
  assert.ok(!r.layers);
});

test('a reply without a drawing, an empty or a huge one is refused', () => {
  assert.throws(() => core.cleanScene('I cannot draw that.'), /did not return an SVG/);
  assert.throws(() => core.cleanScene('<svg viewBox="0 0 1 1"></svg>'), /empty/);
  const huge = `<svg viewBox="0 0 1 1">${'<rect width="1" height="1"/>'.repeat(9000)}</svg>`;
  assert.throws(() => core.cleanScene(huge), /over 200 KB|too many/);
});

test('the prompt carries the persona, the aesthetic, the palette and the frame', () => {
  const p = core.buildPrompt({ name: 'Max', masterPrompt: 'A circus ringmaster.', aesthetic: 'carnival at night', colors: { bg: '#101010', accent: '#ff0066', bad: 'red' } });
  for (const s of ['Max', 'ringmaster', 'carnival at night', 'bg #101010', 'accent #ff0066', 'viewBox="0 0 1600 900"', 'id="far"', 'id="near"', 'caption:']) assert.ok(p.includes(s), s);
  assert.ok(!p.includes('bad red'));
});

test('the prompt asks for a hand-made, lived-in place, and hides the user’s name only when it knows one', () => {
  const p = core.buildPrompt({ name: 'Max', masterPrompt: 'x', aesthetic: 'y', userName: 'Andreas' });
  for (const s of ['surface imperfections', 'asymmetry', 'signs of use', 'environmental storytelling', 'natural randomness', 'lighting imperfections', 'craftsmanship', 'mundane details']) assert.ok(p.toLowerCase().includes(s), s);
  assert.ok(p.includes('Hide the name "Andreas"'));
  assert.ok(p.includes('apart from the hidden name'));
  const q = core.buildPrompt({ name: 'Max', masterPrompt: 'x', aesthetic: 'y' });
  assert.ok(!q.includes('Hide the name'));
  assert.ok(q.includes('- No text,'));
});

test('the tall drawing: its own frame in the prompt and on the root', () => {
  const p = core.buildPrompt({ name: 'Max', masterPrompt: 'x', aesthetic: 'y', orientation: 'portrait' });
  assert.ok(p.includes('viewBox="0 0 900 1600"'));
  assert.ok(p.includes('a tall picture'));
  assert.ok(core.buildPrompt({ name: 'Max', masterPrompt: 'x', aesthetic: 'y' }).includes('viewBox="0 0 1600 900"'));
  const r = core.cleanScene(SCENE, { orientation: 'portrait' });
  assert.ok(r.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 1600" preserveAspectRatio="xMidYMid slice"'));
});

test('persona.generateScene asks the model with the theme colors and returns the clean scene', async () => {
  const dir = require('./helpers').tmpDir('nexus-scene-');
  const calls = [];
  stub({
    electron: { app: { getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => false } },
    './llm': { complete: async (_s, text, opts) => (calls.push({ text, opts }), SCENE) },
    './obsidian': { userName: async () => 'Tester' },
  });
  const persona = load('main/persona.js');
  const r = await persona.generateScene({ masterPrompt: 'A ringmaster.', aesthetic: 'carnival', theme: { colors: { accent: '#ff0066' } } });
  assert.strictEqual(r.caption, 'a big top at night');
  assert.ok(r.svg.startsWith('<svg'));
  assert.ok(r.svg.includes('viewBox="0 0 1600 900"'));
  assert.ok(r.portrait.includes('viewBox="0 0 900 1600"'), 'the tall drawing, from a second call made at the same time');
  assert.strictEqual(calls.length, 2);
  assert.ok(calls.every((c) => c.text.includes('accent #ff0066')));
  assert.ok(calls.every((c) => c.text.includes('Hide the name "Tester"')), 'the user’s name from the profile, as the easter egg');
  assert.ok(calls[0].opts.maxTokens >= 8000);
  require('fs').rmSync(dir, { recursive: true, force: true });
});
