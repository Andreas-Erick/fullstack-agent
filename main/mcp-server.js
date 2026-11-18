// Minimal MCP server (stdio, JSON-RPC 2.0) that Claude Code launches for the "Claude account"
// provider. It exposes the app's tools by forwarding every call to the app's local tool bridge.
// Runs under Electron's bundled Node (ELECTRON_RUN_AS_NODE=1); no dependencies.
const http = require('http');
const readline = require('readline');

const BRIDGE = process.env.NEXUS_BRIDGE_URL;
const TOKEN = process.env.NEXUS_BRIDGE_TOKEN;
const TURN = process.env.NEXUS_TURN;
const SET = process.env.NEXUS_TOOLSET || ''; // core | more | '' (every tool): see claudecode.js

// A tool may run for minutes (a rehearsal, a clone, running a routine): fetch gave up after 300 s (undici's
// headers timeout) while the tool ran on. The bridge (always http://127.0.0.1:<port>, bridge.js) answers
// only when the tool is done, so the socket's idle limit is the tool's limit: above every tool's own.
// The connection closing after the answer began ends the call too (the response's own error and close:
// nothing else fires then, and with the socket gone the limit can't either).
const TOOL_LIMIT_MS = 20 * 60000;
function bridge(route, payload, { limitMs = TOOL_LIMIT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BRIDGE}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` } }, (res) => {
      let text = '';
      const cut = () => reject(new Error('The app closed the connection before the tool finished.'));
      res.setEncoding('utf8');
      res.on('error', cut);
      res.on('close', () => {
        if (!res.complete) cut();
      });
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = {};
        try {
          json = JSON.parse(text || '{}');
        } catch {
          return reject(new Error(`Bridge error ${res.statusCode}`));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(json.error || `Bridge error ${res.statusCode}`));
        resolve(json);
      });
    });
    req.setTimeout(limitMs, () => req.destroy(new Error(`The app’s tool didn’t finish in ${Math.round(limitMs / 60000)} minutes.`)));
    req.on('error', reject);
    req.end(JSON.stringify({ turn: TURN, ...payload }));
  });
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
        // The model called an everyday tool on this server after finding a related one here
        // (mcp__nexus_more__persona_switch): no such tool, a wasted round.
        ...(SET === 'more' ? { instructions: 'The app\'s less-used tools. The everyday ones (calendar, memory, notes, personas, documents, skills…) are on the server "nexus": call each tool on the server that lists it.' } : {}),
      };
    } else if (method === 'tools/list') {
      result = { tools: await bridge('/list', { set: SET }) };
    } else if (method === 'tools/call') {
      const r = await bridge('/call', { name: params?.name, args: params?.arguments || {} });
      const content = [{ type: 'text', text: r.text }];
      const img = String(r.image || '').match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
      if (img) content.push({ type: 'image', mimeType: img[1], data: img[2] });
      result = { content, isError: !r.ok };
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

// Only when Claude Code runs this file: a test that requires it never reads stdin or exits.
if (require.main === module) {
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
}

module.exports = { bridge, TOOL_LIMIT_MS };
