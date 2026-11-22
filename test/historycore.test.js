// History's search, the pure part (renderer/js/historycore.mjs, through main/historycore.js): folding,
// query terms, what a message shows, matching, snippets, the status lines and the renderer's state.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../main/historycore');

const { fold, foldMap, terms, searchable, matchesAll, marks, plainText, messageText, docOf, matchConversation, snippet, hitStatus, resultSummary, hitsReducer, messageHits, listModel, afterDelete, afterUndo, rowTarget, LIST_PAGE, HITS, SNIPPET, MAX_MESSAGE, MAX_TERMS, MAX_TERM } = core;

test('fold: case, accents and compatibility forms', () => {
  assert.strictEqual(fold('Hörsaal'), 'horsaal');
  assert.strictEqual(fold('RÉSUMÉ'), 'resume');
  assert.strictEqual(fold('ﬁle'), 'file');
  assert.strictEqual(fold('İstanbul'), 'istanbul');
  assert.strictEqual(fold('Straße'), 'strasse');
  assert.strictEqual(fold('STRASSE'), 'strasse');
  assert.strictEqual(fold('ẞ'), 'ss');
  assert.strictEqual(fold('σας'), fold('ΣΑΣ'));
  assert.strictEqual(fold('σας'), 'σασ');
  assert.strictEqual(fold('Hello, World! 123 _x_ c++'), 'hello, world! 123 _x_ c++');
  assert.strictEqual(fold(null), '');
});

test('fold agrees with foldMap on mixed text', () => {
  const corpus = ['Grüße 😀 aus Köln', 'Ελληνικά ΣΟΦΙΑ', 'café déjà vu', '日本語のテキスト', 'ＡＢＣ ﬁ ß ẞ İ', 'plain ascii only'];
  for (const t of corpus) {
    assert.strictEqual(fold(t), foldMap(t).folded, t);
    assert.strictEqual(foldMap(t, { map: true }).folded, fold(t), t);
  }
  assert.strictEqual(fold('café'), fold('café'));
});

test('foldMap: each folded char maps back to the code point that made it', () => {
  const t = 'Großer ﬁle';
  const { folded, start, end } = foldMap(t, { map: true });
  assert.strictEqual(folded, 'grosser file');
  assert.strictEqual(start.length, folded.length);
  // 'ss' both come from 'ß' at index 3
  assert.deepStrictEqual([start[3], end[3], start[4], end[4]], [3, 4, 3, 4]);
  // 'fi' from the ligature at index 7
  const i = folded.indexOf('fi');
  assert.deepStrictEqual([start[i], end[i], start[i + 1], end[i + 1]], [7, 8, 7, 8]);
  // a combining mark folds to nothing
  const m = foldMap('éx', { map: true });
  assert.strictEqual(m.folded, 'ex');
  assert.deepStrictEqual(m.start, [0, 2]);
  // an emoji keeps both of its units
  const e = foldMap('a😀b', { map: true });
  assert.strictEqual(e.folded, 'a😀b');
  assert.deepStrictEqual([e.start[1], e.end[1], e.start[2], e.end[2]], [1, 3, 1, 3]);
  assert.deepStrictEqual(marks('Straße', terms('strasse')), [[0, 6]]);
});

