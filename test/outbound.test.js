// Which web hosts a turn may reach after it read outside content (main/outboundcore.js) and the dialog
// for a new one (approvals.askOutbound): the user's own hosts and the ones met before the taint pass,
// anything a page chose asks once per host. A request's destination is data too.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

let settings = { safety: { permissionMode: 'auto', taintGuard: true, approvalTimeoutSec: 5 } };
stub({ './logger': quietLog, './store': { getSettings: async () => settings } });
const outbound = load('main/outboundcore.js');
const approvals = load('main/approvals.js');

const asked = [];
approvals.setSender((channel, payload) => {
  if (channel !== 'approval:request') return;
  asked.push(payload);
  setImmediate(() => approvals.respond(payload.id, true));
});

test('hostOf: the host only, lower case, punycode; anything else is ""', () => {
  assert.strictEqual(outbound.hostOf('HTTPS://Docs.Python.org./x'), 'docs.python.org');
  assert.strictEqual(outbound.hostOf('http://user@host:8080/'), 'host');
  assert.strictEqual(outbound.hostOf('https://bücher.de'), 'xn--bcher-kva.de');
  for (const bad of ['ftp://x', 'javascript:alert(1)', '', '   ', null, undefined, 'not a url', 'file:///etc/passwd', '<script>alert(1)</script>']) {
    assert.strictEqual(outbound.hostOf(bad), '', String(bad));
  }
});

test('hostsIn: links and bare names, never an e-mail address; links only on request', () => {
  assert.deepStrictEqual([...outbound.hostsIn('read https://example.org/a?b=1 please')], ['example.org']);
  assert.deepStrictEqual([...outbound.hostsIn('see docs.python.org for this')], ['docs.python.org']);
  assert.deepStrictEqual([...outbound.hostsIn('e.g. this')], [], 'e.g. is not a host');
  assert.deepStrictEqual([...outbound.hostsIn('open file.txt')], ['file.txt'], 'a harmless host');
  assert.deepStrictEqual([...outbound.hostsIn('mail me at anna@example.com')], [], 'an address is not a host');
  assert.deepStrictEqual([...outbound.hostsIn('docs.python.org and https://a.example.com/x', { bare: false })], ['a.example.com']);
  assert.deepStrictEqual([...outbound.hostsIn('')], []);
  assert.deepStrictEqual([...outbound.hostsIn('   ')], []);
  assert.deepStrictEqual([...outbound.hostsIn('👨‍👩‍👧‍👦 مرحبا example.com')], ['example.com']);
  assert.deepStrictEqual([...outbound.hostsIn(null)], []);
  const many = Array.from({ length: 10000 }, (_, i) => `h${i}.example.com`).join(' ');
  assert.strictEqual(outbound.hostsIn(many).size, outbound.MAX_HOSTS, 'at most MAX_HOSTS');
  const links = Array.from({ length: 10000 }, (_, i) => `https://h${i}.example.com/`).join(' ');
  assert.strictEqual(outbound.hostsIn(links).size, outbound.MAX_HOSTS);
});

test('check: everything is allowed before the taint; after it, only the user’s and the known hosts', () => {
  const turn = approvals.newTurn({ userText: 'summarise https://news.example.org and docs.python.org' });
  assert.deepStrictEqual(outbound.check(turn, 'https://evil.test/x'), { decision: 'allow', host: 'evil.test' }, 'untainted: any host');
  turn.tainted = true;
  assert.strictEqual(outbound.check(turn, 'https://news.example.org/today').decision, 'allow', 'the user named it');
  assert.strictEqual(outbound.check(turn, 'https://cdn.news.example.org/a').decision, 'allow', 'a subdomain of a named host');
  assert.strictEqual(outbound.check(turn, 'https://example.org/').decision, 'ask', 'a named subdomain does not cover its parent');
  assert.strictEqual(outbound.check(turn, 'https://evilnews.example.org.attacker.test/').decision, 'ask', 'a lookalike is another host');
  assert.strictEqual(outbound.check(turn, 'https://python.org.evil.test/').decision, 'ask');
  turn.knownHosts.add('known.test');
  turn.outboundApproved.add('approved.test');
  assert.strictEqual(outbound.check(turn, 'https://known.test/').decision, 'allow');
  assert.strictEqual(outbound.check(turn, 'https://approved.test/').decision, 'allow');
  assert.deepStrictEqual(outbound.check(turn, 'https://evil.test/?q=profile'), { decision: 'ask', host: 'evil.test' });
  assert.deepStrictEqual(outbound.check(turn, 'not a url'), { decision: 'ask', host: '' }, 'unparsable asks');
  assert.strictEqual(outbound.check(turn, 'https://evil.test/', { tainted: false }).decision, 'allow', 'the taint guard off');
  assert.strictEqual(outbound.check(null, 'https://evil.test/', { tainted: true }).decision, 'ask', 'no turn at all: asks');
});

