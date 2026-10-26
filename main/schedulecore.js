// The schedule's pure part (no files, no Electron): the line format of Schedule.md in the vault,
// repeat rules, and expanding entries into dated occurrences. main/calendar.js does the reading and
// writing. Schedule.md keeps one entry per list item under "## Recurring" and "## Events":
//   - every Monday 10:00-11:30 | Linear Algebra lecture | @ Room H1 | from 2026-10-05 | until 2027-02-12 | id r7k2
//   - every 2 weeks on Tuesday, Thursday 08:15 | Lab | except 2026-12-24
//   - every weekday 07:30 | Gym          - every month on the 15th | Rent      - every year on Mar 14 | Birthday
//   - 2026-10-28 14:00-15:00 | Dentist | @ Main St 4 | note Bring the insurance card | id e9f3
//   - 2026-12-21 to 2027-01-06 | Winter break
// Everything else in the note (text, other headings, blockquotes) belongs to the user and is kept.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_MS = 86400000;
const MAX_RANGE_DAYS = 800;
const TIME = String.raw`\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?|\d{1,2}\s*[ap]\.?m\.?`;
const TIME_TAIL = new RegExp(String.raw`(?:^|\s+)(?:at\s+|from\s+)?(${TIME})(?:\s*(?:-|–|—|to|until)\s*(${TIME}))?$`, 'i');
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const clean = (s, max = 200) => String(s ?? '').replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function parseDate(s) {
  if (!DATE.test(String(s || ''))) return null;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

function checkDate(s, what) {
  if (!parseDate(s)) throw new Error(`${what} must be a date like 2026-10-28 (got "${s}").`);
  return s;
}

/** "9:05", "14:00", "2pm", "2:30 p.m." -> "HH:MM", or null. */
function parseTime(s) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?$/i.exec(String(s || '').trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}


function dayIndex(word) {
  let w = String(word || '').trim().toLowerCase().replace(/\.$/, '');
  if (w.length > 4 && w.endsWith('s') && DAYS.some((d) => d.toLowerCase() === w.slice(0, -1))) w = w.slice(0, -1); // "Mondays"
  if (w.length < 2) return -1;
  const hits = DAYS.map((d, i) => (d.toLowerCase().startsWith(w) ? i : -1)).filter((i) => i >= 0);
  return hits.length === 1 ? hits[0] : -1;
}

function parseDays(text) {
  const parts = String(text).split(/\s*(?:,|&|\/|\band\b|\+)\s*/i).filter(Boolean);
  const days = parts.map(dayIndex);
  if (!parts.length || days.includes(-1)) return null;
  return [...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday first
}

function monthIndex(word) {
  const w = String(word || '').toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return -1;
  return MONTHS.findIndex((m) => m.toLowerCase().startsWith(w));
}

// "Mar 14", "14 March", "March 14th", "03-14" -> { month: 1-12, day }
function parseMonthDay(text) {
  const t = String(text).trim().replace(/(\d)(st|nd|rd|th)\b/i, '$1');
  let m = /^(\d{1,2})-(\d{1,2})$/.exec(t);
  let month;
  let day;
  if (m) [month, day] = [Number(m[1]), Number(m[2])];
  else if ((m = /^([a-z]+)\.?\s+(\d{1,2})$/i.exec(t))) [month, day] = [monthIndex(m[1]) + 1, Number(m[2])];
  else if ((m = /^(\d{1,2})\.?\s+([a-z]+)$/i.exec(t))) [month, day] = [monthIndex(m[2]) + 1, Number(m[1])];
  if (!month || month < 1 || month > 12 || !day || day < 1 || day > 31) return null;
  return { month, day };
}

const WHEN_HELP =
  'Use a date ("2026-10-28", "2026-10-28 14:00-15:00", "2026-12-21 to 2027-01-06") or a rule ("every Monday 10:00-11:30", "every Tuesday, Thursday 08:15", "every weekday 07:30", "every 2 weeks on Friday 16:00", "every day 22:00", "every month on the 15th", "every year on Mar 14"). Times are 24-hour HH:MM in local time.';

/**
 * Parses the "when" of an entry. Returns { date, endDate, start, end, repeat } (repeat null for a
 * one-off) or throws with a message saying what is accepted.
 */
function parseWhen(text) {
  let s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s) throw new Error(`Say when. ${WHEN_HELP}`);
  let start = '';
  let end = '';
  const t = TIME_TAIL.exec(s);
  if (t) {
    start = parseTime(t[1]);
    end = t[2] ? parseTime(t[2]) : '';
    if (!start || end === null) throw new Error(`"${t[0].trim()}" is not a time. ${WHEN_HELP}`);
    s = s.slice(0, t.index).trim();
  }
  const out = { date: '', endDate: '', start, end, repeat: null };
  let m = /^(\d{4}-\d{2}-\d{2})(?:\s*(?:to|until|-|–|—|\.\.)\s*(\d{4}-\d{2}-\d{2}))?$/i.exec(s);
  if (m) {
    out.date = checkDate(m[1], 'The date');
    if (m[2]) {
      if (start) throw new Error('An entry that spans several days is all day; leave out the times (or add one entry per day).');
      out.endDate = checkDate(m[2], 'The end date');
      if (out.endDate < out.date) throw new Error('The end date is before the start date.');
      if (out.endDate === out.date) out.endDate = '';
    }
    return out;
  }
  const low = s.toLowerCase();
  if ((m = /^(?:every\s+day|daily|every\s+(\d+)\s+days)$/.exec(low))) out.repeat = { freq: 'daily', interval: Number(m[1] || 1) };
  else if (/^every\s+weekdays?$|^weekdays$/.test(low)) out.repeat = { freq: 'weekly', interval: 1, days: [1, 2, 3, 4, 5] };
  else if (/^every\s+weekends?$|^weekends$/.test(low)) out.repeat = { freq: 'weekly', interval: 1, days: [6, 0] };
  else if ((m = /^every\s+(?:(\d+)\s+weeks?|other\s+week|week)\s+on\s+(.+)$/.exec(low))) {
    const days = parseDays(m[2]);
    if (!days) throw new Error(`"${m[2]}" are not weekdays. ${WHEN_HELP}`);
    out.repeat = { freq: 'weekly', interval: low.includes('other') ? 2 : Number(m[1] || 1), days };
  } else if ((m = /^every\s+(?:(\d+)\s+months?|other\s+month|month)\s+on\s+(?:the\s+|day\s+)?(\d{1,2})(?:st|nd|rd|th)?$/.exec(low))) {
    const day = Number(m[2]);
    if (day < 1 || day > 31) throw new Error('A day of the month is 1 to 31.');
    out.repeat = { freq: 'monthly', interval: low.includes('other') ? 2 : Number(m[1] || 1), monthDay: day };
  } else if ((m = /^every\s+year\s+on\s+(.+)$/.exec(low))) {
    const md = parseMonthDay(m[1]);
    if (!md) throw new Error(`"${m[1]}" is not a day of the year (try "Mar 14"). ${WHEN_HELP}`);
    out.repeat = { freq: 'yearly', interval: 1, month: md.month, monthDay: md.day };
  } else if ((m = /^every\s+other\s+(.+)$/.exec(low)) && parseDays(m[1])) out.repeat = { freq: 'weekly', interval: 2, days: parseDays(m[1]) };
  else if ((m = /^(?:every|each|on)\s+(.+)$/.exec(low)) && parseDays(m[1])) out.repeat = { freq: 'weekly', interval: 1, days: parseDays(m[1]) };
  else throw new Error(`I can't read "${text}". ${WHEN_HELP}`);
  if (!(out.repeat.interval >= 1 && out.repeat.interval <= 52)) throw new Error('Repeat every 1 to 52 days, weeks or months.');
  return out;
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

/** The canonical "when" text of an entry (what parseWhen reads back to the same entry). */
function formatWhen(e) {
  const time = e.start ? ` ${e.start}${e.end ? `-${e.end}` : ''}` : '';
  const r = e.repeat;
  if (!r) return `${e.date}${e.endDate ? ` to ${e.endDate}` : ''}${time}`;
  const n = r.interval || 1;
  let rule;
  if (r.freq === 'daily') rule = n === 1 ? 'every day' : `every ${n} days`;
  else if (r.freq === 'weekly') {
    const names = r.days.map((d) => DAYS[d]).join(', ');
    if (n === 1 && r.days.join() === '1,2,3,4,5') rule = 'every weekday';
    else rule = n === 1 ? `every ${names}` : `every ${n} weeks on ${names}`;
  } else if (r.freq === 'monthly') rule = `every ${n === 1 ? 'month' : `${n} months`} on the ${ordinal(r.monthDay)}`;
  else rule = `every year on ${MONTHS[r.month - 1].slice(0, 3)} ${r.monthDay}`;
  return `${rule}${time}`;
}

/** Plain-words description, for the UI and the agent ("Every Monday, 10:00–11:30"). */
function describe(e) {
  const time = e.start ? `${e.start}${e.end ? `–${e.end}` : ''}` : 'all day';
  if (!e.repeat) {
    const d = parseDate(e.date);
    const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    return e.endDate ? `${day} – ${parseDate(e.endDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}` : `${day}, ${time}`;
  }
  const rule = formatWhen({ ...e, start: '' }).replace(/^every/, 'Every');
  const range = [e.from && `from ${e.from}`, e.until && `until ${e.until}`].filter(Boolean).join(' ');
  return `${rule}, ${time}${range ? ` (${range})` : ''}${e.except?.length ? `, skipping ${e.except.join(', ')}` : ''}`;
}

/**
 * Checks and completes an entry from a tool call, the UI or a parsed line:
 * { title, when, location?, notes?, from?, until?, except? } plus an existing { id }.
 */
function normalize(input) {
  const when = parseWhen(input.when);
  const title = clean(input.title, 120);
  if (!title) throw new Error('An entry needs a title.');
  const e = { id: clean(input.id, 24), title, ...when, location: clean(input.location, 160), notes: clean(input.notes, 500), from: '', until: '', except: [] };
  if (e.repeat) {
    if (input.from) e.from = checkDate(String(input.from).trim(), '"from"');
    if (input.until) e.until = checkDate(String(input.until).trim(), '"until"');
    if (e.from && e.until && e.until < e.from) throw new Error('"until" is before "from".');
    const except = Array.isArray(input.except) ? input.except : String(input.except || '').split(/[,\s]+/);
    e.except = [...new Set(except.map((d) => String(d).trim()).filter(Boolean).map((d) => checkDate(d, 'A skipped date')))].sort();
  }
  return e;
}

/** One list item of Schedule.md for an entry. */
function formatLine(e) {
  const parts = [formatWhen(e), e.title];
  if (e.location) parts.push(`@ ${e.location}`);
  if (e.from) parts.push(`from ${e.from}`);
  if (e.until) parts.push(`until ${e.until}`);
  if (e.except?.length) parts.push(`except ${e.except.join(', ')}`);
  if (e.notes) parts.push(`note ${e.notes}`);
  if (e.id) parts.push(`id ${e.id}`);
  return `- ${parts.map((p) => clean(p, 600)).join(' | ')}`;
}

// The fields of one list item (without the "- "): when | title | @ place | from … | until … | except … | note … | id …
function parseItem(body) {
  const [when, ...rest] = body.split('|').map((p) => p.trim());
  const input = { when, title: '', location: '', notes: '', from: '', until: '', except: '', id: '' };
  const notes = [];
  for (const p of rest) {
    let m;
    if ((m = /^@\s*(.*)$/.exec(p))) input.location = m[1];
    else if ((m = /^(from|until|except|id)\s+(.+)$/i.exec(p))) input[m[1].toLowerCase()] = m[2];
    else if ((m = /^notes?\s*:?\s+(.+)$/i.exec(p))) notes.push(m[1]);
    else if (!input.title) input.title = p;
    else if (p) notes.push(p);
  }
  input.notes = notes.join(' · ');
  return input;
}

// Short id from text, for entries written by hand without one (stable while the line is unchanged).
function hashId(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `h${(h >>> 0).toString(36).slice(0, 5)}`;
}

function sectionKind(heading) {
  if (/recurr|repeat|regular|weekly|routine|rules?\b/i.test(heading)) return 'recurring';
  if (/event|one-?off|one-?time|appointment|dates?\b|single/i.test(heading)) return 'events';
  return null;
}

/**
 * Reads Schedule.md: { entries: [{ ...entry, line, kind }], problems: [{ line, text, error }], sections }.
 * Only list items under a Recurring / Events heading are entries; code blocks are skipped.
 */
function parse(text) {
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];
  const problems = [];
  const sections = []; // { kind, line }
  let kind = null;
  let fence = false;
  const seen = new Set();
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      kind = sectionKind(h[1]);
      if (kind) sections.push({ kind, line: i });
      return;
    }
    const item = /^\s*[-*+]\s+(?:\[[ x]\]\s+)?(.+)$/.exec(line);
    if (!kind || !item) return;
    try {
      const input = parseItem(item[1]);
      const e = normalize(input);
      e.id ||= hashId(item[1]);
      if (seen.has(e.id)) e.id = hashId(`${item[1]}#${i}`);
      seen.add(e.id);
      entries.push({ ...e, line: i, kind: e.repeat ? 'recurring' : 'events' });
    } catch (err) {
      problems.push({ line: i + 1, text: item[1].slice(0, 200), error: err.message });
    }
  });
  return { entries, problems, sections };
}

