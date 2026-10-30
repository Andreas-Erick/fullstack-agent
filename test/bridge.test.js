// The local tool bridge (main/bridge.js) behind the app's MCP server: with tools on request one session
// is served by two servers, "core" (always loaded, with the approval prompt) and "more" (found with
// ToolSearch); together they list every allowed tool once.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load } = require('./helpers');

const tool = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } });
stub({ './tools': { TOOLS: ['calendar_get_events', 'memory_search', 'flashcards_decks', 'github_push', 'secret_tool'].map(tool), execute: async () => ({ ok: true, result: 'done' }), stringifyResult: (r) => String(r) } });
const bridge = load('main/bridge.js');

async function list(info, turn, set) {
  const res = await fetch(`${info.url}/list`, { method: 'POST', headers: { Authorization: `Bearer ${info.token}` }, body: JSON.stringify({ turn, set }) });
  return (await res.json()).map((t) => t.name);
}

test('core and more split the allowed tools; only core carries the approval prompt', async () => {
  const info = await bridge.start();
  const end = bridge.registerSession('t1', { allowed: ['calendar_get_events', 'memory_search', 'flashcards_decks', 'github_push'], core: ['calendar_get_events', 'memory_search'], getCtx: () => null, approve: async () => ({}) });
  assert.deepStrictEqual(await list(info, 't1', 'core'), ['calendar_get_events', 'memory_search', 'approval_prompt']);
  assert.deepStrictEqual(await list(info, 't1', 'more'), ['flashcards_decks', 'github_push'], 'the rest, never a tool the session was not given');
  assert.deepStrictEqual(await list(info, 't1', ''), ['calendar_get_events', 'memory_search', 'flashcards_decks', 'github_push', 'approval_prompt']);
  end();
  const single = bridge.registerSession('t2', { allowed: ['flashcards_decks'], getCtx: () => null, approve: async () => ({}) });
  assert.deepStrictEqual(await list(info, 't2', 'core'), ['flashcards_decks', 'approval_prompt'], 'one server: everything');
  single();
  bridge.stop();
});
