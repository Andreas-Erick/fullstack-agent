// The understanding tracker's notes (Learning/<Topic>.md in the vault): what the user has grasped, what
// is still shaky, misconceptions they had, open questions and a short log. Pure (no I/O): parse a note,
// merge an update, write it back. learning.js does the reading and writing.

const SECTIONS = [
  ['understood', 'Understood'],
  ['shaky', 'Shaky'],
  ['misconceptions', 'Misconceptions'],
  ['questions', 'Open questions'],
  ['log', 'Log'],
];
const MAX_ITEMS = 80; // per section; the oldest log lines go first
const MAX_ITEM_CHARS = 400;

// "Uniform continuity — δ can't depend on x (2026-10-25)" → "uniform continuity"
const keyOf = (item) =>
  String(item)
    .replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '')
    .split(/\s+[—–-]\s+|:\s/)[0]
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const clean = (s) => String(s || '').replace(/\s*\n\s*/g, ' ').trim().slice(0, MAX_ITEM_CHARS);

/** A topic note → { topic, sections: { understood: [], shaky: [], … }, extra }. Unknown sections are kept. */
function parse(text, topic = '') {
  const out = { topic, sections: Object.fromEntries(SECTIONS.map(([k]) => [k, []])), extra: '' };
  const body = String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const title = /^#\s+(.+)$/m.exec(body);
  if (title && !topic) out.topic = title[1].trim();
  let current = null;
  const extra = [];
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      const found = SECTIONS.find(([, label]) => label.toLowerCase() === h[1].toLowerCase());
      current = found ? found[0] : null;
      if (!found) extra.push(line);
      continue;
    }
    if (current) {
      const item = /^\s*[-*]\s+(.+)$/.exec(line);
      if (item) out.sections[current].push(item[1].trim());
    } else if (!/^#\s/.test(line) && (extra.length || line.trim())) extra.push(line);
  }
  out.extra = extra.join('\n').trim();
  return out;
}

/**
 * Applies an update: new items per section (deduplicated by what comes before " — "), `resolved`
 * concepts move from shaky/open questions to understood, and the log gets a dated line.
 */
function merge(note, update = {}, today) {
  const s = JSON.parse(JSON.stringify(note.sections));
  const stamp = (item) => (/\(\d{4}-\d{2}-\d{2}\)$/.test(item) ? item : `${item} (${today})`);
  const drop = (section, key) => (s[section] = s[section].filter((x) => keyOf(x) !== key));
  const add = (section, raw) => {
    const item = clean(raw);
    if (!item) return;
    const key = keyOf(item);
    drop(section, key);
    s[section].push(stamp(item));
  };
  for (const raw of update.resolved || []) {
    const key = keyOf(clean(raw));
    const was = [...s.shaky, ...s.questions].find((x) => keyOf(x) === key);
    drop('shaky', key);
    drop('questions', key);
    if (!s.understood.some((x) => keyOf(x) === key)) add('understood', was ? was.replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '') : raw);
  }
  for (const raw of update.understood || []) {
    // Grasped now: no longer shaky or an open question.
    drop('shaky', keyOf(clean(raw)));
    drop('questions', keyOf(clean(raw)));
    add('understood', raw);
  }
  for (const raw of update.shaky || []) {
    drop('understood', keyOf(clean(raw)));
    add('shaky', raw);
  }
  for (const raw of update.misconceptions || []) add('misconceptions', raw);
  for (const raw of update.questions || []) add('questions', raw);
  if (clean(update.log)) s.log.push(`${today}: ${clean(update.log)}`);
  for (const [k] of SECTIONS) if (s[k].length > MAX_ITEMS) s[k] = s[k].slice(-MAX_ITEMS);
  return { ...note, sections: s };
}

function serialize(note, today) {
  const parts = [`---\ntype: learning\ntopic: ${note.topic}\nupdated: ${today}\n---`, `# ${note.topic}`];
  if (note.extra) parts.push(note.extra);
  for (const [k, label] of SECTIONS) parts.push(`## ${label}\n${note.sections[k].map((x) => `- ${x}`).join('\n')}`.trimEnd());
  return `${parts.join('\n\n')}\n`;
}

/** One line per topic for the prompt and the overview. */
function summary(note, { max = 3 } = {}) {
  const s = note.sections;
  const short = (list) => list.slice(-max).map((x) => keyOf(x)).join('; ');
  return {
    topic: note.topic,
    understood: s.understood.length,
    shakyCount: s.shaky.length,
    questionCount: s.questions.length,
    shaky: s.shaky.slice(-max).map((x) => x.replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '')),
    questions: s.questions.slice(-max).map((x) => x.replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '')),
    line: `${note.topic}: ${s.understood.length} understood${s.shaky.length ? `; shaky: ${short(s.shaky)}` : ''}${s.questions.length ? `; open: ${short(s.questions)}` : ''}`,
  };
}

/** A safe file name for a topic ("Real Analysis" → "Real Analysis.md"). */
function fileName(topic) {
  const name = String(topic || '').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) throw new Error('Give the topic a name, e.g. "Real Analysis".');
  return `${name}.md`;
}

module.exports = { SECTIONS, keyOf, parse, merge, serialize, summary, fileName };
