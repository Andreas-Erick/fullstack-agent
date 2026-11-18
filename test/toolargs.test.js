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
    const call = Object.fromEntries((t.parameters.required || []).map((k) => [k, t.parameters.properties[k]?.enum?.[0] ?? 'x']));
    assert.ok(!checkArgs(t, call).error, t.name);
  }
  const r = await tools.execute('skill_run', { what: 'x' }, { emit() {} });
  assert.strictEqual(r.ok, false);
  assert.match(r.result.error, /skill_run needs "name"/);
});

// Regression (round 3): enums were never checked, and vault_write_note's `a.mode || 'overwrite'` turned a
// mode such as 'add' or 'Append' into an overwrite of the whole note.
const realTool = (name) => load('main/tools.js').TOOLS.find((t) => t.name === name);
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), (x >>> 0) / 2 ** 32);
}

test('a write mode in another case or with spaces is that mode; an unknown one stops the call', () => {
  const write = realTool('vault_write_note');
  const call = (mode) => checkArgs(write, { path: 'Notes/a.md', content: 'x', mode });
  assert.strictEqual(call('Append').args.mode, 'append');
  assert.strictEqual(call(' overwrite ').args.mode, 'overwrite');
  assert.strictEqual(call('\tPREPEND\n').args.mode, 'prepend');
  assert.strictEqual(call('create').args.mode, 'create', 'a listed value is untouched');
  const add = call('add');
  assert.match(add.error, /vault_write_note: "mode" must be one of "create", "overwrite", "append", "prepend"\. You sent "add"\./);
  for (const v of ['', '  ', '\t']) assert.ok(!('mode' in call(v).args), `${JSON.stringify(v)}: left out, so the tool's default applies`);
  assert.match(call(['append']).error, /You sent a list\./);
  assert.match(call(7).error, /You sent a number\./);
  assert.match(call(true).error, /You sent a boolean\./);
  assert.match(call({ mode: 'append' }).error, /You sent an object\./);
  assert.strictEqual(call(null).args.mode, null, 'null is "not given": untouched, the tool’s default');
  assert.ok(!('mode' in checkArgs(write, { path: 'a.md', content: 'x' }).args));
  assert.match(call('<script>alert(1)</script>').error, /You sent "<script>alert\(1\)<\/script>"/);
  assert.ok(call('x'.repeat(10000)).error.length < 300, 'the echo is cut short');
  assert.match(call('apend').error, /must be one of/, 'a misspelling is not guessed');
});

test('a required enum sent empty is refused; tools without one, and non-string enums, are left alone', () => {
  const svc = realTool('setup_check_service');
  assert.match(checkArgs(svc, { service: '' }).error, /"service" must be one of "freellmapi", "voicestudio"\. You sent ""/);
  assert.strictEqual(checkArgs(svc, { service: 'VoiceStudio' }).args.service, 'voicestudio');
  assert.deepStrictEqual(checkArgs(skillRun, { name: 'ADD', input: '' }).args, { name: 'ADD', input: '' });
  const numbers = { name: 'n', parameters: { type: 'object', properties: { level: { type: 'number', enum: [1, 2, 3] }, mixed: { enum: ['a', 2] } }, required: [] } };
  assert.deepStrictEqual(checkArgs(numbers, { level: 9, mixed: 'z' }).args, { level: 9, mixed: 'z' }, 'only all-string enums are checked');
  const empty = { name: 'e', parameters: { type: 'object', properties: { k: { type: 'string', enum: [] } }, required: [] } };
  assert.deepStrictEqual(checkArgs(empty, { k: 'q' }).args, { k: 'q' });
});

