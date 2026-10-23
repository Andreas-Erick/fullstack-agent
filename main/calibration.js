// Voice calibration: the user reads a short script that contains the names and words they will use
// with the agent; comparing it with what speech-to-text heard shows how accurate recognition is
// for their voice, which special words get misheard (learned as corrections), and how loud they
// speak relative to the room (the hands-free sensitivity). Whisper itself is not retrained.

const COMMON = new Set(
  `a an and are as at be but by can do for from go had has have he her him his how i if in is it its me my no not of on or our she so that the their them then there they this to too up us was we what when where who why will with you your yes yeah ok okay next new now all any just get got like make more one out see some take than these those two way well were which would also into over very much many know want need right good back time day here let lets put say said`.split(/\s+/),
);

const TEMPLATES = [
  (w) => `Please remind me to talk to ${w} tomorrow morning.`,
  (w) => `What do I have planned with ${w} next week?`,
  (w) => `Open my notes about ${w} and read me the summary.`,
  (w) => `Add a meeting about ${w} on Friday afternoon.`,
  (w) => `Can you find the latest news on ${w} for me?`,
  (w) => `Send ${w} a short message later today.`,
];

/** Builds the script. Every special word sits between ordinary words, so it can be located afterwards. */
function buildScript({ userName = '', agentName = 'Nexus', words = [] } = {}) {
  const extra = [...new Set(words.map((w) => String(w).trim()).filter(Boolean))]
    .filter((w) => w.toLowerCase() !== agentName.toLowerCase() && w.toLowerCase() !== userName.toLowerCase())
    .slice(0, 6);
  const lines = [
    userName ? `Hey ${agentName}, this is ${userName} speaking.` : `Hey ${agentName}, good morning.`,
    'The quick brown fox jumps over the lazy dog.',
    ...extra.map((w, i) => TEMPLATES[i % TEMPLATES.length](w)),
  ];
  if (extra.length < 2) lines.push('What is on my calendar for the rest of the week?', 'Open my notes and read me the summary.');
  lines.push('Yes, go ahead. Switch to the deep model. Go hands free.', `Thank you ${agentName}, that is all for now.`);
  return { script: lines.join(' '), vocabulary: [agentName, userName, ...extra].filter(Boolean) };
}

const norm = (t) =>
  String(t || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const tokens = (t) => (norm(t) ? norm(t).split(' ') : []);

// Word-level alignment → [{ s: scriptIndex|null, h: heardIndex|null, op }]. A substitution costs a
// bit more than an insertion or deletion, so among equally good alignments the one that keeps exact
// matches wins ("about quantum chess and" lines up with "about QuantumChess and").
const SUB = 1.5;

function align(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  const diag = (i, j) => d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : SUB);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, diag(i, j));
  }
  const out = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === diag(i, j)) {
      out.push({ s: i - 1, h: j - 1, op: a[i - 1] === b[j - 1] ? 'eq' : 'sub' });
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      out.push({ s: --i, h: null, op: 'del' });
    } else {
      out.push({ s: null, h: --j, op: 'ins' });
    }
  }
  out.reverse();
  return { ops: out, distance: out.filter((o) => o.op !== 'eq').length }; // word errors, as in WER
}

/** Compares script and transcript: accuracy, how each special word came out, corrections to learn. */
function analyze({ script, transcript, vocabulary = [] }) {
  const said = tokens(script);
  const heard = tokens(transcript);
  const { ops, distance } = align(said, heard);
  const heardAt = new Map(ops.filter((o) => o.op === 'eq').map((o) => [o.s, o.h]));
  const results = [];
  const corrections = [];
  const seen = new Set();
  for (const word of vocabulary) {
    const w = tokens(word);
    if (!w.length || seen.has(w.join(' '))) continue;
    seen.add(w.join(' '));
    for (let i = 0; i + w.length <= said.length; i++) {
      if (said.slice(i, i + w.length).join(' ') !== w.join(' ')) continue;
      // The words around it must have come through intact to know what it was heard as.
      const before = i === 0 ? -1 : heardAt.get(i - 1);
      const after = i + w.length === said.length ? heard.length : heardAt.get(i + w.length);
      if (before === undefined || after === undefined) {
        results.push({ word, heardAs: null });
        continue;
      }
      const span = heard.slice(before + 1, after).join(' ');
      results.push({ word, heardAs: span || '(missed)' });
      if (span && span !== w.join(' ') && span.split(' ').length <= 4 && !span.split(' ').every((x) => COMMON.has(x))) {
        corrections.push({ heard: span, meant: word });
      }
    }
  }
  // One entry per word: a word read twice reports how it came out where that could be seen.
  const byWord = new Map();
  for (const r of results) if (!byWord.has(r.word) || byWord.get(r.word).heardAs === null) byWord.set(r.word, r);
  return {
    accuracy: said.length ? Math.max(0, 1 - distance / said.length) : 0,
    words: [...byWord.values()],
    corrections: dedupe(corrections),
  };
}

function dedupe(list) {
  const byHeard = new Map();
  for (const c of list) byHeard.set(c.heard, c);
  return [...byHeard.values()];
}

/** Hands-free (energy detector) sensitivity that puts the threshold between room noise and speech. */
function sensitivityFor({ speechLevel, noiseFloor }) {
  if (!(speechLevel > 0) || !(noiseFloor > 0)) return null;
  const ratio = speechLevel / noiseFloor;
  const multiplier = Math.sqrt(ratio); // geometric middle between noise and speech
  return { ratio, sensitivity: Math.round(Math.min(0.9, Math.max(0.15, (3.2 - multiplier) / 1.8)) * 20) / 20 };
}

module.exports = { buildScript, analyze, sensitivityFor, merge: (old = [], add = []) => dedupe([...old, ...add]).slice(-50) };
