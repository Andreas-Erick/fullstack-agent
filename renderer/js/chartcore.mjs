// Charts for study material and explanations (tool chart_create), pure and shared: the main process
// renders the saved SVG with it (main/chartcore.js loads this file), the document viewer redraws a chart
// live with it while the user moves a parameter (renderer/js/livedoc.js). The numbers are computed here,
// never drawn by the model, so a plot is exactly right; the model only describes it (formulas, ranges,
// parameters), and nothing it writes runs as code: formulas go through the parser below (no eval, no
// Function, a fixed list of names).
// Kinds: line (formulas in x and/or points; `discrete` series as stems), scatter, bar, histogram
// (data → bins, with an optional density curve), parametric (x(t), y(t)), polar (r(theta)) and field
// (a vector field dx, dy in x and y). Any formula may use the chart's parameters (`params`).
// The SVG is self-contained and print-friendly (white, the Okabe–Ito palette, dashes for black and
// white), so it works in a document window, in Obsidian and in a PDF.

// ---------------------------------------------------------------------------------------- formulas
export const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, exp: Math.exp, ln: Math.log, log: Math.log10, log2: Math.log2,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  fact: (n) => factorial(n),
};

// erf by Abramowitz & Stegun 7.1.26 (error < 1.5e-7): enough for a plotted normal CDF.
function erf(x) {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
function logFactorial(n) {
  if (!(n >= 0) || n !== Math.floor(n) || n > 1e6) return NaN;
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}
const factorial = (n) => (n > 170 ? Infinity : Math.round(Math.exp(logFactorial(n))));
const isInt = (k) => k === Math.floor(k);

/** Functions of several arguments, with their arity: probability distributions and a few helpers. */
export const FUNCS_N = {
  normpdf: [3, (x, m, s) => (s > 0 ? Math.exp(-(((x - m) / s) ** 2) / 2) / (s * Math.sqrt(2 * Math.PI)) : NaN)],
  normcdf: [3, (x, m, s) => (s > 0 ? 0.5 * (1 + erf((x - m) / (s * Math.SQRT2))) : NaN)],
  exppdf: [2, (x, l) => (l > 0 ? (x < 0 ? 0 : l * Math.exp(-l * x)) : NaN)],
  unifpdf: [3, (x, a, b) => (b > a ? (x >= a && x <= b ? 1 / (b - a) : 0) : NaN)],
  binompmf: [3, (k, n, p) => (isInt(k) && isInt(n) && k >= 0 && k <= n && p >= 0 && p <= 1 ? Math.exp(logFactorial(n) - logFactorial(k) - logFactorial(n - k) + (k ? k * Math.log(p) : 0) + (n - k ? (n - k) * Math.log(1 - p) : 0)) : isInt(k) ? 0 : NaN)],
  poissonpmf: [2, (k, l) => (isInt(k) && k >= 0 && l > 0 ? Math.exp(k * Math.log(l) - l - logFactorial(k)) : isInt(k) ? 0 : NaN)],
  choose: [2, (n, k) => (isInt(n) && isInt(k) && k >= 0 && k <= n ? Math.round(Math.exp(logFactorial(n) - logFactorial(k) - logFactorial(n - k))) : 0)],
  min: [2, Math.min],
  max: [2, Math.max],
  mod: [2, (a, b) => ((a % b) + b) % b],
  atan2: [2, Math.atan2],
};

const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const MAX_FORMULA = 300;
const RESERVED = new Set([...Object.keys(FUNCS), ...Object.keys(FUNCS_N), ...Object.keys(CONSTS)]);

function tokenize(src) {
  const s = String(src ?? '').replace(/\*\*/g, '^').replace(/·|×/g, '*').replace(/−/g, '-').replace(/π/g, 'pi').replace(/θ/g, 'theta');
  if (!s.trim()) throw new Error('The formula is empty.');
  if (s.length > MAX_FORMULA) throw new Error(`The formula is longer than ${MAX_FORMULA} characters.`);
  const out = [];
  const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([a-z][a-z0-9]*)|([-+*/^(),]))/giy;
  let m;
  let at = 0;
  while (at < s.length) {
    re.lastIndex = at;
    if (!(m = re.exec(s))) {
      if (!s.slice(at).trim()) break;
      throw new Error(`Not understood in the formula: "${s.slice(at).trim().slice(0, 12)}".`);
    }
    at = re.lastIndex;
    if (m[1]) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2]) out.push({ t: 'id', v: m[2].toLowerCase() });
    else out.push({ t: m[3] });
  }
  return out;
}

/**
 * A formula → a function. `names` are its variables and parameters (default just x); the function takes
 * a number (the first name) or an object of values ({ x, a, … }). Throws with a readable reason.
 * Letters written together ("ax", "2kx") are a product when each letter is one of the names.
 */
export function compile(formula, names = ['x']) {
  const known = new Set(names);
  const toks = tokenize(formula);
  let i = 0;
  const peek = () => toks[i];
  const take = (t) => (toks[i]?.t === t ? toks[i++] : null);
  const startsFactor = (k) => k && (k.t === 'num' || k.t === 'id' || k.t === '(');
  // expr := term (('+'|'-') term)* ; term := unary (('*'|'/'| implicit) unary)* ; unary := '-' unary | power
  // power := atom ('^' unary)?   (right-associative, and -x^2 = -(x^2) as in mathematics)
  function expr() {
    let n = term();
    for (let k; (k = take('+') || take('-')); ) n = { op: k.t, a: n, b: term() };
    return n;
  }
  function term() {
    let n = unary();
    for (;;) {
      const k = take('*') || take('/');
      if (k) n = { op: k.t, a: n, b: unary() };
      else if (startsFactor(peek())) n = { op: '*', a: n, b: power() };
      else return n;
    }
  }
  function unary() {
    if (take('-')) return { op: 'neg', a: unary() };
    if (take('+')) return unary();
    return power();
  }
  function power() {
    const base = atom();
    return take('^') ? { op: '^', a: base, b: unary() } : base;
  }
  function atom() {
    const k = toks[i++];
    if (!k) throw new Error('The formula ends too early.');
    if (k.t === 'num') return { num: k.v };
    if (k.t === '(') {
      const n = expr();
      if (!take(')')) throw new Error('A closing parenthesis is missing.');
      return n;
    }
    if (k.t === 'id') {
      if (known.has(k.v)) return { v: k.v };
      if (Object.hasOwn(CONSTS, k.v)) return { num: CONSTS[k.v] };
      if (Object.hasOwn(FUNCS, k.v)) {
        if (!take('(')) return { fn: k.v, a: power() }; // "sin x"
        const a = expr();
        if (!take(')')) throw new Error(`A closing parenthesis is missing after ${k.v}(.`);
        return { fn: k.v, a };
      }
      if (Object.hasOwn(FUNCS_N, k.v)) {
        const [arity] = FUNCS_N[k.v];
        if (!take('(')) throw new Error(`${k.v} needs its arguments in parentheses: ${k.v}(…).`);
        const args = [expr()];
        while (take(',')) args.push(expr());
        if (!take(')')) throw new Error(`A closing parenthesis is missing after ${k.v}(.`);
        if (args.length !== arity) throw new Error(`${k.v} takes ${arity} arguments, not ${args.length}.`);
        return { fnN: k.v, args };
      }
      // "ax" = a·x when every letter is a name of this formula.
      if ([...k.v].every((c) => known.has(c))) return [...k.v].map((c) => ({ v: c })).reduce((a, b) => ({ op: '*', a, b }));
      throw new Error(`Unknown name "${k.v}". Use ${[...known].join(', ')}, pi, e and ${Object.keys(FUNCS).join(', ')}, ${Object.keys(FUNCS_N).join(', ')}.`);
    }
    throw new Error(`Unexpected "${k.t}" in the formula.`);
  }
  const tree = expr();
  if (i < toks.length) throw new Error(`Unexpected "${toks[i].v ?? toks[i].t}" in the formula.`);
  const ev = (n, s) => {
    if ('num' in n) return n.num;
    if (n.v) return s[n.v];
    if (n.fn) return FUNCS[n.fn](ev(n.a, s));
    if (n.fnN) return FUNCS_N[n.fnN][1](...n.args.map((a) => ev(a, s)));
    if (n.op === 'neg') return -ev(n.a, s);
    const a = ev(n.a, s);
    const b = ev(n.b, s);
    return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? a / b : a ** b;
  };
  return (arg) => ev(tree, typeof arg === 'number' ? { [names[0]]: arg } : arg || {});
}

