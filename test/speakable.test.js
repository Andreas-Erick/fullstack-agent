// renderer/js/util.js, its pure parts: what the voice reads of a reply (speakable) and how [[note]] links
// become links the chat, Notes and the Vault open (linkWikilinks), without touching code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

let u;
test.before(async () => {
  const dir = tmpDir('nexus-util-');
  for (const f of ['util.js', 'mathtext.js']) fs.copyFileSync(path.join(ROOT, 'renderer/js', f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  globalThis.window = {}; // util.js reads window.nexus when it loads
  u = await import(pathToFileURL(path.join(dir, 'util.js')).href);
});

test.after(() => delete globalThis.window);

test('the voice reads a note link by its name or its alias, without the brackets', () => {
  assert.strictEqual(u.speakable('See [[Linear Algebra]] and [[Notes/Trip ideas|my trip list]].'), 'See Linear Algebra and my trip list.');
  assert.strictEqual(u.speakable('[[Notes/Courses/Real Analysis]]'), 'Real Analysis');
  assert.strictEqual(u.speakable('[[Inbox/Groceries.md]] and [[Plan#Week 2]]'), 'Groceries and Plan');
  assert.strictEqual(u.speakable('[[Notes/Trip ideas|a list / of trips]]'), 'a list / of trips', 'an alias is read whole');
});

test('formulas are still spoken in words, next to a link', () => {
  assert.strictEqual(u.speakable(String.raw`The area is $\pi r^2$ (see [[Circles]]).`), 'The area is pi r squared (see Circles).');
  assert.strictEqual(u.speakable(String.raw`$$\frac{a}{b}$$ in [[Fractions|my fractions note]]`), 'a over b in my fractions note');
  assert.strictEqual(u.speakable('Read **this** and `code`, then https://example.com/x'), 'Read this and code, then a link');
});

test('note links become links the views open, with the target and the shown text escaped', () => {
  const open = { open: true };
  assert.strictEqual(
    u.linkWikilinks('See [[Linear Algebra]] or [[Notes/Trip ideas|my trip list]].', open),
    'See <a class="wikilink" data-note="Linear Algebra" role="link" tabindex="0">Linear Algebra</a> or <a class="wikilink" data-note="Notes/Trip ideas" role="link" tabindex="0">my trip list</a>.',
  );
  assert.strictEqual(u.linkWikilinks('[[Plan#Week 2]]', open), '<a class="wikilink" data-note="Plan" role="link" tabindex="0">Plan</a>', 'a heading link opens the note');
  const evil = u.linkWikilinks('[[a" onclick="x|<img src=x onerror=alert(1)>]]', open);
  assert.ok(!evil.includes('<img') && !evil.includes('" onclick'), evil);
});

test('a link no view opens (Documents, the pop-out viewer) is no keyboard stop', () => {
  assert.strictEqual(u.linkWikilinks('See [[Linear Algebra|my notes]].'), 'See <a class="wikilink" data-note="Linear Algebra">my notes</a>.');
});

test('brackets in code stay code: inline, fenced, and a fence still being streamed', () => {
  const inline = "Select columns with `df[['a', 'b']]`, then [[Pandas]].";
  assert.strictEqual(u.linkWikilinks(inline), "Select columns with `df[['a', 'b']]`, then <a class=\"wikilink\" data-note=\"Pandas\">Pandas</a>.");
  const fenced = '```bash\nif [[ -f notes.md ]]; then echo ok; fi\n```\nSee [[Shell]].';
  const out = u.linkWikilinks(fenced, { open: true });
  assert.ok(out.startsWith('```bash\nif [[ -f notes.md ]]; then echo ok; fi\n```\n'), out);
  assert.ok(out.endsWith('data-note="Shell" role="link" tabindex="0">Shell</a>.'), out);
  const open = 'Like this:\n```python\nx = df[["a"]]';
  assert.strictEqual(u.linkWikilinks(open), open);
  assert.strictEqual(u.linkWikilinks('~~~\n[[x]]\n~~~'), '~~~\n[[x]]\n~~~');
});

test('renderMarkdown links notes only when asked, as keyboard stops only where the view opens them', () => {
  window.marked = { parse: (s) => s };
  window.DOMPurify = { sanitize: (h) => h, addHook() {}, removeHook() {} };
  try {
    assert.ok(u.renderMarkdown('[[A|b]]', { wikilinks: 'open' }).includes('<a class="wikilink" data-note="A" role="link" tabindex="0">b</a>'));
    assert.ok(u.renderMarkdown('[[A|b]]', { wikilinks: true }).includes('<a class="wikilink" data-note="A">b</a>'));
    assert.strictEqual(u.renderMarkdown('[[A|b]]'), '[[A|b]]');
  } finally {
    delete window.marked;
    delete window.DOMPurify;
  }
});