function template(name = 'Siren') {
  return [
    '---',
    'type: schedule',
    'status: active',
    '---',
    '# Schedule',
    '',
    `${name} keeps this from what you tell it, and you can edit it here too: one entry per line, fields separated by \`|\`.`,
    '',
    '> **Recurring:** `- every Monday 10:00-11:30 | Lecture | @ Room H1 | from 2026-10-05 | until 2027-02-12`',
    '> Also: `every day`, `every weekday`, `every Tuesday, Thursday`, `every 2 weeks on Friday`, `every month on the 15th`, `every year on Mar 14`. `except 2026-12-28` skips a date.',
    '> **Events:** `- 2026-10-28 14:00-15:00 | Dentist | @ Main St 4 | note Bring the card`. A date alone is all day; `2026-12-21 to 2027-01-06` spans days.',
    '',
    '## Recurring',
    '',
    '## Events',
    '',
  ].join('\n');
}

// Where a new item goes: after the last item of its section (events in date order). null when the
// note has no such section yet.
function insertAt(lines, parsed, e) {
  const section = parsed.sections.find((s) => s.kind === (e.repeat ? 'recurring' : 'events'));
  if (!section) return null;
  let endLine = lines.findIndex((l, i) => i > section.line && /^#{1,6}\s/.test(l));
  if (endLine < 0) endLine = lines.length;
  const mine = parsed.entries.filter((x) => x.line > section.line && x.line < endLine);
  if (!e.repeat) {
    const later = mine.find((x) => `${x.date} ${x.start}` > `${e.date} ${e.start}`);
    if (later) return later.line;
  }
  if (mine.length) return mine[mine.length - 1].line + 1;
  // An empty section: right after the heading and its blank line.
  return lines[section.line + 1] === '' ? section.line + 2 : section.line + 1;
}

/** Returns the note text with the entry added (the entry must already have an id). */
function addEntry(text, e) {
  let src = String(text || '');
  if (!src.trim()) src = template();
  let lines = src.split(/\r?\n/);
  let parsed = parse(src);
  let at = insertAt(lines, parsed, e);
  if (at == null) {
    lines = [...lines.join('\n').replace(/\s*$/, '').split('\n'), '', e.repeat ? '## Recurring' : '## Events', ''];
    parsed = parse(lines.join('\n'));
    at = insertAt(lines, parsed, e);
  }
  // Keep a blank line before a following heading.
  const add = /^#{1,6}\s/.test(lines[at] || '') ? [formatLine(e), ''] : [formatLine(e)];
  lines.splice(at, 0, ...add);
  const out = lines.join('\n');
  return out.endsWith('\n') ? out : `${out}\n`;
}

function findLine(text, id) {
  const parsed = parse(text);
  const e = parsed.entries.find((x) => x.id === id);
  if (!e) throw new Error(`No schedule entry with id "${id}". List them with calendar_list_entries.`);
  return { e, lines: String(text).split(/\r?\n/) };
}

/** Replaces an entry's line (a change from a rule to a date or back moves it to the other section). */
function replaceEntry(text, id, next) {
  const { e, lines } = findLine(text, id);
  if (Boolean(e.repeat) !== Boolean(next.repeat) || (!next.repeat && next.date !== e.date)) {
    lines.splice(e.line, 1);
    return addEntry(lines.join('\n'), next);
  }
  lines[e.line] = lines[e.line].match(/^\s*/)[0] + formatLine(next);
  return lines.join('\n');
}

function removeEntry(text, id) {
  const { e, lines } = findLine(text, id);
  lines.splice(e.line, 1);
  return { text: lines.join('\n'), removed: e };
}

// ------------------------------------------------------------ occurrences
// Local times as "YYYY-MM-DDTHH:MM:00" (no offset: read as local time by new Date()).
const stamp = (d) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const at = (day, hm) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(hm.slice(0, 2)), Number(hm.slice(3)));