test('seeded: a checked write mode is always absent or one of the four', () => {
  const write = realTool('vault_write_note');
  const modes = ['create', 'overwrite', 'append', 'prepend'];
  const odd = ['مرحبا', '👨‍👩‍👧‍👦', 'a‍b', '‮append', 'append‍', 'ＡＰＰＥＮＤ', 'appénd'];
  const seed = 20261118;
  const rand = rng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const space = () => pick(['', ' ', '  ', '\t', '\n', ' \t ']);
  for (let i = 0; i < 200; i++) {
    const kind = rand();
    let mode;
    if (kind < 0.4) mode = space() + [...pick(modes)].map((c) => (rand() < 0.5 ? c.toUpperCase() : c)).join('') + space();
    else if (kind < 0.7) mode = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(odd)).join(pick(['', ' ']));
    else if (kind < 0.85) mode = space();
    else mode = pick([7, 0, -1, NaN, true, false, [], ['append'], {}, null]);
    const r = checkArgs(write, { path: 'Notes/a.md', content: 'x', mode });
    const where = `seed ${seed} case ${i}: ${JSON.stringify(mode)}`;
    if (r.error) {
      assert.match(r.error, /must be one of/, where);
      continue;
    }
    assert.ok(r.args.mode === undefined || r.args.mode === null || modes.includes(r.args.mode), `${where} → ${JSON.stringify(r.args.mode)}`);
    if (typeof mode === 'string' && modes.includes(mode.trim().toLowerCase())) assert.strictEqual(r.args.mode, mode.trim().toLowerCase(), where);
  }
});

// Regression (round 3): settings_update put any string into claudeCode.model, which reaches the CLI's
// command line (cmd.exe through claude.cmd); a page the agent read could have asked for it.
test('settings_update checks model and effort values', () => {
  const { settingValueError } = load('main/tools.js');
  const ok = [['claudeCode', 'normalModel', ''], ['claudeCode', 'model', 'sonnet[1m]'], ['claudeCode', 'model', 'opusplan'], ['claudeCode', 'model', 'default'], ['claudeCode', 'effort', 'default'], ['anthropic', 'model', 'claude-opus-5-5'], ['llm', 'model', 'qwen2.5:7b-instruct-q4_K_M'], ['groq', 'fastModel', ''], ['voice', 'model', 'tts-1'], ['anthropic', 'effort', 'max'], ['gemini', 'deepModel', 'gemini-2.5-pro'], ['voice', 'speed', 3], ['ui', 'face', 'siren'], ['stt', 'localModel', 'anything goes here']];
  for (const [s, k, v] of ok) assert.strictEqual(settingValueError(s, k, v), '', `${s}.${k} = ${JSON.stringify(v)}`);
  const bad = [['claudeCode', 'model', 'sonnet%X%&calc'], ['claudeCode', 'model', ''], ['claudeCode', 'model', 'sonnet%CMDCMDLINE:~-1%&calc&rem '], ['claudeCode', 'deepModel', 'opus "x"'], ['claudeCode', 'effort', 'high&x'], ['claudeCode', 'effort', 'High'], ['anthropic', 'effort', 'default'], ['anthropic', 'model', 'opus'], ['gemini', 'model', '../x'], ['llm', 'model', 'a'.repeat(121)], ['voice', 'model', 'tts 1'], ['llm', 'fastModel', '<script>alert(1)</script>'], ['claudeCode', 'model', '<script>'], ['perplexity', 'model', 'sonar\nx'], ['claudeCode', 'model', 5]];
  for (const [s, k, v] of bad) assert.match(settingValueError(s, k, v), new RegExp(`isn't a valid ${s}\\.${k}\\.`), `${s}.${k} = ${JSON.stringify(String(v).slice(0, 30))}`);
  assert.ok(settingValueError('llm', 'model', 'x'.repeat(10000)).length < 120, 'the echo is cut short');
});

test('settings_update refuses a bad value before it reads the settings or asks', async () => {
  let asked = 0;
  let reads = 0;
  const written = [];
  stub({
    './tools/common': { ...require('../main/tools/common'), requireApproval: async () => asked++ },
    './store': { getSettings: async () => (reads++, { claudeCode: { model: 'default' } }), setSettings: async (p) => written.push(p) },
  });
  const tools = load('main/tools.js');
  const run = (value) => tools.execute('settings_update', { section: 'claudeCode', key: 'model', value }, { emit() {} });
  for (const v of ['sonnet%X%&calc', 'opus&calc', '%PATH%']) {
    const r = await run(v);
    assert.strictEqual(r.ok, false, v);
    assert.match(r.result.error, /isn't a valid claudeCode\.model/, v);
  }
  assert.strictEqual(asked, 0, 'never asked');
  assert.strictEqual(reads, 0, 'settings never read');
  assert.deepStrictEqual(written, []);
  const good = await run('opus');
  assert.strictEqual(good.ok, true);
  assert.strictEqual(asked, 1, 'a valid value still asks');
  assert.deepStrictEqual(written, [{ claudeCode: { model: 'opus' } }]);
});
