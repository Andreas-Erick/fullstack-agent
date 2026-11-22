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

// SEC-09: a public page can't send the window (or a request) to the globe's local server; the app's own
// load of the globe and the globe page itself can.
test('only the globe and the app’s own loads reach the globe’s server', () => {
  const allowed = core.globeRequestAllowed;
  const globe = 'http://localhost:4173/@fs/C:/Users/x/.ssh/id_ed25519?raw';
  assert.strictEqual(allowed({ url: globe, resourceType: 'mainFrame', from: 'https://evil.example/' }), false, 'a website navigating there');
  assert.strictEqual(allowed({ url: globe, resourceType: 'mainFrame', from: '' }), false, 'nothing behind it: not the app’s load either');
  assert.strictEqual(allowed({ url: globe, resourceType: 'xhr', from: 'https://evil.example/' }), false);
  assert.strictEqual(allowed({ url: 'http://localhost:4173/', resourceType: 'mainFrame', from: 'https://example.com/', appNav: true }), true, 'browser_open / globe_open');
  assert.strictEqual(allowed({ url: 'http://127.0.0.1:4173/#lat=1', resourceType: 'mainFrame', from: 'http://localhost:4173/#lat=0' }), true, 'the globe reloading itself');
  assert.strictEqual(allowed({ url: 'http://localhost:4173/api/tiles', resourceType: 'xhr', from: 'http://localhost:4173/' }), true, 'the globe’s own requests');
  assert.strictEqual(allowed({ url: 'http://localhost:4173/x', resourceType: 'subFrame', from: 'https://localhost.evil.example:4173/' }), false, 'a look-alike page');
  assert.strictEqual(allowed({ url: 'https://example.com/', resourceType: 'mainFrame', from: '', appNav: true }), false, 'only the globe’s server is meant');
  assert.strictEqual(allowed({ url: 'not a url', resourceType: 'mainFrame', appNav: true }), false);
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main', 'agentwindow.js'), 'utf8');
  assert.match(src, /appNav: globeNav === details\.webContentsId/, 'the request filter asks the rule');
  assert.match(src, /globeNav = c\.globe \? wc\.id : null;/, 'set only by open()');
  assert.doesNotMatch(src, /resourceType === 'mainFrame'\) return true/, 'no blanket main-frame exception');
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

// The window side of browser_open's redirect question (test/outbound.test.js plays the hops): every
// main-frame request of the agent's own load asks before it is sent (held, cancelled when declined), set
// before the load starts, ended once it commits or stops. Electron runs onBeforeRequest for each server
// redirect hop (resourceType mainFrame, the view's webContentsId) and holds it until the callback.
test('a server redirect of the agent’s own load is asked before it is requested', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../main/agentwindow.js'), 'utf8').replace(/\r\n/g, '\n');
  const hook = src.slice(src.indexOf('ses.webRequest.onBeforeRequest('), src.indexOf('\n  });\n', src.indexOf('ses.webRequest.onBeforeRequest(')));
  assert.match(hook, /const nav = details\.resourceType === 'mainFrame' && navAsk\?\.wc === details\.webContentsId \? navAsk : null;/);
  assert.match(hook, /\(nav \? asked\(\(\) => nav\.ask\(details\.url\)\) : Promise\.resolve\(true\)\)\.then\(\s*\(ok\) => \{\s*if \(!ok\) return cb\(\{ cancel: true \}\);[\s\S]*\},\s*\(\) => cb\(\{ cancel: true \}\),\s*\);$/);
  assert.ok(hook.indexOf('isPrivateHost') < hook.indexOf('nav.ask'), 'this computer and the network stay refused before any question');
  const open = src.slice(src.indexOf('async function open('), src.indexOf('\nfunction requireOpen('));
  assert.ok(open.indexOf('navAsk = byAgent && !c.globe && beforeRedirect') > 0 && open.indexOf('navAsk = ') < open.indexOf('wc.loadURL(c.url)'), 'set before the load starts (the user’s address bar sets none)');
  assert.match(open, /while \(!loaded && asking && alive\(\)\)/, 'browser_open waits for the answer');
  assert.match(src, /for \(const ev of \['did-navigate', 'did-stop-loading'\]\) wc\.on\(ev, \(\) => navAsk\?\.wc === wc\.id && \(navAsk = null\)\);/);
});

test('page scripts: ids are digits only, and the read script is one expression', () => {
  assert.ok(core.locateScript('3"]; alert(1); //').includes('data-nexus-id="31"'));
  assert.ok(core.focusScript('x7').includes('data-nexus-id="7"'));
  assert.doesNotThrow(() => new Function(`return ${core.readScript(5000)}`));
  assert.ok(core.readScript(10 ** 9).includes('MAX_TEXT = 40000'), 'text limit is bounded');
  assert.strictEqual(core.scrollScript('sideways'), 'scrollBy(0, innerHeight * 0.8)');
});