// ------------------------------------------------------------------------- parameters and values
// Sliders in the app (livedoc.js): each a name the formulas use, a range and a value. The saved SVG
// shows the chart at the values; the app redraws it as they change. defs are named values computed
// from them in order ("x1 = l1 cos(q1)"), so long formulas (kinematics, projections) stay readable.
export const MAX_PARAMS = 6;
export const MAX_DEFS = 16;
const VARS = ['x', 'y', 'z', 't', 'theta'];

function checkName(raw, what, taken, { allowVars = false } = {}) {
  const name = String(raw || '').toLowerCase();
  if (!/^[a-z][a-z0-9]{0,7}$/.test(name) || RESERVED.has(name) || (!allowVars && VARS.includes(name)) || name === 't') throw new Error(`"${name}" can't be a ${what} name: use a short name such as a, k, q1 or mu (not ${allowVars ? 't' : 'x, y, z, t, theta'}, pi, e or a function name).`);
  if (taken.has(name)) throw new Error(`The name "${name}" is used twice.`);
  taken.add(name);
  return name;
}

/** The chart's parameters, checked: [{ name, label, min, max, step, value }]. */
export function params(spec = {}) {
  const list = Array.isArray(spec.params) ? spec.params : [];
  if (list.length > MAX_PARAMS) throw new Error(`At most ${MAX_PARAMS} parameters.`);
  const seen = new Set();
  return list.map((p) => {
    const name = checkName(p?.name, 'parameter', seen);
    const min = Number(p.min);
    const max = Number(p.max);
    if (!finite(min) || !finite(max) || !(max > min)) throw new Error(`Parameter "${name}" needs min < max.`);
    const given = Number(spec.values?.[name] ?? p.value);
    const value = finite(given) ? Math.min(max, Math.max(min, given)) : (min + max) / 2;
    const step = finite(Number(p.step)) && Number(p.step) > 0 ? Number(p.step) : niceStep((max - min) / 200);
    return { name, label: String(p.label || name).slice(0, 40), min, max, step, value };
  });
}
const niceStep = (raw) => {
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
};

/** The values every formula of the chart can use: the parameters, then the defs in order. */
function envOf(spec) {
  const ps = params(spec);
  const taken = new Set(ps.map((p) => p.name));
  const names = ps.map((p) => p.name);
  const scope = Object.fromEntries(ps.map((p) => [p.name, p.value]));
  const defs = Array.isArray(spec.defs) ? spec.defs : [];
  if (defs.length > MAX_DEFS) throw new Error(`At most ${MAX_DEFS} defs.`);
  for (const d of defs) {
    const name = checkName(d?.name, 'def', taken);
    if (d?.fn == null) throw new Error(`The def "${name}" needs fn, a formula of the parameters and earlier defs.`);
    scope[name] = safe(compile(d.fn, [...names]), scope);
    names.push(name);
  }
  return { ps, names, scope };
}

/** A number, or a formula of the chart's values (plus `vars`, with `extra` values). */
function num(v, env, vars = [], extra = {}) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return NaN;
  return safe(compile(String(v), [...vars, ...env.names]), { ...env.scope, ...extra });
}

// ------------------------------------------------------------------------------------------ chart
const W = 720;
const H = 440;
const PAD = { l: 62, r: 24, t: 48, b: 58 };
const COLORS = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#000000'];
const COLOR_NAMES = { blue: 0, orange: 1, green: 2, pink: 3, yellow: 4, sky: 5, black: 6 };
const DASHES = ['', '7 4', '2 3', '10 3 2 3', '4 4', '1 2', '12 4'];
const SAMPLES = 600;
const KINDS = ['line', 'scatter', 'bar', 'histogram', 'parametric', 'polar', 'field', 'geometry', 'simulate', 'heatmap', '3d'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v) => {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(1).replace('e+', 'e');
  return String(Number(v.toPrecision(6)));
};
const colorAt = (s, k) => COLORS[COLOR_NAMES[s?.color] ?? k % COLORS.length];

/** About `count` round tick values covering [lo, hi]: steps of 1, 2 or 5 × 10^k. */
export function ticks(lo, hi, count = 6) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  return out;
}

/** Ticks on a logarithmic axis: the powers of ten in range, with 2 and 5 between when there are few. */
export function logTicks(lo, hi) {
  const out = [];
  for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++) for (const m of [1, 2, 5]) out.push(Number((m * 10 ** k).toPrecision(12)));
  const decades = out.filter((v) => v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9) && String(v).replace(/0|\./g, '').replace(/^-/, '') === '1');
  return decades.length >= 3 ? decades : out.filter((v) => v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9));
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const range = (r, name) => {
  if (!Array.isArray(r) || r.length !== 2 || !finite(Number(r[0])) || !finite(Number(r[1])) || !(Number(r[1]) > Number(r[0]))) throw new Error(`${name} must be [from, to] with from < to.`);
  return [Number(r[0]), Number(r[1])];
};
const safe = (f, scope) => {
  try {
    const v = f(scope);
    return finite(v) ? v : NaN;
  } catch {
    return NaN;
  }
};

// ------------------------------------------------------------------------------------- simulation
// sim: { vars: [{ name, init }], ode: { name: rate } | map: { name: next value }, tEnd or dt, steps }.
// ode: d(var)/dt, integrated with RK4 (a pendulum, a cart, a PID loop); map: every step all vars take
// their next value at once (gradient descent, momentum, Adam). Formulas use t, the vars, the params
// and defs. A run that blows up stops there, and the chart says so (a learning rate too large).
export const MAX_STEPS = 5000;
export function simulate(spec, env = envOf(spec)) {
  const sim = spec.sim || {};
  const ode = sim.ode && typeof sim.ode === 'object';
  const rule = ode ? sim.ode : sim.map;
  if (!rule || typeof rule !== 'object') throw new Error('sim needs ode (rates of change) or map (next values), one formula per variable.');
  const taken = new Set(env.names);
  const vars = (Array.isArray(sim.vars) ? sim.vars : []).slice(0, 8).map((v) => ({ name: checkName(v?.name, 'variable', taken, { allowVars: true }), init: v?.init ?? 0 }));
  if (!vars.length) throw new Error('sim needs vars: [{ name, init }].');
  const names = ['t', ...vars.map((v) => v.name), ...env.names];
  const fns = vars.map((v) => {
    if (rule[v.name] == null) throw new Error(`sim.${ode ? 'ode' : 'map'} needs a formula for ${v.name}.`);
    return compile(rule[v.name], names);
  });
  const steps = Math.max(1, Math.min(MAX_STEPS, Math.round(Number(sim.steps) || (ode ? 600 : 60))));
  const dt = ode ? (Number(sim.dt) > 0 ? Number(sim.dt) : (Number(num(sim.tEnd ?? 10, env)) || 10) / steps) : 1;
  const at = (t, s) => {
    const scope = { ...env.scope, t };
    vars.forEach((v, i) => (scope[v.name] = s[i]));
    return fns.map((f) => safe(f, scope));
  };
  let s = vars.map((v) => num(v.init, env));
  if (!s.every(finite)) throw new Error('Every sim variable needs a starting value (init).');
  const ts = [0];
  const rows = [s];
  let diverged = false;
  for (let i = 0, t = 0; i < steps; i++) {
    let next;
    if (ode) {
      const k1 = at(t, s);
      const k2 = at(t + dt / 2, s.map((v, j) => v + (dt / 2) * k1[j]));
      const k3 = at(t + dt / 2, s.map((v, j) => v + (dt / 2) * k2[j]));
      const k4 = at(t + dt, s.map((v, j) => v + dt * k3[j]));
      next = s.map((v, j) => v + (dt / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    } else next = at(t, s);
    t += dt;
    if (!next.every((v) => finite(v) && Math.abs(v) < 1e12)) {
      diverged = true;
      break;
    }
    s = next;
    ts.push(t);
    rows.push(s);
  }
  return { t: ts, rows, vars: vars.map((v) => v.name), diverged, ode };
}

// ---- layers: what a chart draws, in data coordinates. curve (ordered points, pen lifted at gaps),
// dots, stems, bars ([x0, x1, y]), arrows ([x, y, dx, dy]), heat (cells and contour segments),
// shape (geometry), path (a simulated path with its start and end marked).

function fnLayers(spec, env, xr, logX = false) {
  const names = ['x', ...env.names];
  return (Array.isArray(spec.series) ? spec.series : []).slice(0, 7).map((s, k) => {
    const label = String(s?.label || s?.fn || `Series ${k + 1}`).slice(0, 60);
    if (s?.fn != null) {
      const f = compile(s.fn, names);
      if (s.discrete) {
        const pts = [];
        for (let x = Math.ceil(xr[0]); x <= xr[1] && pts.length < 2000; x++) pts.push([x, safe(f, { ...env.scope, x })]);
        return { label, type: 'stems', fn: true, color: s.color, pts: pts.filter(([, y]) => finite(y)) };
      }
      const pts = [];
      for (let j = 0; j <= SAMPLES; j++) {
        const x = logX ? 10 ** (Math.log10(xr[0]) + ((Math.log10(xr[1]) - Math.log10(xr[0])) * j) / SAMPLES) : xr[0] + ((xr[1] - xr[0]) * j) / SAMPLES;
        pts.push([x, safe(f, { ...env.scope, x })]);
      }
      return { label, type: 'curve', fn: true, color: s.color, pts };
    }
    const pts = (Array.isArray(s?.points) ? s.points : []).slice(0, 5000).map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p?.x), Number(p?.y)])).filter(([x, y]) => finite(x) && finite(y));
    if (!pts.length) throw new Error(`Series "${label}" has no usable points.`);
    return { label, type: spec.kind === 'scatter' ? 'dots' : 'curve', fn: false, color: s.color, pts: pts.sort((a, b) => a[0] - b[0]) };
  });
}

