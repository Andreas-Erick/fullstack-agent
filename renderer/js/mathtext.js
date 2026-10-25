// Math in replies and notes: finds LaTeX ($…$, $$…$$, \(…\), \[…\]) in Markdown so util.js can render
// it with KaTeX, and turns it into words for the voice ("x squared over 2"). Pure (no DOM, no app
// state), so it is tested directly (test/mathtext.test.js).

// Private-use characters mark where a formula was taken out; Markdown leaves them alone.
const PH_OPEN = '';
const PH_CLOSE = '';

// Code spans and fenced blocks keep their dollars; everything else is searched for math.
const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/;

const MATH = new RegExp(
  [
    String.raw`\$\$([\s\S]+?)\$\$`, // $$ display $$
    String.raw`\\\[([\s\S]+?)\\\]`, // \[ display \]
    String.raw`\\\(([\s\S]+?)\\\)`, // \( inline \)
    // $inline$: not "\$", no space just inside the dollars, no digit right after the closing one
    // (so "$5 and $10" stays money), on one line.
    String.raw`(?<![\\$])\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?!\d)`,
  ].join('|'),
  'g',
);

/** Takes the math out of Markdown: { text (with placeholders), items: [{ tex, display }] }. */
export function extractMath(md) {
  const items = [];
  const parts = String(md ?? '').split(CODE);
  const text = parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // code
      return part.replace(MATH, (_m, dd, br, pa, dl) => {
        const display = dd !== undefined || br !== undefined;
        items.push({ tex: (dd ?? br ?? pa ?? dl).trim(), display });
        return `${PH_OPEN}${items.length - 1}${PH_CLOSE}`;
      });
    })
    .join('');
  return { text, items };
}

/** Puts rendered formulas back: render(tex, display) → HTML. */
export function restoreMath(html, items, render) {
  return String(html).replace(new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, 'g'), (_m, i) => {
    const item = items[Number(i)];
    return item ? render(item.tex, item.display) : '';
  });
}

// ------------------------------------------------------------ speech
const GREEK = 'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega'.split(' ');

const SYMBOLS = {
  infty: 'infinity', cdot: 'times', times: 'times', div: 'divided by', pm: 'plus or minus', mp: 'minus or plus',
  le: 'is at most', leq: 'is at most', ge: 'is at least', geq: 'is at least', neq: 'is not equal to', ne: 'is not equal to',
  approx: 'is approximately', equiv: 'is equivalent to', sim: 'is similar to', cong: 'is congruent to', propto: 'is proportional to',
  ll: 'is much less than', gg: 'is much greater than',
  in: 'in', notin: 'not in', subset: 'is a subset of', subseteq: 'is a subset of', supset: 'is a superset of', supseteq: 'is a superset of',
  cup: 'union', cap: 'intersect', setminus: 'minus', emptyset: 'the empty set', varnothing: 'the empty set',
  forall: 'for all', exists: 'there exists', nexists: 'there is no', neg: 'not', lnot: 'not', land: 'and', wedge: 'and', lor: 'or', vee: 'or',
  to: 'to', rightarrow: 'to', mapsto: 'maps to', gets: 'gets', leftarrow: 'gets',
  implies: 'implies', Rightarrow: 'implies', impliedby: 'is implied by', Leftarrow: 'is implied by', iff: 'if and only if', Leftrightarrow: 'if and only if',
  partial: 'partial', nabla: 'nabla', circ: 'composed with', ldots: 'and so on', cdots: 'and so on', dots: 'and so on', vdots: '', ddots: '',
  mid: 'divides', nmid: 'does not divide', perp: 'is perpendicular to', parallel: 'is parallel to', angle: 'angle', triangle: 'triangle',
  langle: '', rangle: '', lvert: '', rvert: '', lVert: '', rVert: '', left: '', right: '', big: '', Big: '', bigl: '', bigr: '', Bigl: '', Bigr: '',
  quad: ',', qquad: ',', displaystyle: '', textstyle: '', limits: '', nolimits: '', ',': ' ', ';': ' ', '!': '', ' ': ' ',
  sin: 'sine', cos: 'cosine', tan: 'tangent', sec: 'secant', csc: 'cosecant', cot: 'cotangent', arcsin: 'arc sine', arccos: 'arc cosine', arctan: 'arc tangent',
  sinh: 'hyperbolic sine', cosh: 'hyperbolic cosine', tanh: 'hyperbolic tangent', log: 'log', ln: 'natural log', exp: 'exp',
  det: 'the determinant of', dim: 'the dimension of', ker: 'the kernel of', deg: 'the degree of', gcd: 'the gcd of', max: 'the max of', min: 'the min of', sup: 'the supremum of', inf: 'the infimum of',
  Re: 'the real part of', Im: 'the imaginary part of', hbar: 'h bar', ell: 'l', aleph: 'aleph', top: 'transpose', prime: 'prime',
};
const SETS = { R: 'the reals', N: 'the naturals', Z: 'the integers', Q: 'the rationals', C: 'the complex numbers' };
const BIG = { sum: 'the sum', prod: 'the product', int: 'the integral', iint: 'the double integral', iiint: 'the triple integral', oint: 'the contour integral', bigcup: 'the union', bigcap: 'the intersection', lim: 'the limit', limsup: 'the limit superior', liminf: 'the limit inferior' };
const POWERS = { 2: 'squared', 3: 'cubed' };

