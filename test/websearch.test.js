// Web fetching (main/websearch.js) never reaches this computer or the local network, however the
// address is written (a page or a prompt could ask the agent to probe it). Regression: IPv4 inside IPv6
// (http://[::ffff:127.0.0.1]/) and the Tailscale / carrier-NAT range 100.64/10 used to pass.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

stub({ './logger': quietLog, './store': { getSettings: async () => ({ web: {} }) } });
const web = load('main/websearch.js');

test('private, local and reserved addresses are recognised', () => {
  for (const a of ['127.0.0.1', '127.255.255.254', '10.0.0.1', '192.168.178.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '0.0.0.0', '100.64.0.1', '100.100.100.100', '100.127.255.255', '192.0.0.1', '198.18.0.1', '224.0.0.251', '255.255.255.255', '::', '::1', 'fc00::1', 'fd7a:115c:a1e0::1', 'fe80::1%eth0', 'fec0::1', 'ff02::fb', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:101', '0:0:0:0:0:ffff:a00:1', '::127.0.0.1', '64:ff9b::a00:1', '[::1]'])
    assert.strictEqual(web.isPrivateAddress(a), true, a);
});

test('public addresses pass', () => {
  for (const a of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '192.169.0.1', '198.20.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8'])
    assert.strictEqual(web.isPrivateAddress(a), false, a);
});

test('anything that is not an address counts as private', () => {
  for (const a of ['', null, undefined, 'localhost', 'not an ip', '999.1.1.1', '1.2.3', ':::'])
    assert.strictEqual(web.isPrivateAddress(a), true, String(a));
});

test('fetch addresses: the URL tricks that end on this computer are refused', async () => {
  for (const u of ['http://127.0.0.1/', 'http://[::1]:8080/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://017700000001/', 'http://127.1/', 'http://[0:0:0:0:0:ffff:7f00:1]/', 'http://100.101.1.2:7860/', 'http://169.254.169.254/latest/meta-data/', 'http://0/'])
    await assert.rejects(() => web.assertPublic(u), /not allowed/, u);
});

test('only http(s), and nonsense is refused cleanly', async () => {
  for (const u of ['file:///C:/Windows/win.ini', 'ftp://example.com/', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings'])
    await assert.rejects(() => web.assertPublic(u), /Only http/, u);
  for (const u of ['', 'not a url', 'http://', null]) await assert.rejects(() => web.assertPublic(u), /Invalid URL|resolve/, String(u));
});

test('a public IP address passes without a lookup', async () => {
  assert.strictEqual((await web.assertPublic('https://1.1.1.1/dns-query')).hostname, '1.1.1.1');
});

test('page text: scripts, styles and odd markup never leak into what the agent reads', () => {
  const { text: t } = web.htmlToText('<html><head><title>T &amp; Co</title><style>body{}</style></head><body><script>steal()</script><nav>menu</nav><p>Hello&nbsp;<b>world</b></p><!-- secret --></body></html>');
  assert.match(t, /Hello/);
  assert.doesNotMatch(t, /steal|body\{\}|secret|menu/);
  assert.doesNotThrow(() => web.htmlToText(''));
  assert.doesNotThrow(() => web.htmlToText('<p>'.repeat(20000)));
});