function curveLayers(spec, env, kind) {
  const list = (Array.isArray(spec.series) ? spec.series : []).slice(0, 7);
  if (!list.length) throw new Error('Give at least one series.');
  const variable = kind === 'polar' ? 'theta' : 't';
  const key = kind === 'polar' ? 'thetaRange' : 'tRange';
  const tr = spec[key] ? range(spec[key], key) : [0, 2 * Math.PI];
  const names = [variable, ...env.names];
  return list.map((s, k) => {
    const label = String(s?.label || (kind === 'polar' ? `r = ${s?.r}` : `(${s?.x}, ${s?.y})`)).slice(0, 60);
    let at;
    if (kind === 'polar') {
      if (s?.r == null) throw new Error('A polar curve needs r, a formula in theta, e.g. "1 + cos(theta)".');
      const r = compile(s.r, names);
      at = (v) => {
        const rv = safe(r, { ...env.scope, theta: v });
        return [rv * Math.cos(v), rv * Math.sin(v)];
      };
    } else {
      if (s?.x == null || s?.y == null) throw new Error('A parametric curve needs x and y, formulas in t, e.g. x "cos(3t)", y "sin(2t)".');
      const fx = compile(s.x, names);
      const fy = compile(s.y, names);
      at = (v) => [safe(fx, { ...env.scope, t: v }), safe(fy, { ...env.scope, t: v })];
    }
    const pts = [];
    for (let j = 0; j <= SAMPLES * 2; j++) pts.push(at(tr[0] + ((tr[1] - tr[0]) * j) / (SAMPLES * 2)));
    return { label, type: 'curve', fn: false, ordered: true, color: s.color, pts };
  });
}

function fieldLayer(spec, env, xr, yr) {
  const f = spec.field || {};
  if (f.dx == null || f.dy == null) throw new Error('A vector field needs field: { dx, dy }, formulas in x and y, e.g. dx "-y", dy "x".');
  const names = ['x', 'y', ...env.names];
  const fx = compile(f.dx, names);
  const fy = compile(f.dy, names);
  const cols = 21;
  const rows = 13;
  const arrows = [];
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const x = xr[0] + ((xr[1] - xr[0]) * (i + 0.5)) / cols;
      const y = yr[0] + ((yr[1] - yr[0]) * (j + 0.5)) / rows;
      const s = { ...env.scope, x, y };
      const dx = safe(fx, s);
      const dy = safe(fy, s);
      if (finite(dx) && finite(dy)) arrows.push([x, y, dx, dy]);
    }
  return { label: String(f.label || 'field').slice(0, 60), type: 'arrows', arrows, cell: [(xr[1] - xr[0]) / cols, (yr[1] - yr[0]) / rows] };
}

function histogramLayer(spec) {
  const data = (Array.isArray(spec.data) ? spec.data : []).slice(0, 100000).map(Number).filter(finite);
  if (data.length < 2) throw new Error('A histogram needs data: at least two numbers.');
  const lo = spec.xRange ? range(spec.xRange, 'xRange')[0] : Math.min(...data);
  const hi = spec.xRange ? range(spec.xRange, 'xRange')[1] : Math.max(...data);
  const n = Math.max(1, Math.min(100, Math.round(Number(spec.bins) || Math.ceil(Math.log2(data.length) + 1))));
  const w = (hi - lo || 1) / n;
  const counts = new Array(n).fill(0);
  for (const v of data) if (v >= lo && v <= hi) counts[Math.min(n - 1, Math.floor((v - lo) / w))]++;
  // density: the bars' area is 1, so a density curve (normpdf…) overlays them.
  const scale = spec.density ? 1 / (data.length * w) : 1;
  return { label: String(spec.dataLabel || 'data').slice(0, 60), type: 'bars', bars: counts.map((c, i) => [lo + i * w, lo + (i + 1) * w, c * scale]), xr: [lo, lo + n * w] };
}

// ---- heatmaps: f(x, y) on a grid, coloured by a perceptually even scale (viridis, readable in print),
// with contour lines (marching squares) and a colour bar. colorScale "log" for steep landscapes.
const VIRIDIS = ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'];
function viridis(u) {
  const x = Math.max(0, Math.min(1, u)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [VIRIDIS[i], VIRIDIS[i + 1]].map((h) => [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16)));
  return `rgb(${a.map((c, j) => Math.round(c + (b[j] - c) * f)).join(',')})`;
}

function heatLayer(spec, env, xr, yr) {
  const f = compile(spec.fn, ['x', 'y', ...env.names]);
  const nx = 64;
  const ny = 40;
  const grid = [];
  for (let j = 0; j <= ny; j++) {
    const row = [];
    for (let i = 0; i <= nx; i++) row.push(safe(f, { ...env.scope, x: xr[0] + ((xr[1] - xr[0]) * i) / nx, y: yr[0] + ((yr[1] - yr[0]) * j) / ny }));
    grid.push(row);
  }
  const vals = grid.flat().filter(finite);
  if (!vals.length) throw new Error('Nothing to colour: the formula has no real values in that range.');
  const log = spec.colorScale === 'log';
  const lo0 = Math.min(...vals);
  const tf = (v) => (log ? Math.log10(1 + v - lo0) : v);
  const zr = spec.zRange ? range(spec.zRange, 'zRange').map(tf) : [tf(lo0), tf(Math.max(...vals))];
  const span = zr[1] - zr[0] || 1;
  const cells = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = [grid[j][i], grid[j][i + 1], grid[j + 1][i], grid[j + 1][i + 1]].filter(finite);
      if (!c.length) continue;
      const v = c.reduce((a, b) => a + b, 0) / c.length;
      cells.push([xr[0] + ((xr[1] - xr[0]) * i) / nx, yr[0] + ((yr[1] - yr[0]) * j) / ny, xr[0] + ((xr[1] - xr[0]) * (i + 1)) / nx, yr[0] + ((yr[1] - yr[0]) * (j + 1)) / ny, viridis((tf(v) - zr[0]) / span)]);
    }
  // Contours: levels evenly spread in the colour scale; one or two segments per grid cell.
  const n = spec.contours === false ? 0 : Math.max(0, Math.min(20, Math.round(Number(spec.contours) || 8)));
  const segs = [];
  for (let l = 1; l <= n; l++) {
    const level = zr[0] + (span * l) / (n + 1);
    const T = (j, i) => tf(grid[j][i]);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => [a, b, T(b, a)]);
        if (!corners.every((c) => finite(c[2]))) continue;
        const pts = [];
        for (let e = 0; e < 4; e++) {
          const [a, b] = [corners[e], corners[(e + 1) % 4]];
          if ((a[2] < level) !== (b[2] < level)) {
            const u = (level - a[2]) / (b[2] - a[2]);
            pts.push([xr[0] + ((xr[1] - xr[0]) * (a[0] + (b[0] - a[0]) * u)) / nx, yr[0] + ((yr[1] - yr[0]) * (a[1] + (b[1] - a[1]) * u)) / ny]);
          }
        }
        if (pts.length >= 2) segs.push([...pts[0], ...pts[1]]);
        if (pts.length === 4) segs.push([...pts[2], ...pts[3]]);
      }
  }
  const back = (u) => (log ? 10 ** u - 1 + lo0 : u);
  return { label: String(spec.fnLabel || spec.fn).slice(0, 60), type: 'heat', cells, segs, bar: [back(zr[0]), back(zr[1])] };
}