// One {group} or a single token after `i` in s: [content, nextIndex].
function arg(s, i) {
  while (s[i] === ' ') i++;
  if (s[i] === '{') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1];
    }
    return [s.slice(i + 1), s.length];
  }
  if (s[i] === '\\') {
    const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
    return [m ? m[0] : '\\', i + (m ? m[0].length : 1)];
  }
  return [s[i] ?? '', i + 1];
}

const isSimple = (words) => !/\s/.test(words.trim());

function speakScript(sup) {
  const w = toWords(sup);
  if (POWERS[w.trim()]) return ` ${POWERS[w.trim()]}`;
  if (w.trim() === 'prime' || sup.trim() === "'") return ' prime';
  if (w.trim() === 'transpose' || sup.trim() === 'T') return ' transpose';
  if (w.trim() === 'minus 1') return ' inverse';
  return isSimple(w) ? ` to the ${w.trim()}` : ` to the power ${w.trim()}, end power`;
}

// LaTeX → spoken words.
function toWords(tex) {
  const s = String(tex);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
      const name = m ? m[1] : '';
      i += m ? m[0].length : 1;
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const [a, i1] = arg(s, i);
        const [b, i2] = arg(s, i1);
        i = i2;
        const wa = toWords(a).trim();
        const wb = toWords(b).trim();
        // d/dx and dy/dx read as derivatives.
        const dTop = /^d ?([a-z]?)$/.exec(wa);
        const dBottom = /^d ?([a-z])$/.exec(wb);
        if (dTop && dBottom) out += dTop[1] ? ` d ${dTop[1]} by d ${dBottom[1]} ` : ` the derivative with respect to ${dBottom[1]} of `;
        else out += isSimple(wa) && isSimple(wb) ? ` ${wa} over ${wb} ` : ` the fraction ${wa}, over ${wb}, end fraction `;
      } else if (name === 'sqrt') {
        let root = '';
        if (s[i] === '[') {
          const end = s.indexOf(']', i);
          root = s.slice(i + 1, end);
          i = end + 1;
        }
        const [a, n] = arg(s, i);
        i = n;
        const w = toWords(a).trim();
        const what = root ? (root === '3' ? 'the cube root of' : `the ${toWords(root).trim()}th root of`) : 'the square root of';
        out += isSimple(w) ? ` ${what} ${w} ` : ` ${what} ${w}, end root `;
      } else if (BIG[name]) {
        let lower = '';
        let upper = '';
        for (let k = 0; k < 3 && (s[i] === '_' || s[i] === '^' || s[i] === ' ' || s.startsWith('\\limits', i)); k++) {
          if (s.startsWith('\\limits', i)) i += 7;
          while (s[i] === ' ') i++;
          if (s[i] === '_') [lower, i] = arg(s, i + 1);
          else if (s[i] === '^') [upper, i] = arg(s, i + 1);
        }
        const lw = toWords(lower).trim().replace(/ equals /, ' equals ');
        if (name === 'lim' || name === 'limsup' || name === 'liminf') out += ` ${BIG[name]}${lw ? ` as ${lw.replace(/ to /, ' goes to ')}` : ''} of `;
        else out += ` ${BIG[name]}${lw ? ` from ${lw}` : ''}${upper ? ` to ${toWords(upper).trim()}` : ''} of `;
      } else if (name === 'mathbb' || name === 'Bbb') {
        const [a, n] = arg(s, i);
        i = n;
        out += ` ${SETS[a.trim()] || a} `;
      } else if (['mathrm', 'mathbf', 'mathit', 'mathcal', 'mathsf', 'mathfrak', 'boldsymbol', 'bm', 'operatorname', 'text', 'textbf', 'textit', 'mbox'].includes(name)) {
        const [a, n] = arg(s, i);
        i = n;
        out += /^text|mbox/.test(name) ? ` ${a} ` : ` ${toWords(a)} `;
      } else if (['hat', 'bar', 'overline', 'vec', 'tilde', 'dot', 'ddot', 'widehat', 'widetilde', 'overrightarrow'].includes(name)) {
        const [a, n] = arg(s, i);
        i = n;
        const w = toWords(a).trim();
        const word = { hat: 'hat', widehat: 'hat', bar: 'bar', overline: 'bar', vec: 'vector', overrightarrow: 'vector', tilde: 'tilde', widetilde: 'tilde', dot: 'dot', ddot: 'double dot' }[name];
        out += name === 'vec' || name === 'overrightarrow' ? ` vector ${w} ` : ` ${w} ${word} `;
      } else if (name === 'binom') {
        const [a, i1] = arg(s, i);
        const [b, i2] = arg(s, i1);
        i = i2;
        out += ` ${toWords(a).trim()} choose ${toWords(b).trim()} `;
      } else if (name === 'begin' || name === 'end') {
        const [env, n] = arg(s, i);
        i = n;
        if (name === 'begin' && /matrix/.test(env)) out += ' the matrix ';
        if (name === 'begin' && env === 'cases') out += ' cases: ';
      } else if (name === '\\') out += ', ';
      else if (GREEK.includes(name)) out += ` ${name.replace(/^var/, '').toLowerCase()} `;
      else if (name in SYMBOLS) out += ` ${SYMBOLS[name]} `;
      else if (/^[{}$%&#_]$/.test(name)) out += name === '%' ? ' percent ' : '';
      else out += ` ${name} `;
    } else if (c === '^') {
      const [a, n] = arg(s, i + 1);
      i = n;
      out += speakScript(a);
    } else if (c === '_') {
      const [a, n] = arg(s, i + 1);
      i = n;
      const w = toWords(a).trim();
      out += isSimple(w) ? ` sub ${w} ` : ` sub ${w}, end sub `;
    } else if (c === '{' || c === '}') {
      i++;
    } else if (c === '&') {
      out += ' ';
      i++;
    } else {
      const ops = { '=': ' equals ', '+': ' plus ', '-': ' minus ', '<': ' is less than ', '>': ' is greater than ', '/': ' over ', '*': ' times ', '!': ' factorial ', '|': ' ', "'": ' prime ', '(': ' (', ')': ') ', ',': ', ', ':': ' such that ' };
      // f(x) is "f of x"; "f: A \to B" is "f from A to B", a set-builder colon is "such that".
      if (c === '(' && /[A-Za-z]$/.test(s.slice(0, i)) && /[A-Za-z]$/.test(out)) out += ' of (';
      else if (c === ':') out += /\\(?:to|rightarrow)\b/.test(s.slice(i)) ? ' from ' : ' such that ';
      else out += ops[c] ?? c;
      i++;
    }
  }
  return out.replace(/\(\s*/g, '(').replace(/\s*\)/g, ')').replace(/\s+([,.])/g, '$1').replace(/\s{2,}/g, ' ');
}

