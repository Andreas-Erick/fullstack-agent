// The local tool bridge (main/bridge.js) behind the app's MCP server: with tools on request one session
// is served by two servers, "core" (always loaded, with the approval prompt) and "more" (found with
// ToolSearch); together they list every allowed tool once.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load } = require('./helpers');

const tool = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } });
stub({ './tools': { TOOLS: ['calendar_get_events', 'memory_search', 'vocab_review', 'github_push', 'secret_tool'].map(tool), execute: async () => ({ ok: true, result: 'done' }), stringifyResult: (r) => String(r) } });
const bridge = load('main/bridge.js');

async function list(info, turn, set) {
  const res = await fetch(`${info.url}/list`, { method: 'POST', headers: { Authorization: `Bearer ${info.token}` }, body: JSON.stringify({ turn, set }) });
  return (await res.json()).map((t) => t.name);
}

test('core and more split the allowed tools; only core carries the approval prompt', async () => {
  const info = await bridge.start();
  const end = bridge.registerSession('t1', { allowed: ['calendar_get_events', 'memory_search', 'vocab_review', 'github_push'], core: ['calendar_get_events', 'memory_search'], getCtx: () => null, approve: async () => ({}) });
  assert.deepStrictEqual(await list(info, 't1', 'core'), ['calendar_get_events', 'memory_search', 'approval_prompt']);
  assert.deepStrictEqual(await list(info, 't1', 'more'), ['vocab_review', 'github_push'], 'the rest, never a tool the session was not given');
  assert.deepStrictEqual(await list(info, 't1', ''), ['calendar_get_events', 'memory_search', 'vocab_review', 'github_push', 'approval_prompt']);
  end();
  const single = bridge.registerSession('t2', { allowed: ['vocab_review'], getCtx: () => null, approve: async () => ({}) });
  assert.deepStrictEqual(await list(info, 't2', 'core'), ['vocab_review', 'approval_prompt'], 'one server: everything');
  single();
  bridge.stop();
});

// Regression (round 3): mcp-server.js called the bridge with fetch, whose headers timeout (300 s) ended a
// tool that ran longer (a rehearsal, a clone, running a routine): "fetch failed" to Claude while the tool
// kept running in the app. Now one explicit limit, above every tool's own.
test('the MCP server waits for a long tool, keeps answers apart, and gives up only at its own limit', async () => {
  const http = require('http');
  const seen = [];
  const held = [];
  let firstArrived;
  let answerFirst = null;
  const firstSeen = new Promise((r) => (firstArrived = r));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, url: req.url, payload });
      const reply = (status, text, type = 'application/json') => (res.writeHead(status, { 'Content-Type': type }), res.end(text));
      if (payload.name === 'ok') return reply(200, JSON.stringify({ ok: true, text: 'done' }));
      if (payload.name === 'refused') return reply(400, JSON.stringify({ error: 'x' }));
      if (payload.name === 'proxy') return reply(502, '<html>Bad gateway</html>', 'text/html');
      if (payload.name === 'empty') return reply(500, '');
      if (payload.name === 'never') return held.push(res); // a tool that never finishes
      if (payload.name === 'first') return firstArrived(() => reply(200, JSON.stringify({ ok: true, text: 'first' })));
      // The second is answered once the first is in flight too; the first waits until the test says so.
      if (payload.name === 'second') return firstSeen.then((fn) => ((answerFirst = fn), reply(200, JSON.stringify({ ok: true, text: 'second' }))));
      reply(404, JSON.stringify({ error: 'unknown' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.NEXUS_BRIDGE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.NEXUS_BRIDGE_TOKEN = 'tok-123';
  process.env.NEXUS_TURN = 'turn-9';
  try {
    const mcp = load('main/mcp-server.js'); // reads the variables when loaded; never touches stdin here
    assert.ok(mcp.TOOL_LIMIT_MS >= 15 * 60000, 'above a routine run’s own 15 minutes');
    assert.deepStrictEqual(await mcp.bridge('/call', { name: 'ok', args: {} }), { ok: true, text: 'done' });
    assert.strictEqual(seen[0].auth, 'Bearer tok-123');
    assert.strictEqual(seen[0].url, '/call');
    assert.deepStrictEqual(seen[0].payload, { turn: 'turn-9', name: 'ok', args: {} });
    await assert.rejects(mcp.bridge('/call', { name: 'refused' }), /^Error: x$/);
    await assert.rejects(mcp.bridge('/call', { name: 'proxy' }), /Bridge error 502/);
    await assert.rejects(mcp.bridge('/call', { name: 'empty' }), /Bridge error 500/);
    // Two calls at once, answered in reverse order: each gets its own answer.
    const first = mcp.bridge('/call', { name: 'first' });
    assert.strictEqual((await mcp.bridge('/call', { name: 'second' })).text, 'second');
    answerFirst();
    assert.strictEqual((await first).text, 'first');
    await assert.rejects(mcp.bridge('/call', { name: 'never' }, { limitMs: 50 }), /didn’t finish/);
  } finally {
    for (const k of ['NEXUS_BRIDGE_URL', 'NEXUS_BRIDGE_TOKEN', 'NEXUS_TURN']) delete process.env[k];
    server.closeAllConnections();
    server.close();
  }
});

// Regression (round 3 review): the app's side closing the connection after the answer began (headers and
// part of the body sent) left the call waiting forever: nothing listened for the response's own error, and
// with the socket gone the limit could not fire either. The test's timeout (and the unref'd server) make a
// hang a failure instead of a test file that never ends.
test('the MCP server gives up at once when the app closes the call half-way', { timeout: 15000 }, async () => {
  const http = require('http');
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      // Headers and the start of the body reach the MCP server, then the connection ends.
      res.write('{"ok":tr', () => res.socket.destroy());
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  process.env.NEXUS_BRIDGE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.NEXUS_BRIDGE_TOKEN = 'tok-123';
  process.env.NEXUS_TURN = 'turn-9';
  try {
    const mcp = load('main/mcp-server.js');
    for (let i = 0; i < 3; i++) await assert.rejects(mcp.bridge('/call', { name: 'cut' }, { limitMs: 60000 }), /closed the connection before the tool finished/, `call ${i}`);
  } finally {
    for (const k of ['NEXUS_BRIDGE_URL', 'NEXUS_BRIDGE_TOKEN', 'NEXUS_TURN']) delete process.env[k];
    server.closeAllConnections();
    server.close();
  }
});