// ---- shapes: geometry with formulas of the chart's values (a robot arm from its joint angles, a
// projection, vectors). points: [[x, y], …], numbers or formulas.
const SHAPES = ['point', 'segment', 'polyline', 'polygon', 'circle', 'arrow', 'text'];
function shapeLayers(spec, env) {
  return (Array.isArray(spec.shapes) ? spec.shapes : []).slice(0, 60).map((s, k) => {
    const type = SHAPES.includes(s?.type) ? s.type : 'polyline';
    const pts = (Array.isArray(s?.points) ? s.points : []).slice(0, 400).map((p) => (Array.isArray(p) ? [num(p[0], env), num(p[1], env)] : [NaN, NaN]));
    if (!pts.length) throw new Error(`Shape ${k + 1} (${type}) needs points: [[x, y], …].`);
    return { type: 'shape', shape: type, pts, r: type === 'circle' ? num(s.r ?? 1, env) : 0, text: String(s.text ?? '').slice(0, 60), label: s.label ? String(s.label).slice(0, 60) : '', joints: Boolean(s.joints), fill: Boolean(s.fill), color: s.color, k };
  });
}

function pathLayer(spec, env) {
  if (!spec.sim || !Array.isArray(spec.path)) return null;
  const run = simulate(spec, env);
  const [a, b] = spec.path.map((n) => run.vars.indexOf(String(n).toLowerCase()));
  if (a < 0 || b < 0) throw new Error(`path names two sim variables (${run.vars.join(', ')}).`);
  return { label: String(spec.pathLabel || `${run.vars[a]}, ${run.vars[b]}`).slice(0, 60), type: 'path', pts: run.rows.map((r) => [r[a], r[b]]), diverged: run.diverged };
}

// The y range of sampled functions ignores the far ends of asymptotes: the middle 96 % of values.
function autoRange(values, robust, log = false) {
  const v = values.filter((x) => finite(x) && (!log || x > 0)).map((x) => (log ? Math.log10(x) : x)).sort((a, b) => a - b);
  if (!v.length) throw new Error('Nothing to plot: no real values in that range.');
  const lo = robust && v.length > 50 ? v[Math.floor(v.length * 0.02)] : v[0];
  const hi = robust && v.length > 50 ? v[Math.ceil(v.length * 0.98) - 1] : v[v.length - 1];
  const out = hi - lo < 1e-12 ? [lo - 1, hi + 1] : [lo - (hi - lo) * 0.08, hi + (hi - lo) * 0.08];
  return log ? out.map((x) => 10 ** x) : out;
}

// Geometry and curves keep their shape: one unit is as long on both axes.
function equalize(xr, yr) {
  const pw = W - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;
  const ux = (xr[1] - xr[0]) / pw;
  const uy = (yr[1] - yr[0]) / ph;
  if (ux > uy) {
    const mid = (yr[0] + yr[1]) / 2;
    return [xr, [mid - (ux * ph) / 2, mid + (ux * ph) / 2]];
  }
  const mid = (xr[0] + xr[1]) / 2;
  return [[mid - (uy * pw) / 2, mid + (uy * pw) / 2], yr];
}

function frame(spec, body, legend, extra = '') {
  const title = spec.title ? `<text x="${W / 2}" y="28" text-anchor="middle" font-size="17" font-weight="600" fill="#15181f">${esc(spec.title)}</text>` : '';
  const xl = spec.xLabel ? `<text x="${PAD.l + (W - PAD.l - PAD.r) / 2}" y="${H - 14}" text-anchor="middle" font-size="13" fill="#344054">${esc(spec.xLabel)}</text>` : '';
  const yl = spec.yLabel ? `<text transform="translate(16 ${PAD.t + (H - PAD.t - PAD.b) / 2}) rotate(-90)" text-anchor="middle" font-size="13" fill="#344054">${esc(spec.yLabel)}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Segoe UI, system-ui, sans-serif" role="img" aria-label="${esc(spec.title || 'Chart')}"><rect width="${W}" height="${H}" fill="#ffffff"/>${title}${body}${xl}${yl}${legend}${extra}</svg>`;
}

const LEGEND_W = 176;
const legendH = (n) => n * 20 + 8;

/** The corner of the plot that the fewest plotted points fall in, for the legend. */
function legendCorner(n, pixels) {
  const h = legendH(n);
  const corners = [
    [W - PAD.r - LEGEND_W - 6, PAD.t + 6],
    [PAD.l + 6, PAD.t + 6],
    [W - PAD.r - LEGEND_W - 6, H - PAD.b - h - 6],
    [PAD.l + 6, H - PAD.b - h - 6],
  ];
  const cost = ([x, y]) => pixels.reduce((c, [px, py]) => c + (px >= x - 4 && px <= x + LEGEND_W + 4 && py >= y - 4 && py <= y + h + 4 ? 1 : 0), 0);
  return corners.reduce((best, c) => (cost(c) < cost(best) ? c : best));
}

function legendSvg(items, [x0, y0] = [W - PAD.r - LEGEND_W - 6, PAD.t + 6], min = 2) {
  if (items.length < min) return '';
  const rows = items.map(({ label, type, color }, i) => {
    const y = y0 + 14 + i * 20;
    const mark = type === 'curve' || type === 'path' ? `<line x1="${x0 + 10}" y1="${y}" x2="${x0 + 34}" y2="${y}" stroke="${color}" stroke-width="2.5" stroke-dasharray="${type === 'path' ? '' : DASHES[i % DASHES.length]}"/>` : `<circle cx="${x0 + 22}" cy="${y}" r="4" fill="${color}"/>`;
    return `${mark}<text x="${x0 + 42}" y="${y + 4}" font-size="12" fill="#15181f">${esc(label.slice(0, 26))}</text>`;
  });
  return `<g><rect x="${x0}" y="${y0}" width="${LEGEND_W}" height="${legendH(items.length)}" fill="#ffffff" fill-opacity="0.92" stroke="#d0d5dd" rx="4"/>${rows.join('')}</g>`;
}

function colorBar([lo, hi]) {
  const x0 = W - PAD.r - 220; // room for the maximum's label on the right
  const stops = VIRIDIS.map((c, i) => `<stop offset="${(i / (VIRIDIS.length - 1)).toFixed(3)}" stop-color="${c}"/>`).join('');
  return `<defs><linearGradient id="cbar">${stops}</linearGradient></defs><rect x="${x0}" y="34" width="180" height="7" fill="url(#cbar)" rx="2"/><text x="${x0 - 4}" y="41" text-anchor="end" font-size="10" fill="#475467">${fmt(lo)}</text><text x="${x0 + 184}" y="41" font-size="10" fill="#475467">${fmt(hi)}</text>`;
}

