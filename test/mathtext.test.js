// Math in replies (renderer/js/mathtext.js): finding LaTeX in Markdown without eating money or code,
// reading formulas aloud, and not splitting speech inside a formula.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

let m;
test.before(async () => {
  const copy = path.join(tmpDir('nexus-math-'), 'mathtext.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/mathtext.js'), copy);
  m = await import(pathToFileURL(copy).href);
});

test('finds inline and display math, leaves money and code alone', () => {
  const md = String.raw`It costs $5 and $10. Inline $x^2$, display $$\int_0^1 x\,dx$$, \(a+b\) and \[c\], code ` + '`$not$`' + '\n```\n$also not$\n```';
  const { text, items } = m.extractMath(md);
  assert.deepStrictEqual(items, [
    { tex: 'x^2', display: false },
    { tex: String.raw`\int_0^1 x\,dx`, display: true },
    { tex: 'a+b', display: false },
    { tex: 'c', display: true },
  ]);
  assert.ok(text.includes('$5 and $10') && text.includes('`$not$`') && text.includes('$also not$'));
  assert.strictEqual(m.restoreMath(text, items, (tex, d) => `[${d ? 'D' : 'I'}:${tex}]`).includes('[I:x^2]'), true);
});

test('escaped dollars and spaced dollars are not math', () => {
  assert.strictEqual(m.extractMath(String.raw`\$5 and \$6`).items.length, 0);
  assert.strictEqual(m.extractMath('between $ 5 and 6 $').items.length, 0);
});

test('formulas read the way a person says them', () => {
  const say = (t) => m.speakMath(t);
  assert.strictEqual(say('x^2'), 'x squared');
  assert.strictEqual(say(String.raw`\frac{a}{b}`), 'a over b');
  assert.strictEqual(say(String.raw`\sum_{i=1}^{n} i^2`), 'the sum from i equals 1 to n of i squared');
  assert.strictEqual(say(String.raw`\int_0^1 f(x)\,dx`), 'the integral from 0 to 1 of f of x dx');
  assert.strictEqual(say(String.raw`f: \mathbb{R} \to \mathbb{R}`), 'f from the reals to the reals');
  assert.strictEqual(say(String.raw`\frac{dy}{dx}`), 'd y by d x');
  assert.strictEqual(say(String.raw`\frac{d}{dx} x^n`), 'the derivative with respect to x of x to the n');
  assert.strictEqual(say('A^{-1}'), 'A inverse');
  assert.strictEqual(say(String.raw`\binom{n}{k}`), 'n choose k');
  assert.match(say(String.raw`\lim_{x \to 0} \frac{\sin x}{x} = 1`), /^the limit as x goes to 0 of .*sine x.*over x.* equals 1$/);
  assert.strictEqual(say(String.raw`\{ x \in \mathbb{N} : x > 2 \}`), 'x in the naturals such that x is greater than 2');
});

test('long formulas point at the screen', () => {
  const long = Array.from({ length: 30 }, (_, i) => `a_{${i}} x^{${i}}`).join(' + ');
  assert.strictEqual(m.speakMath(long), 'the formula on screen');
});

test('speakable text has formulas in words', () => {
  assert.strictEqual(m.speakableMath('So $e^{i\\pi}+1=0$ holds.').replace(/\s+/g, ' '), 'So e to the power i pi, end power plus 1 equals 0 holds.');
});

test('speech never splits inside a formula', () => {
  assert.strictEqual(m.mathOpen('Consider $$\\sum_{k=1}^n k. '), true);
  assert.strictEqual(m.mathOpen('Consider $$x$$ done.'), false);
  assert.strictEqual(m.mathOpen('We have $a: '), true);
  assert.strictEqual(m.mathOpen('It costs $5. '), false);
  assert.strictEqual(m.mathOpen('Code `$x` here.'), false);
});
