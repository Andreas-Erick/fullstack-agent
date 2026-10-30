// "Where we left off" (main/handoff.js): the note on closing, its fallbacks and how it is offered.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

const dir = tmpDir('nexus-handoff-');
const now = Date.now();
const convs = {
  setup: { id: 'setup', title: 'Setup', setup: true, updatedAt: now, messages: [{ role: 'user', content: 'my name is X' }] },
  a: { id: 'a', title: 'Fix calendar sync', updatedAt: now - 1000, messages: [{ role: 'user', content: 'Why does the iCal feed fail?' }, { role: 'assistant', content: 'The URL returns 403.' }] },
  b: { id: 'b', title: 'Older chat', updatedAt: now - 5000, messages: [{ role: 'user', content: 'hi' }] },
};
let llmImpl = async () => '';
let llmCalls = 0;
const vaultWrites = [];
stub({
  './store': fileStore(dir, {
    getSettings: async () => ({ llm: { provider: 'anthropic' }, obsidian: { enabled: true } }),
    listConversations: async () => Object.values(convs).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length, ...(c.setup ? { setup: true } : {}) })).sort((x, y) => y.updatedAt - x.updatedAt),
    getConversation: async (id) => convs[id] || null,
  }),
  './logger': quietLog,
  './llm': { complete: (...a) => (llmCalls++, llmImpl(...a)) },
  './persona': { extractJson: (t) => JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)) },
  './obsidian': { vaultPath: async () => dir, writeNote: async (rel, text) => vaultWrites.push({ rel, text }) },
});
const handoff = load('main/handoff.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('writes an AI note for the latest real conversation', async () => {
  llmImpl = async (_s, prompt) => {
    assert.ok(prompt.includes('iCal feed') && !prompt.includes('my name is X'), 'transcript of the latest non-setup conversation');
    return 'Sure: {"topic":"Calendar sync","summary":"The iCal URL returns 403.","openThreads":["Why 403?"],"nextSteps":["Regenerate the link","Test again"]}';
  };
  const note = await handoff.write();
  assert.strictEqual(note.source, 'ai');
  assert.strictEqual(note.conversationId, 'a');
  assert.ok(note.others.some((o) => o.id === 'b'));
  assert.strictEqual(vaultWrites[0].rel, 'Where We Left Off.md');
  const block = await handoff.promptBlock();
  assert.ok(block.includes('Where you left off') && block.includes('- Test again'));
});



test('nothing new since the last note: kept, no model call', async () => {
  llmCalls = 0;
  const before = await handoff.read();
  const again = await handoff.write();
  assert.strictEqual(llmCalls, 0);
  assert.strictEqual(again.at, before.at);
});

test('Skip and model errors fall back to a basic note', async () => {
  convs.a.updatedAt = Date.now() + 10;
  convs.a.messages.push({ role: 'user', content: 'ok, regenerate it please' });
  llmImpl = () => new Promise(() => {});
  const t0 = Date.now();
  const pending = handoff.write({ interrupted: true });
  setTimeout(() => handoff.skip(), 100);
  const note = await pending;
  assert.strictEqual(note.source, 'basic');
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(note.summary.includes('regenerate it please') && note.summary.includes('still running'));

  convs.a.updatedAt = Date.now() + 20;
  llmImpl = async () => {
    throw new Error('rate limited');
  };
  assert.strictEqual((await handoff.write()).source, 'basic');
});

test('dismissed and old notes', async () => {
  await handoff.dismiss();
  assert.strictEqual((await handoff.read()).dismissed, true);
  const f = path.join(dir, 'handoff.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), at: Date.now() - 15 * 24 * 3600000 }));
  assert.strictEqual(await handoff.read(), null);
  assert.strictEqual(await handoff.promptBlock(), '');
});

// A note that said "who I am … as Siren" went into every persona's prompt, and the Ringmaster then
// answered "I'm Siren, speaking as myself". The note names no persona; reading it, the active one stays itself.
test('the note never decides who the next persona is', async () => {
  let asked = '';
  llmImpl = async (_s, prompt) => ((asked = prompt), '{"topic":"Persona chat","summary":"We talked about who I am as Siren."}');
  convs.a.updatedAt = Date.now() + 1000;
  await handoff.write();
  assert.match(asked, /call yourself "the assistant", never by a persona's name/);
  assert.match(asked, /leave out who you are, which persona spoke and any switching/);
  const block = await handoff.promptBlock('Ringmaster');
  assert.match(block, /the handoff note the assistant wrote/);
  assert.match(block, /not who you are: you are Ringmaster, whatever its "I" or any name in it says/);
  assert.doesNotMatch(await handoff.promptBlock(), /you are Ringmaster/);
});
