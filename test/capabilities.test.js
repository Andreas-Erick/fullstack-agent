// The capability advisor (main/capabilities.js): which skills, connectors, plugins and extensions fit a
// task, ready to use or worth suggesting.
const test = require('node:test');
const assert = require('node:assert');
const { match, SERVICES } = require('../main/capabilities');

const inv = (over = {}) => ({
  skills: [
    { slug: 'diagram-design', name: 'Diagram design', description: 'Draw architecture diagrams, flowcharts and timelines as SVG', triggers: [] },
    { slug: 'weekly-review', name: 'Weekly review', description: 'Review the week', triggers: ['review my week'] },
  ],
  connectors: [
    { name: 'claude.ai Todoist', status: 'connected', source: 'connector' },
    { name: 'plugin:productivity:slack', status: 'needs-auth', source: 'plugin' },
    { name: 'claude.ai Have I Been Pwned', status: 'connected', source: 'connector' },
  ],
  connectorsOn: true,
  claudeBrain: true,
  extensions: [{ id: 'godseye', name: "God's Eye View", on: true, ready: true }, { id: 'rea', name: 'REA', on: false, ready: true }],
  ...over,
});

test('a skill that fits is used without being named; a trigger phrase wins', () => {
  assert.strictEqual(match('Can you make a flowchart of the login architecture?', inv()).use[0].how, 'skill_run "diagram-design"');
  assert.strictEqual(match('let us review my week', inv()).use[0].name, 'Weekly review');
  assert.deepStrictEqual(match('what is 2+2', inv()).use, []);
});

test('a connected connector is used; one needing sign-in is suggested with how', () => {
  const r = match('add buy milk to my tasks', inv());
  assert.ok(r.use.some((u) => u.kind === 'connector' && u.name === 'Todoist'));
  const s = match('send a message to the team channel on slack', inv());
  assert.ok(s.suggest.some((x) => x.name === 'slack' && /\/mcp/.test(x.action)));
});

test('connectors off or another brain: suggested, not used', () => {
  const r = match('add buy milk to my tasks', inv({ connectorsOn: false }));
  assert.ok(!r.use.some((u) => u.kind === 'connector'));
  assert.ok(r.suggest.some((x) => x.name === 'Todoist' && /Settings → AI brain/.test(x.action)));
});

test('a well-known service the user lacks is an optional suggestion; own tools first for the calendar', () => {
  const r = match('translate this letter into French', inv());
  assert.ok(r.suggest.some((x) => x.name === 'DeepL' && x.optional));
  assert.ok(!match('book a meeting with Anna on google calendar', inv()).suggest.some((x) => x.name === 'Google Calendar'));
});

test('generic words in connector names do not match', () => {
  assert.ok(!match('have you been to Paris?', inv()).use.some((u) => /Pwned/.test(u.name)));
});

test('extensions: on and ready → use; off → suggest turning on', () => {
  assert.ok(match('what planes are flying over Munich?', inv()).use.some((u) => u.kind === 'extension'));
  assert.ok(match('how does this electron app work, reverse engineer it', inv()).suggest.some((x) => x.name === 'REA' && x.why === 'off'));
  assert.ok(SERVICES.length > 10);
});