/** A formula in words; long ones point at the screen instead. */
export function speakMath(tex, { maxChars = 160 } = {}) {
  const words = toWords(tex).replace(/[()]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return words.length > maxChars ? 'the formula on screen' : words;
}

/** True while `text` (a streamed piece of a reply) ends inside a formula, so speech waits for the rest. */
export function mathOpen(text) {
  const s = String(text).split(CODE).filter((_p, i) => i % 2 === 0).join('').replace(/\\\$/g, '');
  const display = (s.match(/\$\$/g) || []).length;
  if (display % 2) return true;
  const single = (s.replace(/\$\$/g, '').match(/\$/g) || []).length;
  // A lone "$5" is money: only an odd count with a formula-looking tail keeps the sentence open.
  if (single % 2 && /\$[^$\s\d][^$]*$/.test(s.replace(/\$\$/g, ''))) return true;
  return (s.match(/\\\[/g) || []).length > (s.match(/\\\]/g) || []).length || (s.match(/\\\(/g) || []).length > (s.match(/\\\)/g) || []).length;
}

/** Markdown with every formula replaced by its spoken form (code is left for speakable() to drop). */
export function speakableMath(md) {
  const { text, items } = extractMath(md);
  return restoreMath(text, items, (tex) => ` ${speakMath(tex)} `);
}
