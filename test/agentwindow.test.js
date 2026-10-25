// The agent window (main/agentwindowcore.js): which addresses it shows, the address bar, the globe
// reload rule, and that the page scripts stay data-only.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../main/agentwindowcore');

test('public websites open; this computer and the local network never do', () => {
  assert.ok(core.checkUrl('https://example.com/a?b=1').ok);
  for (const bad of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://192.168.1.1/admin', 'http://10.0.0.5', 'http://172.20.1.1', 'http://[::1]:8080/', 'http://router.local/', 'http://2130706433/', 'http://0x7f000001/', 'http://100.101.102.103/', 'http://[::ffff:127.0.0.1]/']) {
    assert.strictEqual(core.checkUrl(bad).ok, false, bad);
  }
});

test('only websites: no files, scripts, data or browser pages; no credentials in the address', () => {
  for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'devtools://x', 'https://user:pw@example.com/', 'not a url']) {
    assert.strictEqual(core.checkUrl(bad).ok, false, bad);
  }
});

test("the globe's local server is the one exception", () => {
  const c = core.checkUrl('http://localhost:4173/#v=2&lat=48.1&lon=11.5');
  assert.ok(c.ok && c.globe);
  assert.strictEqual(core.checkUrl('http://localhost:4174/').ok, false);
  assert.strictEqual(core.checkUrl('https://localhost:4173/').ok, false, 'only the plain http dev server');
});

test('a new globe view that only changes the # reloads the page', () => {
  assert.ok(core.onlyHashDiffers('http://localhost:4173/#lat=1', 'http://localhost:4173/#lat=2'));
  assert.ok(!core.onlyHashDiffers('http://localhost:4173/#lat=1', 'http://localhost:4173/#lat=1'));
  assert.ok(!core.onlyHashDiffers('', 'http://localhost:4173/#lat=1'));
  assert.ok(!core.onlyHashDiffers('https://a.com/x', 'https://a.com/y'));
});

test('the address bar: addresses as is, domains get https, anything else is a search', () => {
  assert.strictEqual(core.fromAddressBar('https://a.com/x'), 'https://a.com/x');
  assert.strictEqual(core.fromAddressBar('wikipedia.org/wiki/Iceland'), 'https://wikipedia.org/wiki/Iceland');
  assert.strictEqual(core.fromAddressBar('localhost:4173'), 'http://localhost:4173');
  assert.strictEqual(core.fromAddressBar('weather in Munich'), 'https://duckduckgo.com/?q=weather%20in%20Munich');
  assert.strictEqual(core.fromAddressBar('  '), '');
});

test('page scripts: ids are digits only, and the read script is one expression', () => {
  assert.ok(core.locateScript('3"]; alert(1); //').includes('data-nexus-id="31"'));
  assert.ok(core.focusScript('x7').includes('data-nexus-id="7"'));
  assert.doesNotThrow(() => new Function(`return ${core.readScript(5000)}`));
  assert.ok(core.readScript(10 ** 9).includes('MAX_TEXT = 40000'), 'text limit is bounded');
  assert.strictEqual(core.scrollScript('sideways'), 'scrollBy(0, innerHeight * 0.8)');
});
