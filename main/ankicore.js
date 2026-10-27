// Anki's spaced repetition, pure (no I/O): the SM-2 scheduler as Anki's v3 scheduler runs it (learning
// steps, graduating and easy intervals, ease factors, Hard/Good/Easy multipliers, lapses with
// relearning steps, interval fuzz, leeches) and FSRS-5 (Anki's newer scheduler) as a per-deck option,
// with Anki's default parameters. flashcore.js keeps the cards; this decides when each comes back.
//
// A card's schedule: { type: 'new' | 'learn' | 'review' | 'relearn', step, dueAt (ms, learning),
// due ('YYYY-MM-DD', review), ivl (days), ease (2.5 = 250 %), reps, lapses, last ('YYYY-MM-DD'),
// s, d (FSRS stability and difficulty), leech, suspended }. Days roll over at 4 am, as in Anki.

const GRADES = ['again', 'hard', 'good', 'easy'];
const MIN_EASE = 1.3;
const DAY_MS = 86400000;

// Anki's defaults (Deck options).
const DEFAULTS = {
  scheduler: 'sm2', // sm2 | fsrs
  learnSteps: [1, 10], // minutes
  relearnSteps: [10],
  graduatingIvl: 1,
  easyIvl: 4,
  startingEase: 2.5,
  easyBonus: 1.3,
  hardIvl: 1.2,
  ivlModifier: 1,
  maxIvl: 36500,
  lapseMult: 0, // "New interval" after a lapse
  minLapseIvl: 1,
  leechThreshold: 8,
  newPerDay: 20,
  reviewsPerDay: 200,
  retention: 0.9, // FSRS desired retention
  rolloverHour: 4,
  fuzz: true,
};

// FSRS-5 default parameters (as in Anki 24.11).
const FSRS_W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const DECAY = -0.5;
const FACTOR = 0.9 ** (1 / DECAY) - 1; // 19/81

function config(c = {}) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(c || {})) if (k in DEFAULTS && v !== undefined && v !== null && v !== '') out[k] = v;
  const steps = (s) => (Array.isArray(s) ? s : String(s || '').split(/[\s,]+/)).map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(0, 10);
  out.learnSteps = steps(out.learnSteps);
  out.relearnSteps = steps(out.relearnSteps);
  for (const k of ['graduatingIvl', 'easyIvl', 'startingEase', 'easyBonus', 'hardIvl', 'ivlModifier', 'maxIvl', 'lapseMult', 'minLapseIvl', 'leechThreshold', 'newPerDay', 'reviewsPerDay', 'retention', 'rolloverHour']) out[k] = Number(out[k]);
  out.scheduler = out.scheduler === 'fsrs' ? 'fsrs' : 'sm2';
  out.retention = Math.min(0.99, Math.max(0.7, out.retention || 0.9));
  out.maxIvl = Math.max(1, out.maxIvl || 36500);
  return out;
}

