// What leaves the composer (renderer/js/outbox.js): timelines through the module's interface with fake
// ports (the tray, the box, the turn state, the send). The rule they guard: two messages never go out in
// reverse order. A message waiting for its files, or queued behind the reply being stopped, holds whatever
// comes after it (a second Enter does nothing, spoken words go into the box); only the user's own typed or
// spoken words take the tray; a refused or failed send gives the words and the files back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const ESM = tmpDir('nexus-outbox-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
for (const f of ['outbox.js', 'attachcore.mjs', 'braintable.mjs']) fs.copyFileSync(path.join(ROOT, 'renderer/js', f), path.join(ESM, f));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));

let createOutbox;
test.before(async () => {
  ({ createOutbox } = await import(pathToFileURL(path.join(ESM, 'outbox.js')).href));
});

const tick = () => new Promise((r) => setImmediate(r));

// A world of fakes; `log` records every port call in order.
function world({ box = '', files = [], own = null, setup = false } = {}) {
  const log = [];
  let reading = null; // { promise, resolve } while files are being read
  const w = {
    log,
    box,
    chips: files.map((f, i) => ({ token: `t${i}`, meta: { name: f.name, kind: 'pdf' }, status: f.reading ? 'reading' : 'ready' })),
    results: [], // what deliver answers, in order ({} when empty)
    deferred: [],
    sent: [],
    turnWaiting: false,
    turn: {
      own,
      busy: () => Boolean(w.turn.own || w.turnWaiting),
      setWaiting: (on) => (log.push(`setWaiting:${on}`), (w.turnWaiting = on)),
    },
    /** The files still being read finish. */
    async finishReading() {
      for (const c of w.chips) c.status = 'ready';
      reading?.resolve();
      reading = null;
      await tick();
    },
    /** This window's reply has ended (stopped, or done). */
    async replyEnds() {
      w.turn.own = null;
      w.outbox.replyEnded();
      const fns = w.deferred.splice(0);
      for (const fn of fns) fn();
      await tick();
    },
  };
  const tray = {
    count: () => w.chips.length,
    reading: () => w.chips.some((c) => c.status === 'reading'),
    ready: () => {
      if (!reading) {
        let resolve;
        const promise = new Promise((r) => (resolve = r));
        reading = { promise, resolve };
      }
      return reading.promise.then(() => w.chips.some((c) => c.status === 'ready'));
    },
    take: () => {
      const ready = w.chips.filter((c) => c.status === 'ready');
      w.chips = w.chips.filter((c) => c.status !== 'ready');
      log.push(`take:${ready.length}`);
      return { tokens: ready.map((c) => c.token), meta: ready.map((c) => c.meta) };
    },
    restore: (taken) => {
      log.push(`restore:${taken.tokens.length}`);
      w.chips = [...taken.tokens.map((token, i) => ({ token, meta: taken.meta[i], status: 'ready' })), ...w.chips];
    },
    setBusy: (on, n) => log.push(on ? `busy:${n}` : 'busy:off'),
  };
  w.outbox = createOutbox({
    tray,
    box: { read: () => w.box, write: (t) => (w.box = t) },
    turn: w.turn,
    deliver: async (msg) => {
      log.push(`deliver:${msg.text}`);
      w.sent.push(msg);
      return w.results.shift() || {};
    },
    again: async (kind, messageId, text) => {
      log.push(`again:${kind}:${messageId}:${text}`);
      return w.againAnswer ?? true;
    },
    stop: () => log.push('stop'),
    notify: (t) => log.push(`notify:${t}`),
    setup: () => setup,
    waitChanged: () => log.push('waitChanged'),
    editEnded: () => log.push('editEnded'),
    defer: (fn) => w.deferred.push(fn),
  });
  return w;
}