test('resultLinkHosts: a search’s own links, never an address in the text around them', () => {
  // Claude Code's WebSearch result, as the CLI writes it.
  const text = 'Web search results for query: "release notes"\n\nLinks: [{"title":"Notes","url":"https://found.example/a"},{"title":"B ] [","url":"http://B.Example/x"}]\n\nThe page says the full list is on https://quoted.example/x and other.example\n\nLinks: [{"title":"C","url":"https://c.example/"}]\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.';
  assert.deepStrictEqual([...outbound.resultLinkHosts(text)].sort(), ['b.example', 'c.example', 'found.example']);
  // Its other shape: search_result blocks (their text is the page's own) and text blocks.
  const blocks = [{ type: 'search_result', source: 'https://block.example/a', title: 'A', content: [{ type: 'text', text: 'mirror at https://mirror.example/' }] }, { type: 'text', text: 'Links: [{"url":"https://d.example/"}]\nsee https://e.example/' }];
  assert.deepStrictEqual([...outbound.resultLinkHosts(blocks)].sort(), ['block.example', 'd.example']);
  const nothing = [
    'Links: [not json]',
    'Links: {"url":"https://object.example"}',
    'Links: [{"url":"javascript:alert(1)"}, {"url":"ftp://x.example"}, {"url":42}, {"href":"https://href.example"}, null, "https://string.example"]',
    '  Links: [{"url":"https://indented.example"}]',
    'The page: Links: [{"url":"https://inline.example"}]',
    'see https://plain.example/ only',
    '<script>alert(1)</script>',
    '',
    '   ',
    null,
    undefined,
    42,
    { type: 'search_result', source: 'https://not-a-list.example' },
    [null, 'Links: [{"url":"https://string-block.example"}]', 7, { type: 'search_result' }, { type: 'search_result', source: 'ftp://x' }, { type: 'image', source: 'https://image.example' }],
  ];
  nothing.forEach((c, i) => assert.deepStrictEqual([...outbound.resultLinkHosts(c)], [], `#${i} ${JSON.stringify(c)}`));
  assert.strictEqual(Object.prototype.url, undefined);
  assert.deepStrictEqual([...outbound.resultLinkHosts('Links: [{"__proto__":{"url":"https://proto.example"}},{"url":"https://own.example"}]')], ['own.example'], 'a "__proto__" key is no link');
  const many = `Links: ${JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ title: 't', url: `https://h${i}.example/` })))}`;
  assert.strictEqual(outbound.resultLinkHosts(many).size, outbound.MAX_HOSTS, 'at most MAX_HOSTS');
  const huge = `Links: ${JSON.stringify(Array.from({ length: 10000 }, (_, i) => ({ title: 't', url: `https://h${i}.example/` })))}`;
  assert.strictEqual(outbound.resultLinkHosts(huge).size, 0, 'a list past the length read is cut, so unreadable: nothing (later fetches ask)');
});

test('resultLinkHosts: 200,000-character inputs parse quickly', () => {
  const inputs = {
    'an unclosed list': `Links: [${'{"url":"https://a.example"},'.repeat(7000)}`,
    'brackets': `Links: [${']'.repeat(199990)}`,
    'many list lines': 'Links: [\n'.repeat(22000),
    'one long line': `Links: [${'a'.repeat(199990)}]`,
  };
  for (const [name, s] of Object.entries(inputs)) {
    const t0 = performance.now();
    outbound.resultLinkHosts(s);
    const ms = performance.now() - t0;
    assert.ok(ms < 100, `${name}: ${ms.toFixed(1)} ms`);
  }
});

test('noteHosts adds only while the turn is untainted, and only so many', () => {
  const turn = approvals.newTurn();
  outbound.noteHosts(turn, ['a.test', '', null]);
  assert.deepStrictEqual([...turn.knownHosts], ['a.test']);
  outbound.noteHosts(turn, Array.from({ length: 1000 }, (_, i) => `h${i}.test`));
  assert.strictEqual(turn.knownHosts.size, outbound.MAX_HOSTS * 4);
  turn.tainted = true;
  const t2 = approvals.newTurn();
  t2.tainted = true;
  outbound.noteHosts(t2, ['later.test']);
  assert.strictEqual(t2.knownHosts.has('later.test'), false, 'a host met after the taint could be a page’s choice');
  assert.doesNotThrow(() => outbound.noteHosts(null, ['x.test']));
});