// ------------------------------------------------------------------ days
const pad = (n) => String(n).padStart(2, '0');
/** The Anki day of a moment: local date, rolling over at `rollover` o'clock. */
function dayOf(ms, rollover = DEFAULTS.rolloverHour) {
  const d = new Date(ms - rollover * 3600000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS);

/** The end of the Anki day containing `ms`: learning steps past it count as tomorrow's cards. */
function dayEnd(ms, rollover = DEFAULTS.rolloverHour) {
  const d = new Date(ms - rollover * 3600000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, rollover).getTime();
}

// ------------------------------------------------------------------ fuzz (Anki's ranges)
function fuzzRange(ivl, min, max) {
  if (ivl < 2.5) return [Math.round(ivl), Math.round(ivl)];
  let delta = 1;
  for (const [start, end, f] of [[2.5, 7, 0.15], [7, 20, 0.1], [20, Infinity, 0.05]]) delta += f * Math.max(0, Math.min(ivl, end) - start);
  const lo = Math.max(min, Math.round(ivl - delta));
  const hi = Math.min(max, Math.round(ivl + delta));
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

// A stable random number per card and review (Anki seeds its fuzz the same way): the previews match
// what a button really does.
function seeded(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function constrain(ivl, min, cfg, seed) {
  let x = ivl * cfg.ivlModifier;
  if (cfg.fuzz && seed !== undefined) {
    const [lo, hi] = fuzzRange(x, Math.max(1, min), cfg.maxIvl);
    x = lo + Math.floor(seeded(seed) * (hi - lo + 1));
  }
  return Math.round(Math.min(cfg.maxIvl, Math.max(min, 1, x)));
}

// ------------------------------------------------------------------ FSRS-5
const clampD = (d) => Math.min(10, Math.max(1, d));
const fsrs = {
  retrievability: (t, s) => (1 + (FACTOR * t) / s) ** DECAY,
  interval: (s, r) => (s / FACTOR) * (r ** (1 / DECAY) - 1),
  initS: (g) => Math.max(0.1, FSRS_W[g - 1]),
  initD: (g) => clampD(FSRS_W[4] - Math.exp(FSRS_W[5] * (g - 1)) + 1),
  nextD(d, g) {
    const delta = -FSRS_W[6] * (g - 3);
    const damped = d + (delta * (10 - d)) / 9;
    return clampD(FSRS_W[7] * fsrs.initD(4) + (1 - FSRS_W[7]) * damped);
  },
  recallS(d, s, r, g) {
    const hard = g === 2 ? FSRS_W[15] : 1;
    const easy = g === 4 ? FSRS_W[16] : 1;
    return s * (Math.exp(FSRS_W[8]) * (11 - d) * s ** -FSRS_W[9] * (Math.exp(FSRS_W[10] * (1 - r)) - 1) * hard * easy + 1);
  },
  forgetS(d, s, r) {
    return Math.min(s, FSRS_W[11] * d ** -FSRS_W[12] * ((s + 1) ** FSRS_W[13] - 1) * Math.exp(FSRS_W[14] * (1 - r)));
  },
  shortTermS: (s, g) => s * Math.exp(FSRS_W[17] * (g - 3 + FSRS_W[18])),
};

/** The memory state after answering `g` (1–4): FSRS's stability and difficulty. */
function nextMemory(card, g, today) {
  if (!card.s || !card.d) return { s: fsrs.initS(g), d: fsrs.initD(g) };
  const t = card.last ? Math.max(0, daysBetween(card.last, today)) : 0;
  const d = fsrs.nextD(card.d, g);
  if (t === 0) return { s: Math.max(0.01, fsrs.shortTermS(card.s, g)), d };
  const r = fsrs.retrievability(t, card.s);
  return { s: Math.max(0.01, g === 1 ? fsrs.forgetS(card.d, card.s, r) : fsrs.recallS(card.d, card.s, r, g)), d };
}

// ------------------------------------------------------------------ answering
const isLearning = (c) => c.type === 'learn' || c.type === 'relearn';

/** A card with no schedule yet. */
const fresh = () => ({ type: 'new', step: 0, ivl: 0, ease: 0, reps: 0, lapses: 0 });

/** Normalizes a stored schedule (missing or odd fields from hand edits). */
function normalize(c = {}) {
  const type = ['new', 'learn', 'review', 'relearn'].includes(c.type) ? c.type : c.due ? 'review' : 'new';
  return {
    ...c,
    type,
    step: Math.max(0, Number(c.step) || 0),
    ivl: Math.max(0, Number(c.ivl) || 0),
    ease: Number(c.ease) > 0 ? Number(c.ease) : 0,
    reps: Math.max(0, Number(c.reps) || 0),
    lapses: Math.max(0, Number(c.lapses) || 0),
    ...(type === 'review' && !/^\d{4}-\d{2}-\d{2}$/.test(c.due || '') ? { due: '' } : {}),
  };
}

// The delay of a learning step for each button (Anki v3: Hard repeats the step, halfway to the next
// one from the first step, or 1.5 × a single step but at most a day longer).
function stepDelay(steps, step, grade) {
  const cur = steps[Math.min(step, steps.length - 1)];
  if (grade === 'again') return steps[0];
  if (grade === 'hard') {
    if (step === 0 && steps.length > 1) return (steps[0] + steps[1]) / 2;
    if (step === 0) return Math.min(steps[0] * 1.5, steps[0] + 1440);
    return cur;
  }
  return steps[step + 1]; // good: the next step (undefined = graduate)
}

/**
 * Answers a card. Returns the new schedule plus `ivlText`-able facts: { card, graduated, lapsed }.
 * now: ms; card: a schedule (normalize() is applied); cfg: deck options; seed: the card's id.
 */
function answer(card0, grade, now, cfg0 = {}, seed = '') {
  if (!GRADES.includes(grade)) throw new Error(`Grade must be one of: ${GRADES.join(', ')}`);
  const cfg = config(cfg0);
  const card = normalize(card0);
  const g = GRADES.indexOf(grade) + 1;
  const today = dayOf(now, cfg.rolloverHour);
  const c = { ...card, reps: card.reps + 1 };
  const mem = cfg.scheduler === 'fsrs' ? nextMemory(card, g, today) : null;
  if (mem) Object.assign(c, mem);
  const fuzzSeed = `${seed}:${card.reps}`;
  const toReview = (ivl) => {
    Object.assign(c, { type: 'review', step: 0, ivl, due: addDays(today, ivl), last: today });
    delete c.dueAt;
    return c;
  };
  const fsrsIvl = (s, min = 1) => constrain(fsrs.interval(s, cfg.retention), min, { ...cfg, ivlModifier: 1 }, fuzzSeed);

  // New and learning cards: the learning steps, then graduation.
  if (card.type === 'new' || card.type === 'learn') {
    const steps = cfg.learnSteps;
    c.ease ||= cfg.startingEase;
    const graduate = (ivl) => toReview(mem ? fsrsIvl(mem.s) : ivl);
    if (grade === 'easy') return { card: graduate(cfg.easyIvl), graduated: true };
    if (!steps.length && grade !== 'again') return { card: graduate(cfg.graduatingIvl), graduated: true };
    if (!steps.length) {
      Object.assign(c, { type: 'learn', step: 0, dueAt: now + 60000, last: today });
      return { card: c };
    }
    const step = card.type === 'new' ? 0 : card.step;
    const delay = stepDelay(steps, step, grade);
    if (grade === 'good' && delay === undefined) return { card: graduate(cfg.graduatingIvl), graduated: true };
    Object.assign(c, { type: 'learn', step: grade === 'again' ? 0 : grade === 'good' ? step + 1 : step, dueAt: now + delay * 60000, last: today });
    return { card: c };
  }

  // Relearning after a lapse: its own steps, then back to review with the lapse interval.
  if (card.type === 'relearn') {
    const steps = cfg.relearnSteps;
    const back = () => toReview(mem ? fsrsIvl(mem.s) : Math.max(cfg.minLapseIvl, card.ivl || 1) + (grade === 'easy' ? 1 : 0));
    if (!steps.length || grade === 'easy') return { card: back(), graduated: true };
    const delay = stepDelay(steps, card.step, grade);
    if (grade === 'good' && delay === undefined) return { card: back(), graduated: true };
    Object.assign(c, { step: grade === 'again' ? 0 : grade === 'good' ? card.step + 1 : card.step, dueAt: now + delay * 60000, last: today });
    return { card: c };
  }

  // Review cards.
  const daysLate = card.due ? Math.max(0, daysBetween(card.due, today)) : 0;
  const ivl = Math.max(1, card.ivl);
  if (grade === 'again') {
    c.lapses = card.lapses + 1;
    c.ease = Math.max(MIN_EASE, (card.ease || cfg.startingEase) - 0.2);
    const lapseIvl = mem ? Math.max(cfg.minLapseIvl, Math.round(Math.min(fsrs.interval(mem.s, cfg.retention), ivl))) : Math.max(cfg.minLapseIvl, Math.round(ivl * cfg.lapseMult));
    c.ivl = Math.max(1, lapseIvl);
    const t = cfg.leechThreshold;
    if (t > 0 && c.lapses >= t && (c.lapses - t) % Math.max(1, Math.ceil(t / 2)) === 0) c.leech = true;
    if (cfg.relearnSteps.length) {
      Object.assign(c, { type: 'relearn', step: 0, dueAt: now + cfg.relearnSteps[0] * 60000, last: today });
      delete c.due;
      return { card: c, lapsed: true };
    }
    return { card: toReview(c.ivl), lapsed: true };
  }
  if (mem) {
    // FSRS: the interval for the new stability, kept in order (hard ≤ good < easy) as Anki does.
    const others = Object.fromEntries([2, 3, 4].map((x) => [x, fsrs.interval(nextMemory(card, x, today).s, cfg.retention)]));
    const hard = constrain(others[2], 1, { ...cfg, ivlModifier: 1 }, fuzzSeed);
    const good = constrain(others[3], hard + 1, { ...cfg, ivlModifier: 1 }, fuzzSeed);
    const easy = constrain(others[4], good + 1, { ...cfg, ivlModifier: 1 }, fuzzSeed);
    c.ease = Math.max(MIN_EASE, (card.ease || cfg.startingEase) + { hard: -0.15, good: 0, easy: 0.15 }[grade]);
    return { card: toReview({ hard, good, easy }[grade]) };
  }
  const ease = card.ease || cfg.startingEase;
  const hardMin = cfg.hardIvl > 1 ? ivl + 1 : 0;
  const hard = constrain(ivl * cfg.hardIvl, hardMin, cfg, fuzzSeed);
  const good = constrain((ivl + daysLate / 2) * ease, cfg.hardIvl > 1 ? hard + 1 : ivl + 1, cfg, fuzzSeed);
  const easy = constrain((ivl + daysLate) * ease * cfg.easyBonus, good + 1, cfg, fuzzSeed);
  c.ease = Math.max(MIN_EASE, ease + { hard: -0.15, good: 0, easy: 0.15 }[grade]);
  return { card: toReview({ hard, good, easy }[grade]) };
}

/** What each button would do, as Anki shows over its buttons: { again: '10m', hard: '1d', … }. */
function preview(card, now, cfg = {}, seed = '') {
  const out = {};
  for (const g of GRADES) {
    const { card: c } = answer(card, g, now, cfg, seed);
    out[g] = c.dueAt ? spanText((c.dueAt - now) / 60000) : spanText(c.ivl * 1440);
  }
  return out;
}

/** "10m", "1h", "3d", "2.1mo", "1.5y". */
function spanText(minutes) {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  const days = minutes / 1440;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${(days / 30).toFixed(1).replace(/\.0$/, '')}mo`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, '')}y`;
}

/** Where a card stands now: 'new' | 'learn' (due now or later today) | 'due' | 'later' | 'suspended'. */
function status(card0, now, cfg = {}) {
  const card = normalize(card0);
  if (card.suspended) return 'suspended';
  if (card.type === 'new') return 'new';
  const today = dayOf(now, config(cfg).rolloverHour);
  if (isLearning(card)) {
    // Learning steps that end today are today's; a step that runs past the day's end is tomorrow's.
    return !card.dueAt || card.dueAt <= dayEnd(now, config(cfg).rolloverHour) ? 'learn' : 'later';
  }
  return card.due && card.due <= today ? 'due' : 'later';
}

module.exports = { GRADES, DEFAULTS, FSRS_W, config, dayOf, dayEnd, addDays, daysBetween, fuzzRange, answer, preview, spanText, status, normalize, fresh, fsrs, nextMemory, isLearning };
