// The diagnostic log's buffering (main/logger.js, audit #9): lines are written in batches, errors and
// reads flush at once, nothing is lost or reordered.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { stub, load, tmpDir } = require('./helpers');

const dir = tmpDir('nexus-log-');
stub({ electron: { app: { getPath: () => dir } } });
const log = load('main/logger.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const onDisk = () => (fs.existsSync(log.file()) ? fs.readFileSync(log.file(), 'utf8') : '');

test('info lines wait for the batch; an error writes everything at once, in order', () => {
  log.info('first', { n: 1 });
  log.info('second', { n: 2 });
  assert.doesNotMatch(onDisk(), /second/, 'buffered');
  log.error('third', new Error('boom'));
  const text = onDisk();
  assert.ok(text.indexOf('first') < text.indexOf('second') && text.indexOf('second') < text.indexOf('third'));
});

test('reading the log and flush() see every line logged so far', () => {
  log.info('fourth');
  assert.match(log.tail(10), /fourth/);
  log.info('fifth');
  log.flush();
  assert.match(onDisk(), /fifth/);
});

test('the batch is written on its own shortly after', async () => {
  log.info('sixth');
  await new Promise((r) => setTimeout(r, 400));
  assert.match(onDisk(), /sixth/);
});

test('every key format the app can hold is masked before it is written', () => {
  // Fake keys, put together at run time: written out whole, GitHub's secret scanning takes them for
  // real ones (it reported the Google and Tailscale ones). Each is a real prefix plus filler.
  const fill = (n) => 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'.slice(0, n);
  const keys = {
    anthropic: ['sk-ant-', 'api03-', fill(30)].join(''),
    openai: ['sk-', 'proj-', fill(32)].join(''),
    groq: ['gsk', '_', fill(40)].join(''),
    perplexity: ['pplx', '-', fill(40)].join(''),
    xai: ['xai', '-', fill(36)].join(''),
    openrouter: ['sk-or-', 'v1-', fill(36)].join(''),
    gemini: ['AI', 'za', 'Sy', fill(33)].join(''),
    github: ['gh', 'p_', fill(36)].join(''),
    tailscale: ['tskey', '-auth-', 'k', fill(12), '-', fill(26)].join(''),
    jwt: ['ey', 'J', fill(18), '.ey', 'J', fill(20), '.', fill(21)].join(''),
  };
  for (const [name, key] of Object.entries(keys)) {
    const out = log.redact(`failed with ${key} in it`);
    assert.ok(!out.includes(key.slice(-12)), `${name}: ${out}`);
  }
  assert.strictEqual(log.redact('mcp__claude_ai_Google_Calendar__list_events took 120 ms'), 'mcp__claude_ai_Google_Calendar__list_events took 120 ms', 'ordinary text stays');
});
