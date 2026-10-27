// Charts for study material (main/chartcore.js) and diagrams in PDFs (main/diagrams.js embedDiagrams):
// formulas computed exactly and safely, asymptotes broken instead of drawn, odd input refused with a
// reason, and saved drawings placed into a PDF as images that can't run or restyle anything.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');
const chart = require('../main/chartcore');

stub({ './logger': quietLog, './obsidian': { vaultPath: async () => null, ymd: () => '2026-10-27' } });
const diagrams = load('main/diagrams.js');

const f = (src, x) => chart.compile(src)(x);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('formulas follow the conventions of mathematics', () => {
  near(f('x^2 - 3x + 2', 2), 0);
  near(f('-x^2', 3), -9); // not 9
  near(f('2^3^2', 0), 512); // right-associative
  near(f('2x', 3), 6);
  near(f('3(x+1)', 1), 6);
  near(f('x sin(x)', Math.PI / 2), Math.PI / 2);
  near(f('sin x', Math.PI / 2), 1);
  near(f('e^x', 1), Math.E);
  near(f('ln(e)', 0), 1);
  near(f('log(1000)', 0), 3);
  near(f('sqrt(16) + abs(-2)', 0), 6);
  near(f('2 * pi', 0), 2 * Math.PI);
  near(f('x**2', 3), 9);
  near(f('2·x − 1', 2), 3);
  near(f('π', 0), Math.PI);
  near(f('1/x', 4), 0.25);
  near(f('1e3 + .5', 0), 1000.5);
});

test('formulas can never reach anything but arithmetic', () => {
  for (const bad of ['process.exit()', 'constructor', '__proto__', 'this', 'globalThis', 'alert(1)', 'x;1', 'x = 1', 'require("fs")', '`x`', 'x[0]', 'Math.PI', 'eval(x)', 'toString']) assert.throws(() => chart.compile(bad), /Unknown name|Not understood|Unexpected/, bad);
});

test('broken formulas say what is wrong', () => {
  assert.throws(() => chart.compile(''), /empty/);
  assert.throws(() => chart.compile('   '), /empty/);
  assert.throws(() => chart.compile('x +'), /ends too early/);
  assert.throws(() => chart.compile('(x'), /closing parenthesis/);
  assert.throws(() => chart.compile('sin(x'), /closing parenthesis/);
  assert.throws(() => chart.compile('x)'), /Unexpected/);
  assert.throws(() => chart.compile('y + 1'), /Unknown name "y"/);
  assert.throws(() => chart.compile('x'.repeat(400)), /longer than/);
  assert.throws(() => chart.compile(null), /empty/);
});

