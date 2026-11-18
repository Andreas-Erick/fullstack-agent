// The Claude API conversation (main/llm.js anthropicHistory, audit #2): a bounded window, raw tool
// exchanges only for the most recent replies, always starting with a user turn.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load } = require('./helpers');

const anything = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : anything), apply: () => anything, construct: () => anything });
stub({ electron: anything });
const { anthropicHistory } = load('main/llm.js');

function conversation(turns) {
  const out = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'user', content: `question ${i}` });
    out.push({
      role: 'assistant',
      content: `answer ${i}`,
      raw: { provider: 'anthropic', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'web_fetch', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(5000) }] }, { role: 'assistant', content: `answer ${i}` }] },
    });
  }
  return out;
}

test('a long conversation is cut to a window that starts with the user', () => {
  const msgs = anthropicHistory(conversation(100), { limit: 60, rawReplies: 6 });
  assert.strictEqual(msgs[0].role, 'user');
  const texts = msgs.filter((m) => typeof m.content === 'string').map((m) => m.content);
  assert.ok(!texts.includes('question 0'), 'old turns are out of the window');
  assert.ok(texts.includes('question 99'));
});

test('only the last few replies keep their tool exchanges', () => {
  const msgs = anthropicHistory(conversation(20), { limit: 60, rawReplies: 3 });
  const toolResults = msgs.filter((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  assert.strictEqual(toolResults.length, 3);
  // Older replies are their text, not their 5 000-character tool results.
  const size = JSON.stringify(msgs).length;
  assert.ok(size < 30000, `small: ${size}`);
  assert.ok(msgs.some((m) => m.role === 'assistant' && m.content === 'answer 0'));
});

test('roles alternate (consecutive text turns are merged)', () => {
  const msgs = anthropicHistory([{ role: 'assistant', content: 'stray' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'c' }]);
  assert.deepStrictEqual(msgs.map((m) => m.role), ['user', 'assistant']);
  assert.strictEqual(msgs[0].content, 'a\n\nb');
});

// Attached files (main/attachments.js): their text is sent again only for the newest two messages that
// carry files; older ones keep the headers with the saved path, so a long chat doesn't resend every PDF.
test('the newest two messages with files keep their text; older ones only the headers', () => {
  const block = (n) => `<attachment index="1" kind="pdf" name="p${n}.pdf" size="4 MB" saved="C:\\att\\c1\\p${n}.pdf">\nEXTERNAL\nText extracted from the PDF.\n${`PDF ${n} `.repeat(3000)}\n</attachment>\n\nquestion ${n}`;
  const history = [];
  for (let n = 0; n < 4; n++) history.push({ role: 'user', content: block(n), display: `question ${n}`, attachments: [{ kind: 'pdf', name: `p${n}.pdf` }] }, { role: 'assistant', content: `answer ${n}` });
  history.push({ role: 'user', content: 'and without files?' });
  const users = anthropicHistory(history).filter((m) => m.role === 'user').map((m) => m.content);
  assert.deepStrictEqual(users.map((c) => c.includes('[Not repeated here')), [true, true, false, false, false]);
  assert.ok(users[0].includes('saved="C:\\att\\c1\\p0.pdf"') && users[0].endsWith('question 0'), 'the path and the words stay');
  assert.ok(users[3].includes('PDF 3 PDF 3'));
  assert.strictEqual(users[4], 'and without files?');
  assert.ok(anthropicHistory(history, { fullAttachments: 0 }).filter((m) => m.role === 'user').slice(0, 4).every((m) => m.content.includes('[Not repeated here')));
});
