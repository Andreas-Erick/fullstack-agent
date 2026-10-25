// Connectors (main/connectors.js, their use in main/claudecode.js): reading `claude mcp list`, the
// session flags, and that every connector call is approved by the user unless they always-allow it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, quietLog } = require('./helpers');

const gates = [];
let answer = true;
stub({
  './store': { getSettings: async () => ({}) },
  './bridge': {},
  './github': {},
  './logger': quietLog,
  './approvals': {
    gate: async (turn, kind, title) => (gates.push({ kind, title }), answer ? { allow: true } : { allow: false, reason: 'no' }),
    markTainted: (turn, source) => turn && ((turn.tainted = true), turn.taintSources.push(source)),
  },
});
const connectors = load('main/connectors.js');
const claudecode = load('main/claudecode.js');

const MCP_LIST = `Checking MCP server health…

claude.ai Todoist: https://ai.todoist.net/mcp - ✔ Connected
claude.ai AccuWeather®: https://mcp.accuweather.com/v0/mcp/claude - ✔ Connected
claude.ai Canvs.io: https://app.canvs.io/mcp - ✘ Failed to connect — HTTP 405: Error POSTing to endpoint
claude.ai Hugging Face: https://huggingface.co/mcp - ! Needs authentication
plugin:productivity:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication
plugin:productivity:gmail:  (HTTP) - - Not configured
my-db: node C:/servers/db.js - ✔ Connected
nexus: node mcp-server.js - ✔ Connected`;

test('reads claude mcp list', () => {
  const list = connectors.parseMcpList(MCP_LIST);
  assert.deepStrictEqual(
    list.map((c) => [c.key, c.source, c.status]),
    [
      ['claude_ai_Todoist', 'connector', 'connected'],
      ['claude_ai_AccuWeather', 'connector', 'connected'],
      ['claude_ai_Canvs_io', 'connector', 'failed'],
      ['claude_ai_Hugging_Face', 'connector', 'needs-auth'],
      ['plugin_productivity_slack', 'plugin', 'needs-auth'],
      ['plugin_productivity_gmail', 'plugin', 'not-configured'],
      ['my-db', 'local', 'connected'],
    ],
    'the app\'s own server is left out',
  );
});

test('server keys match Claude Code tool names', () => {
  assert.strictEqual(connectors.serverKey('claude.ai Have I Been Pwned'), 'claude_ai_Have_I_Been_Pwned');
  assert.strictEqual(connectors.serverKey('claude.ai Three.js 3D Viewer'), 'claude_ai_Three_js_3D_Viewer');
  assert.strictEqual(connectors.serverKey('claude.ai Kahoot!'), 'claude_ai_Kahoot');
  assert.strictEqual(connectors.toolServer('mcp__claude_ai_Todoist__find-tasks'), 'claude_ai_Todoist');
  assert.ok(connectors.isConnectorTool('mcp__plugin_productivity_slack__send_message'));
  assert.ok(!connectors.isConnectorTool('mcp__nexus__memory_save'));
  assert.ok(!connectors.isConnectorTool('WebFetch'));
  assert.deepStrictEqual(connectors.describeTool('mcp__claude_ai_Todoist__find-tasks'), { service: 'Todoist', action: 'find tasks' });
  assert.deepStrictEqual(connectors.allowedKeys(['claude_ai_Todoist', 'nexus', '', 'claude_ai_Todoist']), ['claude_ai_Todoist'], 'the own server can never be always-allowed');
});

const settings = (claudeCode) => ({ claudeCode: { effort: 'default', idleMinutes: 20, ...claudeCode }, web: { enabled: true }, code: { allowSelfModify: false } });
const spec = (claudeCode) => claudecode.sessionSpec({ settings: settings(claudeCode), configKey: 'k', activeTools: [], cwd: '/app', vault: '', repos: '', model: 'default' });

test('connectors off: nothing changes', () => {
  const s = spec({});
  assert.strictEqual(s.connectors, false);
  assert.ok(!s.builtins.includes('ToolSearch'));
  assert.ok(!s.allowed.some((a) => a.startsWith('mcp__claude_ai')));
});

test('connectors on: tool search and skills, always-allowed connectors skip the prompt', () => {
  const s = spec({ connectors: true, connectorsAllowed: ['claude_ai_AccuWeather'] });
  assert.strictEqual(s.connectors, true);
  assert.ok(s.builtins.includes('ToolSearch') && s.builtins.includes('Skill'));
  assert.ok(s.allowed.includes('mcp__claude_ai_AccuWeather'));
  assert.ok(!s.allowed.includes('mcp__claude_ai_Todoist'));
  assert.notStrictEqual(s.key, spec({}).key, 'turning connectors on restarts the session');
});

function session(on) {
  const sess = new claudecode.Session('conv1');
  sess.spec = { connectors: on, codeRoot: '/app' };
  sess.turn = { ctx: { turn: { tainted: false, taintSources: [], approved: new Set() } } };
  return sess;
}

test('a connector call asks the user, once per service and turn', async () => {
  gates.length = 0;
  answer = true;
  const sess = session(true);
  const a = await sess.approve({ tool_name: 'mcp__claude_ai_Todoist__add-tasks', input: { content: 'Buy milk' } });
  assert.strictEqual(a.behavior, 'allow');
  assert.deepStrictEqual(gates, [{ kind: 'connector', title: 'Use Todoist: add tasks' }]);
  await sess.approve({ tool_name: 'mcp__claude_ai_Todoist__find-tasks', input: {} });
  assert.strictEqual(gates.length, 1, 'the same service is covered for the turn');
  await sess.approve({ tool_name: 'mcp__claude_ai_Canva__create-design', input: {} });
  assert.strictEqual(gates.length, 2, 'another service asks again');
});

test('a declined or disabled connector call is denied', async () => {
  answer = false;
  assert.strictEqual((await session(true).approve({ tool_name: 'mcp__plugin_productivity_slack__send_message', input: {} })).behavior, 'deny');
  gates.length = 0;
  assert.strictEqual((await session(false).approve({ tool_name: 'mcp__claude_ai_Todoist__add-tasks', input: {} })).behavior, 'deny');
  assert.strictEqual(gates.length, 0, 'with connectors off it is denied without asking');
  answer = true;
});

test('the agent can never turn connectors on or always-allow one; off by default', () => {
  const tools = fs.readFileSync(path.join(ROOT, 'main', 'tools.js'), 'utf8');
  const settable = /const SETTABLE = \{([\s\S]*?)\n\};/.exec(tools)[1];
  assert.ok(!/connector/i.test(settable), 'no connector setting in SETTABLE');
  const storeSrc = fs.readFileSync(path.join(ROOT, 'main', 'store.js'), 'utf8');
  assert.match(storeSrc, /\n\s+connectors: false,/);
});

test('the summary the agent gets names services by state, once each', () => {
  const list = connectors.parseMcpList(`${MCP_LIST}\nplugin:engineering:gmail:  (HTTP) - - Not configured`);
  assert.deepStrictEqual(connectors.byStatus(list), {
    connected: ['Todoist', 'AccuWeather®', 'my-db'],
    needSignIn: ['Hugging Face', 'slack'],
    failing: ['Canvs.io'],
    notSetUp: ['gmail'],
  });
});
