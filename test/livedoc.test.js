// Visualizations that teach (renderer/js/chartcore.mjs, main/diagrams.js chartPage, renderer/js/livedoc.js):
// parameters, distributions and the new kinds computed exactly; a chart's description saved as data the
// viewer reads back (never code); diagrams revealed a step at a time.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir, stub, load, quietLog } = require('./helpers');
const chart = require('../main/chartcore');

let live;
test.before(async () => {
  const dir = tmpDir('nexus-livedoc-');
  for (const f of ['livedoc.js', 'chartcore.mjs']) fs.copyFileSync(path.join(ROOT, 'renderer/js', f), path.join(dir, f.replace(/\.js$/, '.mjs')));
  live = await import(pathToFileURL(path.join(dir, 'livedoc.mjs')).href);
});

test('parameters: formulas use them, letters together multiply, odd names are refused', () => {
  const f = chart.compile('a sin(bx)', ['x', 'a', 'b']);
  assert.ok(Math.abs(f({ x: Math.PI / 4, a: 2, b: 2 }) - 2) < 1e-12);
  assert.strictEqual(chart.compile('2ax', ['x', 'a'])({ x: 3, a: 2 }), 12);
  assert.strictEqual(chart.compile('x^2')(3), 9, 'a number still means x');
  assert.throws(() => chart.compile('k x'), /Unknown name "k"/);
  const ps = chart.params({ params: [{ name: 'Mu', min: -2, max: 2 }, { name: 'sigma', min: 0.5, max: 3, value: 9, label: 'spread' }] });
  assert.deepStrictEqual(ps.map((p) => [p.name, p.value, p.label]), [['mu', 0, 'mu'], ['sigma', 3, 'spread']], 'default mid-range, clamped');
  for (const name of ['x', 't', 'theta', 'sin', 'pi', 'e', 'normpdf', '2a', 'toolongname']) assert.throws(() => chart.params({ params: [{ name, min: 0, max: 1 }] }), /parameter name/, name);
  assert.throws(() => chart.params({ params: [{ name: 'a', min: 1, max: 1 }] }), /min < max/);
  assert.throws(() => chart.params({ params: Array.from({ length: 7 }, (_, i) => ({ name: `p${i}`, min: 0, max: 1 })) }), /At most 6/);
  // The values the viewer sends override the saved ones.
  const spec = { series: [{ fn: 'a x' }], xRange: [0, 1], params: [{ name: 'a', min: 0, max: 5, value: 1 }] };
  assert.notStrictEqual(chart.render(spec), chart.render({ ...spec, values: { a: 4 } }));
});

test('distributions are exact and sum or integrate to one', () => {
  const pdf = chart.compile('normpdf(x, 0, 1)');
  assert.ok(Math.abs(pdf(0) - 1 / Math.sqrt(2 * Math.PI)) < 1e-12);
  assert.ok(Math.abs(chart.compile('normcdf(x, 0, 1)')(1.96) - 0.975) < 1e-4);
  const binom = chart.compile('binompmf(x, 10, 0.3)');
  let s = 0;
  for (let k = 0; k <= 10; k++) s += binom(k);
  assert.ok(Math.abs(s - 1) < 1e-9);
  assert.ok(Math.abs(binom(3) - 0.266827932) < 1e-8);
  assert.strictEqual(binom(2.5), NaN, 'only whole numbers');
  assert.ok(Math.abs(chart.compile('poissonpmf(x, 4)')(2) - 0.146525111) < 1e-8);
  assert.strictEqual(chart.compile('choose(x, 2)')(5), 10);
  assert.throws(() => chart.compile('normpdf(x, 1)'), /takes 3 arguments/);
  assert.throws(() => chart.compile('normpdf x'), /in parentheses/);
});

