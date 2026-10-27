// Charts for study material (tool chart_create), pure: a safe formula parser and an SVG renderer for
// function plots, data lines, scatter plots and bar charts. The numbers are computed here, not drawn
// by the model, so a plot of sin(x) or a parabola is exactly right. The SVG is self-contained and
// print-friendly (white background, the Okabe–Ito palette, readable in black and white through dashes),
// so it works in a document window, in Obsidian and inside a PDF (pdf.js).

// ---------------------------------------------------------------------------------------- formulas
// A small expression language, parsed into a tree and evaluated without eval or Function: numbers,
// x, pi, e, + - * / ^, parentheses, implicit multiplication ("2x", "3(x+1)", "x sin(x)"), and a fixed
// set of functions. Anything else is an error that says what was not understood.
const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, exp: Math.exp, ln: Math.log, log: Math.log10, log2: Math.log2,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
};
const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const MAX_FORMULA = 300;

function tokenize(src) {
  const s = String(src ?? '').replace(/\*\*/g, '^').replace(/·|×/g, '*').replace(/−/g, '-').replace(/π/g, 'pi');
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

/** "x^2 - 3x + 2" → a function of x (only x is a variable). Throws with a readable reason. */
function compile(formula) {
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
      if (k.v === 'x') return { x: true };
      if (Object.hasOwn(CONSTS, k.v)) return { num: CONSTS[k.v] };
      if (Object.hasOwn(FUNCS, k.v)) {
        if (!take('(')) return { fn: k.v, a: power() }; // "sin x"
        const a = expr();
        if (!take(')')) throw new Error(`A closing parenthesis is missing after ${k.v}(.`);
        return { fn: k.v, a };
      }
      throw new Error(`Unknown name "${k.v}". Use x, pi, e and ${Object.keys(FUNCS).join(', ')}.`);
    }
    throw new Error(`Unexpected "${k.t}" in the formula.`);
  }
  const tree = expr();
  if (i < toks.length) throw new Error(`Unexpected "${toks[i].v ?? toks[i].t}" in the formula.`);
  const ev = (n, x) => {
    if ('num' in n) return n.num;
    if (n.x) return x;
    if (n.fn) return FUNCS[n.fn](ev(n.a, x));
    if (n.op === 'neg') return -ev(n.a, x);
    const a = ev(n.a, x);
    const b = ev(n.b, x);
    return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? a / b : a ** b;
  };
  return (x) => ev(tree, x);
}

// ------------------------------------------------------------------------------------------ chart
const W = 720;
const H = 440;
const PAD = { l: 62, r: 24, t: 48, b: 58 };
const COLORS = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#000000'];
const DASHES = ['', '7 4', '2 3', '10 3 2 3', '4 4', '1 2', '12 4'];
const SAMPLES = 600;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v) => {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(1).replace('e+', 'e');
  return String(Number(v.toPrecision(6)));
};

/** About `count` round tick values covering [lo, hi]: steps of 1, 2 or 5 × 10^k. */
function ticks(lo, hi, count = 6) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  return out;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const range = (r, name) => {
  if (!Array.isArray(r) || r.length !== 2 || !finite(Number(r[0])) || !finite(Number(r[1])) || !(Number(r[1]) > Number(r[0]))) throw new Error(`${name} must be [from, to] with from < to.`);
  return [Number(r[0]), Number(r[1])];
};

/**
 * The series of a chart as point lists: functions are sampled across xRange; a jump between two
 * neighbours far beyond the visible height (tan at π/2, 1/x at 0) breaks the line instead of drawing
 * a vertical stroke. Returns [{ label, segments: [[[x,y]…]…], points }].
 */
function seriesData(spec, xr) {
  const list = Array.isArray(spec.series) ? spec.series.slice(0, 7) : [];
  if (!list.length) throw new Error('Give at least one series: a formula (fn) or points.');
  return list.map((s, k) => {
    const label = String(s.label || s.fn || `Series ${k + 1}`).slice(0, 60);
    if (s.fn != null) {
      const f = compile(s.fn);
      const pts = [];
      for (let j = 0; j <= SAMPLES; j++) {
        const x = xr[0] + ((xr[1] - xr[0]) * j) / SAMPLES;
        let y;
        try {
          y = f(x);
        } catch {
          y = NaN;
        }
        pts.push([x, finite(y) ? y : NaN]);
      }
      return { label, fn: true, pts };
    }
    const pts = (Array.isArray(s.points) ? s.points : []).slice(0, 5000).map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p?.x), Number(p?.y)])).filter(([x, y]) => finite(x) && finite(y));
    if (!pts.length) throw new Error(`Series "${label}" has no usable points.`);
    return { label, fn: false, pts: pts.sort((a, b) => a[0] - b[0]) };
  });
}

