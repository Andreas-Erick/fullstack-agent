// Remote access server (main/companion.js): pairing by code and QR secret, what devices may see,
// device expiry and removal, security headers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

const dir = tmpDir('nexus-companion-');
const convs = {
  c1: { id: 'c1', title: 'Normal', updatedAt: 2, messages: [{ id: 'm1', role: 'user', content: 'EXPANDED SKILL STEPS', display: '/skill hi' }, { id: 'm2', role: 'assistant', content: 'reply', raw: { secret: 1 }, toolCalls: [{ name: 'read_file', input: { path: 'C:/secret.txt' }, ok: true, preview: 'SECRET CONTENTS' }] }] },
  s1: { id: 's1', title: 'Setup', setup: true, updatedAt: 3, messages: [] },
};
stub({
  './store': fileStore(dir, {
    getSettings: async () => ({ agent: { name: 'Nexus' }, appearance: {}, voice: {} }),
    listConversations: async () => Object.values(convs).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, ...(c.setup ? { setup: true } : {}) })),
    getConversation: async (id) => convs[id] || null,
  }),
  './voice': {},
  './logger': quietLog,
  './tunnel': { apply: async () => {}, stop() {}, status: () => ({ mode: 'off' }), publicHost: () => '' },
});
const companion = load('main/companion.js');
let base = '';
const devicesFile = path.join(dir, 'remote-devices.json');
const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function pairDevice(name = 'Phone') {
  const p = companion.startPairing();
  const r = await post('/api/pair', { code: p.code, name });
  return (await r.json()).token;
}

// A port that is free right now (never a fixed one: a busy port must not fail the suite).
function freePort() {
  return new Promise((resolve) => {
    const s = require('net').createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test.before(async () => {
  companion.init({ startTurn: async () => ({ conversationId: 'c1' }), abortTurn() {}, respondApproval: () => true, transcribe: async () => '', notify() {} });
  const port = await freePort();
  await companion.apply({ remote: { enabled: true, lan: true, port } });
  base = `http://127.0.0.1:${port}`;
});
test.after(async () => {
  await companion.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pairing code: wrong and malformed codes are refused and counted', async () => {
  companion.startPairing();
  let r = await post('/api/pair', { code: 'é0000' });
  assert.strictEqual(r.status, 403);
  assert.ok(r.headers.get('permissions-policy').includes('camera=()'));
  assert.strictEqual(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.strictEqual(r.headers.get('strict-transport-security'), null, 'no HSTS on plain http');
  for (let i = 0; i < 4; i++) await post('/api/pair', { code: 'abcdef' }); // malformed: a wrong try that can't match by chance
  r = await post('/api/pair', { code: '123456' });
  assert.strictEqual(r.status, 403);
  assert.match((await r.json()).error, /No pairing in progress/, 'five wrong tries end the pairing');
});

test('QR pairing: one-time secret, reachable address only', async () => {
  const p = companion.startPairing();
  assert.ok(p.links.length && p.links.every((l) => !/127\.0\.0\.1|localhost/.test(l.url)));
  const secret = p.links[0].link.split('#pair=')[1];
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.strictEqual((await post('/api/pair', { secret: 'x'.repeat(43) })).status, 403);
  const r = await post('/api/pair', { secret, name: 'QR phone' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await post('/api/pair', { secret })).status, 403, 'works once');
});

test('devices never see setup, tool inputs/results or raw provider data', async () => {
  const auth = { Authorization: `Bearer ${await pairDevice()}` };
  const list = await (await fetch(`${base}/api/conversations`, { headers: auth })).json();
  assert.deepStrictEqual(list.map((c) => c.id), ['c1']);
  assert.strictEqual((await fetch(`${base}/api/conversations/s1`, { headers: auth })).status, 404);
  const body = await (await fetch(`${base}/api/conversations/c1`, { headers: auth })).text();
  assert.ok(!/secret|SECRET/.test(body), body);
  assert.ok(body.includes('/skill hi') && !body.includes('EXPANDED'));

  const ctl = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: auth, signal: ctl.signal });
  const reader = res.body.getReader();
  let streamed = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        streamed += Buffer.from(value).toString();
      }
    } catch {
      /* aborted */
    }
  })();
  companion.publish('chat:event', { requestId: 'r1', conversationId: 'c1', type: 'tool_start', id: 't1', name: 'run_command', input: { command: 'type passwords.txt' } });
  companion.publish('chat:event', { requestId: 'r1', conversationId: 'c1', type: 'tool_end', id: 't1', name: 'run_command', ok: true, preview: 'hunter2' });
  companion.publish('chat:event', { requestId: 'r1', conversationId: 'c1', type: 'settings_changed' });
  companion.publish('approval:request', { id: 'a1', kind: 'command', title: 'Run', tainted: true, sources: ['web_fetch https://x'], timeoutSec: 75 });
  await new Promise((r) => setTimeout(r, 200));
  ctl.abort();
  await pump;
  assert.ok(streamed.includes('"name":"run_command"'));
  assert.ok(!/passwords|hunter2|settings_changed/.test(streamed), streamed);
  assert.match(streamed, /"expiresIn":7[45]/);
});

test('idle devices expire; a corrupt entry does not break the rest; remove all', async () => {
  const token = await pairDevice('Old phone');
  const list = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
  list.find((d) => d.name === 'Old phone').lastSeen = Date.now() - 91 * 24 * 3600000;
  list.push({ id: 'bad', name: 'Corrupt', tokenHash: 'zz' });
  fs.writeFileSync(devicesFile, JSON.stringify(list));
  assert.strictEqual((await fetch(`${base}/api/info`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.ok(!JSON.parse(fs.readFileSync(devicesFile, 'utf8')).some((d) => d.name === 'Old phone'));

  const fresh = await pairDevice('Fresh');
  assert.strictEqual((await fetch(`${base}/api/info`, { headers: { Authorization: `Bearer ${fresh}` } })).status, 200);
  const dev = (await companion.status()).devices.find((d) => d.name === 'Fresh');
  assert.strictEqual(dev.lastVia, 'this computer');
  await companion.revokeAll();
  assert.strictEqual((await fetch(`${base}/api/info`, { headers: { Authorization: `Bearer ${fresh}` } })).status, 401);
});