test('the new kinds draw, and say what they need', () => {
  const lis = chart.render({ kind: 'parametric', series: [{ x: 'cos(3t)', y: 'sin(2t)' }] });
  assert.match(lis, /<path d="M/);
  assert.match(chart.render({ kind: 'polar', series: [{ r: '1 + cos(θ)' }] }), /<path d="M/);
  const field = chart.render({ kind: 'field', field: { dx: '-y', dy: 'x' }, xRange: [-2, 2], yRange: [-2, 2] });
  assert.ok((field.match(/<polyline/g) || []).length > 200, 'an arrow per grid point');
  const stems = chart.render({ series: [{ fn: 'binompmf(x, 10, p)', discrete: true }], xRange: [0, 10], params: [{ name: 'p', min: 0, max: 1, value: 0.5 }] });
  assert.strictEqual((stems.match(/<circle/g) || []).length, 11);
  const hist = chart.render({ kind: 'histogram', data: [1, 2, 2, 3, 3, 3, 4, 4, 5], bins: 5, density: true, series: [{ fn: 'normpdf(x, 3, 1)' }] });
  assert.strictEqual((hist.match(/<rect x="[\d.]+" y="[\d.]+" width/g) || []).length >= 5, true);
  assert.match(hist, /<path d="M/, 'the density curve on top');
  assert.throws(() => chart.render({ kind: 'parametric', series: [{ x: 't' }] }), /needs x and y/);
  assert.throws(() => chart.render({ kind: 'polar', series: [{}] }), /needs r/);
  assert.throws(() => chart.render({ kind: 'field', field: { dx: 'y', dy: 'x' }, xRange: [0, 1] }), /xRange and yRange/);
  assert.throws(() => chart.render({ kind: 'histogram', data: [1] }), /at least two/);
  // Text the model wrote is escaped, also in the new kinds.
  assert.doesNotMatch(chart.render({ kind: 'polar', title: '<script>x</script>', series: [{ r: '1', label: '<b>' }, { r: '2' }] }), /<script>|<b>/);
});

test('a chart with parameters is saved as its picture plus a description the viewer reads back', () => {
  stub({ './logger': quietLog, './obsidian': { vaultPath: async () => null, ymd: () => '2026-11-16' } });
  const diagrams = load('main/diagrams.js');
  const spec = { title: 'Waves "on" é', kind: 'line', series: [{ fn: 'a sin(bx)', label: 'onload=x' }], xRange: [-6, 6], params: [{ name: 'a', min: 0, max: 2, value: 1 }, { name: 'b', min: 1, max: 4 }], play: 'b', open: true, junk: 1 };
  const page = diagrams.chartPage(spec, chart.render(spec));
  // What the saved file goes through: the cleaning leaves the description whole.
  const clean = diagrams.sanitize(page);
  assert.match(clean, /<svg/);
  const back = live.chartSpecFrom(clean);
  assert.strictEqual(back.title, 'Waves "on" é');
  assert.strictEqual(back.series[0].label, 'onload=x');
  assert.strictEqual(back.play, 'b');
  assert.strictEqual(back.open, undefined, 'only chart fields');
  assert.strictEqual(back.junk, undefined);
  assert.strictEqual(live.chartSpecFrom('<div data-nexus-chart="!!!">'), null);
  assert.strictEqual(live.chartSpecFrom(`<div data-nexus-chart="${Buffer.from('[1]').toString('base64')}">`), null, 'an object only');
  assert.strictEqual(live.chartSpecFrom('<svg></svg>'), null);
});

test('diagrams in steps: counted, and each step shows the ones before it', () => {
  const page = '<html><head><title>t</title></head><body><g data-step="1">a</g><g data-step=\'2\'>b</g><g data-step=3>c</g></body></html>';
  assert.strictEqual(live.stepCount(page), 3);
  assert.strictEqual(live.stepCount('<svg></svg>'), 0);
  assert.strictEqual(live.stepCount('<g data-step="999">'), live.MAX_STEPS);
  const two = live.withStep(page, 2, 3);
  assert.match(two, /<head><style id="nexus-steps">/);
  assert.match(two, /\[data-step="1"\],\[data-step="2"\]\{opacity:1\}/);
  assert.match(two, /\[data-step="2"\]\{animation:nexus-step/);
  assert.doesNotMatch(two, /\[data-step="3"\]\{opacity:1/);
  assert.match(two, /prefers-reduced-motion/);
  assert.match(live.withStep('<svg data-step="1"></svg>', 1, 1), /^<style id="nexus-steps">/);
});

test('playing a parameter sweeps its range smoothly and back', () => {
  const p = { min: 1, max: 5 };
  assert.strictEqual(live.playValue(p, 0), 1);
  assert.ok(Math.abs(live.playValue(p, 3000) - 5) < 1e-9);
  assert.ok(Math.abs(live.playValue(p, 6000) - 1) < 1e-9);
  assert.ok(Math.abs(live.playValue(p, 1500) - 3) < 1e-9);
});

// Computer science and robotics: kinematics from joint angles, simulated dynamics and optimizers,
// heatmaps and matrices, log axes, 3D scenes.
const ex = {
  fk: { kind: 'geometry', params: [{ name: 'q1', min: -3, max: 3, value: Math.PI / 2 }, { name: 'q2', min: -3, max: 3, value: -Math.PI / 2 }], defs: [{ name: 'x1', fn: 'cos(q1)' }, { name: 'y1', fn: 'sin(q1)' }], shapes: [{ type: 'polyline', joints: true, points: [[0, 0], ['x1', 'y1'], ['x1 + cos(q1 + q2)', 'y1 + sin(q1 + q2)']], label: 'arm' }, { type: 'circle', points: [[0, 0]], r: 2 }] },
};

test('defs: named values from the sliders, in order, in every formula', () => {
  const svg = chart.render(ex.fk);
  assert.match(svg, /<polyline points="[^"]+"[^>]*stroke-width="7"/, 'the arm drawn thick, with joints');
  assert.match(svg, /<ellipse/);
  // With q1 = 90° and q2 = -90° the end effector is at (1, 1): the same SVG as giving the numbers.
  const literal = chart.render({ ...ex.fk, defs: [], shapes: [{ ...ex.fk.shapes[0], points: [[0, 0], [0, 1], [1, 1]] }, ex.fk.shapes[1]] });
  assert.strictEqual(svg.replace(/aria-label="[^"]*"/, ''), literal.replace(/aria-label="[^"]*"/, ''));
  assert.throws(() => chart.render({ ...ex.fk, defs: [{ name: 'q1', fn: '1' }] }), /used twice/);
  assert.throws(() => chart.render({ ...ex.fk, defs: [{ name: 'a' }] }), /needs fn/);
  assert.throws(() => chart.render({ kind: 'geometry' }), /needs shapes/);
});

test('simulation: RK4 is accurate, maps iterate, and a blow-up is caught', () => {
  // x'' = -x from x = 1: x(t) = cos(t).
  const osc = chart.simulate({ sim: { vars: [{ name: 'x', init: 1 }, { name: 'v', init: 0 }], ode: { x: 'v', v: '-x' }, tEnd: 2 * Math.PI, steps: 400 } });
  assert.ok(Math.abs(osc.rows.at(-1)[0] - 1) < 1e-6 && Math.abs(osc.t.at(-1) - 2 * Math.PI) < 1e-9);
  // Gradient descent on x² with a learning rate: converges, or diverges past lr = 1.
  const gd = (lr) => chart.simulate({ params: [{ name: 'lr', min: 0, max: 2, value: lr }], sim: { vars: [{ name: 'x', init: 3 }], map: { x: 'x - lr 2x' }, steps: 2000 } });
  assert.ok(Math.abs(gd(0.1).rows.at(-1)[0]) < 1e-9);
  assert.strictEqual(gd(1.5).diverged, true);
  assert.match(chart.render({ kind: 'simulate', params: [{ name: 'lr', min: 0, max: 2, value: 1.5 }], sim: { vars: [{ name: 'x', init: 3 }], map: { x: 'x - lr 2x' }, steps: 2000 } }), />diverged</);
  assert.throws(() => chart.simulate({ sim: { vars: [{ name: 'x' }], ode: {} } }), /needs a formula for x/);
  assert.throws(() => chart.simulate({ sim: { vars: [{ name: 't' }], ode: { t: '1' } } }), /variable name/);
  assert.throws(() => chart.simulate({ sim: { ode: { x: '1' } } }), /needs vars/);
});

test('heatmaps: a formula with contours and a descent path on top, or a labelled matrix', () => {
  const spec = { kind: 'heatmap', fn: 'x^2 + 3y^2', xRange: [-2, 2], yRange: [-2, 2], contours: 5, params: [{ name: 'lr', min: 0, max: 0.5, value: 0.1 }], sim: { vars: [{ name: 'x', init: 1.8 }, { name: 'y', init: 1.5 }], map: { x: 'x - lr 2x', y: 'y - lr 6y' }, steps: 50 }, path: ['x', 'y'], pathLabel: 'descent' };
  const svg = chart.render(spec);
  assert.ok((svg.match(/<rect x=/g) || []).length > 2000, 'the coloured grid');
  assert.match(svg, /stroke="#ffffff" stroke-opacity="0.55"/, 'contours');
  assert.match(svg, /linearGradient id="cbar"/, 'a colour bar');
  assert.match(svg, />descent</);
  assert.throws(() => chart.render({ ...spec, path: ['x', 'q'] }), /path names two sim variables/);
  const m = chart.render({ kind: 'heatmap', matrix: [[1, 0], [0.5, 2]], rowLabels: ['<a>', 'b'], colLabels: ['c', 'd'] });
  assert.match(m, />&lt;a&gt;</);
  assert.match(m, />0\.5</);
  assert.throws(() => chart.render({ kind: 'heatmap', matrix: [[1, 2], [3]] }), /same length/);
  assert.throws(() => chart.render({ kind: 'heatmap', fn: 'x' }), /xRange and yRange/);
});

test('log axes: decades as ticks, and nothing at or below zero', () => {
  assert.deepStrictEqual(chart.logTicks(0.01, 100), [0.01, 0.1, 1, 10, 100]);
  assert.deepStrictEqual(chart.logTicks(1, 9), [1, 2, 5]);
  const bode = chart.render({ xScale: 'log', xRange: [0.01, 100], series: [{ fn: '-10 log((1 - x^2)^2 + (0.4x)^2)' }] });
  assert.match(bode, />0\.01</);
  assert.match(bode, />100</);
  assert.throws(() => chart.render({ xScale: 'log', xRange: [0, 10], series: [{ fn: 'x' }] }), /above zero/);
});

test('3D: a surface and items, turned by the view, depth-sorted, labels escaped', () => {
  const spec = { kind: '3d', surface: { fn: 'x^2 + y^2', xRange: [-1, 1], yRange: [-1, 1], grid: 10 }, items: [{ type: 'points', points: [[0, 0, 2]], label: '<P>', text: true }, { type: 'curve', x: 'cos(t)', y: 'sin(t)', z: 't/6' }] };
  const a = chart.render(spec);
  assert.strictEqual((a.match(/<polygon/g) || []).length, 100);
  assert.match(a, />&lt;P&gt;</);
  assert.notStrictEqual(a, chart.render({ ...spec, view: { azimuth: 30, elevation: 60 } }));
  assert.match(chart.render({ ...spec, view: { azimuth: 30, elevation: 200 } }), /el 89°/, 'elevation clamped');
  assert.throws(() => chart.render({ kind: '3d' }), /surface or items/);
  assert.throws(() => chart.render({ kind: '3d', items: [{ type: 'curve', x: 't' }] }), /x, y and z/);
});
