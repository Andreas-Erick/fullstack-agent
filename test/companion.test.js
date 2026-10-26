// Remote access server (main/companion.js): pairing by code and QR secret, what devices may see,
// device expiry and removal, security headers, moving to the secure address, the schedule.
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
// The tunnel as tests set it: off, or a connected Tailscale address.
let tunnelState = { mode: 'off' };
const calls = [];
let share = true; // remote.shareData
const habitLogs = [];
stub({
  './store': fileStore(dir, {
    getSettings: async () => ({ agent: { name: 'Nexus' }, appearance: {}, voice: {}, calendar: { enabled: true }, remote: { shareData: share } }),
    listConversations: async () => Object.values(convs).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, ...(c.setup ? { setup: true } : {}) })),
    getConversation: async (id) => convs[id] || null,
  }),
  './voice': {},
  './companiondata': {
    today: async () => ({ date: '2026-10-26', events: [], habits: [] }),
    habits: async () => ({ habits: [{ name: 'Run', doneToday: false }] }),
    logHabit: async (name, done) => (habitLogs.push([name, done]), { habits: [{ name, doneToday: done !== false }] }),
    note: async (p) => ({ path: p, title: 'X', content: '# X' }),
  },
  './logger': quietLog,
  './tunnel': { apply: async () => {}, stop() {}, status: () => tunnelState, publicHost: () => tunnelState.host || '' },
  './calendar': {
    events: async (range) => {
      calls.push(range);
      return [{ id: 'r1@2026-10-26', entryId: 'r1', title: 'Lecture', location: 'H1', notes: '', allDay: false, start: '2026-10-26T10:00:00', end: '2026-10-26T11:30:00', openEnd: false, recurring: true, rule: 'Every Monday', internal: 'x' }];
    },
  },
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

