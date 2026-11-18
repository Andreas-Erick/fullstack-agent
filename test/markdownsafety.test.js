// Rendered Markdown can't restyle or take over the app (renderer/js/util.js renderMarkdown, sanitizeHtml):
// marked's output is sanitized strictly before KaTeX's formulas go back in (their inline styles stay), a
// formula placeholder in an attribute becomes its source before DOMPurify checks the value, only note-link
// and code-language classes are kept, ids are prefixed (no clobbering of #modal), the content's own #links
// follow them, and the hooks exist only around the one call. The real DOMPurify runs in the smoke check
// (main/smoke.js MARKDOWN_JS); here stand-ins record what util.js asks of it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

let u;
let m;
const katexCalls = [];
// DOMPurify's stand-in: records each call with the hooks registered at that moment; onSanitize may run them.
const purify = {
  hooks: {},
  calls: [],
  onSanitize: null,
  addHook(name, fn) {
    (this.hooks[name] ||= []).push(fn);
  },
  removeHook(name, fn) {
    const list = this.hooks[name] || [];
    const i = list.lastIndexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },
  sanitize(html, cfg) {
    const hooks = Object.fromEntries(Object.entries(this.hooks).map(([k, v]) => [k, [...v]]));
    this.calls.push({ html, cfg, hooks });
    return this.onSanitize ? this.onSanitize(html, cfg, hooks) : html;
  },
};
const registered = () => Object.values(purify.hooks).reduce((n, l) => n + l.length, 0);
// A formula's placeholder is its index between the private-use characters U+E000 and U+E001 (mathtext.js).
const PLACEHOLDER_CHAR = new RegExp(`[${String.fromCharCode(0xe000)}${String.fromCharCode(0xe001)}]`);
const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466); // one ZWJ emoji

