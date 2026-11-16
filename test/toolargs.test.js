// Tool arguments checked against the schema (main/toolargs.js): skill_run({ skill }) was told
// "No skill called "undefined"" twice in one turn.
const test = require('node:test');
const assert = require('node:assert');
const { checkArgs } = require('../main/toolargs');
const { stub, load } = require('./helpers');

const skillRun = { name: 'skill_run', parameters: { type: 'object', properties: { name: { type: 'string' }, input: { type: 'string' } }, required: ['name'] } };

test('an obvious other name for a missing parameter is renamed', () => {
  assert.deepStrictEqual(checkArgs(skillRun, { skill: 'Lecture summary', args: 'steps only' }), { args: { name: 'Lecture summary', args: 'steps only' }, renamed: [['skill', 'name']] });
  // Right names: untouched (a copy).
  const a = { name: 'x', input: 'y' };
  const r = checkArgs(skillRun, a);
  assert.deepStrictEqual(r, { args: a, renamed: [] });
  assert.notStrictEqual(r.args, a);
  // Never over a parameter the tool has, never over a given value.
  const both = { name: 'skill_x', parameters: { type: 'object', properties: { name: { type: 'string' }, skill: { type: 'string' } }, required: ['name'] } };
  assert.ok(checkArgs(both, { skill: 's' }).error, 'skill is its own parameter here');
  assert.deepStrictEqual(checkArgs(skillRun, { name: 'a', skill: 'b' }).args, { name: 'a', skill: 'b' });
  // '' is a value (clearing a field); only missing or null counts.
  assert.deepStrictEqual(checkArgs(skillRun, { name: '' }).renamed, []);
});

test('otherwise the call stops with what the tool takes and what it was sent', () => {
  const r = checkArgs(skillRun, { what: 'x' });
  assert.match(r.error, /skill_run needs "name"/);
  assert.match(r.error, /It takes: name \(required\): string, input: string/);
  assert.match(r.error, /You sent: what/);
  assert.match(checkArgs(skillRun, null).error, /You sent: nothing/);
  // No schema: nothing to check.
  assert.deepStrictEqual(checkArgs({ name: 't' }, { a: 1 }), { args: { a: 1 }, renamed: [] });
});

test('every real tool takes its own well-formed call, and the executor stops a wrong one', async () => {
  const anything = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => require('os').tmpdir() : p === 'getPath' ? () => require('os').tmpdir() : anything), apply: () => anything, construct: () => anything });
  stub({ electron: anything });
  const tools = load('main/tools.js');
  for (const t of tools.TOOLS) {
    const call = Object.fromEntries((t.parameters.required || []).map((k) => [k, 'x']));
    assert.ok(!checkArgs(t, call).error, t.name);
  }
  const r = await tools.execute('skill_run', { what: 'x' }, { emit() {} });
  assert.strictEqual(r.ok, false);
  assert.match(r.result.error, /skill_run needs "name"/);
});
