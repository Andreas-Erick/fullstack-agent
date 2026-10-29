// The agent can't give itself permissions it shouldn't have. settings_update may change only SETTABLE
// (main/tools.js), which must never hold safety, permissions, code or folder access, programs to run,
// remote access, secrets or the user-only sections; the addresses its brain and voice talk to (their
// API keys go there) ask every time, in auto mode too; during setup, what widens its access is
// confirmed in the app. Read statically, like test/helperapps.test.js, so nothing needs to run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, quietLog } = require('./helpers');

const tools = fs.readFileSync(path.join(ROOT, 'main/tools.js'), 'utf8');
const settable = () => {
  const block = /const SETTABLE = \{([\s\S]*?)\n\};/.exec(tools)[1];
  const out = {};
  for (const m of block.matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)) out[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  return out;
};

// Sections that are the user's alone: never in SETTABLE, not one key of them.
const USER_ONLY = ['safety', 'code', 'documents', 'remote', 'helperApps', 'extensions', 'privacy', 'agentWindow', 'perf', 'updates', 'github', 'web', 'screen', 'logging', 'personas', 'innerWorld'];
// Keys that run a program, reach another address with a key, or hold a secret.
const NEVER = ['cliPath', 'apiKey', 'remoteKey', 'remoteUrl', 'braveKey', 'tavilyKey', 'tunnelToken', 'connectors', 'connectorsAllowed', 'connectorsReadOnly', 'connectorsWrite', 'allowedRoots', 'cloudFallback', 'handOver'];

test('the agent can change none of the user-only sections or dangerous keys', () => {
  const s = settable();
  assert.ok(Object.keys(s).length > 5, 'SETTABLE was read');
  for (const section of USER_ONLY) assert.ok(!(section in s), `${section} must not be in SETTABLE`);
  for (const [section, keys] of Object.entries(s)) for (const k of keys) assert.ok(!NEVER.includes(k), `${section}.${k} must not be in SETTABLE`);
});

test('every secret field stays out of SETTABLE and out of the setup list', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/store.js'), 'utf8');
  const secrets = [...(/const SECRET_FIELDS = \[([\s\S]*?)\n\];/.exec(src)[1]).matchAll(/\['(\w+)', '(\w+)'\]/g)].map((m) => [m[1], m[2]]);
  assert.ok(secrets.length >= 10);
  const s = settable();
  const setup = /const SETUP_SETTABLE = \[([\s\S]*?)\];/.exec(tools)[1];
  for (const [section, key] of secrets) {
    assert.ok(!s[section]?.includes(key), `${section}.${key}`);
    assert.ok(!setup.includes(`'${section}.${key}'`), `${section}.${key} during setup`);
  }
});

test('the brain and voice addresses ask each time, also in auto mode and after a yes', async () => {
  assert.match(tools, /const ENDPOINTS = new Set\(\['llm\.baseUrl', 'voice\.baseUrl'\]\)/);
  // Every *.baseUrl the agent may change is an endpoint that asks.
  const urls = Object.entries(settable()).flatMap(([section, keys]) => keys.filter((k) => /url/i.test(k)).map((k) => `${section}.${k}`));
  for (const u of urls) assert.ok(new RegExp(`'${u.replace('.', '\\.')}'`).test(/const ENDPOINTS = new Set\(\[([^\]]*)\]\)/.exec(tools)[1]), `${u} must be in ENDPOINTS`);

  stub({ './logger': quietLog, './store': { getSettings: async () => ({ safety: { permissionMode: 'auto', taintGuard: true, approvalTimeoutSec: 5 } }) } });
  const approvals = load('main/approvals.js');
  const asked = [];
  approvals.setSender((channel, payload) => {
    if (channel !== 'approval:request') return;
    asked.push([payload.kind, payload.tainted]);
    setImmediate(() => approvals.respond(payload.id, true));
  });
  const turn = approvals.newTurn();
  await approvals.gate(turn, 'endpoint', 'Change llm.baseUrl');
  await approvals.gate(turn, 'endpoint', 'Change voice.baseUrl');
  assert.deepStrictEqual(asked, [['endpoint', false], ['endpoint', false]], 'asked twice in one turn, in auto mode');
  approvals.markTainted(turn, 'web page');
  await approvals.gate(turn, 'endpoint', 'Change llm.baseUrl');
  assert.deepStrictEqual(asked[2], ['endpoint', true], 'after reading the web the dialog says so');
  await approvals.gate(turn, 'permissions', 'Give the assistant more access');
  assert.strictEqual(asked[3][0], 'permissions');
});

test('during setup, widening access goes through the approval dialog', () => {
  assert.match(tools, /const widens = \(a\.setting === 'safety\.permissionMode' && value === 'auto'\) \|\| \(a\.setting === 'code\.allowSelfModify' && value === true\) \|\| \(\['documents\.workspace', 'obsidian\.vaultPath'\]\.includes\(a\.setting\)/, 'the workspace and the vault (both opened to the agent) ask');
  assert.match(tools, /if \(widens\) await requireApproval\(ctx, 'permissions'/);
});