test('Enter while files are read, words spoken meanwhile, the reply stops, the files finish: one message, in order', async () => {
  const w = world({ box: 'Look at this', files: [{ name: 'a.pdf', reading: true }], own: { requestId: 'r1' } });
  assert.strictEqual(w.outbox.typed(), 'wait', 'read first, then interrupt');
  assert.strictEqual(w.box, 'Look at this', 'the words wait in the box');
  assert.strictEqual(w.outbox.waitingFiles, true);
  assert.strictEqual(w.turn.busy(), true, 'turnstate hears about the wait (Try again, Regenerate and Edit step aside)');
  assert.deepStrictEqual(w.log, ['busy:1', 'setWaiting:true', 'waitChanged']);

  assert.strictEqual(w.outbox.typed(), 'hold', 'a second Enter does nothing');
  assert.strictEqual(w.outbox.spoken('and the second page'), 'hold');
  assert.strictEqual(w.box, 'Look at this and the second page', 'speech goes into the box, never in its place');
  assert.ok(w.log.includes('notify:Still reading your file; your words are in the box.'));

  await w.replyEnds(); // the reply stopped on its own: nothing was queued
  assert.strictEqual(w.sent.length, 0);

  await w.finishReading();
  const tail = w.log.slice(w.log.indexOf('setWaiting:false'));
  assert.deepStrictEqual(tail, ['setWaiting:false', 'busy:off', 'waitChanged', 'take:1', 'deliver:Look at this and the second page'], 'the buttons come back before the message goes');
  assert.strictEqual(w.log.filter((x) => x === 'waitChanged').length, 2, 'when the wait starts, and before it sends');
  assert.strictEqual(w.box, '');
  assert.deepStrictEqual(w.sent[0].files.tokens, ['t0']);
  assert.strictEqual(w.outbox.waitingFiles, false);
});

test('the files finish while the reply still runs: it is stopped, then the message goes; speech meanwhile waits in the box', async () => {
  const w = world({ box: 'Summarise', files: [{ name: 'a.pdf', reading: true }], own: { requestId: 'r1' } });
  w.outbox.typed();
  await w.finishReading();
  assert.ok(w.log.includes('stop') && w.log.includes('notify:Interrupting the current reply…'), 'read, then interrupt');
  assert.strictEqual(w.sent.length, 0, 'not before the reply has ended');
  assert.strictEqual(w.outbox.spoken('also the charts'), 'hold');
  assert.strictEqual(w.box, 'also the charts');
  assert.ok(w.log.includes('notify:Your last message goes first; these words are in the box.'));
  assert.strictEqual(w.outbox.typed(), 'hold', 'Enter waits for the queued one too');
  await w.replyEnds();
  assert.deepStrictEqual(w.sent.map((m) => m.text), ['Summarise']);
  assert.deepStrictEqual(w.sent[0].files.tokens, ['t0'], 'the queued message keeps its files');
  assert.strictEqual(w.box, 'also the charts', 'the later words are still in the box, to send next');
});

// Regression: a message queued behind the reply being stopped, then a second one waiting for a dropped file,
// went out in reverse order and the earlier one interrupted the later one's reply.
test('a message queued behind the reply being stopped holds a later one with a file still being read', async () => {
  const w = world({ box: 'first', own: { requestId: 'r1' } });
  assert.strictEqual(w.outbox.typed(), 'queue');
  w.box = 'second';
  w.chips.push({ token: 'tx', meta: { name: 'b.pdf' }, status: 'reading' });
  assert.strictEqual(w.outbox.typed(), 'hold', 'not a wait of its own');
  assert.strictEqual(w.outbox.waitingFiles, false);
  await w.finishReading();
  await w.replyEnds();
  assert.deepStrictEqual(w.sent.map((m) => m.text), ['first']);
  assert.strictEqual(w.box, 'second');
});

