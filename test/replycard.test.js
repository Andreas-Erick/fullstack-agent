// The Face layout's reply card (renderer/js/replycard.js): what it shows and when it goes, driven through
// the presenter's interface (chat.js only paints its decisions).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const ESM = tmpDir('nexus-replycard-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
for (const f of ['replycard.js', 'chatcore.js', 'braintable.mjs']) fs.copyFileSync(path.join(ROOT, 'renderer/js', f), path.join(ESM, f));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));

let rc;
test.before(async () => {
  rc = await import(pathToFileURL(path.join(ESM, 'replycard.js')).href);
});

function setup(face = true) {
  const layout = { face };
  const card = rc.createReplyCard({ isFace: () => layout.face });
  return { card, layout };
}

// The rule as CLAUDE.md states it, written out on its own: the card shows the reply as it is written when it
// isn't spoken or the voice reached its limit, else when it is done; a failure always; a stop only where it
// was being read; never in another layout, never after the user closed it during this reply.
function expected({ face, spoken, capped, closed, outcome, words }) {
  const liveOnCard = face && !closed && (!spoken || capped);
  const frame = !face ? 'bubble' : liveOnCard ? 'card' : null;
  let end = null;
  if (face && !closed) {
    if (outcome === 'done') end = words ? 'reply' : 'hide';
    else if (outcome === 'failed') end = 'error';
    else if (liveOnCard) end = 'stopped';
  }
  return { frame, end, onScreen: !face || !closed };
}

test('a reply: layout × spoken × capped × closed × outcome', () => {
  const rows = [];
  for (const face of [true, false])
    for (const spoken of [true, false])
      for (const capped of [true, false])
        for (const closed of [true, false])
          for (const outcome of ['done', 'failed', 'stopped'])
            for (const words of outcome === 'done' ? [true, false] : [true]) rows.push({ face, spoken, capped, closed, outcome, words });
  for (const row of rows) {
    const where = JSON.stringify(row);
    const { card } = setup(row.face);
    const turn = { id: 'r1' };
    card.hide(); // the message went out
    if (row.closed) card.close(turn);
    card.text(turn, { spoken: row.spoken });
    const f = card.frame(turn, { text: 'Hello', capped: row.capped });
    const want = expected(row);
    assert.strictEqual(f.render, want.frame, `${where}: frame`);
    if (f.render === 'card') {
      assert.strictEqual(f.decision.card.kind, 'live', where);
      assert.strictEqual(f.decision.card.follow, true, where);
      assert.strictEqual(f.decision.card.text, 'Hello', where);
    } else assert.strictEqual(f.decision, null, where);
    const message = { id: 'a1', role: 'assistant', content: row.words ? 'Hello there' : '  ' };
    const e = card.ended(turn, { outcome: row.outcome, text: 'Hello', message: row.outcome === 'done' ? message : null, error: '429 rate limit' });
    assert.strictEqual(e.onScreen, want.onScreen, `${where}: onScreen`);
    const got = !e.decision ? null : e.decision.type === 'hide' ? 'hide' : e.decision.card.kind;
    assert.strictEqual(got, want.end, `${where}: end`);
    if (got === 'reply') assert.deepStrictEqual([e.decision.card.text, e.decision.card.reply, card.at], ['Hello there', message, 'a1'], where);
    if (got === 'error') assert.strictEqual(e.decision.card.error, '429 rate limit', where);
    if (got) assert.strictEqual(card.shown, got !== 'hide', where);
  }
});

test('a spoken reply comes onto the card when the voice reaches its limit, and follows it from then on', () => {
  const { card } = setup();
  const t = {};
  card.text(t, { spoken: true });
  assert.strictEqual(card.frame(t, { capped: false }).render, null, 'spoken: nothing on the card, nothing rendered');
  assert.strictEqual(card.frame(t, { capped: true }).render, 'card', 'past speakLimit: the rest is on the screen');
  // A retract's speaker.stop() clears capped: once up, the card still follows the text.
  assert.strictEqual(card.frame(t, { capped: false }).render, 'card');
  const e = card.ended(t, { outcome: 'stopped', text: '' });
  assert.deepStrictEqual([e.decision.card.kind, e.decision.card.text], ['stopped', '*(stopped)*']);
});

test('closed by the user, it stays away for the rest of that reply; the next reply starts over', () => {
  const { card } = setup();
  const a = {};
  card.text(a);
  assert.strictEqual(card.frame(a, { text: 'x' }).render, 'card');
  assert.deepStrictEqual(card.close(a), { type: 'hide' });
  assert.strictEqual(card.shown, false);
  assert.strictEqual(card.frame(a, { text: 'xy' }).render, null, 'not back with the next frame');
  assert.strictEqual(card.ended(a, { outcome: 'failed', error: 'boom' }).decision, null, 'nor with its failure');
  assert.strictEqual(card.ended(a, { outcome: 'failed' }).onScreen, false, 'the failure is out of view: a notice with the buttons');
  const b = {};
  card.hide();
  card.text(b);
  assert.strictEqual(card.frame(b, { text: 'y' }).render, 'card', 'the next reply');
});

