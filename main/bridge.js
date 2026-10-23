// Local tool bridge: a loopback HTTP endpoint (random port + secret token) through which the MCP
// server (spawned by Claude Code) calls the app's own tools — and answers Claude Code's permission
// prompts (approval_prompt), so approvals come from the user in the app.
const http = require('http');
const crypto = require('crypto');
const tools = require('./tools');

const APPROVAL_TOOL = {
  name: 'approval_prompt',
  description: 'Internal: permission decisions for Claude Code. Do not call this yourself.',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
};

const sessions = new Map(); // id -> { allowed: Set, getCtx, approve }
let server = null;
let info = null;

function start() {
  if (info) return Promise.resolve(info);
  const token = crypto.randomBytes(24).toString('hex');
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403).end();
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const msg = JSON.parse(body || '{}');
          const session = sessions.get(msg.turn);
          if (!session) throw new Error('This tool session has ended.');
          let out;
          if (req.url === '/list') {
            out = [...tools.TOOLS.filter((t) => session.allowed.has(t.name)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })), APPROVAL_TOOL];
          } else if (req.url === '/call' && msg.name === APPROVAL_TOOL.name) {
            const decision = await session.approve(msg.args || {});
            out = { ok: true, text: JSON.stringify(decision) };
          } else if (req.url === '/call') {
            if (!session.allowed.has(msg.name)) throw new Error(`Tool "${msg.name}" is not available`);
            const ctx = session.getCtx();
            if (!ctx) throw new Error('No active turn.');
            const r = await tools.execute(msg.name, msg.args || {}, ctx);
            out = { ok: r.ok, text: tools.stringifyResult(r.result) };
          } else throw new Error('Unknown route');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      info = { url: `http://127.0.0.1:${server.address().port}`, token };
      resolve(info);
    });
  });
}

function registerSession(id, { allowed, getCtx, approve }) {
  sessions.set(id, { allowed: new Set(allowed), getCtx, approve });
  return () => sessions.delete(id);
}

module.exports = { start, registerSession };
