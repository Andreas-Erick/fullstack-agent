// The memory stream, after "Generative Agents" (Park et al. 2023, github.com/joonspk-research/generative_agents,
// Apache-2.0): a dated log of small observations and the reflections drawn from them. Retrieval scores
// every record by recency + importance + relevance (each scaled to 0..1 across the candidates), and
// reflection turns a pile of recent observations into a few higher-level insights that cite their
// evidence. Pure (no Electron, no I/O): stream.js and innerworld.js do the reading and writing.
//
// One record per line, readable and editable in Obsidian:
//   - 2026-10-26 14:02 · ★7 · Text <!-- rec {"id":"r-1a2b3c","k":"o"} -->
// k: o = observation, r = reflection (with "ev": the ids it rests on). A line the user wrote by hand
// ("- 2026-10-26 14:02 · text", no comment) counts as an observation of importance 5.

const KINDS = { o: 'observation', r: 'reflection' };
const DECAY = 0.995; // per hour, as in the paper
const REFLECT_AT = 60; // summed importance of new observations that triggers a reflection
const MAX_TEXT = 400;

const LINE = /^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) · (?:★(\d{1,2}) · )?(.*?)\s*(?:<!-- rec (\{.*\}) -->)?\s*$/;

const clip = (s, n = MAX_TEXT) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const clampImportance = (v) => Math.min(10, Math.max(1, Math.round(Number(v) || 5)));
const pad = (n) => String(n).padStart(2, '0');

/** Local "YYYY-MM-DD HH:MM" for a timestamp. */
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// A stable id for a hand-written line, so its access time can be remembered.
function hashId(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return `u-${(h >>> 0).toString(36)}`;
}

/** Records from a stream note, oldest first. Lines that aren't records are ignored. */
function parse(text) {
  const records = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (!m) continue;
    let meta = {};
    try {
      meta = m[5] ? JSON.parse(m[5]) : {};
    } catch {
      meta = {}; // a damaged comment: keep the line as a plain observation
    }
    const body = clip(m[4]);
    if (!body) continue;
    const at = new Date(`${m[1]}T${m[2]}:00`).getTime();
    if (!Number.isFinite(at)) continue;
    records.push({
      id: typeof meta.id === 'string' && /^[\w-]{1,40}$/.test(meta.id) ? meta.id : hashId(raw),
      kind: KINDS[meta.k] || 'observation',
      at,
      importance: clampImportance(m[3] ?? 5),
      text: body,
      evidence: Array.isArray(meta.ev) ? meta.ev.filter((x) => typeof x === 'string').slice(0, 20) : [],
    });
  }
  return records.sort((a, b) => a.at - b.at);
}

function formatLine(r) {
  const meta = { id: r.id, k: r.kind === 'reflection' ? 'r' : 'o' };
  if (r.evidence?.length) meta.ev = r.evidence;
  return `- ${stamp(r.at)} · ★${clampImportance(r.importance)} · ${clip(r.text).replace(/<!--|-->/g, '')} <!-- rec ${JSON.stringify(meta)} -->`;
}

/** A whole stream note: a heading, a line of explanation, one line per record. */
function serialize(records, { title, intro } = {}) {
  const head = [`# ${title || 'Memory stream'}`, '', intro || '_One line per record: when, how important (★1–10), what. Edit or delete lines freely._', ''];
  return `${head.join('\n')}\n${[...records].sort((a, b) => a.at - b.at).map(formatLine).join('\n')}\n`;
}

/** A new record from untrusted input (tool arguments, model output). */
function make({ id, text, importance, kind = 'observation', evidence = [], at }) {
  const t = clip(text);
  if (!t) throw new Error('A memory needs some text.');
  return { id, kind: kind === 'reflection' ? 'reflection' : 'observation', at, importance: clampImportance(importance), text: t, evidence: Array.isArray(evidence) ? evidence.slice(0, 20) : [] };
}

