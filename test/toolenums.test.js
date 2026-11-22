// Tool arguments against their schemas (main/toolargs.js checkArgs, through tools.js executeTool): every
// tool's string enums accept their own values in any case, refuse an unknown one and cover the values the
// tool's code compares with; enums that mirror another module match it; every model and effort Settings
// offers passes settings_update's check and reaches the CLI; a stopped turn's call never runs.
const test = require('node:test');
const assert = require('node:assert');
const fx = require('./appfixture')('toolenums');
const { store, approvals, read, escapeRe, allTools } = fx;
const { checkArgs } = require('../main/toolargs');

const sample = (p) => (p?.type === 'number' || p?.type === 'integer' ? 1 : p?.type === 'boolean' ? true : p?.type === 'array' ? [] : p?.type === 'object' ? {} : 'x');
const stringEnum = (p) => (Array.isArray(p?.enum) && p.enum.length && p.enum.every((v) => typeof v === 'string') ? p.enum : null);
// The name of a run function's first parameter: async (a, ctx) =>, async run(a) {, (args) =>, a =>.
function firstParam(fn) {
  const src = fn.toString();
  const m = /^(?:async\s+)?(?:function\b[^(]*|[\w$]+\s*)?\(\s*([\w$]+)/.exec(src) || /^(?:async\s+)?([\w$]+)\s*=>/.exec(src);
  return m ? m[1] : null;
}

test('every tool passes the enum check with its own values; another case is that value, an unknown one stops the call', () => {
  let enums = 0;
  for (const t of allTools().TOOLS) {
    const props = t.parameters?.properties || {};
    const full = {};
    for (const [k, p] of Object.entries(props)) if (stringEnum(p)) full[k] = p.enum[0];
    for (const k of t.parameters?.required || []) if (!(k in full)) full[k] = sample(props[k]);
    const ok = checkArgs(t, full);
    assert.ok(!ok.error, `${t.name}: ${ok.error}`);
    assert.deepStrictEqual(ok.args, full, `${t.name}: a well-formed call is left as it is`);
    for (const [k, p] of Object.entries(props)) {
      const values = stringEnum(p);
      if (!values) continue;
      enums++;
      const where = `${t.name}.${k}`;
      const folded = values.map((v) => v.trim().toLowerCase());
      assert.strictEqual(new Set(folded).size, folded.length, `${where}: two values differ only in case or spaces (the check would always pick the first)`);
      for (const v of values) {
        assert.strictEqual(v, v.trim(), `${where}: "${v}" has spaces around it`);
        assert.strictEqual(checkArgs(t, { ...full, [k]: v }).args?.[k], v, `${where} = "${v}"`);
        assert.strictEqual(checkArgs(t, { ...full, [k]: ` ${v.toUpperCase()}\t` }).args?.[k], v, `${where} = "${v.toUpperCase()}"`);
      }
      if ('default' in p) assert.ok(values.includes(p.default), `${where}: its default "${p.default}" is not one of its values`);
      assert.match(checkArgs(t, { ...full, [k]: 'no-such-value' }).error || '', new RegExp(`^${escapeRe(t.name)}: "${escapeRe(k)}" must be one of`), where);
      // A value the tool's own code compares with must be one the check lets through.
      const param = firstParam(t.run);
      if (!param) continue;
      const src = t.run.toString();
      const ref = `\\b${escapeRe(param)}\\.${escapeRe(k)}\\b`;
      const used = [
        ...[...src.matchAll(new RegExp(`${ref}\\s*[!=]==?\\s*'([^']*)'`, 'g'))].map((m) => m[1]),
        ...[...src.matchAll(new RegExp(`'([^']*)'\\s*[!=]==?\\s*${ref}`, 'g'))].map((m) => m[1]),
        ...[...src.matchAll(new RegExp(`\\[((?:\\s*'[^']*'\\s*,?)+)\\]\\.includes\\(${ref}\\)`, 'g'))].flatMap((m) => [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])),
      ];
      for (const u of used) assert.ok(values.includes(u), `${where}: its code handles "${u}", which the enum check refuses`);
    }
  }
  assert.ok(enums >= 25, `only ${enums} enums found`);
});

test('the enums that mirror another module accept exactly what that module does', () => {
  const byName = (n) => allTools().TOOLS.find((t) => t.name === n);
  const enumOf = (tool, key) => [...byName(tool).parameters.properties[key].enum].sort();
  const writeModes = /const WRITE_MODES = new Set\(\[([^\]]*)\]\)/.exec(read('main/obsidian.js'));
  assert.ok(writeModes, 'obsidian.js has WRITE_MODES');
  assert.deepStrictEqual(enumOf('vault_write_note', 'mode'), [...writeModes[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(), 'the write modes obsidian.writeNote accepts');
  assert.deepStrictEqual(enumOf('connector_permission', 'level'), [...require('../main/connectors').LEVELS].sort(), 'connectors.LEVELS');
  assert.deepStrictEqual(enumOf('tasks_save', 'source'), Object.keys(require('../main/taskscore').SOURCES).sort(), 'taskscore.SOURCES');
  assert.deepStrictEqual(enumOf('brain_switch', 'brain'), [...require('../main/braincore').IDS].sort(), 'braincore.IDS');
  assert.deepStrictEqual(enumOf('tools_more', 'group'), Object.keys(require('../main/localcore').TOOLBOX).sort(), 'localcore.TOOLBOX');
  assert.deepStrictEqual(enumOf('setup_add_persona', 'template'), require('../main/personatemplates').TEMPLATES.map((t) => t.id).sort(), 'personatemplates');
});

// settings_update's VALUE_CHECKS and claudecode.cliValue against what Settings offers and what the defaults
// (store.js) hold: the agent may set what the user may pick, and it reaches the CLI.
test('every model and effort Settings offers, and every default, passes settings_update’s check and reaches the CLI', () => {
  const { settingValueError } = allTools();
  const { cliValue } = require('../main/claudecode');
  const src = read('renderer/js/settings.js');
  const pairs = (block) => [...block.matchAll(/\['([^']*)', '[^']*'\]/g)].map((m) => m[1]);
  const claudeModels = pairs(/const CLAUDE_MODELS = \[([\s\S]*?)\n\];/.exec(src)[1]);
  assert.ok(claudeModels.length >= 3);
  const offered = (p) => {
    const lists = [...src.matchAll(new RegExp(`select\\('${escapeRe(p)}', '[^']*', (CLAUDE_MODELS|\\[\\['', '[^']*'\\], \\.\\.\\.CLAUDE_MODELS\\]|\\[(?:\\['[^']*', '[^']*'\\](?:, )?)+\\])`, 'g'))];
    assert.ok(lists.length, `Settings offers no list for ${p}`);
    return [...new Set(lists.flatMap((m) => (m[1].includes('CLAUDE_MODELS') ? [...(m[1].startsWith('[') ? [''] : []), ...claudeModels] : pairs(m[1]))))];
  };
  const keys = ['claudeCode.model', 'claudeCode.effort', 'anthropic.model', 'anthropic.fastModel', 'anthropic.deepModel', 'anthropic.normalModel', 'anthropic.effort'];
  for (const p of keys) {
    const [section, key] = p.split('.');
    const values = [...offered(p), store.DEFAULTS[section][key]];
    for (const v of values) {
      assert.strictEqual(settingValueError(section, key, v), '', `Settings offers ${p} = "${v}", which settings_update refuses`);
      if (section === 'claudeCode' && v) assert.strictEqual(cliValue(/effort/i.test(key) ? 'effort' : 'model', v), v, `${p} = "${v}" is dropped from the CLI line`);
    }
  }
});

test('a stopped turn’s call doesn’t run; a malformed one is still told what is wrong', async () => {
  const ctl = new AbortController();
  ctl.abort();
  const ctx = { emit() {}, signal: ctl.signal, turn: approvals.newTurn({ signal: ctl.signal }) };
  const stopped = await allTools().execute('routine_run', { id: 'any' }, ctx);
  assert.strictEqual(stopped.ok, false);
  assert.match(stopped.result.error, /^Stopped by the user before this ran\./, 'the stop’s line, not the routine’s (which would say it isn’t running)');
  const wrong = await allTools().execute('vault_write_note', { path: 'Notes/a.md', content: 'x', mode: 'add' }, ctx);
  assert.match(wrong.result.error, /"mode" must be one of/, 'the argument check comes first');
});