test('closing with no reply running does not keep the next one away; New chat mid-reply keeps its stop away', () => {
  const { card } = setup();
  card.close(null);
  const t = {};
  card.text(t);
  assert.strictEqual(card.frame(t).render, 'card');
  // newChat(): closed (not just hidden) while the stopped reply's 'stopped' is still to come.
  card.close(t);
  assert.strictEqual(card.ended(t, { outcome: 'stopped', text: 'half' }).decision, null);
});

test('hides on the next message and on Open in chat, which says where the chat opens', () => {
  const { card } = setup();
  const t = {};
  card.ended(t, { outcome: 'done', message: { id: 'm9', role: 'assistant', content: 'Done.' } });
  assert.strictEqual(card.at, 'm9');
  assert.deepStrictEqual(card.openInChat(), { type: 'hide', at: 'm9' });
  assert.strictEqual(card.shown, false);
  assert.deepStrictEqual(card.openInChat(), { type: 'hide', at: null }, 'nothing shown: the latest reply');
  card.ended({}, { outcome: 'failed', error: 'x' });
  assert.deepStrictEqual(card.hide(), { type: 'hide' });
  assert.strictEqual(card.card, null);
});

test('leaving the Face layout puts the card away and says when the bubble was left behind', () => {
  const { card, layout } = setup();
  const t = {};
  card.text(t, { spoken: true });
  card.frame(t, { text: 'abc' }); // in the Face layout: the bubble isn't filled
  assert.strictEqual(card.layout(true, t), null, 'still the Face layout: nothing changes');
  layout.face = false;
  assert.deepStrictEqual(card.layout(false, t), { type: 'hide', fill: true });
  assert.deepStrictEqual(card.layout(false, t), { type: 'hide', fill: false }, 'filled once');
  assert.strictEqual(card.frame(t, { text: 'abcd' }).render, 'bubble');
  assert.deepStrictEqual(card.layout(false, t), { type: 'hide', fill: false }, 'the bubble got its frames');
  assert.deepStrictEqual(card.layout(false, null), { type: 'hide', fill: false }, 'no reply running');
  // Back in the Face layout the card comes back with the next reply, not with the layout.
  layout.face = true;
  assert.strictEqual(card.layout(true, t), null);
  assert.strictEqual(card.shown, false);
  // A reply whose frames came in another layout left nothing behind.
  const u = {};
  layout.face = false;
  card.frame(u);
  assert.strictEqual(card.layout(false, u).fill, false);
});

const conv = [
  { id: 'u1', role: 'user', content: 'What is a monad?', createdAt: Date.UTC(2026, 10, 20, 9) },
  { id: 'a1', role: 'assistant', content: 'A **monad** is…', createdAt: Date.UTC(2026, 10, 20, 9, 1), persona: 'Ada' },
  { id: 'h1', role: 'assistant', content: 'hidden', hidden: true },
  { id: 'u2', role: 'user', content: 'Thanks', createdAt: Date.UTC(2026, 10, 20, 9, 2) },
  { id: 'a2', role: 'assistant', content: '', createdAt: Date.UTC(2026, 10, 20, 9, 3) },
];