// The y range of sampled functions ignores the far ends of asymptotes: the middle 96 % of values,
// padded, unless the caller gives yRange.
function autoY(series) {
  const ys = series.flatMap((s) => s.pts.map((p) => p[1]).filter(finite)).sort((a, b) => a - b);
  if (!ys.length) throw new Error('Nothing to plot: the formula has no real values in that x range.');
  const fnOnly = series.every((s) => s.fn);
  const lo = fnOnly && ys.length > 50 ? ys[Math.floor(ys.length * 0.02)] : ys[0];
  const hi = fnOnly && ys.length > 50 ? ys[Math.ceil(ys.length * 0.98) - 1] : ys[ys.length - 1];
  if (hi - lo < 1e-12) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

function frame(spec, body, legend) {
  const title = spec.title ? `<text x="${W / 2}" y="28" text-anchor="middle" font-size="17" font-weight="600" fill="#15181f">${esc(spec.title)}</text>` : '';
  const xl = spec.xLabel ? `<text x="${PAD.l + (W - PAD.l - PAD.r) / 2}" y="${H - 14}" text-anchor="middle" font-size="13" fill="#344054">${esc(spec.xLabel)}</text>` : '';
  const yl = spec.yLabel ? `<text transform="translate(16 ${PAD.t + (H - PAD.t - PAD.b) / 2}) rotate(-90)" text-anchor="middle" font-size="13" fill="#344054">${esc(spec.yLabel)}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Segoe UI, system-ui, sans-serif" role="img" aria-label="${esc(spec.title || 'Chart')}"><rect width="${W}" height="${H}" fill="#ffffff"/>${title}${body}${xl}${yl}${legend}</svg>`;
}

const LEGEND_W = 176;
const legendH = (n) => n * 20 + 8;

/**
 * Where the legend covers the least data: the corner of the plot (top right, top left, bottom right,
 * bottom left) that the fewest plotted points fall in. `pixels` are [x, y] screen points.
 */
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

function legendSvg(labels, kind, [x0, y0] = [W - PAD.r - LEGEND_W - 6, PAD.t + 6]) {
  if (labels.length < 2) return '';
  const rows = labels.map((l, k) => {
    const y = y0 + 14 + k * 20;
    const mark = kind === 'scatter' ? `<circle cx="${x0 + 22}" cy="${y}" r="4" fill="${COLORS[k]}"/>` : `<line x1="${x0 + 10}" y1="${y}" x2="${x0 + 34}" y2="${y}" stroke="${COLORS[k]}" stroke-width="2.5" stroke-dasharray="${DASHES[k]}"/>`;
    return `${mark}<text x="${x0 + 42}" y="${y + 4}" font-size="12" fill="#15181f">${esc(l.slice(0, 26))}</text>`;
  });
  return `<g><rect x="${x0}" y="${y0}" width="${LEGEND_W}" height="${legendH(labels.length)}" fill="#ffffff" fill-opacity="0.92" stroke="#d0d5dd" rx="4"/>${rows.join('')}</g>`;
}

function axes(xr, yr, X, Y) {
  const g = [];
  for (const v of ticks(xr[0], xr[1])) g.push(`<line x1="${X(v)}" y1="${PAD.t}" x2="${X(v)}" y2="${H - PAD.b}" stroke="#eaecf0"/><text x="${X(v)}" y="${H - PAD.b + 18}" text-anchor="middle" font-size="11" fill="#475467">${fmt(v)}</text>`);
  for (const v of ticks(yr[0], yr[1])) g.push(`<line x1="${PAD.l}" y1="${Y(v)}" x2="${W - PAD.r}" y2="${Y(v)}" stroke="#eaecf0"/><text x="${PAD.l - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="#475467">${fmt(v)}</text>`);
  // The axes through zero when zero is in view, else along the frame.
  const x0 = xr[0] <= 0 && xr[1] >= 0 ? X(0) : PAD.l;
  const y0 = yr[0] <= 0 && yr[1] >= 0 ? Y(0) : H - PAD.b;
  g.push(`<line x1="${PAD.l}" y1="${y0}" x2="${W - PAD.r}" y2="${y0}" stroke="#667085" stroke-width="1.2"/><line x1="${x0}" y1="${PAD.t}" x2="${x0}" y2="${H - PAD.b}" stroke="#667085" stroke-width="1.2"/>`);
  g.push(`<rect x="${PAD.l}" y="${PAD.t}" width="${W - PAD.l - PAD.r}" height="${H - PAD.t - PAD.b}" fill="none" stroke="#d0d5dd"/>`);
  return g.join('');
}

function lineChart(spec, kind) {
  const xrIn = spec.xRange ? range(spec.xRange, 'xRange') : null;
  const anyFn = (spec.series || []).some((s) => s?.fn != null);
  if (anyFn && !xrIn) throw new Error('A formula needs xRange, e.g. [-5, 5].');
  const series = seriesData(spec, xrIn || [0, 1]);
  const xs = series.flatMap((s) => s.pts.map((p) => p[0]));
  const xr = xrIn || (Math.max(...xs) > Math.min(...xs) ? [Math.min(...xs), Math.max(...xs)] : [xs[0] - 1, xs[0] + 1]);
  const yr = spec.yRange ? range(spec.yRange, 'yRange') : autoY(series);
  const X = (v) => +(PAD.l + ((v - xr[0]) / (xr[1] - xr[0])) * (W - PAD.l - PAD.r)).toFixed(2);
  const Y = (v) => +(H - PAD.b - ((v - yr[0]) / (yr[1] - yr[0])) * (H - PAD.t - PAD.b)).toFixed(2);
  const span = yr[1] - yr[0];
  const paths = series.map((s, k) => {
    if (kind === 'scatter') return s.pts.filter(([x, y]) => x >= xr[0] && x <= xr[1] && y >= yr[0] && y <= yr[1]).map(([x, y]) => `<circle cx="${X(x)}" cy="${Y(y)}" r="3.5" fill="${COLORS[k]}" fill-opacity="0.85"/>`).join('');
    let d = '';
    let pen = false;
    let prev = null;
    for (const [x, y] of s.pts) {
      // Off-screen values are clamped a little past the edge (so a line leaves the frame, not stops
      // short), and a huge jump between neighbours is an asymptote: lift the pen.
      if (!finite(y) || (prev !== null && Math.abs(y - prev) > span * 4)) {
        pen = false;
        prev = finite(y) ? y : null;
        if (!finite(y)) continue;
      }
      const yc = Math.max(yr[0] - span * 0.5, Math.min(yr[1] + span * 0.5, y));
      d += `${pen ? 'L' : 'M'}${X(x)} ${Y(yc)}`;
      pen = true;
      prev = y;
    }
    return d ? `<path d="${d}" fill="none" stroke="${COLORS[k]}" stroke-width="2.4" stroke-linejoin="round" stroke-dasharray="${DASHES[k]}"/>` : '';
  });
  const clip = `<clipPath id="plot"><rect x="${PAD.l}" y="${PAD.t}" width="${W - PAD.l - PAD.r}" height="${H - PAD.t - PAD.b}"/></clipPath>`;
  const pixels = series.flatMap((s) => s.pts.filter(([x, y]) => finite(y) && x >= xr[0] && x <= xr[1] && y >= yr[0] && y <= yr[1]).map(([x, y]) => [X(x), Y(y)]));
  return frame(spec, `<defs>${clip}</defs>${axes(xr, yr, X, Y)}<g clip-path="url(#plot)">${paths.join('')}</g>`, legendSvg(series.map((s) => s.label), kind, legendCorner(series.length, pixels)));
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
  const legend = groups.length > 1 ? legendSvg(groups.map((x) => x.label), 'scatter') : '';
  return frame(spec, g.join(''), legend);
}

/** A chart spec → an SVG string. kind: line (default; formulas and/or points) | scatter | bar. */
function render(spec = {}) {
  const kind = ['line', 'scatter', 'bar'].includes(spec.kind) ? spec.kind : 'line';
  return kind === 'bar' ? barChart(spec) : lineChart(spec, kind);
}

module.exports = { compile, ticks, render, FUNCS };