function axes(xr, yr, X, Y, { logX = false, logY = false } = {}) {
  const g = [];
  for (const v of logX ? logTicks(xr[0], xr[1]) : ticks(xr[0], xr[1])) g.push(`<line x1="${X(v)}" y1="${PAD.t}" x2="${X(v)}" y2="${H - PAD.b}" stroke="#eaecf0"/><text x="${X(v)}" y="${H - PAD.b + 18}" text-anchor="middle" font-size="11" fill="#475467">${fmt(v)}</text>`);
  for (const v of logY ? logTicks(yr[0], yr[1]) : ticks(yr[0], yr[1])) g.push(`<line x1="${PAD.l}" y1="${Y(v)}" x2="${W - PAD.r}" y2="${Y(v)}" stroke="#eaecf0"/><text x="${PAD.l - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="#475467">${fmt(v)}</text>`);
  // The axes through zero when zero is in view, else along the frame (a log axis never has zero).
  const x0 = !logX && xr[0] <= 0 && xr[1] >= 0 ? X(0) : PAD.l;
  const y0 = !logY && yr[0] <= 0 && yr[1] >= 0 ? Y(0) : H - PAD.b;
  g.push(`<line x1="${PAD.l}" y1="${y0}" x2="${W - PAD.r}" y2="${y0}" stroke="#667085" stroke-width="1.2"/><line x1="${x0}" y1="${PAD.t}" x2="${x0}" y2="${H - PAD.b}" stroke="#667085" stroke-width="1.2"/>`);
  g.push(`<rect x="${PAD.l}" y="${PAD.t}" width="${W - PAD.l - PAD.r}" height="${H - PAD.t - PAD.b}" fill="none" stroke="#d0d5dd"/>`);
  return g.join('');
}

function shapeSvg(s, X, Y, c) {
  const ok = s.pts.filter(([x, y]) => finite(x) && finite(y));
  if (!ok.length) return '';
  const p = ok.map(([x, y]) => `${X(x)},${Y(y)}`).join(' ');
  const mark = (x, y, r = 4) => `<circle cx="${X(x)}" cy="${Y(y)}" r="${r}" fill="#ffffff" stroke="${c}" stroke-width="2"/>`;
  const caption = s.text && s.shape !== 'text' ? `<text x="${X(ok[ok.length - 1][0]) + 8}" y="${Y(ok[ok.length - 1][1]) - 8}" font-size="12" fill="${c}">${esc(s.text)}</text>` : '';
  switch (s.shape) {
    case 'point':
      return ok.map(([x, y]) => `<circle cx="${X(x)}" cy="${Y(y)}" r="4.5" fill="${c}"/>`).join('') + caption;
    case 'text':
      return `<text x="${X(ok[0][0])}" y="${Y(ok[0][1])}" font-size="13" fill="${c}" text-anchor="middle">${esc(s.text)}</text>`;
    case 'circle': {
      const rx = Math.abs(X(ok[0][0] + s.r) - X(ok[0][0]));
      const ry = Math.abs(Y(ok[0][1] + s.r) - Y(ok[0][1]));
      return `<ellipse cx="${X(ok[0][0])}" cy="${Y(ok[0][1])}" rx="${rx.toFixed(2)}" ry="${ry.toFixed(2)}" fill="${s.fill ? c : 'none'}" fill-opacity="0.15" stroke="${c}" stroke-width="2"/>${caption}`;
    }
    case 'polygon':
      return `<polygon points="${p}" fill="${s.fill !== false ? c : 'none'}" fill-opacity="0.15" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>${caption}`;
    case 'arrow': {
      if (ok.length < 2) return '';
      const [[ax, ay], [bx, by]] = [ok[0], ok[1]];
      const ang = Math.atan2(Y(by) - Y(ay), X(bx) - X(ax));
      const head = [0.42, -0.42].map((a) => `${(X(bx) - 11 * Math.cos(ang + a)).toFixed(2)},${(Y(by) - 11 * Math.sin(ang + a)).toFixed(2)}`);
      return `<line x1="${X(ax)}" y1="${Y(ay)}" x2="${X(bx)}" y2="${Y(by)}" stroke="${c}" stroke-width="2.2"/><polygon points="${head[0]} ${X(bx)},${Y(by)} ${head[1]}" fill="${c}"/>${caption}`;
    }
    default: {
      // segment / polyline; a robot arm: thick links and its joints marked (the base filled).
      const links = `<polyline points="${p}" fill="none" stroke="${c}" stroke-width="${s.joints ? 7 : 2.4}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${s.joints ? 0.85 : 1}"/>`;
      const joints = s.joints ? ok.map(([x, y], i) => (i === 0 ? `<rect x="${X(x) - 9}" y="${Y(y) - 9}" width="18" height="18" rx="3" fill="#344054"/>` : mark(x, y, i === ok.length - 1 ? 5 : 5.5))).join('') : '';
      return links + joints + caption;
    }
  }
}

