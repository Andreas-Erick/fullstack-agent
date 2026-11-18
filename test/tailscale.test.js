// Setting up Tailscale Serve for the secure address (main/tunnel.js serveOutcome): what the tailscale
// CLI printed decides between done, "enable HTTPS for your tailnet first" (with Tailscale's link) and
// an error the user can act on. The cause of "the secure address doesn't work" was exactly this:
// Serve not set up, and HTTPS off for the tailnet.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

stub({ './logger': quietLog });
const { serveOutcome } = load('main/tunnel.js');

test('success', () => {
  assert.deepStrictEqual(serveOutcome(0, 'Available within your tailnet:\n\nhttps://pc.tail1234.ts.net/\n|-- proxy http://127.0.0.1:7823\n\nServe started and running in the background.'), { ok: true });
});

test('HTTPS off for the tailnet: the link to enable it', () => {
  const out = 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nABC123\n';
  assert.deepStrictEqual(serveOutcome(null, out), { enableUrl: 'https://login.tailscale.com/f/serve?node=nABC123' });
});

test('an error says what to do', () => {
  const r = serveOutcome(1, 'serve config: Access denied: serve config denied');
  assert.match(r.error, /Access denied/);
  assert.match(r.error, /operator/);
  assert.match(serveOutcome(1, '').error, /code 1/);
});

// A Tailscale address is opened again every 5 minutes (tunnel.js watchAddress), so the Remote light
// notices when Tailscale is switched off or Serve stops: one timer at a time, quiet (no 'checking' flash).
test('a Tailscale address is re-checked every 5 minutes, with one timer at a time', async () => {
  const real = { setInterval: global.setInterval, clearInterval: global.clearInterval, fetch: global.fetch };
  const live = new Set();
  let fetches = 0;
  let answer = async () => ({ status: 200, json: async () => ({ app: 'nexus-agent' }) });
  global.setInterval = (fn, ms) => {
    const t = { fn, ms, unref() {} };
    live.add(t);
    return t;
  };
  global.clearInterval = (t) => live.delete(t);
  global.fetch = (...args) => (fetches++, answer(...args));
  const warned = [];
  stub({ './logger': { ...quietLog, warn: (event) => warned.push(event) } });
  try {
    const tunnel = load('main/tunnel.js');
    const checks = [];
    tunnel.setListener((st) => checks.push(st.check));
    const settings = (host, extra = {}) => ({ remote: { enabled: true, tunnel: 'tailscale', publicHost: host, ...extra } });

    await tunnel.apply(settings('pc.tail1234.ts.net'), 7823);
    assert.strictEqual(live.size, 1);
    const [timer] = live;
    assert.strictEqual(timer.ms, 5 * 60000);
    await tunnel.apply(settings('pc.tail1234.ts.net'), 7823);
    assert.strictEqual(live.size, 1, 'the same settings again: the same timer');
    await tunnel.apply(settings('laptop.tail1234.ts.net'), 7823);
    assert.strictEqual(live.size, 1, 'another address: the old timer is gone');
    assert.ok(!live.has(timer));

    const before = fetches;
    await [...live][0].fn();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(fetches, before + 1, 'the re-check opens the address');
    assert.strictEqual(tunnel.status().check, 'ok');
    checks.length = 0;
    await [...live][0].fn();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(fetches, before + 2);
    assert.deepStrictEqual(checks, [], 'the same answer again: nothing sent to the window every 5 minutes');

    // Tailscale switched off: the quiet re-check records the failure without a 'checking' state first.
    answer = async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    checks.length = 0;
    await [...live][0].fn();
    await new Promise((r) => setImmediate(r));
    assert.ok(checks.includes('fail'), `checks: ${checks.join(', ')}`);
    assert.ok(!checks.includes('checking'), 'no flicker');
    assert.match(tunnel.status().warning, /laptop\.tail1234\.ts\.net/);
    // One warning in the log when it starts failing, not one every 5 minutes while Tailscale is off.
    const failed = () => warned.filter((e) => e === 'secure address check failed').length;
    assert.strictEqual(failed(), 1);
    const told = checks.length;
    await [...live][0].fn();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(failed(), 1);
    assert.strictEqual(checks.length, told, 'still failing the same way: nothing new for the window');
    await tunnel.verify(); // the user's own "Test it" always says so
    assert.strictEqual(failed(), 2);

    // An address that isn't one: no timer, nothing opened.
    for (const host of ['', '   ', 'not a host', 'x'.repeat(10000)]) {
      await tunnel.apply(settings(host), 7823);
      assert.strictEqual(live.size, 0, `host ${JSON.stringify(host.slice(0, 20))}`);
    }
    await tunnel.apply(settings('pc.tail1234.ts.net'), 7823);
    assert.strictEqual(live.size, 1);
    tunnel.stop();
    assert.strictEqual(live.size, 0, 'stop() ends the re-check');
    await tunnel.apply(settings('pc.tail1234.ts.net'), 7823);
    await tunnel.apply(settings('pc.tail1234.ts.net', { enabled: false }), 7823);
    assert.strictEqual(live.size, 0, 'remote access off: no re-check');
  } finally {
    global.setInterval = real.setInterval;
    global.clearInterval = real.clearInterval;
    global.fetch = real.fetch;
    stub({ './logger': quietLog });
  }
});
