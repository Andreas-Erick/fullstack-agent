// The launch check (main/smoke.js) never calls a real model: it runs after every change and in
// release.yml, on the user's own Claude account. Its seeded chats are already journaled, so the journal's
// sweep (main/journal.js, 20 s after start) never summarizes one, and the chat it opens is never warmed
// (main.js llm:prewarm). A seeded chat from 9 days ago was summarized by the model on every run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, tmpDir, quietLog } = require('./helpers');

const dir = tmpDir('nexus-smokemodel-');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
stub({ electron: { app: { getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => false } }, './logger': quietLog });
const store = load('main/store.js');
const calls = [];
stub({
  './store': { ...store, getSettings: async () => ({ journal: { enabled: true, idleMinutes: 15 }, obsidian: { enabled: true } }) },
  './llm': { complete: async (_s, prompt) => (calls.push(prompt), '{}') },
  './obsidian': { logSession: async () => {} },
  './persona': { jsonWithRetry: async () => ({ topic: 'Control' }) },
});
const journal = load('main/journal.js');
const smoke = load('main/smoke.js');

// The journal's sweep as if it ran a day later, when every seeded chat has long gone quiet.
async function sweepLater() {
  const realNow = Date.now;
  Date.now = () => realNow() + 86400000;
  try {
    await journal.sweep();
  } finally {
    Date.now = realNow;
  }
}

test('the seeded chats are already journaled: the journal never asks the model about them', async () => {
  smoke.seedChat(dir);
  const seeded = await store.listConversations();
  assert.ok(seeded.length >= 2, `${seeded.length} seeded chats`);
  await sweepLater();
  assert.deepStrictEqual(calls, []);
  // The same sweep does summarize a quiet chat that was never journaled (the check above isn't empty).
  const c = await store.createConversation('Control');
  c.messages = [{ role: 'user', content: 'a question' }, { role: 'assistant', content: 'an answer' }];
  c.updatedAt = Date.now() - 9 * 86400000;
  await store.saveConversation(c, { touch: false });
  await sweepLater();
  assert.strictEqual(calls.length, 1);
});

test('the chat the launch check opens is never warmed on a real model (main.js llm:prewarm)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8').replace(/\r\n/g, '\n');
  const handler = src.match(/handle\('llm:prewarm'[\s\S]*?\n {2}\}\);/)?.[0] || '';
  assert.ok(handler, 'the llm:prewarm handler');
  assert.match(handler, /if \(smoke\.active\) return false;/);
});
