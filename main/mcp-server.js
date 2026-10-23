// Minimal MCP server (stdio, JSON-RPC 2.0) that Claude Code launches for the "Claude account"
// provider. It exposes the app's tools by forwarding every call to the app's local tool bridge.
// Runs under Electron's bundled Node (ELECTRON_RUN_AS_NODE=1); no dependencies.
const readline = require('readline');

const BRIDGE = process.env.NEXUS_BRIDGE_URL;
const TOKEN = process.env.NEXUS_BRIDGE_TOKEN;
const TURN = process.env.NEXUS_TURN;

async function bridge(route, payload) {
  const res = await fetch(`${BRIDGE}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ turn: TURN, ...payload }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Bridge error ${res.status}`);
  return json;
}

function send(msg) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  try {
    let result;
    if (method === 'initialize') {
      result = {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'nexus', version: '1.0.0' },
      };
    } else if (method === 'tools/list') {
      result = { tools: await bridge('/list', {}) };
    } else if (method === 'tools/call') {
      const r = await bridge('/call', { name: params?.name, args: params?.arguments || {} });
      result = { content: [{ type: 'text', text: r.text }], isError: !r.ok };
    } else if (method === 'ping') {
      result = {};
    } else {
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    send({ id, result });
  } catch (err) {
    if (method === 'tools/call') send({ id, result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true } });
    else send({ id, error: { code: -32603, message: err.message } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch {
    /* ignore malformed input */
  }
});
rl.on('close', () => process.exit(0));