// Draws the layers on axes: [xr, yr] in data units.
function plot(spec, layers, xr, yr, { logX = spec.xScale === 'log', logY = spec.yScale === 'log', extra = '' } = {}) {
  const tx = logX ? Math.log10 : (v) => v;
  const ty = logY ? Math.log10 : (v) => v;
  const [x0, x1, y0, y1] = [tx(xr[0]), tx(xr[1]), ty(yr[0]), ty(yr[1])];
  const X = (v) => +(PAD.l + ((tx(v) - x0) / (x1 - x0)) * (W - PAD.l - PAD.r)).toFixed(2);
  const Y = (v) => +(H - PAD.b - ((ty(v) - y0) / (y1 - y0)) * (H - PAD.t - PAD.b)).toFixed(2);
  const span = y1 - y0;
  const inView = ([x, y]) => finite(x) && finite(y) && (!logX || x > 0) && (!logY || y > 0) && x >= xr[0] && x <= xr[1] && y >= yr[0] && y <= yr[1];
  let series = 0;
  const out = layers.map((s) => {
    const k = s.type === 'shape' ? s.k : series++;
    const c = s.type === 'heat' ? '#15181f' : colorAt(s, k);
    s.drawColor = c;
    s.index = k;
    if (s.type === 'heat') {
      const cells = s.cells.map(([a, b, cc, d, fill]) => `<rect x="${X(a)}" y="${Y(d)}" width="${(X(cc) - X(a) + 0.6).toFixed(2)}" height="${(Y(b) - Y(d) + 0.6).toFixed(2)}" fill="${fill}"/>`).join('');
      const lines = s.segs.length ? `<path d="${s.segs.map(([a, b, cc, d]) => `M${X(a)} ${Y(b)}L${X(cc)} ${Y(d)}`).join('')}" stroke="#ffffff" stroke-opacity="0.55" stroke-width="1" fill="none"/>` : '';
      return cells + lines;
    }
    if (s.type === 'shape') return shapeSvg(s, X, Y, c);
    if (s.type === 'dots') return s.pts.filter(inView).map(([x, y]) => `<circle cx="${X(x)}" cy="${Y(y)}" r="3.5" fill="${c}" fill-opacity="0.85"/>`).join('');
    if (s.type === 'stems') {
      const base = Y(Math.max(yr[0], Math.min(yr[1], 0)));
      return s.pts.filter(([x]) => x >= xr[0] && x <= xr[1]).map(([x, y]) => `<line x1="${X(x)}" y1="${base}" x2="${X(x)}" y2="${Y(y)}" stroke="${c}" stroke-width="2"/><circle cx="${X(x)}" cy="${Y(y)}" r="3.6" fill="${c}"/>`).join('');
    }
    if (s.type === 'bars') return s.bars.map(([a, b, y]) => `<rect x="${X(a)}" y="${Y(Math.max(y, 0))}" width="${Math.max(0, X(b) - X(a) - 1).toFixed(2)}" height="${Math.abs(Y(y) - Y(0)).toFixed(2)}" fill="${c}" fill-opacity="0.75"><title>${fmt(a)}–${fmt(b)}: ${fmt(y)}</title></rect>`).join('');
    if (s.type === 'arrows') {
      // Each arrow points along the field, length by strength (the strongest fills its cell); colour fades with weakness.
      const mags = s.arrows.map(([, , dx, dy]) => Math.hypot(dx, dy));
      const top = Math.max(...mags, 1e-12);
      return s.arrows
        .map(([x, y, dx, dy], i) => {
          const m = mags[i] / top;
          if (m < 1e-6) return `<circle cx="${X(x)}" cy="${Y(y)}" r="1.6" fill="${c}"/>`;
          const len = 0.42 * Math.min(s.cell[0], s.cell[1]) * (0.35 + 0.65 * m);
          const ux = (dx / mags[i]) * len;
          const uy = (dy / mags[i]) * len;
          const [ax, ay, bx, by] = [X(x - ux), Y(y - uy), X(x + ux), Y(y + uy)];
          const ang = Math.atan2(by - ay, bx - ax);
          const hx = (a) => (bx - 6 * Math.cos(ang + a)).toFixed(2);
          const hy = (a) => (by - 6 * Math.sin(ang + a)).toFixed(2);
          return `<g stroke="${c}" stroke-opacity="${(0.35 + 0.65 * m).toFixed(2)}" stroke-width="1.6" fill="none" stroke-linecap="round"><line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/><polyline points="${hx(0.45)},${hy(0.45)} ${bx},${by} ${hx(-0.45)},${hy(-0.45)}"/></g>`;
        })
        .join('');
    }
    let d = '';
    let pen = false;
    let prev = null;
    for (const [x, y] of s.pts) {
      // Off-screen values are clamped a little past the edge (so a line leaves the frame), and a huge
      // jump between neighbours is an asymptote or a gap: lift the pen.
      const ok = finite(x) && finite(y) && (!logX || x > 0) && (!logY || y > 0);
      if (!ok || (prev !== null && Math.abs(ty(y) - prev) > span * 4)) {
        pen = false;
        prev = ok ? ty(y) : null;
        if (!ok) continue;
      }
      const yc = Math.max(y0 - span * 0.5, Math.min(y1 + span * 0.5, ty(y)));
      d += `${pen ? 'L' : 'M'}${X(x)} ${Y(logY ? 10 ** yc : yc)}`;
      pen = true;
      prev = ty(y);
    }
    if (!d) return '';
    if (s.type === 'path') {
      // A simulated path: the line, every step as a dot (the step size shows), start and end marked.
      const okPts = s.pts.filter(inView);
      const dots = okPts.length <= 400 ? okPts.map(([x, y]) => `<circle cx="${X(x)}" cy="${Y(y)}" r="2.2" fill="${c}"/>`).join('') : '';
      const [sx, sy] = s.pts[0];
      const [ex, ey] = s.pts[s.pts.length - 1];
      const ends = `${inView([sx, sy]) ? `<circle cx="${X(sx)}" cy="${Y(sy)}" r="6" fill="#ffffff" stroke="${c}" stroke-width="2.5"/>` : ''}${inView([ex, ey]) ? `<circle cx="${X(ex)}" cy="${Y(ey)}" r="6" fill="${c}" stroke="#ffffff" stroke-width="2"/>` : ''}`;
      return `<path d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>${dots}${ends}`;
    }
    return `<path d="${d}" fill="none" stroke="${c}" stroke-width="2.4" stroke-linejoin="round" stroke-dasharray="${DASHES[k % DASHES.length]}"/>`;
  });
  const clip = `<clipPath id="plot"><rect x="${PAD.l}" y="${PAD.t}" width="${W - PAD.l - PAD.r}" height="${H - PAD.t - PAD.b}"/></clipPath>`;
  const pixels = layers.flatMap((s) => (s.pts || []).filter(inView).map(([x, y]) => [X(x), Y(y)]));
  const named = layers.filter((s) => (s.type !== 'shape' || s.label) && s.type !== 'heat');
  const legendItems = named.map((s) => ({ label: s.label, type: s.type, color: s.drawColor }));
  const diverged = layers.some((s) => s.diverged) ? `<text x="${W - PAD.r - 8}" y="${H - PAD.b - 10}" text-anchor="end" font-size="13" font-weight="600" fill="#D55E00">diverged</text>` : '';
  return frame(spec, `<defs>${clip}</defs>${axes(xr, yr, X, Y, { logX, logY })}<g clip-path="url(#plot)">${out.join('')}</g>${diverged}`, legendSvg(legendItems, legendCorner(legendItems.length, pixels), layers.some((s) => s.type === 'heat') ? 1 : 2), extra);
}

function xyChart(spec, kind) {
  const env = envOf(spec);
  const logX = spec.xScale === 'log';
  const logY = spec.yScale === 'log';
  const xrIn = spec.xRange ? range(spec.xRange, 'xRange') : null;
  const yrIn = spec.yRange ? range(spec.yRange, 'yRange') : null;
  if ((logX && xrIn && xrIn[0] <= 0) || (logY && yrIn && yrIn[0] <= 0)) throw new Error('A logarithmic axis needs a range above zero.');
  const shapes = shapeLayers(spec, env);
  const path = pathLayer(spec, env);
  const extras = [...(path ? [path] : []), ...shapes];
  const extraPts = extras.flatMap((l) => l.pts.filter(([x, y]) => finite(x) && finite(y)));
  if (kind === 'heatmap') {
    if (Array.isArray(spec.matrix)) return matrixChart(spec);
    if (spec.fn == null) throw new Error('A heatmap needs fn, a formula in x and y (or matrix, rows of numbers).');
    if (!xrIn || !yrIn) throw new Error('A heatmap of a formula needs xRange and yRange.');
    const heat = heatLayer(spec, env, xrIn, yrIn);
    return plot(spec, [heat, ...fnLayers(spec, env, xrIn), ...extras], xrIn, yrIn, { extra: colorBar(heat.bar) });
  }
  if (kind === 'field') {
    if (!xrIn || !yrIn) throw new Error('A vector field needs xRange and yRange.');
    return plot(spec, [fieldLayer(spec, env, xrIn, yrIn), ...(spec.series?.length ? fnLayers(spec, env, xrIn) : []), ...extras], xrIn, yrIn);
  }
  if (kind === 'parametric' || kind === 'polar' || kind === 'geometry' || (kind === 'simulate' && path && !spec.series?.length)) {
    const layers = kind === 'parametric' || kind === 'polar' ? curveLayers(spec, env, kind) : [];
    const pts = [...layers.flatMap((l) => l.pts), ...extraPts].filter(([x, y]) => finite(x) && finite(y));
    if (!pts.length) throw new Error(kind === 'geometry' ? 'A geometry chart needs shapes with points.' : 'Nothing to plot: no real points in that range.');
    let xr = xrIn || autoRange(pts.map((p) => p[0]), false);
    let yr = yrIn || autoRange(pts.map((p) => p[1]), false);
    // Equal units: always for geometry (a circle stays round, an arm keeps its lengths), for curves when
    // the ranges are left to the chart.
    if (kind === 'geometry' || (!xrIn && !yrIn && kind !== 'simulate')) [xr, yr] = equalize(xr, yr);
    return plot(spec, [...layers, ...extras], xr, yr);
  }
  if (kind === 'simulate') return timeChart(spec, env, extras, xrIn, yrIn);
  if (kind === 'histogram') {
    const hist = histogramLayer(spec);
    const xr = xrIn || hist.xr;
    const curves = Array.isArray(spec.series) && spec.series.length ? fnLayers(spec, env, xr) : [];
    const top = Math.max(...hist.bars.map((b) => b[2]), ...curves.flatMap((c) => c.pts.map((p) => p[1]).filter(finite)));
    return plot(spec, [hist, ...curves, ...extras], xr, yrIn || [0, top * 1.1 || 1]);
  }
  const anyFn = (spec.series || []).some((s) => s?.fn != null);
  if (anyFn && !xrIn) throw new Error('A formula needs xRange, e.g. [-5, 5].');
  if (!(Array.isArray(spec.series) && spec.series.length)) throw new Error('Give at least one series: a formula (fn) or points.');
  const layers = fnLayers(spec, env, xrIn || [0, 1], logX);
  const xs = layers.flatMap((s) => s.pts.map((p) => p[0]));
  const xr = xrIn || (Math.max(...xs) > Math.min(...xs) ? [Math.min(...xs), Math.max(...xs)] : [xs[0] - 1, xs[0] + 1]);
  let yr = yrIn;
  if (!yr) {
    yr = autoRange([...layers.flatMap((s) => s.pts.map((p) => p[1])), ...extraPts.map((p) => p[1])], layers.every((s) => s.fn && s.type === 'curve'), logY);
    if (!logY && layers.some((s) => s.type === 'stems')) yr = [Math.min(0, yr[0]), Math.max(0, yr[1])];
  }
  return plot(spec, [...layers, ...extras], xr, yr);
}

