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
