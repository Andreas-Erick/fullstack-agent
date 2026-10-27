// Connectors (main/connectors.js, their use in main/claudecode.js): reading `claude mcp list`, the
// session flags, and that every connector call is approved by the user unless they always-allow it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, quietLog } = require('./helpers');

const gates = [];
let answer = true;
let remember; // the "Always allow…" choice the user picks in the dialog
let offered = []; // the choices the last dialog offered
let live = { claudeCode: {} }; // the settings approve() reads on every call
stub({
  './store': {
    getSettings: async () => live,
    setSettings: async (patch) => (live = { ...live, claudeCode: { ...live.claudeCode, ...patch.claudeCode } }),
  },
  './bridge': {},
  './github': {},
  './logger': quietLog,
  './approvals': {
    gate: async (turn, kind, title, detail, extra) => (gates.push({ kind, title }), (offered = (extra?.remember || []).map((c) => c.level)), answer ? { allow: true, ...(remember ? { remember } : {}) } : { allow: false, reason: 'no' }),
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

test('connectors on: tool search and skills; no connector is pre-allowed, levels never restart the session', () => {
  const s = spec({ connectors: true, connectorsAllowed: ['claude_ai_AccuWeather'] });
  assert.strictEqual(s.connectors, true);
  assert.ok(s.builtins.includes('ToolSearch') && s.builtins.includes('Skill'));
  assert.ok(!s.allowed.some((a) => a.startsWith('mcp__claude_ai')), 'every call reaches approve(), so taking a level back applies at once');
  assert.strictEqual(s.key, spec({ connectors: true, connectorsReadOnly: ['claude_ai_Todoist'] }).key, 'changing a level keeps the warm session');
  assert.notStrictEqual(s.key, spec({}).key, 'turning connectors on restarts the session');
});

test('"allow everything" is read live: on at once, and off at once', async () => {
  gates.length = 0;
  answer = false;
  const sess = session(true);
  live = { claudeCode: { connectorsAllowed: ['claude_ai_Todoist'] } };
  assert.strictEqual((await sess.approve({ tool_name: 'mcp__claude_ai_Todoist__delete-object', input: {} })).behavior, 'allow');
  assert.strictEqual(gates.length, 0);
  live = { claudeCode: {} };
  assert.strictEqual((await sess.approve({ tool_name: 'mcp__claude_ai_Todoist__delete-object', input: {} })).behavior, 'deny', 'revoked: asks (declined here)');
  assert.strictEqual(gates.length, 1);
  answer = true;
});

test('"Always allow…" in the dialog sets that service\'s level; it never grants more than offered', async () => {
  live = { claudeCode: {} };
  gates.length = 0;
  answer = true;
  remember = 'read';
  const t = 'mcp__claude_ai_Google_Calendar__list_events';
  assert.strictEqual((await session(true).approve({ tool_name: t, input: {} })).behavior, 'allow');
  assert.deepStrictEqual(offered, ['read', 'write'], 'a reading tool offers reading and all-but-deleting');
  assert.deepStrictEqual(live.claudeCode.connectorsReadOnly, ['claude_ai_Google_Calendar']);
  assert.strictEqual((await session(true).approve({ tool_name: t, input: {} })).behavior, 'allow');
  assert.strictEqual(gates.length, 1, 'the next turn does not ask');
  // A delete offers nothing to remember; a forged "all" is ignored.
  remember = 'all';
  await session(true).approve({ tool_name: 'mcp__claude_ai_Google_Calendar__delete_event', input: {} });
  assert.deepStrictEqual(offered, []);
  assert.deepStrictEqual(live.claudeCode.connectorsAllowed || [], []);
  assert.strictEqual(connectors.levelOf(live.claudeCode, 'claude_ai_Google_Calendar'), 'read');
  remember = undefined;
  live = { claudeCode: {} };
});

test('levels: one list per server, matched by name', () => {
  const cc = { connectorsReadOnly: ['claude_ai_Plaud'], connectorsAllowed: ['claude.ai Todoist'] };
  assert.strictEqual(connectors.levelOf(cc, 'claude_ai_Todoist'), 'all');
  assert.strictEqual(connectors.levelOf(cc, 'claude_ai_Canva'), 'ask');
  const p = connectors.levelPatch(cc, 'claude_ai_Plaud', 'write');
  assert.deepStrictEqual(p, { connectorsAllowed: ['claude_ai_Todoist'], connectorsWrite: ['claude_ai_Plaud'], connectorsReadOnly: [] });
  assert.deepStrictEqual(connectors.levelPatch(cc, 'claude_ai_Todoist', 'ask').connectorsAllowed, []);
  const list = connectors.parseMcpList(`${MCP_LIST}\nclaude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ✔ Connected\nplugin:productivity:google calendar:  (HTTP) - - Not configured`);
  assert.deepStrictEqual(connectors.findServers(list, 'google calendar').map((c) => c.key), ['claude_ai_Google_Calendar', 'plugin_productivity_google_calendar'], 'the connected connector first');
  assert.deepStrictEqual(connectors.findServers(list, 'Calendar').map((c) => c.key)[0], 'claude_ai_Google_Calendar');
  assert.deepStrictEqual(connectors.findServers(list, 'gmail').map((c) => c.key), ['plugin_productivity_gmail']);
  assert.deepStrictEqual(connectors.findServers(list, ''), []);
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

test('"allow reading": reading tools run without asking, writing tools still ask', async () => {
  assert.ok(connectors.isReadOnly('mcp__claude_ai_Google_Calendar__list_events'));
  assert.ok(connectors.isReadOnly('mcp__claude_ai_Plaud__get_transcript'));
  assert.ok(!connectors.isReadOnly('mcp__claude_ai_Google_Calendar__create_event'));
  assert.ok(!connectors.isReadOnly('mcp__shop__checkout'), 'a word that only starts like a reading verb');
  gates.length = 0;
  answer = false;
  const sess = session(true);
  live = { claudeCode: { connectorsReadOnly: ['claude.ai Google Calendar'] } };
  assert.strictEqual((await sess.approve({ tool_name: 'mcp__claude_ai_Google_Calendar__list_events', input: {} })).behavior, 'allow');
  assert.strictEqual(gates.length, 0, 'no question for a read');
  assert.strictEqual((await sess.approve({ tool_name: 'mcp__claude_ai_Google_Calendar__delete_event', input: { id: 'x' } })).behavior, 'deny');
  assert.strictEqual(gates.length, 1, 'a write asks (and was declined here)');
  assert.strictEqual((await sess.approve({ tool_name: 'mcp__claude_ai_Todoist__find-tasks', input: {} })).behavior, 'deny', 'only the services set to allow reading');
  assert.strictEqual((await session(false).approve({ tool_name: 'mcp__claude_ai_Google_Calendar__list_events', input: {} })).behavior, 'deny', 'nothing while connectors are off');
  answer = true;
  live = { claudeCode: {} };
});

test('"allow all but deleting": writes run, deleting still asks', async () => {
  for (const t of ['mcp__claude_ai_Todoist__delete-object', 'mcp__x__remove_member', 'mcp__x__archive-project', 'mcp__claude_ai_Todoist__project-management']) assert.ok(connectors.isDestructive(t), t);
  for (const t of ['mcp__claude_ai_Todoist__add-tasks', 'mcp__claude_ai_Todoist__complete-tasks', 'mcp__claude_ai_Todoist__update-tasks', 'mcp__x__clearance_report']) assert.ok(!connectors.isDestructive(t), t);
  gates.length = 0;
  answer = false;
  const sess = session(true);
  live = { claudeCode: { connectorsWrite: ['claude.ai Todoist'] } };
  assert.strictEqual((await sess.approve({ tool_name: 'mcp__claude_ai_Todoist__add-tasks', input: {} })).behavior, 'allow');
  assert.strictEqual((await sess.approve({ tool_name: 'mcp__claude_ai_Todoist__complete-tasks', input: {} })).behavior, 'allow');
  assert.strictEqual(gates.length, 0);
  assert.strictEqual((await sess.approve({ tool_name: 'mcp__claude_ai_Todoist__delete-object', input: { id: '1' } })).behavior, 'deny', 'asked and declined');
  assert.strictEqual(gates.length, 1);
  answer = true;
  live = { claudeCode: {} };
});

test('extensions reach the session with connectors off, through the permission levels', async () => {
  const s = claudecode.sessionSpec({ settings: { ...settings({ connectorsReadOnly: ['rea', 'claude_ai_Todoist'] }), extensions: { rea: true } }, configKey: 'k', activeTools: [], cwd: '/app', vault: '', repos: '', model: 'default' });
  assert.ok(s.extensions.rea, 'the rea server is in the session');
  assert.ok(s.builtins.includes('ToolSearch'), 'tool search for its many tools');
  gates.length = 0;
  answer = true;
  live = { claudeCode: { connectorsReadOnly: ['rea', 'claude_ai_Todoist'] } };
  const sess = session(false);
  sess.spec.extensions = s.extensions;
  assert.strictEqual((await sess.approve({ tool_name: 'mcp__rea__list_findings', input: {} })).behavior, 'allow', 'the extension\'s level applies');
  assert.strictEqual(gates.length, 0);
  assert.strictEqual((await sess.approve({ tool_name: 'mcp__rea__analyze_javascript_application', input: { path: '/x' } })).behavior, 'allow');
  assert.strictEqual(gates.length, 1, 'not a reading verb: it asked');
  assert.strictEqual((await sess.approve({ tool_name: 'mcp__claude_ai_Todoist__find-tasks', input: {} })).behavior, 'deny', 'connectors stay off, whatever their level');
  live = { claudeCode: {} };
});