test('spoken words: sent, queued behind a reply (no notice), or into the box with autoSend off', async () => {
  const w = world();
  assert.strictEqual(w.outbox.spoken('hello', { autoSend: false }), 'box');
  assert.strictEqual(w.box, 'hello');
  assert.strictEqual(w.outbox.spoken('there', { autoSend: false }), 'box');
  assert.strictEqual(w.box, 'hello there');
  assert.strictEqual(w.sent.length, 0);
  w.box = '';
  w.chips.push({ token: 'tp', meta: { name: 'p.png', kind: 'image' }, status: 'ready' });
  assert.strictEqual(w.outbox.spoken('what is this'), 'send');
  await tick();
  assert.strictEqual(w.sent[0].voice, true);
  assert.deepStrictEqual(w.sent[0].files.tokens, ['tp'], 'spoken words are the user’s own: they take the tray');
  w.turn.own = { requestId: 'r2' };
  assert.strictEqual(w.outbox.spoken('stop, do this instead'), 'queue');
  assert.ok(w.log.includes('stop'));
  assert.ok(!w.log.some((x) => x.startsWith('notify:Interrupting')), 'talking over it needs no notice');
  await w.replyEnds();
  assert.deepStrictEqual(w.sent.map((m) => [m.text, m.voice]), [['what is this', true], ['stop, do this instead', true]]);
});

test('spoken words while a file is read (no reply): they wait with it, then go with the file', async () => {
  const w = world({ files: [{ name: 'a.pdf', reading: true }] });
  assert.strictEqual(w.outbox.spoken('read this'), 'wait');
  assert.strictEqual(w.box, '', 'not in the box: they go once the file is read');
  await w.finishReading();
  assert.deepStrictEqual(w.sent.map((m) => [m.text, m.voice, m.files.tokens]), [['read this', true, ['t0']]]);
});

test('a refused send gives the words back; a failed one gives the words and the files back', async () => {
  const w = world({ box: 'with a file', files: [{ name: 'a.pdf' }] });
  w.results.push({ refused: 'An attachment expired.' });
  w.outbox.typed();
  await tick();
  assert.strictEqual(w.box, 'with a file', 'refused: the words come back');
  assert.strictEqual(w.chips.length, 0, 'an expired token isn’t given back');

  w.box = 'again';
  w.chips.push({ token: 't9', meta: { name: 'b.pdf' }, status: 'ready' });
  w.results.push({ error: new Error('offline') });
  w.outbox.typed();
  assert.strictEqual(w.box, '', 'the box empties as it goes');
  w.box = 'typed meanwhile';
  await tick();
  assert.ok(w.log.indexOf('restore:1') > w.log.lastIndexOf('deliver:again'), 'the chips come back after the failure');
  assert.deepStrictEqual(w.chips.map((c) => c.token), ['t9']);
  assert.strictEqual(w.box, 'typed meanwhile', 'what was typed meanwhile stays');

  w.box = '';
  w.results.push({ error: new Error('offline') });
  await w.outbox.submit('', { redo: { kind: 'again' } });
  assert.strictEqual(w.box, '', 'a failed redo reloads its conversation: nothing comes back to the box');
  w.results.push({ refused: 'Expired' });
  await w.outbox.submit('old words', { redo: { kind: 'again' } });
  assert.strictEqual(w.box, 'old words', 'a refused redo gives its words back');
});

test('only the user’s own words take the tray: never a suggestion, a skill run, a hidden message, setup or a redo', async () => {
  const w = world({ files: [{ name: 'a.pdf' }] });
  await w.outbox.submit('A suggestion');
  await w.outbox.submit('/study-pack chapter 3');
  await w.outbox.submit('hidden', { attach: true, hidden: true });
  await w.outbox.submit('again', { attach: true, redo: { kind: 'again' }, kept: [{ name: 'k.pdf' }] });
  assert.deepStrictEqual(w.sent.map((m) => m.files.tokens.length), [0, 0, 0, 0]);
  assert.deepStrictEqual(w.sent[3].kept, [{ name: 'k.pdf' }], 'a redo shows the files it keeps');
  assert.ok(!w.log.some((x) => x.startsWith('take')));
  assert.strictEqual(w.chips.length, 1, 'still in the tray');
  assert.strictEqual(await w.outbox.submit(''), 'none', 'nothing to send');
  assert.strictEqual(await w.outbox.submit('', { redo: { kind: 'again' } }), 'send', 'a redo may have no words of its own');

  const s = world({ files: [{ name: 'a.pdf' }], setup: true });
  await s.outbox.submit('my name is Anna', { attach: true });
  assert.deepStrictEqual(s.sent[0].files.tokens, [], 'the setup conversation never takes the tray');
  assert.strictEqual(await s.outbox.submit('', { attach: true }), 'none', 'so files alone are nothing to send there');
});