// A simulation over time: each series is a formula of t and the sim's variables (default: every variable).
function timeChart(spec, env, extras, xrIn, yrIn) {
  const run = simulate(spec, env);
  const names = ['t', ...run.vars, ...env.names];
  const list = Array.isArray(spec.series) && spec.series.length ? spec.series.slice(0, 7) : run.vars.map((v) => ({ fn: v, label: v }));
  const layers = list.map((s, k) => {
    if (s?.fn == null) throw new Error('A simulate chart\'s series are formulas of t and the sim variables (fn).');
    const f = compile(s.fn, names);
    const pts = run.rows.map((r, i) => {
      const scope = { ...env.scope, t: run.t[i] };
      run.vars.forEach((v, j) => (scope[v] = r[j]));
      return [run.t[i], safe(f, scope)];
    });
    return { label: String(s.label || s.fn).slice(0, 60), type: run.ode ? 'curve' : 'dots', fn: false, color: s.color, pts, diverged: k === 0 && run.diverged };
  });
  if (!run.ode) for (const l of layers) l.type = 'curve';
  const xr = xrIn || [0, Math.max(run.t[run.t.length - 1], 1e-9)];
  const yr = yrIn || autoRange(layers.flatMap((l) => l.pts.map((p) => p[1])), false, spec.yScale === 'log');
  return plot(spec, [...layers, ...extras.filter((e) => e.type !== 'path')], xr, yr);
}

// A matrix as a heatmap (attention weights, a confusion matrix): labelled rows and columns, the values
// written in the cells when there is room.
function matrixChart(spec) {
  const m = spec.matrix.slice(0, 40).map((r) => (Array.isArray(r) ? r.slice(0, 40).map(Number) : []));
  const cols = Math.max(...m.map((r) => r.length));
  if (!m.length || !cols || m.some((r) => r.length !== cols || !r.every(finite))) throw new Error('matrix needs rows of numbers, all the same length.');
  const vals = m.flat();
  const zr = spec.zRange ? range(spec.zRange, 'zRange') : [Math.min(...vals), Math.max(...vals)];
  const rl = (Array.isArray(spec.rowLabels) ? spec.rowLabels : []).map((l) => String(l).slice(0, 16));
  const cl = (Array.isArray(spec.colLabels) ? spec.colLabels : []).map((l) => String(l).slice(0, 16));
  const left = rl.length ? 96 : 30;
  const top = cl.length ? 92 : 50;
  const size = Math.min((W - left - 30) / cols, (H - top - 30) / m.length);
  const g = [];
  m.forEach((row, i) =>
    row.forEach((v, j) => {
      const u = (v - zr[0]) / (zr[1] - zr[0] || 1);
      const x = left + j * size;
      const y = top + i * size;
      g.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(size - 1).toFixed(2)}" height="${(size - 1).toFixed(2)}" fill="${viridis(u)}"><title>${esc(`${rl[i] ?? i} → ${cl[j] ?? j}: ${fmt(v)}`)}</title></rect>`);
      if (size >= 26) g.push(`<text x="${(x + size / 2).toFixed(2)}" y="${(y + size / 2 + 4).toFixed(2)}" text-anchor="middle" font-size="${Math.min(13, size / 3.2).toFixed(1)}" fill="${u > 0.6 ? '#15181f' : '#ffffff'}">${fmt(Number(v.toPrecision(3)))}</text>`);
    }),
  );
  rl.forEach((l, i) => g.push(`<text x="${left - 6}" y="${(top + i * size + size / 2 + 4).toFixed(2)}" text-anchor="end" font-size="11" fill="#344054">${esc(l)}</text>`));
  cl.forEach((l, j) => g.push(`<text transform="translate(${(left + j * size + size / 2 + 4).toFixed(2)} ${top - 6}) rotate(-45)" font-size="11" fill="#344054">${esc(l)}</text>`));
  return frame({ ...spec, xLabel: spec.xLabel, yLabel: spec.yLabel }, g.join(''), '', colorBar(zr));
}

// ------------------------------------------------------------------------------------------- 3D
// A 3D scene drawn as SVG (no 3D library): a surface z = f(x, y), 3D curves (x, y, z in t), points
// (a cloud), segments, polylines and polygons (camera frustums, image planes, a 3D arm). Rotated by
// view { azimuth, elevation } in degrees; in the app the user drags it round. z is up.
function project(az, el) {
  const [ca, sa, ce, se] = [Math.cos(az), Math.sin(az), Math.cos(el), Math.sin(el)];
  return ([x, y, z]) => {
    const x1 = x * ca - y * sa;
    const y1 = x * sa + y * ca;
    return [x1, z * ce - y1 * se, y1 * ce + z * se]; // screen right, screen up, depth (away from the viewer)
  };
}

