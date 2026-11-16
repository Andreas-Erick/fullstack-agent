// What a chat message shows (renderer/js/chatcore.js, the pure part of renderer/js/chat.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

let c;
test.before(async () => {
  const copy = path.join(tmpDir('nexus-chatcore-'), 'chatcore.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/chatcore.js'), copy);
  c = await import(pathToFileURL(copy).href);
});

test('tool chips: the app’s label, a connector’s, or the raw name; state and details', () => {
  const labels = { create_pdf: '📄 Created a PDF' };
  assert.strictEqual(c.toolLabel('create_pdf', labels), '📄 Created a PDF');
  assert.strictEqual(c.toolLabel('mcp__claude_ai_Todoist__find-tasks', labels), '🔌 Todoist · find tasks');
  assert.strictEqual(c.toolLabel('mcp__plugin_productivity_slack__send_message'), '🔌 slack · send message');
  assert.strictEqual(c.toolLabel('mcp__nexus__memory_save'), '🔧 mcp__nexus__memory_save', 'the app’s own MCP server is not a connector');
  const running = c.toolChip({ name: 'web_search', input: { query: 'weather' } });
  assert.strictEqual(running.state, 'running');
  assert.strictEqual(running.brief, '· weather');
  assert.match(running.detail, /running…$/);
  assert.strictEqual(c.toolChip({ name: 'x', input: {}, ok: false, preview: 'boom' }).state, 'fail');
  assert.match(c.toolChip({ name: 'x', input: {}, ok: true, preview: 'done' }).detail, /result: done/);
});

test('the input summary keeps long paths short and stops at 60 characters', () => {
  assert.strictEqual(c.briefInput({ path: 'C:\\Users\\me\\vault\\Notes\\today.md' }), '· Notes/today.md');
  assert.strictEqual(c.briefInput({ file_path: '/home/me/code/app.js' }), '· code/app.js');
  assert.strictEqual(c.briefInput({ query: 'x'.repeat(100) }).length, 62);
  assert.strictEqual(c.briefInput({}), '');
  assert.strictEqual(c.briefInput(null), '');
});

test('messages: Markdown for replies, plain text (what was typed) for the user, tags', () => {
  const reply = c.describeMessage({ role: 'assistant', content: '**hi**', toolCalls: [{ name: 'create_pdf', input: { title: 'Report' }, ok: true }] }, { create_pdf: '📄 PDF' });
  assert.strictEqual(reply.markdown, true);
  assert.strictEqual(reply.text, '**hi**');
  assert.deepStrictEqual(reply.tools.map((t) => [t.label, t.brief, t.state]), [['📄 PDF', '· Report', 'ok']]);
  const mine = c.describeMessage({ role: 'user', content: 'expanded skill steps…', display: '/reflect', skill: 'reflect', screen: true });
  assert.strictEqual(mine.markdown, false);
  assert.strictEqual(mine.text, '/reflect');
  assert.deepStrictEqual(mine.tags, ['⚡ skill /reflect', '🖥 screen shared']);
});

test('the HUD stamp names the agent, the time and the model', () => {
  assert.strictEqual(c.modelName('claude-opus-5-5'), 'opus 5.5');
  assert.strictEqual(c.modelName('gemini-2.5-flash'), 'gemini 2.5 flash');
  assert.strictEqual(c.stampText({ model: 'claude-sonnet-5-5' }, 'Siren', '14:32:05'), 'Siren · 14:32:05 · sonnet 5.5');
  assert.strictEqual(c.stampText({}, 'Siren', '14:32:05'), 'Siren · 14:32:05');
});

test('the spoken filler fits the tool', () => {
  assert.strictEqual(c.fillerGroup('web_search'), 'web');
  assert.strictEqual(c.fillerGroup('calendar_add'), 'calendar');
  assert.strictEqual(c.fillerGroup('daily_note_log'), 'vault');
  assert.strictEqual(c.fillerGroup('Grep'), 'code');
  assert.strictEqual(c.fillerGroup('routine_list'), 'other');
  assert.strictEqual(c.fillerFor('web_search', () => 0), 'Let me look that up.');
});

// A spoken message heard nothing for 4–11 s when the reply started with tools or long thinking.
test('an early filler for spoken requests, never for small talk or a word or two', () => {
  for (const t of ['When is my last Icelandic course before Christmas?', 'Can you switch to Ringmaster please?', 'Now can you create a master summary for the lecture?']) assert.ok(c.FILLERS.think.includes(c.earlyFiller(t, () => 0)), t);
  for (const t of ['How are you my friend?', 'Thanks a lot, that helps', 'Hey there Siren', 'Yes, please.', 'ok', 'Good morning!', 'thank’s so much']) assert.strictEqual(c.earlyFiller(t), null, t);
  // Every line, once, to make its audio ahead of time.
  const all = c.allFillers();
  assert.strictEqual(new Set(all).size, all.length);
  for (const list of Object.values(c.FILLERS)) for (const line of list) assert.ok(all.includes(line));
  assert.ok(c.EARLY_FILLER_MS >= 1000 && c.EARLY_FILLER_MS <= 3000);
});
