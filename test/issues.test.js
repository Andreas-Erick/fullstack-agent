// Problem reports (main/issuecore.js): anonymized before the user sees them, the app's own code
// locations kept, a GitHub link only for the project's repository; and the setting is the user's alone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, load } = require('./helpers');

const core = load('main/issuecore.js');
const known = { home: String.raw`C:\Users\andre`, user: 'andre', root: String.raw`C:\Users\andre\Apps\Siren`, vault: String.raw`C:\Users\andre\Documents\Siren Vault`, names: ['Ringmaster'] };

test('what could identify the user is removed', () => {
  const t = core.anonymize(
    String.raw`ENOENT: no such file 'C:\Users\andre\Documents\Siren Vault\Notes\Therapy.md' (andre, ringmaster) at C:\Users\andre\Apps\Siren\main\llm.js:120 mail andre.x@example.com from 192.168.1.20 key sk-ant-abcdefghijklmnop1234 url https://api.example.com/v1/x?token=abc and D:\Private\taxes.pdf`,
    known,
  );
  assert.ok(!/andre|Therapy|taxes|example\.com\/v1|abcdefghijklmnop|192\.168/i.test(t), t);
  assert.ok(t.includes("'<vault .md>'"), `a note: neither its folder nor its name: ${t}`);
  assert.ok(t.includes(String.raw`main\llm.js:120`), `the app’s own file stays, inside the app: ${t}`);
  assert.match(t, /<email>/);
  assert.match(t, /<ip>/);
  assert.match(t, /<key>/);
  assert.match(t, /https:\/\/api\.example\.com(?!\/)/, 'only the host of a web address');
  assert.match(t, /<path \.pdf>/);
  assert.strictEqual(core.anonymize('connect ECONNREFUSED 127.0.0.1:3900 http://localhost:3900/v1/audio/speech'), 'connect ECONNREFUSED 127.0.0.1:3900 http://localhost:3900');
  assert.strictEqual(core.anonymize('a Bearer eyJhbGciOi.eyJzdWIiOiIx.abc123'), 'a Bearer <token>');
});

test('a report: the problem, the code locations, the environment; offered once by a stable key', () => {
  const problem = { level: 'error', event: 'turn failed', where: 'chat:send', message: String.raw`Cannot read properties of undefined (reading 'model') in C:\Users\andre\x.js`, count: 3, first: '2026-10-28T10:00:00Z', last: '2026-10-29T09:00:00Z', locations: ['main/llm.js:231', 'main/router.js:102'] };
  const r = core.report(problem, { version: '2.6.5', os: 'Windows_NT 10.0.26200 (x64)', electron: '39.0.0', brain: 'auto' }, known);
  assert.match(r.title, /^\[auto\] turn failed: Cannot read properties/);
  assert.match(r.body, /- `main\/llm\.js:231`/);
  assert.match(r.body, /Seen 3× \(first 2026-10-28, last 2026-10-29\)/);
  assert.match(r.body, /Siren 2\.6\.5 · Windows_NT/);
  assert.ok(!/andre/i.test(r.title + r.body));
  assert.strictEqual(core.keyOf(problem), core.keyOf({ ...problem, message: problem.message.replace('x.js', 'y.js').replace('undefined', 'undefined') }), 'same problem, same key');
  assert.strictEqual(core.keyOf({ event: 'e', message: 'took 120 ms' }), core.keyOf({ event: 'e', message: 'took 9 ms' }), 'numbers don’t make a new problem');
  const long = core.report({ ...problem, message: 'x '.repeat(5000) }, {}, known);
  assert.ok(long.body.length <= core.MAX_BODY + 2);
});

test('the link opens a new issue on GitHub, filled in, and nothing else', () => {
  const url = new URL(core.issueUrl('Andreas-Erick/fullstack-agent', { title: 'T & more', body: 'line\nline' }));
  assert.strictEqual(url.origin + url.pathname, 'https://github.com/Andreas-Erick/fullstack-agent/issues/new');
  assert.deepStrictEqual([url.searchParams.get('title'), url.searchParams.get('body'), url.searchParams.get('labels')], ['T & more', 'line\nline', 'auto-report']);
  assert.throws(() => core.issueUrl('evil.com/x/../y?', { title: '', body: '' }), /repository/);
});

test('reporting is off by default and the agent can’t turn it on', () => {
  const store = fs.readFileSync(path.join(ROOT, 'main/store.js'), 'utf8');
  assert.match(store, /privacy: \{[^}]*reportIssues: false/);
  const tools = fs.readFileSync(path.join(ROOT, 'main/tools.js'), 'utf8');
  assert.ok(!/reportIssues/.test(tools), 'not in SETTABLE or the setup list');
});

test('details logged as data keep only what describes the failure, never a tool’s input or output', () => {
  // As found in a real log: a failed tool's entry carries what the user asked it.
  const raw = '{"name":"mcp__claude_ai_Consensus__search","ms":599,"input":"{\\"query\\":\\"my private research question\\"}","preview":"User did not approve"}';
  assert.strictEqual(core.message(raw), 'name=mcp__claude_ai_Consensus__search, ms=599 (+2 details not included)');
  const r = core.report({ event: 'tool failed', message: raw, count: 1 }, {}, {});
  assert.ok(!/private research|did not approve/.test(r.title + r.body));
  assert.match(r.title, /mcp__claude_ai_Consensus__search/, 'a tool name is not mistaken for a token');
  assert.strictEqual(core.message('{"mode":"tailscale","reason":"no answer within 10 seconds"}'), 'mode=tailscale, reason=no answer within 10 seconds');
  assert.strictEqual(core.message('{"cut off'), '(details not included)');
  assert.strictEqual(core.message('plain text stays'), 'plain text stays');
  assert.strictEqual(core.anonymize('id a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7'), 'id <token>');
});