test('ticks are round numbers covering the range', () => {
  assert.deepStrictEqual(chart.ticks(-5, 5), [-4, -2, 0, 2, 4]);
  assert.deepStrictEqual(chart.ticks(0, 1), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepStrictEqual(chart.ticks(0, 0.37), [0, 0.1, 0.2, 0.3]);
  assert.deepStrictEqual(chart.ticks(3, 3), [3]);
  assert.ok(chart.ticks(-1e6, 1e6).every((t) => t % 500000 === 0));
});

test('a function plot: a valid standalone SVG, one line per series, a legend for several', () => {
  const svg = chart.render({ title: 'Parabolas', series: [{ fn: 'x^2', label: 'x²' }, { fn: '2x + 1', label: 'line' }], xRange: [-3, 3], xLabel: 'x', yLabel: 'y' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  assert.strictEqual((svg.match(/<path /g) || []).length, 2);
  assert.match(svg, />Parabolas</);
  assert.match(svg, />x²</);
  assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
  assert.doesNotMatch(svg, /<script|on\w+=/i);
});

test('asymptotes are not drawn as vertical lines; impossible values are skipped', () => {
  const tan = chart.render({ series: [{ fn: 'tan(x)' }], xRange: [-6, 6] });
  const moves = (tan.match(/<path d="([^"]*)"/)[1].match(/M/g) || []).length;
  assert.strictEqual(moves, 5, 'four asymptotes in [-6, 6]: five separate pieces');
  const inv = chart.render({ series: [{ fn: '1/x' }], xRange: [-2, 2] });
  assert.strictEqual((inv.match(/<path d="([^"]*)"/)[1].match(/M/g) || []).length, 2);
  const ln = chart.render({ series: [{ fn: 'ln(x)' }], xRange: [-2, 5] });
  assert.doesNotMatch(ln, /NaN/, 'ln of negatives is left out');
  assert.throws(() => chart.render({ series: [{ fn: 'sqrt(x)' }], xRange: [-5, -1] }), /no real values/);
});

test('data charts: line and scatter from points, bars from labels', () => {
  const pts = chart.render({ kind: 'scatter', series: [{ label: 'measured', points: [[1, 2], [2, 3.9], [3, 6.1], ['bad', 1], [4]] }] });
  assert.strictEqual((pts.match(/<circle /g) || []).length, 3, 'unusable points are dropped');
  const bars = chart.render({ kind: 'bar', labels: ['Mon', 'Tue', 'Wed'], series: [{ label: 'hours', values: [2, -1, 3.5] }], title: 'Study time' });
  assert.strictEqual((bars.match(/<rect x=/g) || []).length, 3);
  assert.throws(() => chart.render({ kind: 'bar', labels: ['a', 'b'], series: [{ values: [1] }] }), /one number per label/);
  assert.throws(() => chart.render({ kind: 'bar', labels: [], series: [] }), /labels/);
});

test('odd chart requests are refused with a reason, never a broken drawing', () => {
  assert.throws(() => chart.render({}), /at least one series/);
  assert.throws(() => chart.render({ series: [{ fn: 'x' }] }), /xRange/);
  assert.throws(() => chart.render({ series: [{ fn: 'x' }], xRange: [5, 1] }), /from < to/);
  assert.throws(() => chart.render({ series: [{ fn: 'x' }], xRange: ['a', 'b'] }), /xRange/);
  assert.throws(() => chart.render({ series: [{ points: [] }] }), /no usable points/);
  const many = chart.render({ series: [...Array(20)].map((_, i) => ({ fn: `x + ${i}` })), xRange: [0, 1] });
  assert.strictEqual((many.match(/<path /g) || []).length, 7, 'at most seven series');
  assert.match(chart.render({ title: '<script>alert(1)</script>', series: [{ fn: 'x' }], xRange: [0, 1] }), /&lt;script&gt;/, 'titles are escaped');
  const flat = chart.render({ series: [{ fn: '3' }], xRange: [0, 1] });
  assert.doesNotMatch(flat, /NaN/, 'a constant gets a sensible y range');
});

test('PDF embedding: a saved drawing becomes an image; nothing outside Diagrams/ is read', async () => {
  const files = {
    'Diagrams/2026-10-27 Cycle.html': '<!doctype html><html><head><style>.n{fill:red}</style></head><body><svg viewBox="0 0 10 10"><circle class="n" r="4" cx="5" cy="5" onclick="x()"/></svg><script>bad()</script></body></html>',
    'Diagrams/Text only.html': '<html><body><p>No drawing</p></body></html>',
  };
  const reads = [];
  const read = async (rel) => (reads.push(rel), files[rel] ?? Promise.reject(new Error('missing')));
  const md = 'Intro\n\n![[Diagrams/2026-10-27 Cycle.html|The cycle]]\n\n![[2026-10-27 Cycle.html]]\n\n![[Text only.html]]\n\n![[../Secrets/keys.html]]\n\n![[Missing.html]]\n\nEnd';
  const r = await diagrams.embedDiagrams(md, read);
  assert.strictEqual(r.embeds.length, 5);
  assert.match(r.markdown, /%%DIAGRAM-0%%[\s\S]*%%DIAGRAM-4%%/);
  assert.match(r.embeds[0], /^<figure class="diagram"><img alt="The cycle" src="data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(r.embeds[0].match(/base64,([^"]+)/)[1], 'base64').toString();
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 10 10"><style>\.n\{fill:red\}<\/style>/, 'standalone, with its styles inside');
  assert.doesNotMatch(svg, /onclick|<script/);
  assert.match(r.embeds[0], /<figcaption>The cycle<\/figcaption>/);
  assert.match(r.embeds[1], /<img alt="2026-10-27 Cycle"/, 'a bare name is looked up in Diagrams/');
  assert.match(r.embeds[2], /not found or not drawable/);
  assert.match(r.embeds[3], /not found or not drawable/);
  assert.ok(!reads.some((p) => p.includes('..')), 'a path out of Diagrams/ is never read');
  assert.match(r.embeds[4], /not found or not drawable/);
  assert.deepStrictEqual(await diagrams.embedDiagrams('', read), { markdown: '', embeds: [] });
});
