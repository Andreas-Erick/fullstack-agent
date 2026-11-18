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

// While a reply streams, every frame rendered every formula again (KaTeX, ~1 ms each): typeset ones are kept.
test('memoTex: a formula is typeset once, inline and display apart, and the cache clears at its cap', () => {
  const calls = [];
  const render = (tex, display) => (calls.push(`${display ? 'D' : 'I'}:${tex}`), `<k>${tex}${display ? '!' : ''}</k>`);
  const memo = m.memoTex(render, 3);
  assert.strictEqual(memo('a', false), '<k>a</k>');
  assert.strictEqual(memo('a', false), '<k>a</k>', 'exactly what render returned');
  assert.strictEqual(memo('a', true), '<k>a!</k>', 'display is another formula');
  assert.deepStrictEqual(calls, ['I:a', 'D:a']);
  assert.strictEqual(memo('', false), '<k></k>', 'an empty formula is one like any other');
  assert.strictEqual(memo('', false), '<k></k>');
  assert.deepStrictEqual(calls, ['I:a', 'D:a', 'I:']);

  calls.length = 0;
  const capped = m.memoTex(render, 3);
  for (const t of ['a', 'b', 'c', 'd']) capped(t, false); // d clears a, b and c
  capped('d', false);
  assert.deepStrictEqual(calls, ['I:a', 'I:b', 'I:c', 'I:d'], 'd is kept');
  capped('a', false);
  assert.deepStrictEqual(calls.slice(4), ['I:a'], 'a is typeset again after the clear');
  const big = m.memoTex(render);
  calls.length = 0;
  for (let i = 0; i < 3; i++) for (const t of ['x^2', String.raw`\frac{1}{2}`, 'y']) big(t, false);
  assert.strictEqual(calls.length, 3, 'three formulas, three renders');
});

// A placeholder is the formula's index between the private-use characters U+E000 and U+E001 (mathtext.js).
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
const PLACEHOLDER_CHAR = new RegExp(`[${OPEN}${CLOSE}]`);

test('mathSource: placeholders back to the formula’s source, for attributes', () => {
  const { text, items } = m.extractMath('a $x^2$ b $$y$$');
  const ph = (i) => text.match(new RegExp(`${OPEN}\\d+${CLOSE}`, 'g'))[i];
  assert.strictEqual(m.mathSource(`a${ph(0)}b`, items), 'ax^2b');
  assert.strictEqual(m.mathSource(text, items), 'a x^2 b y');
  assert.strictEqual(m.mathSource(`${OPEN} stray`, items), `${OPEN} stray`, 'an opening without its pair stays');
  assert.strictEqual(m.mathSource(`${OPEN}7${CLOSE}`, items), '', 'an index past the formulas');
  assert.strictEqual(m.mathSource('', items), '');
  assert.strictEqual(m.mathSource(null, []), 'null');
  assert.strictEqual(m.mathSource(text, items), m.mathSource(text, items), 'the global pattern restarts by itself');
});

// Seeded: any Markdown's placeholders all go back to their sources, none left behind.
test('mathSource round trip over random Markdown (seeded)', () => {
  const seed = 0x9e3779b9;
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466); // one ZWJ emoji
  const words = ['the', 'value', 'שלום', family, 'x', '**bold**', '_it_', '[l](u)', '\n', '  '];
  const pieces = [
    () => pick(words),
    () => `$${pick(['x^2', 'a+b', String.raw`\alpha`, 'f(x)', String.raw`\frac{1}{n}`])}$`,
    () => `$$${pick(['E=mc^2', String.raw`\sum_k k`, 'y'])}$$`,
    () => String.raw`\(` + pick(['a', 'b_1', 'c^3']) + String.raw`\)`,
    () => `$${Math.floor(rnd() * 100)}`,
    () => '`$code$`',
  ];
  for (let i = 0; i < 100; i++) {
    const n = 1 + Math.floor(rnd() * 12);
    const md = Array.from({ length: n }, () => pick(pieces)()).join(' ');
    const { text, items } = m.extractMath(md);
    const back = m.mathSource(text, items);
    assert.ok(!PLACEHOLDER_CHAR.test(back), `seed ${seed} case ${i}: no placeholder left in ${JSON.stringify(md)}`);
    for (const it of items) assert.ok(back.includes(it.tex), `seed ${seed} case ${i}: ${JSON.stringify(it.tex)} is back`);
  }
});