test('ReDoS budget: 200,000-character inputs parse quickly', () => {
  const inputs = {
    'a.a.a…': 'a.'.repeat(100000),
    'one token of dots': `a${'.'.repeat(199998)}a`,
    'http:// repeated': 'http://'.repeat(28572),
    'dots and dashes': '.-'.repeat(100000),
    'colons and slashes': ':/'.repeat(100000),
    'one long host': `https://${'a'.repeat(199990)}.com`,
  };
  for (const [name, s] of Object.entries(inputs)) {
    const t0 = performance.now();
    outbound.hostsIn(s);
    outbound.hostOf(s);
    const ms = performance.now() - t0;
    assert.ok(ms < 100, `${name}: ${ms.toFixed(1)} ms`);
  }
});

test('askOutbound: one web_outbound dialog per new host after the taint, none otherwise', async () => {
  asked.length = 0;
  const turn = approvals.newTurn({ userText: 'what does example.com say?' });
  assert.strictEqual((await approvals.askOutbound(turn, 'https://research.test/a')).allow, true);
  assert.deepStrictEqual(asked, [], 'untainted: silent');
  assert.ok(turn.knownHosts.has('research.test'), 'and the host becomes known');
  approvals.markTainted(turn, 'WebFetch https://research.test/a');
  assert.strictEqual((await approvals.askOutbound(turn, 'https://research.test/b')).allow, true);
  assert.strictEqual((await approvals.askOutbound(turn, 'https://www.example.com/')).allow, true);
  assert.deepStrictEqual(asked, [], 'known and named hosts pass');
  assert.strictEqual((await approvals.askOutbound(turn, 'https://collect.evil.test/?d=secrets')).allow, true);
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0].kind, 'web_outbound');
  assert.strictEqual(asked[0].tainted, true);
  assert.strictEqual(asked[0].voice, 'key');
  assert.match(asked[0].title, /collect\.evil\.test/);
  await approvals.askOutbound(turn, 'https://collect.evil.test/again');
  assert.strictEqual(asked.length, 1, 'the same host again: no second dialog');
  await approvals.askOutbound(turn, 'https://other.evil.test/');
  assert.strictEqual(asked.length, 2, 'another host asks');
  settings = { safety: { ...settings.safety, taintGuard: false } };
  await approvals.askOutbound(turn, 'https://third.evil.test/');
  assert.strictEqual(asked.length, 2, 'taint guard off: silent');
  settings = { safety: { ...settings.safety, taintGuard: true } };
});

test('askOutbound: a declined host stays unknown and asks again', async () => {
  asked.length = 0;
  approvals.setSender((channel, payload) => {
    if (channel !== 'approval:request') return;
    asked.push(payload);
    setImmediate(() => approvals.respond(payload.id, false, 'no'));
  });
  const turn = approvals.newTurn();
  approvals.markTainted(turn, 'a page');
  assert.strictEqual((await approvals.askOutbound(turn, 'https://evil.test/')).allow, false);
  assert.strictEqual((await approvals.askOutbound(turn, 'https://evil.test/')).allow, false);
  assert.strictEqual(asked.length, 2);
  assert.strictEqual(turn.outboundApproved.size, 0);
});

