// Extensions (main/extensions.js): which MCP servers a Claude Code session gets, what counts as a God's
// Eye View checkout and a globe link, and that the agent can never switch extensions on itself.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, tmpDir, quietLog } = require('./helpers');

stub({ './logger': quietLog });
const ext = load('main/extensions.js');
const dir = tmpDir('nexus-ext-');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function checkout(name, { mcp = true, modules = true, pkgName = 'gods-eye-view' } = {}) {
  const d = path.join(dir, name);
  fs.mkdirSync(path.join(d, 'server', 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: pkgName }));
  if (mcp) fs.writeFileSync(path.join(d, 'server', 'mcp', 'stdio.js'), '');
  else fs.rmSync(path.join(d, 'server'), { recursive: true });
  if (modules) fs.mkdirSync(path.join(d, 'node_modules'), { recursive: true });
  return d;
}

test("a God's Eye View folder must be a real, installed checkout", () => {
  assert.strictEqual(ext.checkGodsEye(checkout('ok')).ok, true);
  assert.match(ext.checkGodsEye('').reason, /No folder/);
  assert.match(ext.checkGodsEye(path.join(dir, 'missing')).reason, /package\.json/);
  assert.match(ext.checkGodsEye(checkout('other', { mcp: false, pkgName: 'something-else' })).reason, /isn't a God's Eye View checkout/);
  const fresh = ext.checkGodsEye(checkout('fresh', { modules: false }));
  assert.strictEqual(fresh.needsInstall, true);
});

test('a session gets only the extensions that are on and usable, with fixed commands', () => {
  assert.deepStrictEqual(ext.mcpServers({}), {});
  const rea = ext.mcpServers({ extensions: { rea: true } }).rea;
  assert.ok(rea.args.includes(`rea-agents@${ext.REA_VERSION}`) && rea.args.includes('mcp'), 'pinned release');
  const good = checkout('good');
  const globe = ext.mcpServers({ extensions: { godseye: true, godseyePath: good } })['gods-eye-view'];
  assert.deepStrictEqual(globe.args, [path.join(good, 'server', 'mcp', 'stdio.js'), '--api-base', 'http://localhost:4173']);
  assert.strictEqual(globe.env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepStrictEqual(ext.mcpServers({ extensions: { godseye: true, godseyePath: path.join(dir, 'nope') } }), {}, 'not without a checkout');
});

test('only local God\'s Eye View links open in the globe window', () => {
  assert.ok(ext.isGlobeUrl('http://localhost:4173/?lat=64.1&lon=-21.9'));
  assert.ok(ext.isGlobeUrl('http://127.0.0.1:4173/'));
  for (const bad of ['https://localhost:4173/', 'http://localhost:4174/', 'http://evil.example:4173/', 'file:///C:/x.html', 'javascript:alert(1)', 'not a url']) assert.ok(!ext.isGlobeUrl(bad), bad);
});

test('a globe server listening on IPv6 localhost only ([::1], Vite on Windows) counts as running', async (t) => {
  const net = require('net');
  const srv = net.createServer((s) => s.end());
  try {
    await new Promise((resolve, reject) => srv.once('error', reject).listen(0, '::1', resolve));
  } catch {
    return t.skip('no IPv6 loopback here');
  }
  const { port } = srv.address();
  try {
    assert.strictEqual(await ext.up(port), true);
  } finally {
    srv.close();
  }
  assert.strictEqual(await ext.up(port), false);
});

test('the agent can never switch extensions on or point them elsewhere', () => {
  const tools = fs.readFileSync(path.join(ROOT, 'main', 'tools.js'), 'utf8');
  const settable = /const SETTABLE = \{([\s\S]*?)\n\};/.exec(tools)[1];
  assert.ok(!/extensions|godseye|rea:/i.test(settable));
  assert.ok(!/SETUP_SETTABLE = \[[^\]]*extensions/.test(tools), 'not during setup either');
});
