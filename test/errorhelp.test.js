// A failed reply in plain words (renderer/js/chatcore.js errorHelp, shown by the chat, the Face layout's
// card and the phone), and what Copy on a message copies.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

let c;
test.before(async () => {
  const copy = path.join(tmpDir('nexus-errorhelp-'), 'chatcore.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/chatcore.js'), copy);
  c = await import(pathToFileURL(copy).href);
});

const time = (ms) => `T${ms}`; // a fixed formatter: no clock, no locale
const help = (message, opts = {}) => c.errorHelp(message, { time, now: 0, ...opts });
const brainAction = { label: 'Open AI brain settings', go: 'settings', section: 'brain' };
const openai = (baseUrl) => ({ llm: { provider: 'openai', baseUrl } });

test('Copy copies what the bubble shows: the typed words, a /skill as typed; a reply as written', () => {
  assert.strictEqual(c.copyText({ role: 'user', content: 'STEPS OF THE SKILL', display: '/study physics' }), '/study physics');
  assert.strictEqual(c.copyText({ role: 'user', content: 'hello' }), 'hello');
  assert.strictEqual(c.copyText({ role: 'assistant', content: '**hi**', display: 'x' }), '**hi**');
});

test('no brain ready, no model, Claude Code missing, no provider could answer', () => {
  const r = help('No AI provider is ready. Connect your Claude account or add an API key in Settings → AI brain.');
  assert.strictEqual(r.kind, 'notready');
  assert.strictEqual(r.title, 'No brain is ready');
  assert.deepStrictEqual(r.action, brainAction);
  assert.strictEqual(r.retry, true);
  assert.strictEqual(help('No model selected. Choose a model in Settings → AI Brain.').title, 'No model is chosen');
  assert.match(help('Claude Code is not installed. Install it, then connect your Claude account in Settings → AI brain.').title, /Claude Code isn.t installed/);
  const none = help('No provider could answer: Claude (account) hit its rate limit; Gemini is unavailable.');
  assert.strictEqual(none.title, 'No brain could answer');
  assert.strictEqual(none.text, 'Claude (account) hit its rate limit; Gemini is unavailable.');
});

test('the plan’s limit says when it resets: from the CLI’s epoch, the usage meter, or its own words', () => {
  const epoch = help('Claude AI usage limit reached|1700000000');
  assert.strictEqual(epoch.kind, 'limit');
  assert.match(epoch.text, /^It resets at T1700000000000\. Until then you can pick another brain/);
  assert.deepStrictEqual(epoch.action, brainAction);
  const words = help("You've hit your limit · resets 5pm (Europe/Berlin)");
  assert.strictEqual(words.kind, 'limit');
  assert.match(words.text, /It resets at 5pm \(Europe\/Berlin\)\./);
  const usage = { limited: true, windows: [{ used: 0.4, resetsAt: 100 }, { used: 1, resetsAt: 300 }, { used: 0.995, resetsAt: 200 }] };
  assert.match(help('Claude AI usage limit reached', { usage }).text, /It resets at T200000\./, 'the earliest full window');
  assert.match(help('Claude AI usage limit reached').text, /^It resets after a while\./);
  assert.strictEqual(help('You’ve hit your weekly limit').kind, 'limit', 'a curly apostrophe too');
});

test('rate limits, overload and sign-in', () => {
  const rate = help('LLM error 429: {"error":{"message":"Rate limit reached for requests"}}');
  assert.strictEqual(rate.kind, 'rate');
  assert.strictEqual(rate.title, 'The brain is busy right now');
  assert.strictEqual(rate.action, null);
  assert.strictEqual(rate.raw, 'LLM error 429: {"error":{"message":"Rate limit reached for requests"}}', 'the raw text for Details');
  assert.strictEqual(help('overloaded_error: Overloaded').kind, 'overloaded');
  const signin = help('Invalid API key · Please run /login');
  assert.strictEqual(signin.kind, 'signin');
  assert.deepStrictEqual(signin.action, brainAction);
  assert.strictEqual(help('Your credit balance is too low to access the Anthropic API.').kind, 'credits');
});

test('a server on this computer that doesn’t answer: FreeLLMAPI (start it), Ollama / LM Studio, the local model', () => {
  const free = help('fetch failed', { settings: openai('http://localhost:3001/v1') });
  assert.strictEqual(free.kind, 'local-down');
  assert.strictEqual(free.title, 'FreeLLMAPI isn’t running');
  assert.deepStrictEqual(free.action, { label: 'Start FreeLLMAPI', go: 'helper', id: 'freellmapi' });
  const ollama = help('fetch failed', { settings: openai('http://127.0.0.1:11434/v1') });
  assert.strictEqual(ollama.title, 'Ollama / LM Studio isn’t running');
  assert.deepStrictEqual(ollama.action, brainAction);
  const local = help('ECONNREFUSED 127.0.0.1:8080', { settings: { llm: { provider: 'local' }, local: { baseUrl: 'http://localhost:8080/v1' } } });
  assert.strictEqual(local.title, 'Your local model’s server isn’t running');
  assert.strictEqual(help("LM Studio isn't running (nothing answers at localhost:1234). Start LM Studio, then try again.").title, 'Ollama / LM Studio isn’t running', 'from its own words, no settings needed');
  assert.strictEqual(help('Nothing answers at gpu-box.lan:8000: check that the server is running and the address is right.').title, 'The brain’s server doesn’t answer', 'another computer: nothing to start here');
  // The same failure against a server on the internet is the connection, not a local server.
  const net = help('fetch failed', { settings: openai('https://api.example.com/v1') });
  assert.strictEqual(net.kind, 'network');
  assert.strictEqual(help('fetch failed').kind, 'network', 'no settings (the phone)');
});