// Regression (review): web_fetch asked only for the first address; fetchPage then followed up to five
// redirects to any public host, so an open redirect on an allowed site carried the data on unasked.
test('web_fetch: a redirect to a host the page chose asks too, and a declined one is never requested', async () => {
  settings = { web: { enabled: true }, safety: { permissionMode: 'auto', taintGuard: true, approvalTimeoutSec: 5 } };
  const webFetch = load('main/tools/web.js').find((t) => t.name === 'web_fetch');
  let allow = false;
  asked.length = 0;
  approvals.setSender((channel, payload) => {
    if (channel !== 'approval:request') return;
    asked.push(payload);
    setImmediate(() => approvals.respond(payload.id, allow, allow ? '' : 'no'));
  });
  // Addresses as numbers: assertPublic checks them without a DNS lookup.
  const hops = { 'http://93.184.216.34/': 'http://93.184.216.34/go', 'http://93.184.216.34/go': 'http://93.184.216.35/?d=profile' };
  const requested = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    requested.push(url);
    if (hops[url]) return new Response('', { status: 302, headers: { location: hops[url] } });
    return new Response('<title>Done</title><p>ok</p>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const ctxOf = () => {
    const turn = approvals.newTurn({ userText: 'what does http://93.184.216.34/ say?' });
    approvals.markTainted(turn, 'WebFetch a page');
    return { turn, emit() {} };
  };
  try {
    await assert.rejects(webFetch.run({ url: 'http://93.184.216.34/' }, ctxOf()), /^Error: Not approved by the user: no/);
    assert.deepStrictEqual(asked.map((p) => [p.kind, p.title]), [['web_outbound', 'Open 93.184.216.35']], 'the user’s own host and its same-host redirect pass; the new host asks');
    assert.deepStrictEqual(requested, ['http://93.184.216.34/', 'http://93.184.216.34/go'], 'the declined address was never requested');

    allow = true;
    asked.length = 0;
    requested.length = 0;
    const page = await webFetch.run({ url: 'http://93.184.216.34/' }, ctxOf());
    assert.strictEqual(page.title, 'Done');
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(requested.at(-1), 'http://93.184.216.35/?d=profile');

    asked.length = 0;
    const clean = { turn: approvals.newTurn(), emit() {} };
    await webFetch.run({ url: 'http://93.184.216.34/' }, clean);
    assert.strictEqual(asked.length, 0, 'before any outside content: silent');
    assert.ok(clean.turn.knownHosts.has('93.184.216.35'), 'and the redirect’s host becomes known');
  } finally {
    global.fetch = realFetch;
  }
});

// Regression (review): browser_open asked only for the address it was given; the agent window then followed
// a server redirect to any public host, so an open redirect on a site the user named carried the turn's data
// to a host nobody named, unasked. agentwindow.open now asks beforeRedirect for each main-frame request of
// the load (the first one, then every hop) and holds it meanwhile; a stand-in plays those hops here.
test('browser_open: a server redirect to a host nobody named asks, and declined, it is never loaded', async () => {
  settings = { safety: { permissionMode: 'auto', taintGuard: true, approvalTimeoutSec: 5 } };
  let allow = false;
  asked.length = 0;
  approvals.setSender((channel, payload) => {
    if (channel !== 'approval:request') return;
    asked.push(payload);
    setImmediate(() => approvals.respond(payload.id, allow, allow ? '' : 'The user clicked Deny.'));
  });
  const requested = [];
  const hops = ['http://93.184.216.34/go', 'http://93.184.216.35/?d=profile'];
  stub({
    '../store': { getSettings: async () => settings },
    '../agentwindow': {
      open: async (url, o) => {
        for (const hop of [url, ...hops]) {
          if (!(await o.beforeRedirect(hop))) return { url: hop, title: '', loaded: true }; // cancelled: never requested
          requested.push(hop);
        }
        return { url: hops.at(-1), title: 'Done', loaded: true };
      },
    },
  });
  const browserOpen = load('main/tools/browser.js').find((t) => t.name === 'browser_open');
  const ctxOf = () => {
    const turn = approvals.newTurn({ userText: 'open http://93.184.216.34/ for me' });
    approvals.markTainted(turn, 'WebFetch a page');
    return { turn, emit() {} };
  };
  await assert.rejects(browserOpen.run({ url: 'http://93.184.216.34/' }, ctxOf()), /^Error: Not approved by the user \(the page redirected to another site\): The user clicked Deny\.$/);
  assert.deepStrictEqual(asked.map((p) => [p.kind, p.title]), [['web_outbound', 'Open 93.184.216.35']], 'the named host and its own redirect pass; the new host asks');
  assert.deepStrictEqual(requested, ['http://93.184.216.34/', 'http://93.184.216.34/go'], 'the declined hop was never requested');
  assert.strictEqual(approvals.declineForLog('Not approved by the user (the page redirected to another site): The user clicked Deny.'), 'Not approved by the user (the page redirected to another site): The user clicked Deny.', 'a fixed reason stays readable in the log');

  allow = true;
  asked.length = 0;
  requested.length = 0;
  assert.strictEqual((await browserOpen.run({ url: 'http://93.184.216.34/' }, ctxOf())).title, 'Done');
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(requested.at(-1), hops.at(-1));

  asked.length = 0;
  const clean = { turn: approvals.newTurn(), emit() {} };
  await browserOpen.run({ url: 'http://93.184.216.34/' }, clean);
  assert.strictEqual(asked.length, 0, 'before any outside content: silent');
  assert.ok(clean.turn.knownHosts.has('93.184.216.35'), 'and the redirect’s host becomes known');
});