function chart3d(spec) {
  const env = envOf(spec);
  const az = ((Number(spec.view?.azimuth ?? -55) % 360) * Math.PI) / 180;
  const el = (Math.max(-89, Math.min(89, Number(spec.view?.elevation ?? 25))) * Math.PI) / 180;
  const P = project(az, el);
  const prims = []; // { pts3: [[x,y,z]…], kind, color, fill, label }
  const legend = [];
  if (spec.surface) {
    const s = spec.surface;
    if (s.fn == null || !s.xRange || !s.yRange) throw new Error('A surface needs fn (z as a formula in x and y), xRange and yRange.');
    const f = compile(s.fn, ['x', 'y', ...env.names]);
    const [xr, yr] = [range(s.xRange, 'surface.xRange'), range(s.yRange, 'surface.yRange')];
    const n = Math.max(6, Math.min(36, Math.round(Number(s.grid) || 24)));
    const z = [];
    for (let j = 0; j <= n; j++) {
      z.push([]);
      for (let i = 0; i <= n; i++) z[j].push(safe(f, { ...env.scope, x: xr[0] + ((xr[1] - xr[0]) * i) / n, y: yr[0] + ((yr[1] - yr[0]) * j) / n }));
    }
    const zs = z.flat().filter(finite);
    const [zlo, zhi] = [Math.min(...zs), Math.max(...zs)];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const q = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => [xr[0] + ((xr[1] - xr[0]) * a) / n, yr[0] + ((yr[1] - yr[0]) * b) / n, z[b][a]]);
        if (!q.every((p) => finite(p[2]))) continue;
        const mean = q.reduce((a, p) => a + p[2], 0) / 4;
        prims.push({ pts3: q, kind: 'face', fill: viridis((mean - zlo) / (zhi - zlo || 1)) });
      }
    if (s.label) legend.push({ label: String(s.label).slice(0, 60), color: viridis(0.6) });
  }
  (Array.isArray(spec.items) ? spec.items : []).slice(0, 60).forEach((it, k) => {
    const color = colorAt(it, k);
    let pts3;
    if (it?.type === 'curve') {
      if (it.x == null || it.y == null || it.z == null) throw new Error('A 3D curve needs x, y and z, formulas in t.');
      const names = ['t', ...env.names];
      const [fx, fy, fz] = [it.x, it.y, it.z].map((v) => compile(v, names));
      const tr = it.tRange ? range(it.tRange, 'tRange') : [0, 2 * Math.PI];
      pts3 = [];
      for (let j = 0; j <= 400; j++) {
        const t = tr[0] + ((tr[1] - tr[0]) * j) / 400;
        pts3.push([fx, fy, fz].map((f) => safe(f, { ...env.scope, t })));
      }
    } else pts3 = (Array.isArray(it?.points) ? it.points : []).slice(0, 5000).map((p) => (Array.isArray(p) ? [0, 1, 2].map((i) => num(p[i], env)) : [NaN, NaN, NaN]));
    pts3 = pts3.filter((p) => p.every(finite));
    if (!pts3.length) throw new Error(`3D item ${k + 1} has no usable points.`);
    const type = ['points', 'segment', 'polyline', 'polygon', 'curve', 'arrow'].includes(it.type) ? it.type : 'polyline';
    if (type === 'points') for (const p of pts3) prims.push({ pts3: [p], kind: 'dot', color });
    else if (type === 'polygon') prims.push({ pts3, kind: 'face', fill: color, opacity: 0.22, stroke: color });
    else for (let i = 0; i + 1 < pts3.length; i++) prims.push({ pts3: [pts3[i], pts3[i + 1]], kind: 'line', color, arrow: type === 'arrow' && i + 2 === pts3.length, width: Number(it.width) > 0 ? Math.min(8, Number(it.width)) : 2.2 });
    if (it.label) legend.push({ label: String(it.label).slice(0, 60), color, at: pts3[pts3.length - 1], text: Boolean(it.text) });
  });
  if (!prims.length) throw new Error('A 3D chart needs a surface or items.');
  // Axes from the origin, as long as the scene is big.
  const all = prims.flatMap((p) => p.pts3);
  const ext = Math.max(...all.flatMap((p) => p.map(Math.abs)), 1e-9);
  const axisLen = spec.axes === false ? 0 : ext * 1.1;
  const axisDefs = axisLen ? [['x', [axisLen, 0, 0]], ['y', [0, axisLen, 0]], ['z', [0, 0, axisLen]]] : [];
  for (const [, end] of axisDefs) prims.push({ pts3: [[0, 0, 0], end], kind: 'axis' });
  // Fit the projection into the plot area, equal scale.
  const proj = prims.flatMap((p) => p.pts3.map(P));
  const us = proj.map((p) => p[0]);
  const vs = proj.map((p) => p[1]);
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  // Labels written beside items need room on the right.
  const room = legend.some((l) => l.text) ? 150 : 0;
  const sc = Math.min((W - 80 - room) / (u1 - u0 || 1), (H - 110) / (v1 - v0 || 1));
  const cx = (W - room) / 2 - ((u0 + u1) / 2) * sc;
  const cy = (H + 30) / 2 + ((v0 + v1) / 2) * sc;
  const S = (p) => {
    const [u, v] = P(p);
    return [+(cx + u * sc).toFixed(2), +(cy - v * sc).toFixed(2)];
  };
  // Painter's order: the farthest first.
  const depth = (pr) => pr.pts3.reduce((a, p) => a + P(p)[2], 0) / pr.pts3.length;
  const order = prims.map((pr) => ({ pr, d: depth(pr) })).sort((a, b) => b.d - a.d);
  const g = order.map(({ pr }) => {
    const pts = pr.pts3.map(S);
    if (pr.kind === 'face') return `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="${pr.fill}" fill-opacity="${pr.opacity ?? 0.92}" stroke="${pr.stroke || '#ffffff'}" stroke-opacity="${pr.stroke ? 0.9 : 0.35}" stroke-width="${pr.stroke ? 1.6 : 0.6}"/>`;
    if (pr.kind === 'dot') return `<circle cx="${pts[0][0]}" cy="${pts[0][1]}" r="3" fill="${pr.color}" fill-opacity="0.85"/>`;
    if (pr.kind === 'axis') return `<line x1="${pts[0][0]}" y1="${pts[0][1]}" x2="${pts[1][0]}" y2="${pts[1][1]}" stroke="#98a2b3" stroke-width="1.2" stroke-dasharray="4 3"/>`;
    const head = pr.arrow ? (() => {
      const ang = Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]);
      const h = [0.42, -0.42].map((a) => `${(pts[1][0] - 11 * Math.cos(ang + a)).toFixed(2)},${(pts[1][1] - 11 * Math.sin(ang + a)).toFixed(2)}`);
      return `<polygon points="${h[0]} ${pts[1].join(',')} ${h[1]}" fill="${pr.color}"/>`;
    })() : '';
    return `<line x1="${pts[0][0]}" y1="${pts[0][1]}" x2="${pts[1][0]}" y2="${pts[1][1]}" stroke="${pr.color}" stroke-width="${pr.width}" stroke-linecap="round"/>${head}`;
  });
  const axisLabels = axisDefs.map(([n, end]) => {
    const [x, y] = S(end);
    return `<text x="${x}" y="${y}" dx="6" dy="-4" font-size="13" font-style="italic" fill="#475467">${n}</text>`;
  });
  const tags = legend.filter((l) => l.text && l.at).map((l) => {
    const [x, y] = S(l.at);
    return `<text x="${x + 8}" y="${y - 6}" font-size="12" fill="${l.color}">${esc(l.label)}</text>`;
  });
  const items = legend.filter((l) => !l.text).map((l) => ({ label: l.label, type: 'dots', color: l.color }));
  const hint = `<text x="${W - 12}" y="${H - 10}" text-anchor="end" font-size="10" fill="#98a2b3">az ${Math.round((az * 180) / Math.PI)}°, el ${Math.round((el * 180) / Math.PI)}°</text>`;
  return frame(spec, g.join('') + axisLabels.join('') + tags.join('') + hint, legendSvg(items));
}

function barChart(spec) {
  const labels = (Array.isArray(spec.labels) ? spec.labels : []).slice(0, 40).map((l) => String(l).slice(0, 24));
  const groups = (Array.isArray(spec.series) ? spec.series : []).slice(0, 5).map((s, k) => ({ label: String(s.label || `Series ${k + 1}`).slice(0, 40), values: (s.values || []).slice(0, labels.length).map(Number) }));
  if (!labels.length || !groups.length) throw new Error('A bar chart needs labels and at least one series with values.');
  for (const g of groups) if (g.values.length !== labels.length || !g.values.every(finite)) throw new Error(`Series "${g.label}" needs one number per label (${labels.length}).`);
  const all = groups.flatMap((g) => g.values);
  const yr = spec.yRange ? range(spec.yRange, 'yRange') : [Math.min(0, ...all), Math.max(0, ...all) * 1.1 || 1];
  const Y = (v) => +(H - PAD.b - ((v - yr[0]) / (yr[1] - yr[0])) * (H - PAD.t - PAD.b)).toFixed(2);
  const slot = (W - PAD.l - PAD.r) / labels.length;
  const bw = (slot * 0.72) / groups.length;
  const g = [];
  for (const v of ticks(yr[0], yr[1])) g.push(`<line x1="${PAD.l}" y1="${Y(v)}" x2="${W - PAD.r}" y2="${Y(v)}" stroke="#eaecf0"/><text x="${PAD.l - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="#475467">${fmt(v)}</text>`);
  const rotate = labels.length > 8 || labels.some((l) => l.length > 10);
  labels.forEach((l, i) => {
    const cx = PAD.l + slot * i + slot / 2;
    groups.forEach((grp, k) => {
      const v = grp.values[i];
      const x = cx - (bw * groups.length) / 2 + bw * k;
      const top = Y(Math.max(v, 0));
      g.push(`<rect x="${x.toFixed(2)}" y="${top}" width="${(bw - 2).toFixed(2)}" height="${Math.abs(Y(v) - Y(0)).toFixed(2)}" fill="${COLORS[k]}"><title>${esc(`${grp.label}: ${fmt(v)}`)}</title></rect>`);
    });
    g.push(rotate ? `<text transform="translate(${cx} ${H - PAD.b + 14}) rotate(-35)" text-anchor="end" font-size="11" fill="#475467">${esc(l)}</text>` : `<text x="${cx}" y="${H - PAD.b + 18}" text-anchor="middle" font-size="11" fill="#475467">${esc(l)}</text>`);
  });
  g.push(`<line x1="${PAD.l}" y1="${Y(0)}" x2="${W - PAD.r}" y2="${Y(0)}" stroke="#667085" stroke-width="1.2"/>`);
  const legend = groups.length > 1 ? legendSvg(groups.map((x, k) => ({ label: x.label, type: 'bars', color: COLORS[k] }))) : '';
  return frame(spec, g.join(''), legend);
}

/** A chart spec → an SVG string (at the parameters' values: spec.values overrides them; spec.view turns a 3D one). */
export function render(spec = {}) {
  const kind = KINDS.includes(spec.kind) ? spec.kind : 'line';
  if (kind === 'bar') return barChart(spec);
  if (kind === '3d') return chart3d(spec);
  return xyChart(spec, kind);
}

export { KINDS };