test('a suggestion during a reply interrupts it; a redo that meets a reply started since does nothing', async () => {
  const w = world({ own: { requestId: 'r1' } });
  assert.strictEqual(await w.outbox.submit('', { redo: { kind: 'again' } }), 'none');
  assert.ok(!w.log.includes('stop'));
  assert.strictEqual(await w.outbox.submit('Tell me a joke'), 'queue');
  assert.ok(w.log.includes('notify:Interrupting the current reply…') && w.log.includes('stop'));
  await w.replyEnds();
  assert.deepStrictEqual(w.sent.map((m) => m.text), ['Tell me a joke']);
});

test('✎ Edit: the draft is kept, Esc gives it back, Enter runs it again, a refusal keeps the edited words', async () => {
  const w = world({ box: 'half a thought' });
  assert.strictEqual(w.outbox.startEdit('u1', 'the old message'), true);
  assert.strictEqual(w.outbox.editing, true);
  assert.strictEqual(w.box, 'the old message');
  assert.strictEqual(w.outbox.startEdit('u2', 'newer'), true, 'a second Edit keeps the first draft');
  w.outbox.cancelEdit();
  assert.strictEqual(w.box, 'half a thought', 'Esc: the draft comes back');
  assert.strictEqual(w.outbox.editing, false);
  assert.ok(w.log.includes('editEnded'));

  w.outbox.startEdit('u1', 'the old message');
  w.box = 'the new message';
  assert.strictEqual(await w.outbox.typed(), 'edit');
  assert.ok(w.log.includes('again:edit:u1:the new message'));
  assert.strictEqual(w.box, 'half a thought', 'sent: the draft comes back');

  w.box = 'draft';
  w.outbox.startEdit('u1', 'old');
  w.box = 'edited';
  w.againAnswer = false;
  await w.outbox.typed();
  assert.strictEqual(w.box, 'edited', 'refused: the edited words stay');

  w.box = 'draft';
  w.outbox.startEdit('u1', 'old');
  w.box = '';
  await w.outbox.typed();
  assert.strictEqual(w.box, 'draft', 'an empty edit gives the old draft back');

  w.box = 'draft';
  w.outbox.startEdit('u1', 'old');
  await w.outbox.submit('A suggestion');
  assert.strictEqual(w.outbox.editing, false, 'another message went first');
  assert.strictEqual(w.box, 'old', 'the box keeps the edit as a draft');
});

test('✎ Edit is refused while a message waits for its files, or while a reply runs', async () => {
  const w = world({ box: 'x', files: [{ name: 'a.pdf', reading: true }] });
  w.outbox.typed();
  assert.strictEqual(w.outbox.startEdit('u1', 'old'), false);
  assert.ok(w.log.includes('notify:Still reading your file…'));
  assert.strictEqual(w.box, 'x', 'no edit in the waiting message’s place');
  await w.finishReading();
  w.turn.own = { requestId: 'r1' };
  assert.strictEqual(w.outbox.startEdit('u1', 'old'), false);
  w.turn.own = null;
  assert.strictEqual(w.outbox.startEdit('u1', null), false, 'the message isn’t there');
  assert.strictEqual(w.outbox.editing, false);
});