test('a conversation opened: the found message, else a recent failure, else (from History) its latest reply', () => {
  const { card, layout } = setup();
  // History's search found a message of the user's: plain text, who and when.
  let d = card.opened({ messages: conv, fromHistory: true, found: 'u1', failed: { failed: true, error: 'x' }, agent: 'Siren' });
  assert.strictEqual(d.card.kind, 'message');
  assert.deepStrictEqual([d.card.text, d.card.plain, d.card.at, d.card.reply], ['What is a monad?', true, 'u1', null]);
  assert.match(d.card.kicker, /^You · /);
  assert.deepStrictEqual(card.buttons({ reply: 'a1', again: 'u2', edit: 'u2' }), [], 'a message of the user’s: no buttons');
  // A found reply: Markdown, the persona that wrote it, and the reply's buttons.
  d = card.opened({ messages: conv, fromHistory: true, found: 'a1', agent: 'Siren' });
  assert.deepStrictEqual([d.card.plain, d.card.at, d.card.reply.id], [false, 'a1', 'a1']);
  assert.match(d.card.kicker, /^Ada · /);
  assert.deepStrictEqual(card.buttons({ reply: 'a9', again: 'u2', edit: 'u2' }), [{ action: 'copy' }], 'not the latest: Copy only');
  // A found message with nothing to show: nothing (not the failure instead).
  assert.strictEqual(card.opened({ messages: conv, fromHistory: true, found: 'a2', failed: { text: 'Stopped' } }), null);
  // No message found (or not shown): a recent failure first, at launch too.
  d = card.opened({ messages: conv, fromHistory: true, found: null, failed: { failed: true, error: '429' } });
  assert.deepStrictEqual([d.card.kind, d.card.error, d.card.text], ['error', '429', '']);
  assert.deepStrictEqual(card.buttons({ again: 'u2', edit: 'u2' }), [], 'a failure’s buttons are in its own box');
  d = card.opened({ messages: conv, fromHistory: false, failed: { text: 'This message got no reply.' } });
  assert.deepStrictEqual([d.card.kind, d.card.text], ['stopped', 'This message got no reply.']);
  assert.deepStrictEqual(card.buttons({ again: 'u2', edit: 'u2' }), [{ action: 'again', label: 'try', id: 'u2' }, { action: 'edit', id: 'u2' }]);
  // From History without a failure: the latest reply with words (a2 is empty, h1 hidden).
  d = card.opened({ messages: conv, fromHistory: true, failed: null, agent: 'Siren' });
  assert.deepStrictEqual([d.card.at, d.card.reply.id], ['a1', 'a1']);
  assert.match(d.card.kicker, /^Latest reply · /);
  assert.deepStrictEqual(card.buttons({ reply: 'a1', again: 'u1', edit: 'u1' }), [{ action: 'copy' }, { action: 'again', label: 'regenerate', id: 'u1' }, { action: 'edit', id: 'u1' }]);
  // At launch (not from History) without a failure: nothing.
  assert.strictEqual(card.opened({ messages: conv, fromHistory: false, failed: null }), null);
  // Only in the Face layout.
  layout.face = false;
  assert.strictEqual(card.opened({ messages: conv, fromHistory: true, found: 'u1', failed: { failed: true } }), null);
});

test('a message without a usable time: the kicker has no date', () => {
  const { card } = setup();
  const d = card.opened({ messages: [{ id: 'a', role: 'assistant', content: 'Hi' }], fromHistory: true, agent: 'Siren' });
  assert.strictEqual(d.card.kicker, 'Latest reply');
  assert.strictEqual(card.opened({ messages: [{ id: 'a', role: 'assistant', content: 'Hi' }], fromHistory: true, found: 'a', agent: 'Siren' }).card.kicker, 'Siren');
});

test('buttons: none while live; a finished reply’s depend on whether it is the latest; a stop offers Try again only with something to send', () => {
  const { card } = setup();
  const t = {};
  card.text(t);
  card.frame(t, { text: 'x' });
  assert.deepStrictEqual(card.buttons({ again: 'u1', edit: 'u1' }), [], 'live');
  card.ended(t, { outcome: 'done', message: { id: 'a1', role: 'assistant', content: 'x' } });
  assert.deepStrictEqual(card.buttons({ reply: 'a1', again: 'u1', edit: null }).map((b) => b.action), ['copy', 'again']);
  const u = {};
  card.hide();
  card.text(u);
  card.frame(u, { text: 'y' });
  card.ended(u, { outcome: 'stopped', text: 'y' });
  assert.deepStrictEqual(card.buttons({}), [], 'nothing to send again');
  card.hide();
  assert.deepStrictEqual(card.buttons({ again: 'u1' }), [], 'hidden');
});

test('scrollFor: a card that just appeared starts at the top; a live one follows only a reader at the end', () => {
  assert.strictEqual(rc.scrollFor({ wasShown: false, follow: true, atEnd: true }), 'top');
  assert.strictEqual(rc.scrollFor({ wasShown: true, follow: true, atEnd: true }), 'end');
  assert.strictEqual(rc.scrollFor({ wasShown: true, follow: true, atEnd: false }), null, 'scrolled up to read');
  assert.strictEqual(rc.scrollFor({ wasShown: true, follow: false, atEnd: true }), null);
});

test('chat.js paints the decisions: no card rule of its own', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/chat.js'), 'utf8');
  for (const gone of ['cardLive', 'cardClosed', 'view.behind', 'cardFor(', 'showFailedCard', 'let cardAt']) assert.ok(!src.includes(gone), gone);
  assert.ok(!src.includes("replyCard().classList.contains('hidden')") || src.split("replyCard().classList.contains('hidden')").length === 2, 'read only where the card is painted (its scroll)');
  // The card is shown only from a presenter's card, never with options decided here.
  for (const call of src.matchAll(/showCard\(([^)]*)\)/g)) assert.match(call[1], /^(d\.card|decision\.card, \{ html \}|card, \{ html = null \} = \{\})$/, call[0]);
});