function monthsBetween(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

function weekStart(d) {
  return addDays(startOfDay(d), -((d.getDay() + 6) % 7));
}

// Does a repeating entry happen on this day?
function happensOn(e, day) {
  const key = ymd(day);
  if ((e.from && key < e.from) || (e.until && key > e.until) || e.except?.includes(key)) return false;
  const r = e.repeat;
  const anchor = parseDate(e.from) || new Date(1970, 0, 5); // a Monday
  const n = r.interval || 1;
  if (r.freq === 'daily') return Math.round((startOfDay(day) - startOfDay(anchor)) / DAY_MS) % n === 0;
  if (r.freq === 'weekly') return r.days.includes(day.getDay()) && Math.round((weekStart(day) - weekStart(anchor)) / (7 * DAY_MS)) % n === 0;
  if (r.freq === 'monthly') return day.getDate() === r.monthDay && monthsBetween(anchor, day) % n === 0;
  return day.getMonth() === r.month - 1 && day.getDate() === r.monthDay;
}

function occurrence(e, day) {
  const base = { id: `${e.id}@${ymd(day)}`, entryId: e.id, title: e.title, location: e.location, notes: e.notes, recurring: Boolean(e.repeat), rule: e.repeat ? describe(e) : '' };
  if (!e.start) return { ...base, allDay: true, start: stamp(day), end: stamp(addDays(e.endDate ? parseDate(e.endDate) : day, 1)) };
  const start = at(day, e.start);
  // No end: shown as an hour. An end at or before the start runs past midnight.
  let end = e.end ? at(day, e.end) : new Date(start.getTime() + 3600000);
  if (end <= start) end = at(addDays(day, 1), e.end);
  return { ...base, allDay: false, start: stamp(start), end: stamp(end), openEnd: !e.end };
}

/** Every occurrence overlapping [from, to) (Dates), sorted by start. */
function occurrences(entries, from, to) {
  const lo = stamp(from);
  const hi = stamp(to);
  const first = startOfDay(from);
  let lastDay = startOfDay(new Date(to.getTime() - 1));
  if (lastDay - first > MAX_RANGE_DAYS * DAY_MS) lastDay = addDays(first, MAX_RANGE_DAYS);
  const out = [];
  for (const e of entries) {
    if (!e.repeat) {
      const o = occurrence(e, parseDate(e.date));
      if (o.start < hi && o.end > lo) out.push(o);
      continue;
    }
    // From the day before, for something that runs past midnight into the range.
    for (let d = addDays(first, -1); d <= lastDay; d = addDays(d, 1)) {
      if (!happensOn(e, d)) continue;
      const o = occurrence(e, d);
      if (o.start < hi && o.end > lo) out.push(o);
    }
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title)));
}

module.exports = { parse, parseWhen, formatWhen, formatLine, describe, normalize, addEntry, replaceEntry, removeEntry, occurrences, template, WHEN_HELP, DAYS, ymd };
