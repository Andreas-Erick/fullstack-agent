// The title-bar lights' wording (renderer/js/statuscore.js): every red or amber light reads as one plain
// sentence ending "Click to fix.", in plain words; the technical detail stays in Settings → Health.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

let core;
test.before(async () => {
  const copy = path.join(tmpDir('nexus-statuscore-'), 'statuscore.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/statuscore.js'), copy);
  core = await import(pathToFileURL(copy).href);
});

const every = () => Object.entries(core.STATES).flatMap(([pill, states]) => states.map((state) => [pill, state]));
// What a tooltip may never show: product names, file names, addresses, raw error text.
const LEAKS = /FreeLLMAPI|VoiceStudio|Kokoro|Schedule\.md|Obsidian|Claude Code|CLI|https?:|localhost|\d+\.\d+\.\d+\.\d+|ECONN|ENOENT|Error\b|unreachable|undefined|null/;
const HOSTILE = { error: 'connect ECONNREFUSED 127.0.0.1:3001', url: 'http://localhost:8000', message: 'FreeLLMAPI unreachable', count: 12, path: 'C:\\Users\\Anna\\Vault' };

test('the five lights have their plain names', () => {
  assert.deepStrictEqual(core.NAMES, { brain: 'Assistant', voice: 'Voice', calendar: 'Calendar', notes: 'Notes library', usage: 'Claude plan usage' });
});

test('every red or amber light is one plain sentence followed by "Click to fix."', () => {
  let problems = 0;
  for (const [pill, state] of every()) {
    const r = core.pillText(pill, state, HOSTILE);
    if (r.level !== 'err' && r.level !== 'warn') continue;
    problems++;
    assert.match(r.text, /^[A-Z][^.?!]*[a-z)]\. Click to fix\.$/, `${pill}/${state}: ${r.text}`);
  }
  assert.ok(problems >= 12, 'every pill has problem states');
});

test('no text carries an error message, an address, a path or a product name', () => {
  for (const [pill, state] of every()) {
    const r = core.pillText(pill, state, HOSTILE);
    assert.doesNotMatch(r.text, LEAKS, `${pill}/${state}: ${r.text}`);
    assert.doesNotMatch(r.aria, LEAKS, `${pill}/${state}: ${r.aria}`);
    assert.ok(!r.text.includes('Anna'), `${pill}/${state}: no path`);
  }
});

test('ok and off texts are short and never ask for a fix', () => {
  for (const [pill, state] of every()) {
    const r = core.pillText(pill, state, { count: 1234, left: 40 });
    if (r.level === 'err' || r.level === 'warn') continue;
    assert.ok(r.text.length <= 40, `${pill}/${state} is short: ${r.text}`);
    assert.doesNotMatch(r.text, /Click to fix/);
  }
});

test('the aria label names the light first, then says what is wrong', () => {
  const r = core.pillText('notes', 'missing');
  assert.strictEqual(r.level, 'warn');
  assert.strictEqual(r.aria, `Notes library: ${r.text}`);
  assert.strictEqual(core.pillText('brain', 'unreachable').text, 'The assistant can’t think right now. Click to fix.');
  assert.strictEqual(core.pillText('voice', 'failed').text, 'Voice isn’t working right now. Click to fix.');
  assert.strictEqual(core.pillText('calendar', 'unreadable').text, 'Your schedule couldn’t be read. Click to fix.');
});

test('the levels: ok, off (no colour), warn, err', () => {
  assert.strictEqual(core.pillText('brain', 'ready').level, 'ok');
  assert.strictEqual(core.pillText('voice', 'off').level, '');
  assert.strictEqual(core.pillText('brain', 'unchecked').level, 'warn');
  assert.strictEqual(core.pillText('brain', 'signedOut').level, 'err');
  assert.strictEqual(core.pillText('usage', 'limited').level, 'err');
  assert.strictEqual(core.pillText('usage', 'low').level, 'warn');
});

test('counts are the only details that show, and only when they are numbers', () => {
  assert.strictEqual(core.pillText('notes', 'ready', { count: 12 }).text, 'Your notes library has 12 notes.');
  assert.strictEqual(core.pillText('notes', 'ready', { count: 1 }).text, 'Your notes library has 1 note.');
  assert.strictEqual(core.pillText('notes', 'ready', { count: '12; rm' }).text, 'Your notes library is ready.');
  assert.strictEqual(core.pillText('usage', 'ok', { left: 40 }).text, '40% of your Claude plan left.');
});

test('an unknown pill or state still reads as a plain problem with a fix', () => {
  const r = core.pillText('brain', 'something-new', HOSTILE);
  assert.strictEqual(r.level, 'err');
  assert.strictEqual(r.text, 'The assistant isn’t working right now. Click to fix.');
  const u = core.pillText('mystery', 'x');
  assert.match(u.text, /Click to fix\.$/);
});

test('app.js and usage.js word their lights only through pillText; no raw detail reaches a tooltip', () => {
  const app = fs.readFileSync(path.join(ROOT, 'renderer/js/app.js'), 'utf8');
  const usage = fs.readFileSync(path.join(ROOT, 'renderer/js/usage.js'), 'utf8');
  for (const call of app.match(/setPill\([^;]*/g) || []) {
    if (/^setPill\(id, /.test(call)) continue; // the definition
    assert.match(call, /^setPill\('#pill\w+', '(brain|voice|calendar|notes)', /, `a light set by pill and state: ${call}`);
    assert.doesNotMatch(call, /`|e\.message|baseUrl|FreeLLMAPI|VoiceStudio|Kokoro/, call);
  }
  assert.match(usage, /pillText\('usage'/);
  const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
  assert.match(html, /id="pillLlm" title="Assistant"><i><\/i>Assistant<\/button>/);
  assert.match(html, /id="pillKb" title="Notes library"><i><\/i>Notes library<\/button>/);
  assert.match(app, /const pillTargets = \{ pillLlm: 'brain', pillVoice: 'voice', pillCal: 'calendar', pillKb: 'obsidian', pillUsage: 'brain' \};/, 'click targets unchanged');
});

// Review of spec #17: the voice light said its reason was in Settings → Health, but nothing showed it there.
test('the offline voice\'s failure reason is a Health row (and nothing when it works)', () => {
  assert.strictEqual(core.offlineVoiceHealth(''), null);
  const row = core.offlineVoiceHealth('WebGPU device lost');
  assert.strictEqual(row.status, 'fail');
  assert.strictEqual(row.label, 'Offline voice');
  assert.match(row.detail, /WebGPU device lost/, 'Health is where the technical reason goes');
  assert.ok(row.fix);
  const system = fs.readFileSync(path.join(ROOT, 'renderer/js/settings/system.js'), 'utf8');
  assert.match(system, /offlineVoiceHealth\(state\.offlineVoiceError\)/, 'the Health card adds it to the checks');
  const app = fs.readFileSync(path.join(ROOT, 'renderer/js/app.js'), 'utf8');
  assert.match(app, /state\.offlineVoiceError = p\.message \|\| 'unknown error'/);
});
