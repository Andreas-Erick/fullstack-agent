// PDF export: formulas are typeset by KaTeX with its fonts inlined (the print window is offline).
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

stub({ electron: { app: {}, BrowserWindow: class {}, session: {} }, './store': {}, './logger': quietLog });
const pdf = load('main/pdf.js');

test('katexCss inlines every font and references nothing external', async () => {
  const css = await pdf.katexCss();
  assert.ok(css.includes('@font-face'));
  assert.ok(css.includes('url(data:font/woff2;base64,'));
  assert.ok(!/url\((?!data:)/.test(css), 'only data: urls');
});

test('markdownHtml typesets inline and display math as KaTeX markup', async () => {
  const html = await pdf.markdownHtml('Cramer: $x=\frac{a}{b}$\n\n$$\sqrt{x^2+y^2}$$');
  assert.ok(html.includes('class="katex"'));
  assert.ok(html.includes('katex-display'));
  assert.ok(html.includes('<math'), 'MathML kept for copy and search');
});
