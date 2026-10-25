// Diagrams (main/diagrams.js) and imported Agent Skills (main/skills.js folder skills, main/skillimport.js):
// nothing that runs survives in a saved page; skill folders, their frontmatter and companion files.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, fileStore } = require('./helpers');

const data = tmpDir('nexus-diagrams-');
const vault = path.join(data, 'vault');
stub({
  './store': fileStore(data),
  './obsidian': { vaultPath: async () => vault, ymd: () => '2026-10-25' },
});
const diagrams = load('main/diagrams.js');
const skills = load('main/skills.js');
const imp = load('main/skillimport.js');
test.after(() => fs.rmSync(data, { recursive: true, force: true }));

test('a saved diagram keeps its drawing and styles, never anything that runs', async () => {
  const page = `<!doctype html><html><head><style>:root{--a:#bf4520}</style><link rel="stylesheet" href="https://evil.example/x.css"><meta http-equiv="refresh" content="0;url=https://x"><base href="https://x/"></head>
<body onload="steal()"><svg viewBox="0 0 10 10"><rect width="10" height="10" fill="var(--a)" onclick="alert(1)"/><a xlink:href="javascript:alert(1)"><text>t</text></a></svg>
<script>alert(1)</script><SCRIPT src="x.js"></SCRIPT><iframe src="https://x"></iframe><object data="x"></object><embed src="x"><img src=x onerror=alert(1)><a href="javascript:void(0)">x</a><a href=" JavaScript:alert(1)">y</a></body></html>`;
  const clean = diagrams.sanitize(page);
  for (const bad of [/<script/i, /onload|onclick|onerror/i, /javascript:/i, /<iframe/i, /<object/i, /<embed/i, /<link/i, /http-equiv/i, /<base/i]) assert.doesNotMatch(clean, bad);
  for (const good of [/<style>:root\{--a:#bf4520\}<\/style>/, /<svg viewBox="0 0 10 10">/, /<rect width="10" height="10" fill="var\(--a\)"/]) assert.match(clean, good);
  const r = await diagrams.save('System: overview / v2', page);
  assert.strictEqual(r.vaultPath, 'Diagrams/2026-10-25 System overview v2.html');
  assert.doesNotMatch(fs.readFileSync(r.path, 'utf8'), /<script/i);
  await assert.rejects(diagrams.save('x', 'just text'), /not an HTML page/);
  const bare = await diagrams.save('Bare svg', '<svg width="4" height="4"></svg>');
  assert.match(fs.readFileSync(bare.path, 'utf8'), /^<!doctype html>/);
});

test('folder skills: frontmatter from elsewhere, companion files, and reads stay inside', async () => {
  const folder = path.join(data, 'skills', 'diagram-design');
  fs.mkdirSync(path.join(folder, 'references'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: diagram-design\ndescription: >\n  Create branded diagrams\n  as HTML/SVG.\nlicense: MIT\nmetadata:\n  version: "2.6"\n---\n# Diagram Design\nRead references/style-guide.md first.\n');
  fs.writeFileSync(path.join(folder, 'references', 'style-guide.md'), 'paper #f5f5f5');
  fs.writeFileSync(path.join(folder, '.source.json'), JSON.stringify({ repo: 'cathrynlavery/diagram-design' }));
  fs.writeFileSync(path.join(data, 'secret.txt'), 'no');
  const s = await skills.get('diagram-design');
  assert.deepStrictEqual([s.name, s.description, s.folder, s.source, s.files], ['diagram-design', 'Create branded diagrams as HTML/SVG.', true, 'cathrynlavery/diagram-design', ['references/style-guide.md']]);
  assert.match(skills.instructions(s), /skill_file \(skill "diagram-design"/);
  assert.strictEqual((await skills.readFile('diagram-design', 'references/style-guide.md')).content, 'paper #f5f5f5');
  await assert.rejects(skills.readFile('diagram-design', '../../secret.txt'), /outside the skill/);
  await assert.rejects(skills.readFile('diagram-design', 'references/missing.md'), /No file/);
  await skills.remove('diagram-design');
  assert.ok(!fs.existsSync(folder), 'removing a folder skill removes its folder');
});

test('importing: repository links and which files are copied', () => {
  assert.deepStrictEqual(imp.parseRepo('https://github.com/mattpocock/skills/tree/main/skills'), { owner: 'mattpocock', repo: 'skills' });
  assert.deepStrictEqual(imp.parseRepo('cathrynlavery/diagram-design.git'), { owner: 'cathrynlavery', repo: 'diagram-design' });
  assert.throws(() => imp.parseRepo('not a repo'), /owner\/repo/);
  assert.throws(() => imp.parseRepo('../etc'), /owner\/repo/);
  assert.ok(imp.importable('references/type-flowchart.md', 1000));
  assert.ok(imp.importable('scripts/export_svg.py', 68000), 'scripts come along as text');
  assert.ok(!imp.importable('assets/hero.png', 1000), 'binaries stay behind');
  assert.ok(!imp.importable('assets/huge.html', 900000), 'too big');
  assert.ok(!imp.importable('.github/workflows/ci.yml', 100), 'hidden folders stay behind');
  assert.ok(!imp.importable('../outside.md', 100));
});