test('the phone gets the desktop face and its modules', async () => {
  const auth = { Authorization: `Bearer ${await pairDevice()}` };
  const info = await (await fetch(`${base}/api/info`, { headers: auth })).json();
  assert.strictEqual(info.face.id, 'siren', 'the default face (Siren) when none is set');
  assert.ok('sleepAfterMin' in info);
  const r = await fetch(`${base}/js/faces/common.js`);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.notStrictEqual((await fetch(`${base}/js/faces/host.js`)).status, 200, 'the desktop-only host is not served');
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

// A request with a chosen Host header (fetch can't set one): how requests arrive through the tunnel.
function viaHost(host, p, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = require('http').request(`${base}${p}`, { method, headers: { Host: host, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(text || '{}') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('moving to the secure address: one-time, only through the tunnel, rotates the token', async () => {
  const old = await pairDevice('LAN phone');
  const auth = { Authorization: `Bearer ${old}` };
  let r = await post('/api/move', {}, auth);
  assert.strictEqual(r.status, 409, 'no secure address yet');
  assert.strictEqual((await (await fetch(`${base}/api/info`, { headers: auth })).json()).secureUrl, '');

  tunnelState = { mode: 'tailscale', connected: true, host: 'pc.tail1234.ts.net', url: 'https://pc.tail1234.ts.net' };
  try {
    assert.strictEqual((await (await fetch(`${base}/api/info`, { headers: auth })).json()).secureUrl, 'https://pc.tail1234.ts.net');
    assert.strictEqual((await post('/api/move', {})).status, 401, 'needs a paired device');
    const move = await (await post('/api/move', {}, auth)).json();
    assert.strictEqual(move.url, 'https://pc.tail1234.ts.net');
    assert.match(move.secret, /^[A-Za-z0-9_-]{43}$/);

    assert.strictEqual((await post('/api/pair', { move: move.secret })).status, 403, 'not over the plain local address');
    const tunnelOrigin = { Origin: 'https://pc.tail1234.ts.net' };
    // Asking again replaces the first secret; this one is redeemed through the tunnel.
    const again = await (await post('/api/move', {}, auth)).json();
    assert.strictEqual((await viaHost('pc.tail1234.ts.net', '/api/pair', { method: 'POST', body: { move: 'y'.repeat(43) }, headers: tunnelOrigin })).status, 403);
    r = await viaHost('pc.tail1234.ts.net', '/api/pair', { method: 'POST', body: { move: again.secret }, headers: tunnelOrigin });
    assert.strictEqual(r.status, 200);
    const moved = r.json();
    assert.strictEqual(moved.name, 'LAN phone');
    assert.strictEqual((await viaHost('pc.tail1234.ts.net', '/api/pair', { method: 'POST', body: { move: again.secret }, headers: tunnelOrigin })).status, 403, 'works once');

    assert.strictEqual((await fetch(`${base}/api/info`, { headers: auth })).status, 401, 'the old token stopped working');
    assert.strictEqual((await viaHost('pc.tail1234.ts.net', '/api/info', { headers: { Authorization: `Bearer ${moved.token}` } })).status, 200);
    const devices = JSON.parse(fs.readFileSync(devicesFile, 'utf8')).filter((d) => d.name === 'LAN phone');
    assert.strictEqual(devices.length, 1, 'the same device, not a new one');
  } finally {
    tunnelState = { mode: 'off' };
  }
});

test('the schedule: read-only, a bounded range, only the fields the phone shows', async () => {
  const auth = { Authorization: `Bearer ${await pairDevice()}` };
  for (const q of ['', '?from=2026-10-26', '?from=2026-10-26&to=2026-10-26', '?from=2026-10-01&to=2027-01-01', '?from=x&to=y']) {
    assert.strictEqual((await fetch(`${base}/api/schedule${q}`, { headers: auth })).status, 400, q);
  }
  assert.strictEqual((await fetch(`${base}/api/schedule?from=2026-10-26&to=2026-11-02`)).status, 401);
  const r = await fetch(`${base}/api/schedule?from=2026-10-26&to=2026-11-02`, { headers: auth });
  assert.strictEqual(r.status, 200);
  const { events } = await r.json();
  assert.strictEqual(events[0].title, 'Lecture');
  assert.strictEqual(events[0].internal, undefined);
  assert.deepStrictEqual(calls.at(-1), { start: '2026-10-26T00:00:00', end: '2026-11-02T00:00:00' });
  assert.strictEqual((await post('/api/schedule', {}, auth)).status, 404, 'no way to change it');
});

test('data screens: only paired devices, only while shared; habits can be checked off', async () => {
  let r = await fetch(`${base}/api/data/today`);
  assert.strictEqual(r.status, 401, 'no token, no data');
  const token = await pairDevice('Data phone');
  const auth = { Authorization: `Bearer ${token}` };
  r = await fetch(`${base}/api/data/today`, { headers: auth });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).date, '2026-10-26');
  r = await post('/api/data/habits/log', { name: 'Run', done: true }, auth);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(habitLogs.pop(), ['Run', true]);
  r = await fetch(`${base}/api/data/nothing-here`, { headers: auth });
  assert.strictEqual(r.status, 404);
  r = await fetch(`${base}/api/data/__proto__`, { headers: auth });
  assert.strictEqual(r.status, 404);
  share = false;
  r = await fetch(`${base}/api/data/habits`, { headers: auth });
  assert.strictEqual(r.status, 403, 'the user turned sharing off');
  r = await fetch(`${base}/api/info`, { headers: auth });
  assert.strictEqual((await r.json()).share, false);
  share = true;
});

test('the village: its code and art are served, nothing else under those paths', async () => {
  let r = await fetch(`${base}/js/world/map.js`);
  assert.strictEqual(r.status, 200);
  r = await fetch(`${base}/assets/world/manifest.json`);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /json/);
  for (const p of ['/assets/world/../../../package.json', '/assets/world/%2e%2e%2fmain.js', '/assets/world/.hidden.json', '/assets/world/x.js', '/js/world/innerworld.js']) {
    r = await fetch(`${base}${p}`);
    assert.notStrictEqual(r.status, 200, p);
  }
});
