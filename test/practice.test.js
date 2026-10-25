// Language practice (renderer/js/practice.js), persona templates (main/personatemplates.js) and the
// one-time install of the bundled skills (main/skills.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, stub, load, tmpDir, fileStore } = require('./helpers');

let p;
test.before(async () => {
  const copy = path.join(tmpDir('nexus-practice-'), 'practice.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/practice.js'), copy);
  p = await import(pathToFileURL(copy).href);
});

test('blockquote notes are shown but not spoken, even when streamed in pieces', () => {
  const feed = p.quoteFilter();
  const pieces = ['¡Muy bien! Dijiste "yo ', 'soy cansado".\n', '> Use *estar* for ', 'states: estoy cansado.\n', '  > indented too\n', '¿Qué hiciste hoy?'];
  const spoken = pieces.map(feed).join('');
  assert.strictEqual(spoken, '¡Muy bien! Dijiste "yo soy cansado".\n¿Qué hiciste hoy?');
});

test('a voice for the practiced language, natural ones first', () => {
  const voices = [{ name: 'Microsoft David', lang: 'en-US', default: true }, { name: 'Microsoft Helena', lang: 'es-ES' }, { name: 'Microsoft Elvira Online (Natural)', lang: 'es-ES' }];
  assert.strictEqual(p.pickVoice(voices, 'es').name, 'Microsoft Elvira Online (Natural)');
  assert.strictEqual(p.pickVoice(voices, 'ja'), null);
  assert.strictEqual(p.practiceLanguage({ learning: { practiceLanguage: ' ES ' } }), 'es');
  assert.strictEqual(p.practiceLanguage({}), '');
  assert.strictEqual(p.languageName('pt-BR'), 'Portuguese');
});

test('persona templates are complete personas', () => {
  const templates = load('main/personatemplates.js');
  const core = load('main/personacore.js');
  assert.ok(templates.list().some((t) => t.id === 'stem-tutor') && templates.list().some((t) => t.id === 'polyglot-coach'));
  for (const t of templates.TEMPLATES) {
    const fields = templates.personaFields(t);
    for (const k of ['name', 'personality', 'aesthetic', 'greeting', 'theme', 'face']) assert.ok(fields[k], `${t.id}.${k}`);
    for (const c of Object.values(t.theme.colors)) assert.match(c, /^#[0-9a-f]{6}$/);
    const settings = { agent: { name: 'Nexus', personality: 'p' }, appearance: {}, ui: { face: 'circuit' }, voice: { voice: 'v1' }, personas: { active: 'a', list: [{ id: 'a', name: 'Nexus' }] } };
    const defaults = { agent: { name: 'Nexus', personality: 'default' }, appearance: { theme: null }, ui: { face: 'circuit' } };
    const { persona } = core.create(settings, { template: fields }, { newId: () => 'p-new', defaults });
    assert.strictEqual(persona.name, t.name, 'named after the template');
    assert.strictEqual(persona.voice, 'v1', 'keeps the current voice');
    assert.strictEqual(persona.theme.name, t.theme.name);
  }
});

test('bundled skills are installed once; a deleted one stays deleted', async () => {
  const data = tmpDir('nexus-skills-');
  stub({ './store': fileStore(data) });
  let skills = load('main/skills.js');
  const first = await skills.list();
  assert.ok(['explain', 'proof-coach', 'teach-back', 'study-session', 'drill', 'converse'].every((s) => first.some((x) => x.slug === s)));
  fs.rmSync(path.join(data, 'skills', 'drill.md'));
  skills = load('main/skills.js'); // a new start
  assert.ok(!(await skills.list()).some((x) => x.slug === 'drill'));
  fs.rmSync(data, { recursive: true, force: true });
});