test('sessions, timeouts, crashes, a conversation too long for the brain', () => {
  assert.strictEqual(help('No conversation found with session ID: abc').kind, 'session');
  assert.strictEqual(help('Claude Code did not respond in time').kind, 'timeout');
  assert.strictEqual(help('Stopped after 5 minutes.').kind, 'timeout');
  assert.strictEqual(help('Claude Code exited (code 1)').kind, 'exited');
  const claude = help('Prompt is too long', { settings: { llm: { provider: 'claude-code' } } });
  assert.strictEqual(claude.kind, 'toolong');
  assert.match(claude.text, /fresh session/);
  assert.deepStrictEqual(claude.action, { label: '＋ New chat', go: 'newchat' });
  assert.match(help('maximum context length is 8192 tokens', { settings: openai('https://api.example.com/v1') }).text, /Start a new chat/);
});

test('multi-provider mode’s “already used tools” keeps its own words', () => {
  for (const m of [
    'Claude hit its rate limit after it had already used tools, so this reply was not repeated on another provider (no action should run twice). Your next message goes to Gemini.',
    'Claude is not signed in (or the key is wrong) after it had already used tools, so this reply was not repeated on another provider (no action should run twice). Your next message goes to Gemini.',
  ]) {
    const r = help(m);
    assert.strictEqual(r.kind, 'toolsran');
    assert.strictEqual(r.text, m);
  }
});

test('refusals and server errors; anything else by its first line', () => {
  const declined = help('The model declined this request.');
  assert.strictEqual(declined.kind, 'declined');
  assert.deepStrictEqual(declined.action, { label: '✎ Edit message', go: 'edit' });
  assert.strictEqual(help('LLM error 500: internal').kind, 'server');
  const bad = help('LLM error 400: {"error":{"message":"Bad thing"}}');
  assert.strictEqual(bad.kind, 'badrequest');
  assert.strictEqual(bad.text, 'Bad thing');
  const other = help(`Something odd ${'x'.repeat(300)}\nsecond line`);
  assert.strictEqual(other.kind, 'default');
  assert.strictEqual(other.text.length, 200);
  assert.strictEqual(help('y'.repeat(5000)).raw.length, 2000);
  assert.strictEqual(help('').text, 'The reply failed.');
});

// The Claude CLI's own offline wording (2.1.327) read "Something went wrong"; a certificate or proxy
// problem is not the connection being down.
test('the CLI’s offline errors read as the connection; certificate and proxy problems don’t', () => {
  for (const m of [
    'Unable to connect to API. Check your internet connection',
    'Unable to connect to API (ECONNRESET)',
    'Connection dropped (ECONNRESET)',
    'Can’t reach the API server — check your internet or DNS (ENOTFOUND)',
    "Can't reach the API server — check your internet or DNS (ENOTFOUND)",
    'No internet route — check your connection or VPN (ENETUNREACH)',
    'connect ENETDOWN 1.2.3.4:443',
    'connect EHOSTDOWN 1.2.3.4:443',
  ]) {
    const r = help(m);
    assert.strictEqual(r.kind, 'network', m);
    assert.strictEqual(r.title, 'Couldn’t reach the brain', m);
  }
  for (const m of ['Unable to connect to API: SSL certificate has expired', 'Unable to connect to API: Self-signed certificate detected', "Couldn't connect through your proxy (ERR_PROXY_TUNNEL) — the proxy refused the tunnel"])
    assert.notStrictEqual(help(m).kind, 'network', m);
});

// A page of CLI output, or the same phrase thousands of times, is read in one pass (no backtracking blow-up).
test('long and hostile error texts are read at once', () => {
  const t0 = performance.now();
  // (errorHelp reads the first 2000 characters: 36 of these and "Unable to connect to", never a bare "…API".)
  assert.notStrictEqual(help('Unable to connect to API: SSL certificate has expired. '.repeat(20000)).kind, 'network', 'a certificate problem, many times over');
  assert.strictEqual(help(`Connection dropped (ECONNRESET) ${'x'.repeat(200000)}`).kind, 'network');
  assert.notStrictEqual(help('can’t reach the ap'.repeat(20000)).kind, 'network');
  assert.ok(performance.now() - t0 < 2000, `took ${Math.round(performance.now() - t0)} ms`);
});

test('the phone can load it: no imports', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/chatcore.js'), 'utf8');
  assert.ok(!/^import /m.test(src));
});