test.before(async () => {
  const dir = tmpDir('nexus-mdsafe-');
  for (const f of ['util.js', 'mathtext.js']) fs.copyFileSync(path.join(ROOT, 'renderer/js', f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  globalThis.window = {
    marked: { parse: (s) => s },
    katex: { renderToString: (tex, o) => (katexCalls.push({ tex, display: o.displayMode }), `<span class="katex" style="height:1em">${tex}</span>`) },
    DOMPurify: purify,
  };
  u = await import(pathToFileURL(path.join(dir, 'util.js')).href);
  m = await import(pathToFileURL(path.join(dir, 'mathtext.js')).href);
});

test.after(() => delete globalThis.window);

test.beforeEach(() => {
  purify.calls.length = 0;
  purify.onSanitize = null;
});

// The placeholder util.js puts in for formula 0 (never typed here: mathtext makes it).
const placeholder = () => m.extractMath('$x^2$').text;

test('formulas are typeset after the sanitizer, so KaTeX keeps its inline styles; the config is strict', () => {
  const out = u.renderMarkdown('a $x^2$ b');
  assert.strictEqual(purify.calls.length, 1);
  const { html, cfg } = purify.calls[0];
  assert.ok(html.includes(placeholder()), 'the sanitizer sees the placeholder');
  assert.ok(!html.includes('katex'), 'not the typeset formula');
  assert.ok(out.includes('<span class="katex" style="height:1em">x^2</span>'), 'KaTeX’s output, styles and all');
  for (const t of ['style', 'form', 'button', 'textarea', 'select', 'option', 'dialog', 'template', 'iframe', 'object', 'embed', 'link', 'meta', 'base']) assert.ok(cfg.FORBID_TAGS.includes(t), `forbids <${t}>`);
  // for=: a <label for="evoRestart"> in a reply clicked the app's own button (Restart now) when clicked.
  for (const a of ['style', 'action', 'formaction', 'form', 'for']) assert.ok(cfg.FORBID_ATTR.includes(a), `forbids ${a}=`);
  assert.strictEqual(cfg.SANITIZE_NAMED_PROPS, true, 'ids and names prefixed: no clobbering');
  assert.ok(cfg.ADD_ATTR.includes('data-note'), 'note links keep their target');
});

// Hand-made DOMPurify events for the hooks, run during a renderMarkdown whose formulas are `src`'s.
function runHooks(src, events) {
  const seen = [];
  purify.onSanitize = (html, _cfg, hooks) => {
    for (const ev of events) {
      if ('text' in ev) {
        const node = { data: ev.text, parentNode: ev.ns ? { namespaceURI: ev.ns } : null };
        for (const h of hooks.uponSanitizeElement || []) h(node, { tagName: '#text' });
        seen.push({ data: node.data });
      } else if (ev.tagName) {
        let removed = false;
        const node = { getAttribute: (n) => (n === 'type' ? ev.type : null), remove: () => (removed = true) };
        for (const h of hooks.uponSanitizeElement || []) h(node, { tagName: ev.tagName });
        seen.push({ removed });
      } else {
        const data = { attrName: ev.name, attrValue: ev.value, keepAttr: true };
        for (const h of hooks.uponSanitizeAttribute || []) h({}, data);
        seen.push(data);
      }
    }
    return html;
  };
  u.renderMarkdown(src);
  return seen;
}

test('a formula placeholder in an attribute becomes its source before DOMPurify checks it; one in a name drops it', () => {
  const ph = placeholder();
  const [title, name] = runHooks('$x^2$', [
    { name: 'title', value: `a${ph}b` },
    { name: `data-${ph}`, value: '1' },
  ]);
  assert.strictEqual(title.attrValue, 'ax^2b');
  assert.strictEqual(title.keepAttr, true);
  assert.strictEqual(name.keepAttr, false, 'an attribute whose name holds a formula goes');
  // href="$javascript:alert(1)$": the value DOMPurify then validates is the plain javascript: URL, which it refuses.
  const [href] = runHooks('$javascript:alert(1)$', [{ name: 'href', value: ph }]);
  assert.strictEqual(href.attrValue, 'javascript:alert(1)', 'left for DOMPurify’s own URL check (the smoke check shows it refused)');
  assert.ok(!PLACEHOLDER_CHAR.test(href.attrValue));
});

// Regression: KaTeX's <span> put into an inline SVG's <text> (or MathML) after the sanitizer ran breaks out of
// that foreign content when the page parses it, so the tree shown wasn't the tree sanitized.
test('a formula in SVG or MathML text stays its source; in HTML text it is typeset', () => {
  const ph = placeholder();
  const [svg, math, html, loose] = runHooks('$x^2$', [
    { text: `a ${ph} b`, ns: 'http://www.w3.org/2000/svg' },
    { text: ph, ns: 'http://www.w3.org/1998/Math/MathML' },
    { text: `a ${ph} b`, ns: 'http://www.w3.org/1999/xhtml' },
    { text: ph, ns: null },
  ]);
  assert.strictEqual(svg.data, 'a x^2 b');
  assert.strictEqual(math.data, 'x^2');
  assert.strictEqual(html.data, `a ${ph} b`, 'left for KaTeX');
  assert.strictEqual(loose.data, ph, 'a node without a parent is left alone');
});

test('classes: only note links and code languages; the content’s own #links follow the prefixed ids', () => {
  const [cls, none, frag, prefixed, external, plain] = runHooks('text', [
    { name: 'class', value: 'modal wikilink toast language-js katex' },
    { name: 'class', value: 'modal toast' },
    { name: 'href', value: '#modal' },
    { name: 'href', value: '#user-content-x' },
    { name: 'href', value: 'https://x#y' },
    { name: 'title', value: '#modal' },
  ]);
  assert.strictEqual(cls.attrValue, 'wikilink language-js');
  assert.strictEqual(none.keepAttr, false, 'no class left: the attribute goes');
  assert.strictEqual(frag.attrValue, '#user-content-modal');
  assert.strictEqual(prefixed.attrValue, '#user-content-x', 'not prefixed twice');
  assert.strictEqual(external.attrValue, 'https://x#y');
  assert.strictEqual(plain.attrValue, '#modal', 'only href is a link');
  // An inline SVG's own references (a gradient, a clip path, a marker) follow its prefixed ids too.
  const refs = runHooks('text', [
    { name: 'fill', value: 'url(#g)' },
    { name: 'stroke', value: 'url("#g") red' },
    { name: 'clip-path', value: "url( '#c')" },
    { name: 'marker-end', value: 'url(#user-content-m)' },
    { name: 'fill', value: 'red' },
    { name: 'title', value: 'url(#g)' },
    { name: 'xlink:href', value: '#g' },
  ]);
  assert.deepStrictEqual(refs.map((r) => r.attrValue), ['url(#user-content-g)', 'url("#user-content-g") red', "url( '#user-content-c')", 'url(#user-content-m)', 'red', 'url(#g)', '#user-content-g']);
});

test('inputs: task-list checkboxes stay, every other input goes', () => {
  const r = runHooks('x', [
    { tagName: 'input', type: 'text' },
    { tagName: 'input', type: 'checkbox' },
    { tagName: 'input', type: 'CHECKBOX' },
    { tagName: 'input', type: null },
    { tagName: 'div', type: 'text' },
  ]);
  assert.deepStrictEqual(r.map((x) => x.removed), [true, false, false, true, false]);
});

test('the hooks exist only around the call: none left after render, sanitizeHtml or a throw', () => {
  u.renderMarkdown('a $y$');
  assert.ok(Object.keys(purify.calls[0].hooks).length >= 2, 'registered during the call');
  assert.strictEqual(registered(), 0);
  u.sanitizeHtml('<p>x</p>');
  assert.ok((purify.calls[1].hooks.uponSanitizeAttribute || []).length === 1);
  assert.strictEqual(registered(), 0);
  purify.onSanitize = () => {
    throw new Error('boom');
  };
  assert.throws(() => u.renderMarkdown('x'), /boom/);
  assert.throws(() => u.sanitizeHtml('x'), /boom/);
  assert.strictEqual(registered(), 0, 'removed after a throw too');
  // Another user of DOMPurify (scene.js, facecapture.js) sees none of them.
  purify.onSanitize = null;
  purify.sanitize('<svg/>', {});
  assert.deepStrictEqual(purify.calls.at(-1).hooks, Object.fromEntries(Object.keys(purify.hooks).map((k) => [k, []])));
});

test('a typeset formula is kept: a streamed reply doesn’t typeset it again every frame', () => {
  const before = katexCalls.length;
  u.renderMarkdown('$memoA$ $memoB$ $memoA$');
  u.renderMarkdown('$memoA$ $memoB$ $memoA$');
  assert.deepStrictEqual(katexCalls.slice(before).map((c) => c.tex), ['memoA', 'memoB']);
  u.renderMarkdown('$memoC$ and $$memoC$$');
  assert.deepStrictEqual(katexCalls.slice(before + 2).map((c) => [c.tex, c.display]), [['memoC', false], ['memoC', true]], 'inline and display apart');
});

test('edge strings render, each with one sanitizer call', () => {
  const long = Array.from({ length: 100 }, (_, i) => `Step ${i}: ${'words '.repeat(15)}$edge_{${i}}$`).join('\n');
  assert.ok(long.length > 10000);
  for (const s of ['', '   ', long, 'שלום $x$', FAMILY, '<script>alert(1)</script>', null, undefined]) {
    purify.calls.length = 0;
    const out = u.renderMarkdown(s);
    assert.strictEqual(typeof out, 'string', JSON.stringify(s));
    assert.strictEqual(purify.calls.length, 1, `one call for ${JSON.stringify(s)?.slice(0, 30)}`);
    assert.ok(!PLACEHOLDER_CHAR.test(out), 'no placeholder left');
  }
  assert.strictEqual((u.renderMarkdown(long).match(/class="katex"/g) || []).length, 100);
  assert.ok(u.renderMarkdown('שלום $x$').startsWith('שלום '), 'RTL text kept');
  assert.ok(u.renderMarkdown(FAMILY).includes(FAMILY), 'one ZWJ emoji kept whole');
});

test('Word documents: no form controls, ids prefixed, internal links follow them', () => {
  let seen = null;
  purify.onSanitize = (html, _cfg, hooks) => {
    const data = { attrName: 'href', attrValue: '#modal', keepAttr: true };
    for (const h of hooks.uponSanitizeAttribute || []) h({}, data);
    seen = data.attrValue;
    return html;
  };
  u.sanitizeHtml('<a id="modal" href="#modal">x</a>');
  const { cfg } = purify.calls[0];
  for (const t of ['style', 'form', 'input', 'button', 'textarea', 'select', 'dialog']) assert.ok(cfg.FORBID_TAGS.includes(t), `forbids <${t}>`);
  for (const a of ['style', 'for']) assert.ok(cfg.FORBID_ATTR.includes(a), `forbids ${a}=`);
  assert.strictEqual(cfg.SANITIZE_NAMED_PROPS, true);
  assert.strictEqual(seen, '#user-content-modal', 'a table of contents still jumps to its heading');
});

test('the window and the document viewer refuse form submissions (CSP form-action)', () => {
  for (const page of ['renderer/index.html', 'renderer/viewer.html']) {
    const csp = fs.readFileSync(path.join(ROOT, page), 'utf8').match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
    assert.ok(csp, page);
    assert.match(csp[1], /(^|; )form-action 'none'(;|$)/, page);
    assert.match(csp[1], /(^|; )base-uri 'none'(;|$)/, page);
  }
});