// ------------------------------------------------------------- relevance (TF-IDF, no model needed)
const STOP = new Set(
  'a an and are as at be been but by can did do does for from had has have he her his how i if in into is it its just me my of on or our she so than that the their them then there these they this to too up us was we were what when where which who why will with you your about after again all also am any because before being both could each few more most much must no nor not now off once only other out over own same should some such very would yes'.split(' '),
);

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokens(text) {
  return (String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

function vector(toks, idf) {
  const tf = new Map();
  for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
  const v = new Map();
  let norm = 0;
  for (const [t, n] of tf) {
    const w = (1 + Math.log(n)) * (idf.get(t) || 0);
    if (!w) continue;
    v.set(t, w);
    norm += w * w;
  }
  return { v, norm: Math.sqrt(norm) };
}

function cosine(a, b) {
  if (!a.norm || !b.norm) return 0;
  let dot = 0;
  const [small, big] = a.v.size < b.v.size ? [a.v, b.v] : [b.v, a.v];
  for (const [t, w] of small) dot += w * (big.get(t) || 0);
  return dot / (a.norm * b.norm);
}

// Scale to 0..1 across the candidates (min-max, as in the paper); all equal → all 0.
function scale(xs) {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return xs.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 0));
}

/**
 * The k records that matter most for `query` now: score = recency + importance + relevance.
 * access: { id: last time it was recalled } (recency counts from the later of that and its creation).
 */
function retrieve(records, query, { now = Date.now(), access = {}, k = 8, weights = { recency: 1, importance: 1, relevance: 1 }, minRelevance = 0 } = {}) {
  if (!records.length) return [];
  const docs = records.map((r) => tokens(r.text));
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + records.length / n)]));
  const q = vector(tokens(query), idf);
  const rel = docs.map((d) => cosine(q, vector(d, idf)));
  const rec = records.map((r) => DECAY ** (Math.max(0, now - Math.max(r.at, access[r.id] || 0)) / 3600000));
  const imp = records.map((r) => r.importance / 10);
  const [sRec, sRel] = [scale(rec), scale(rel)];
  return records
    .map((r, i) => ({ ...r, relevance: rel[i], score: weights.recency * sRec[i] + weights.importance * imp[i] + weights.relevance * sRel[i] }))
    .filter((r) => !q.norm || r.relevance >= minRelevance)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ------------------------------------------------------------------------------- reflection
/** Observations since the latest reflection, and whether they add up to enough to reflect on. */
function pending(records, threshold = REFLECT_AT) {
  const last = records.filter((r) => r.kind === 'reflection').reduce((t, r) => Math.max(t, r.at), 0);
  const fresh = records.filter((r) => r.kind === 'observation' && r.at > last);
  const sum = fresh.reduce((s, r) => s + r.importance, 0);
  return { fresh, sum, due: sum >= threshold };
}

/** The prompt that asks for insights; records are numbered so the reply can cite them. */
function reflectionPrompt(records, { subject = 'the user', who = 'an AI assistant', max = 3 } = {}) {
  const list = records.slice(-80);
  return `You are ${who}, reflecting on your recent memories about ${subject}, as in the "Generative Agents" architecture.
From the records below, what are the ${max} most important high-level insights you can infer? Good insights connect several records: patterns, preferences, what works and what doesn't, how ${subject} is changing. Don't repeat a single record, don't moralize, and don't invent anything the records don't support.
Respond with ONLY a JSON object: {"insights": [{"text": "one sentence", "importance": 1-10, "because": [record numbers]}]}

RECORDS:
${list.map((r, i) => `${i + 1}. [${stamp(r.at)}${r.kind === 'reflection' ? ', earlier insight' : ''}] ${r.text}`).join('\n')}`;
}

/** Insights from the model's JSON, with evidence mapped back to record ids. Bad items are dropped. */
function parseReflections(json, records, { max = 5 } = {}) {
  const list = records.slice(-80);
  const items = Array.isArray(json?.insights) ? json.insights : [];
  return items
    .map((x) => {
      const text = clip(x?.text, 300);
      const evidence = (Array.isArray(x?.because) ? x.because : [])
        .map((n) => list[Number(n) - 1]?.id)
        .filter(Boolean);
      return text && evidence.length ? { text, importance: clampImportance(x.importance ?? 7), evidence: [...new Set(evidence)] } : null;
    })
    .filter(Boolean)
    .slice(0, max);
}

module.exports = { KINDS, DECAY, REFLECT_AT, stamp, parse, formatLine, serialize, make, tokens, retrieve, pending, reflectionPrompt, parseReflections, clampImportance };