test('terms: words, phrases, punctuation, limits', () => {
  assert.deepStrictEqual(terms('  PID  Tuning '), ['pid', 'tuning']);
  assert.deepStrictEqual(terms('"pid tuning" motor'), ['pid tuning', 'motor']);
  assert.deepStrictEqual(terms('“Hörsaal  eins” (later)'), ['horsaal eins', 'later']);
  assert.deepStrictEqual(terms('why, though?'), ['why', 'though']);
  assert.deepStrictEqual(terms('c++ some_function'), ['c++', 'some_function']);
  assert.deepStrictEqual(terms('Pid pid PID'), ['pid']);
  const many = terms(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '));
  assert.strictEqual(many.length, MAX_TERMS);
  assert.ok(terms('x'.repeat(150)).every((t) => t.length <= MAX_TERM));
  assert.deepStrictEqual(terms('a ab', { min: 2 }), ['ab']);
  assert.deepStrictEqual(terms('a ab'), ['a', 'ab']);
  assert.deepStrictEqual(terms('? ! ,'), []);
  assert.strictEqual(searchable('a'), false);
  assert.strictEqual(searchable('ab'), true);
  assert.strictEqual(searchable('   '), false);
  assert.strictEqual(searchable(null), false);
  assert.strictEqual(searchable('a b c'), false);
});

test('matchesAll and marks', () => {
  assert.strictEqual(matchesAll('Tuning the PID loop', terms('pid tuning')), true);
  assert.strictEqual(matchesAll('Tuning the PID loop', terms('"pid tuning"')), false);
  assert.strictEqual(matchesAll('Tuning the PID loop', terms('pid motor')), false);
  assert.strictEqual(matchesAll('anything', []), true);
  assert.deepStrictEqual(marks('Hörsaal', terms('horsaal')), [[0, 7]]);
  assert.deepStrictEqual(marks('Tuning the PID loop', terms('pid tuning')), [[0, 6], [11, 14]]);
  // overlapping and touching occurrences are merged
  assert.deepStrictEqual(marks('abcdef', ['abc', 'bcd', 'ef']), [[0, 6]]);
  assert.deepStrictEqual(marks('nothing here', terms('pid')), []);
  assert.ok(marks('ab '.repeat(100), ['ab']).length <= 40);
});

test('plainText: Markdown as the words a reader sees', () => {
  assert.strictEqual(plainText('**bold** and *it* and ~~gone~~'), 'bold and it and gone');
  assert.strictEqual(plainText('## A heading'), 'A heading');
  assert.strictEqual(plainText('> a quote'), 'a quote');
  assert.strictEqual(plainText('- one\n* two\n+ three\n1. four\n- [ ] task'), 'one two three four task');
  assert.strictEqual(plainText('see [the docs](https://example.com/x)'), 'see the docs');
  assert.strictEqual(plainText('[[Notes/Lab/Week 3.md]] and [[Physics|my notes]]'), 'Week 3 and my notes');
  assert.strictEqual(plainText('before ![a chart](chart.png) after'), 'before after');
  assert.strictEqual(plainText('```python\nprint(snake_case)\n```'), 'print(snake_case)');
  assert.strictEqual(plainText('| a | b |\n|---|:-:|\n| c | d |'), 'a · b c · d');
  assert.strictEqual(plainText('call `some_function()` now'), 'call some_function() now');
  assert.strictEqual(plainText('2 * 3 * 4'), '2 * 3 * 4');
  assert.strictEqual(plainText('<b>bold</b> a < b'), 'bold a < b');
  assert.strictEqual(plainText('  many \n\n  spaces\t here '), 'many spaces here');
});

test('messageText: what the bubble shows', () => {
  // a /skill is found by what was typed, not its steps
  const skill = { role: 'user', display: '/plan my week', content: 'Steps: open the calendar, list priorities…', skill: 'plan' };
  assert.ok(fold(messageText(skill)).includes('week'));
  assert.ok(!fold(messageText(skill)).includes('priorities'));
  // a routine's run by its name, not its prompt
  const run = { role: 'user', display: '⏰ Morning briefing', content: 'Check the weather and summarise the inbox', routine: 'r1' };
  assert.ok(fold(messageText(run)).includes('morning'));
  assert.ok(!fold(messageText(run)).includes('weather'));
  assert.strictEqual(messageText({ role: 'user', content: 'secret prompt', hidden: true }), '');
  assert.strictEqual(messageText({ role: 'tool', content: 'x' }), '');
  assert.strictEqual(messageText({ role: 'system', content: 'x' }), '');
  assert.strictEqual(messageText({ role: 'assistant', content: '*(stopped)*' }), '');
  assert.strictEqual(messageText({ role: 'assistant', content: 'The **answer**', display: 'ignored' }), 'The answer');
  assert.strictEqual(messageText({ role: 'assistant', content: 'x'.repeat(MAX_MESSAGE + 500) }).length, MAX_MESSAGE);
  assert.strictEqual(messageText({ role: 'user', display: 'hi', content: '<file>sampling theorem…</file>\n\nhi', attachments: [{ kind: 'pdf', name: 'a.pdf' }] }), 'hi');
  // files sent without a word: nothing to find (the content is the files' text and a placeholder)
  const filesOnly = { role: 'user', display: '', content: '<attachment name="a.pdf">Slide 4: the sampling theorem.</attachment>\n\n[The user sent only these attachments, without a message.]', attachments: [{ kind: 'pdf', name: 'a.pdf' }] };
  assert.strictEqual(messageText(filesOnly), '');
  assert.strictEqual(matchConversation(docOf({ messages: [filesOnly] }), terms('sampling')), null);
  assert.strictEqual(messageText({ role: 'user', content: 'typed, no files' }), 'typed, no files');
  assert.strictEqual(messageText(null), '');
  assert.strictEqual(messageText({ role: 'assistant', content: [{ type: 'text', text: 'blocks' }] }), '');
});

test('docOf: one entry per message with text', () => {
  const conv = {
    updatedAt: 5000,
    messages: [
      { id: 'm1', role: 'user', content: 'Hello', createdAt: 1000 },
      { id: 'm2', role: 'assistant', content: 'Hi', persona: 'Ada' },
      { role: 'assistant', content: '' },
      { id: 'm4', role: 'user', content: 'quiet', hidden: true },
    ],
  };
  const doc = docOf(conv);
  assert.strictEqual(doc.length, 2);
  assert.deepStrictEqual(doc[0], { id: 'm1', role: 'user', at: 1000, persona: '', plain: 'Hello', folded: 'hello' });
  assert.strictEqual(doc[1].at, 5000); // no createdAt: the conversation's updatedAt
  assert.strictEqual(doc[1].persona, 'Ada');
  assert.strictEqual(docOf({ messages: [{ role: 'user', content: 'x' }] })[0].id, null);
});

test('matchConversation: every term somewhere, the best message', () => {
  const doc = docOf({
    updatedAt: 1,
    messages: [
      { id: 'a', role: 'user', content: 'How do I tune a PID controller?' },
      { id: 'b', role: 'assistant', content: 'Start with the motor model.' },
      { id: 'c', role: 'assistant', content: 'PID tuning for the motor: PID gains, PID limits.' },
      { id: 'd', role: 'user', content: 'and the motor again' },
    ],
  });
  const m = matchConversation(doc, terms('pid motor'));
  assert.strictEqual(doc[m.index].id, 'c'); // both terms in one message
  assert.strictEqual(m.hits, 4);
  assert.strictEqual(matchConversation(doc, terms('pid gearbox')), null);
  assert.strictEqual(matchConversation(doc, []), null);
  // same distinct terms: the most occurrences; then the earliest
  const d2 = docOf({ messages: [{ id: 'x', role: 'user', content: 'pid once' }, { id: 'y', role: 'user', content: 'pid pid twice' }, { id: 'z', role: 'user', content: 'pid pid again' }] });
  assert.strictEqual(d2[matchConversation(d2, ['pid']).index].id, 'y');
  // terms spread over two messages still match
  const d3 = docOf({ messages: [{ id: 'p', role: 'user', content: 'about the capacitor' }, { id: 'q', role: 'assistant', content: 'in the lab report' }] });
  assert.ok(matchConversation(d3, terms('capacitor lab')));
});

test('snippet: around the words, cut at spaces, marks inside', () => {
  const short = snippet('A short capacitor note', terms('capacitor'));
  assert.strictEqual(short.text, 'A short capacitor note');
  assert.deepStrictEqual(short.marks, [[8, 17]]);
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau';
  const long = `${words} ${words} the capacitor charges slowly ${words} ${words}`;
  const s = snippet(long, terms('capacitor'));
  assert.ok(s.text.startsWith('…') && s.text.endsWith('…'), s.text);
  assert.ok(s.text.length <= SNIPPET.width + 2, `${s.text.length}`);
  assert.ok(s.marks.length >= 1);
  assert.ok(s.marks[0][0] <= SNIPPET.lead + 2, `${s.marks[0][0]}`);
  for (const [a, b] of s.marks) assert.ok(terms('capacitor').includes(fold(s.text.slice(a, b))));
  // the cuts sit at spaces (within 15 characters)
  assert.ok(/^… ?\S/.test(s.text) && long.includes(s.text.slice(1, -1).trim()));
  const inner = s.text.slice(1, -1);
  const at = long.indexOf(inner);
  assert.ok(at > 0 && /\s/.test(long[at - 1]), 'starts after a space');
  assert.ok(/\s/.test(long[at + inner.length]), 'ends before a space');
  // the window with more distinct terms wins
  const two = snippet(`pid ${words} ${words} pid and motor together ${words}`, terms('pid motor'));
  assert.ok(fold(two.text).includes('pid and motor'), two.text);
  // a 300-character token is cut hard
  const token = snippet(`${'x'.repeat(150)}capacitor${'y'.repeat(150)}`, terms('capacitor'));
  assert.ok(token.text.length <= SNIPPET.width + 2);
  assert.strictEqual(fold(token.text.slice(token.marks[0][0], token.marks[0][1])), 'capacitor');
  // never half a surrogate pair
  for (const pre of ['', 'x', 'xa']) {
    for (const post of ['', 'z']) {
      // 'acapacitor': the match starts an odd number of units after the emoji, so the cut lands inside one
      const emoji = snippet(`${'😀'.repeat(60)}${pre}capacitor${post}${'😀'.repeat(60)}`, terms('capacitor'));
      assert.ok(emoji.text.includes('capacitor'));
      for (let i = 0; i < emoji.text.length; i++) {
        const c = emoji.text.charCodeAt(i);
        const next = emoji.text.charCodeAt(i + 1);
        const prev = emoji.text.charCodeAt(i - 1);
        if (c >= 0xd800 && c <= 0xdbff) assert.ok(next >= 0xdc00 && next <= 0xdfff, `high surrogate without its pair (${pre}|${post})`);
        if (c >= 0xdc00 && c <= 0xdfff) assert.ok(prev >= 0xd800 && prev <= 0xdbff, `low surrogate without its pair (${pre}|${post})`);
      }
    }
  }
  // no occurrence: the start
  const none = snippet(long, terms('gearbox'));
  assert.ok(none.text.startsWith(long.slice(0, SNIPPET.width)));
  assert.deepStrictEqual(none.marks, []);
  // near the end: shifted left to keep the width
  const end = snippet(`${words} ${words} capacitor`, terms('capacitor'));
  assert.ok(end.text.endsWith('capacitor') && end.text.length >= SNIPPET.width - 15);
});

test('hitStatus and resultSummary: the exact lines', () => {
  assert.strictEqual(hitStatus({ state: 'searching' }), 'Searching the messages…');
  assert.strictEqual(hitStatus({ state: 'error' }), 'Couldn’t search the messages.');
  assert.strictEqual(hitStatus({ state: 'idle' }), '');
  assert.strictEqual(hitStatus({ state: 'done', done: true }), '');
  assert.strictEqual(hitStatus({ state: 'done', done: false, capped: true, shown: 30 }), 'The 30 newest chats with these words.');
  assert.strictEqual(hitStatus({ state: 'done', done: false, capped: true, shown: 1 }), 'The 1 newest chat with these words.');
  assert.strictEqual(hitStatus({ state: 'done', done: false, scanned: 120, total: 2000 }), 'Looked through the newest 120 of 2,000 chats.');
  assert.strictEqual(hitStatus({ state: 'done', done: true, unreadable: 1 }), '1 chat couldn’t be read.');
  assert.strictEqual(hitStatus({ state: 'done', done: false, scanned: 5, total: 9, unreadable: 2 }), 'Looked through the newest 5 of 9 chats. 2 chats couldn’t be read.');
  assert.strictEqual(resultSummary({ titles: 2, shown: 3 }), '2 chats by title and 3 more by what was said.');
  assert.strictEqual(resultSummary({ titles: 1, shown: 1 }), '1 chat by title and 1 more by what was said.');
  assert.strictEqual(resultSummary({ titles: 0, shown: 1 }), '1 chat by what was said.');
  assert.strictEqual(resultSummary({ titles: 4, shown: 0 }), '4 chats by title.');
  assert.strictEqual(resultSummary({ titles: 0, shown: 0 }), 'No matches.');
  assert.strictEqual(resultSummary({ state: 'error' }), 'Couldn’t search the messages.');
  assert.strictEqual(resultSummary({ state: 'searching', titles: 2 }), '');
  // a search that stopped early says so, as the list's status row does ("No matches." only when done)
  assert.strictEqual(resultSummary({ titles: 0, shown: 0, done: false, scanned: 120, total: 2000 }), 'No matches so far. Looked through the newest 120 of 2,000 chats.');
  assert.strictEqual(resultSummary({ titles: 2, shown: 3, done: false, scanned: 5, total: 9 }), '2 chats by title and 3 more by what was said. Looked through the newest 5 of 9 chats.');
  assert.strictEqual(resultSummary({ titles: 1, shown: 28, found: 30, done: false, capped: true }), '1 chat by title and 28 more by what was said. The 30 newest chats with these words.');
  assert.strictEqual(resultSummary({ titles: 0, shown: 1, unreadable: 2 }), '1 chat by what was said. 2 chats couldn’t be read.');
});

test('hitsReducer and messageHits: the window’s search state', () => {
  const item = (id) => ({ id, title: id, snippet: { text: '', marks: [] } });
  let h = hitsReducer(HITS, { type: 'query', query: 'pid', searchable: true });
  assert.strictEqual(h.state, 'searching');
  assert.strictEqual(h.token, 1);
  // an old token's result is ignored
  assert.strictEqual(hitsReducer(h, { type: 'result', token: 0, result: { items: [item('a')], done: true } }), h);
  // superseded is ignored
  assert.strictEqual(hitsReducer(h, { type: 'result', token: 1, result: { superseded: true } }), h);
  h = hitsReducer(h, { type: 'result', token: 1, result: { items: [item('a'), item('b')], done: false, capped: true, cursor: { updatedAt: 5, id: 'b' }, scanned: 10, total: 40, unreadable: 1 } });
  assert.strictEqual(h.state, 'done');
  assert.deepStrictEqual(h.items.map((x) => x.id), ['a', 'b']);
  assert.deepStrictEqual(h.cursor, { updatedAt: 5, id: 'b' });
  // more, then append: deduped by id, scanned and unreadable add up
  h = hitsReducer(h, { type: 'more' });
  assert.strictEqual(h.state, 'searching');
  h = hitsReducer(h, { type: 'result', token: 1, append: true, result: { items: [item('b'), item('c')], done: true, cursor: null, scanned: 30, total: 40, unreadable: 0 } });
  assert.deepStrictEqual(h.items.map((x) => x.id), ['a', 'b', 'c']);
  assert.strictEqual(h.scanned, 40);
  assert.strictEqual(h.unreadable, 1);
  assert.strictEqual(h.cursor, null);
  assert.strictEqual(h.done, true);
  // forget
  h = hitsReducer(h, { type: 'forget', id: 'b' });
  assert.deepStrictEqual(h.items.map((x) => x.id), ['a', 'c']);
  // messageHits: stale when the box says something else
  assert.strictEqual(messageHits(h, 'pid').stale, false);
  assert.strictEqual(messageHits(h, 'pid tuning').stale, true);
  assert.strictEqual(messageHits(h, 'p'), null);
  assert.strictEqual(messageHits(HITS, 'pid'), null);
  // only chats still listed: after Settings → Clear all conversations the hits don't linger
  assert.deepStrictEqual(messageHits(h, 'pid', new Set(['c'])).items.map((x) => x.id), ['c']);
  assert.deepStrictEqual(messageHits(h, 'pid', new Map()).items, []);
  assert.deepStrictEqual(h.items.map((x) => x.id), ['a', 'c']); // the state itself is untouched
  // an error counts for its own token only
  const e = hitsReducer(hitsReducer(h, { type: 'query', query: 'motor', searchable: true }), { type: 'error', token: h.token, message: 'x' });
  assert.strictEqual(e.state, 'searching');
  assert.strictEqual(hitsReducer(e, { type: 'error', token: e.token, message: 'boom' }).state, 'error');
  // a query that isn't searchable drops everything and bumps the token
  const idle = hitsReducer(h, { type: 'query', query: 'p', searchable: false });
  assert.strictEqual(idle.state, 'idle');
  assert.deepStrictEqual(idle.items, []);
  assert.strictEqual(idle.token, h.token + 1);
  // a searchable query keeps the old rows (dimmed) while it runs
  const next = hitsReducer(h, { type: 'query', query: 'pid loop', searchable: true });
  assert.deepStrictEqual(next.items.map((x) => x.id), ['a', 'c']);
  assert.strictEqual(next.state, 'searching');
  assert.strictEqual(messageHits(next, 'pid loop').stale, true); // they are the last query's
  // ...but a failed search doesn't pass them off as matches for the new words
  const failed = hitsReducer(next, { type: 'error', token: next.token, message: 'boom' });
  assert.deepStrictEqual(messageHits(failed, 'pid loop').items, []);
  // while a failed "Search older chats" keeps what this query already found
  let more = hitsReducer(HITS, { type: 'query', query: 'pid', searchable: true });
  more = hitsReducer(more, { type: 'result', token: more.token, result: { items: [item('a')], done: false, cursor: { updatedAt: 1, id: 'a' }, scanned: 1, total: 2 } });
  more = hitsReducer(hitsReducer(more, { type: 'more' }), { type: 'error', token: more.token, message: 'boom' });
  assert.strictEqual(more.state, 'error');
  assert.deepStrictEqual(messageHits(more, 'pid').items.map((x) => x.id), ['a']);
  assert.strictEqual(messageHits(more, 'pid').stale, false);
});

// ------------------------------------------------------------------ History's list (history.js drawList)
const DAY = 86400000;
const D0 = new Date(2026, 10, 21).getTime(); // local midnight
const conv = (id, title, updatedAt) => ({ id, title, updatedAt, count: 2 });
const labels = (m) => m.groups.map((g) => `${g.label}:${g.items.map((c) => c.id).join(',')}`);

test('listModel: date groups, newest page first, Show more counts the older ones', () => {
  const list = [conv('a', 'PID tuning', D0 + 1000), conv('b', 'Lunch', D0 - 1000), conv('c', 'Résumé', D0 - 3 * DAY), conv('d', 'Old', D0 - 30 * DAY), conv('e', 'No time')];
  let m = listModel(list, { startToday: D0 });
  assert.deepStrictEqual(labels(m), ['Today:a', 'Yesterday:b', 'This week:c', 'Earlier:d'], 'an entry without a time is in no group, as before');
  assert.strictEqual(m.more, 0);
  assert.strictEqual(m.searched, false);
  assert.strictEqual(m.empty, '');
  assert.deepStrictEqual(m.counts, { titles: 5, shown: 0, found: 0 });
  // A page at a time: Show more raises the limit by LIST_PAGE.
  m = listModel(list, { startToday: D0, limit: 2 });
  assert.deepStrictEqual(labels(m), ['Today:a', 'Yesterday:b']);
  assert.strictEqual(m.more, 3);
  assert.strictEqual(LIST_PAGE, 100);
  const many = Array.from({ length: 250 }, (_, i) => conv(`k${i}`, `Chat ${i}`, D0 - i * 1000));
  assert.strictEqual(listModel(many, { startToday: D0 }).more, 150);
  assert.strictEqual(listModel(many, { startToday: D0, limit: 2 * LIST_PAGE }).more, 50);
  // Titles: every word, accent- and case-blind.
  m = listModel(list, { query: 'resume', startToday: D0 });
  assert.deepStrictEqual(labels(m), ['This week:c']);
  assert.deepStrictEqual(m.words, ['resume']);
});

test('listModel: the empty line, and message hits under the titles', () => {
  assert.strictEqual(listModel([], {}).empty, 'No conversations yet.');
  const list = [conv('a', 'PID tuning', D0), conv('b', 'Lunch', D0), conv('c', 'Garden', D0)];
  assert.strictEqual(listModel(list, { query: 'zebra', startToday: D0 }).empty, 'No matches.');
  const item = (id) => ({ id, messageId: `m-${id}`, snippet: { text: 'pid loop', marks: [[0, 3]] } });
  let h = hitsReducer(HITS, { type: 'query', query: 'pid', searchable: true });
  // Searching: no "No matches." yet, the rows dimmed.
  let m = listModel(list, { query: 'pid', hits: h, startToday: D0 });
  assert.strictEqual(m.stale, true);
  assert.strictEqual(m.status, 'Searching the messages…');
  h = hitsReducer(h, { type: 'result', token: h.token, result: { items: [item('a'), item('b'), item('gone')], done: false, capped: false, cursor: { updatedAt: 1, id: 'b' }, scanned: 3, total: 9 } });
  m = listModel(list, { query: 'pid', hits: h, startToday: D0 });
  // 'a' is already found by its title, 'gone' isn't listed any more (deleted since).
  assert.deepStrictEqual(m.found.map((x) => x.conv.id), ['b']);
  assert.strictEqual(m.found[0].hit.messageId, 'm-b');
  assert.strictEqual(m.older, true, 'Search older chats continues from the cursor');
  assert.strictEqual(m.stale, false);
  assert.match(m.status, /Looked through the newest 3 of 9 chats/);
  assert.deepStrictEqual(m.counts, { titles: 1, shown: 1, found: 2 });
  assert.strictEqual(m.empty, '');
  // Nothing anywhere, but the search stopped early: never "No matches."
  const none = hitsReducer(hitsReducer(HITS, { type: 'query', query: 'zebra', searchable: true }), { type: 'result', token: 1, result: { items: [], done: false, cursor: { updatedAt: 1, id: 'x' } } });
  assert.strictEqual(listModel(list, { query: 'zebra', hits: none, startToday: D0 }).empty, '');
  // Done: no cursor, nothing more.
  const done = hitsReducer(hitsReducer(HITS, { type: 'query', query: 'zebra', searchable: true }), { type: 'result', token: 1, result: { items: [], done: true } });
  const md = listModel(list, { query: 'zebra', hits: done, startToday: D0 });
  assert.strictEqual(md.older, false);
  assert.strictEqual(md.empty, 'No matches.');
  // Words that aren't searchable show titles only.
  assert.strictEqual(listModel(list, { query: 'p', hits: h, startToday: D0 }).searched, false);
});

test('afterDelete: focus on the next row, else the one before, else the search; cancelled: the row itself', () => {
  const rows = [{ id: 'a', kind: 'title' }, { id: 'b', kind: 'title' }, { id: 'c', kind: 'hit' }];
  assert.deepStrictEqual(afterDelete(rows, 'b'), { next: { id: 'c', kind: 'hit', part: 'open' }, self: { id: 'b', kind: 'title', part: 'open' } });
  assert.deepStrictEqual(afterDelete(rows, 'c').next, { id: 'b', kind: 'title', part: 'open' });
  assert.strictEqual(afterDelete([{ id: 'a', kind: 'title' }], 'a').next, null);
  assert.strictEqual(afterDelete([], 'a').next, null);
});

test('afterDelete: a chat listed twice (by title and in messages) hides both rows, so the focus skips its other row', () => {
  const rows = [{ id: 'a', kind: 'title' }, { id: 'b', kind: 'title' }, { id: 'c', kind: 'hit' }, { id: 'b', kind: 'hit' }];
  assert.deepStrictEqual(afterDelete(rows, 'b').next, { id: 'c', kind: 'hit', part: 'open' });
  assert.deepStrictEqual(afterDelete([{ id: 'a', kind: 'title' }, { id: 'b', kind: 'title' }, { id: 'b', kind: 'hit' }], 'b').next, { id: 'a', kind: 'title', part: 'open' });
  assert.strictEqual(afterDelete([{ id: 'b', kind: 'title' }, { id: 'b', kind: 'hit' }], 'b').next, null);
});

test('afterUndo: the focus goes to the chat that came back, on the row it was deleted from; gone from the list (another search): null', () => {
  const rows = [{ id: 'a', kind: 'title' }, { id: 'b', kind: 'title' }, { id: 'b', kind: 'hit' }];
  assert.deepStrictEqual(afterUndo(rows, 'b', 'hit'), { id: 'b', kind: 'hit', part: 'open' });
  assert.deepStrictEqual(afterUndo(rows, 'b', 'title'), { id: 'b', kind: 'title', part: 'open' });
  assert.deepStrictEqual(afterUndo([{ id: 'b', kind: 'title' }], 'b', 'hit'), { id: 'b', kind: 'title', part: 'open' }, 'its other row when the hit is gone');
  assert.strictEqual(afterUndo([{ id: 'a', kind: 'title' }], 'b', 'title'), null);
  assert.strictEqual(afterUndo(null, 'b', 'title'), null);
});

test('rowTarget: ↑ ↓ Home End in the list, ↑ from the first to the search', () => {
  assert.strictEqual(rowTarget('ArrowDown', 0, 3), 1);
  assert.strictEqual(rowTarget('ArrowDown', 2, 3), 2, 'past the last stays on it');
  assert.strictEqual(rowTarget('ArrowUp', 1, 3), 0);
  assert.strictEqual(rowTarget('ArrowUp', 0, 3), -1);
  assert.strictEqual(rowTarget('Home', 2, 3), 0);
  assert.strictEqual(rowTarget('End', 0, 3), 2);
  assert.strictEqual(rowTarget('Delete', 0, 3), undefined);
  assert.strictEqual(rowTarget('Enter', 0, 3), undefined);
});
