// The habit tracker's note (Habits.md in the vault), readable and editable in Obsidian:
//   ## Habits
//   - **Meditate** — daily · 10 minutes after coffee <!-- habit target=7 since=2026-10-25 -->
//   - **Run** — 3× a week · for energy <!-- habit target=3 since=2026-10-25 -->
//   ## Log
//   - 2026-10-25: Meditate, Run
// target = times per week (7 = every day). Pure: parse, change, write back, and the stats (streaks,
// this week, the last four weeks). Dates are YYYY-MM-DD in local time; weeks run Monday to Sunday.

const HABIT = /^\s*[-*]\s+\*\*(.+?)\*\*(?:\s*[—–-]\s*(.*?))?\s*(?:<!--\s*habit\s+(.*?)\s*-->)?\s*$/;
const LOG = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2}):\s*(.*)$/;
const MAX_HABITS = 30;

const keyOf = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
const clean = (s, n = 120) => String(s ?? '').replace(/\s*\n\s*/g, ' ').replace(/\*\*|<!--|-->|,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function addDays(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const weekday = (ymd) => (new Date(`${ymd}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
const weekStart = (ymd) => addDays(ymd, -weekday(ymd));

const frequency = (target) => (target >= 7 ? 'daily' : `${target}× a week`);

function parse(text) {
  const out = { habits: [], log: new Map(), before: '', between: '', after: '' };
  const lines = String(text || '').split(/\r?\n/);
  let section = 'before';
  const keep = { before: [], between: [], after: [] };
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h && /^habits$/i.test(h[1])) {
      section = 'habits';
      continue;
    }
    if (h && /^log$/i.test(h[1])) {
      section = 'log';
      continue;
    }
    if (h) section = section === 'before' ? 'before' : 'after';
    if (section === 'habits') {
      const m = HABIT.exec(line);
      if (m) {
        const meta = Object.fromEntries((m[3] || '').split(/\s+/).filter(Boolean).map((kv) => (kv.includes('=') ? kv.split('=') : [kv, true])));
        const desc = (m[2] || '').split('·').slice(1).join('·').trim();
        out.habits.push({ name: m[1].trim(), target: Math.max(1, Math.min(7, Number(meta.target) || 7)), note: desc, since: meta.since || '', paused: Boolean(meta.paused) });
      } else if (line.trim()) keep.between.push(line);
      continue;
    }
    if (section === 'log') {
      const m = LOG.exec(line);
      if (m) {
        const names = m[2].split(',').map((x) => x.trim()).filter(Boolean);
        out.log.set(m[1], [...new Set([...(out.log.get(m[1]) || []), ...names])]);
      } else if (line.trim()) keep.after.push(line);
      continue;
    }
    keep[section].push(line);
  }
  out.before = keep.before.join('\n').trim();
  out.between = keep.between.join('\n').trim();
  out.after = keep.after.join('\n').trim();
  return out;
}

function serialize(h) {
  const habitLine = (x) => `- **${x.name}** — ${frequency(x.target)}${x.note ? ` · ${x.note}` : ''} <!-- habit target=${x.target}${x.since ? ` since=${x.since}` : ''}${x.paused ? ' paused' : ''} -->`;
  const days = [...h.log.keys()].filter((d) => h.log.get(d).length).sort().reverse();
  return `${[
    h.before || '---\ntype: habits\n---\n# Habits\n\nTracked with the assistant: tell it what you did ("I went for a run") or tick it off in the Habits view. Edit freely; keep the `<!-- habit … -->` comments.',
    `## Habits\n${[h.between, ...h.habits.map(habitLine)].filter(Boolean).join('\n')}`,
    `## Log\n${days.map((d) => `- ${d}: ${h.log.get(d).join(', ')}`).join('\n')}`,
    h.after,
  ]
    .filter((x) => x && x.trim())
    .join('\n\n')}\n`;
}

const copy = (h) => ({ ...h, habits: h.habits.map((x) => ({ ...x })), log: new Map([...h.log].map(([d, n]) => [d, [...n]])) });
const findHabit = (h, name) => h.habits.find((x) => keyOf(x.name) === keyOf(name));

function addHabit(h, { name, target = 7, note = '' }, today) {
  const n = clean(name, 60);
  if (!n) throw new Error('Give the habit a short name, e.g. "Meditate".');
  const out = copy(h);
  const old = findHabit(out, n);
  const t = Math.max(1, Math.min(7, Math.round(Number(target) || 7)));
  if (old) Object.assign(old, { target: t, note: clean(note) || old.note, paused: false });
  else {
    if (out.habits.filter((x) => !x.paused).length >= MAX_HABITS) throw new Error(`That's ${MAX_HABITS} habits already; fewer, smaller habits stick better.`);
    out.habits.push({ name: n, target: t, note: clean(note), since: today, paused: false });
  }
  return out;
}

/** Marks habits done (or not) on a day; names must be tracked habits. */
function setDone(h, names, date, done = true) {
  const out = copy(h);
  const list = (Array.isArray(names) ? names : [names]).map((n) => {
    const x = findHabit(out, n);
    if (!x) throw new Error(`"${n}" isn't a tracked habit. Habits: ${out.habits.map((y) => y.name).join(', ') || 'none yet'}`);
    return x.name;
  });
  const day = out.log.get(date) || [];
  const keys = new Set(day.map(keyOf));
  if (done) for (const n of list) !keys.has(keyOf(n)) && day.push(n);
  const next = done ? day : day.filter((n) => !list.some((l) => keyOf(l) === keyOf(n)));
  if (next.length) out.log.set(date, next);
  else out.log.delete(date);
  return { habits: out, changed: list };
}

/** Pauses (keeps history) or removes a habit from the list (its log lines stay). */
function setPaused(h, name, paused) {
  const out = copy(h);
  const x = findHabit(out, name);
  if (!x) throw new Error(`No habit called "${name}".`);
  x.paused = paused;
  return out;
}

const doneOn = (h, x, date) => (h.log.get(date) || []).some((n) => keyOf(n) === keyOf(x.name));

function stats(h, today) {
  return h.habits.map((x) => {
    const doneToday = doneOn(h, x, today);
    let streak = 0;
    let unit = 'days';
    if (x.target >= 7) {
      // Consecutive days, ending today (or yesterday while today is still open).
      let d = doneToday ? today : addDays(today, -1);
      while (doneOn(h, x, d) && streak < 3650) {
        streak++;
        d = addDays(d, -1);
      }
    } else {
      // Consecutive weeks that met the target, ending this week (if met) or last week.
      unit = 'weeks';
      const count = (start) => Array.from({ length: 7 }, (_, i) => addDays(start, i)).filter((d) => d <= today && doneOn(h, x, d)).length;
      let w = weekStart(today);
      if (count(w) < x.target) w = addDays(w, -7);
      while (count(w) >= x.target && streak < 520) {
        streak++;
        w = addDays(w, -7);
      }
    }
    const thisWeek = Array.from({ length: weekday(today) + 1 }, (_, i) => addDays(weekStart(today), i)).filter((d) => doneOn(h, x, d)).length;
    const last28 = Array.from({ length: 28 }, (_, i) => addDays(today, -i)).filter((d) => doneOn(h, x, d) && (!x.since || d >= x.since)).length;
    const weeks = x.since ? Math.min(4, Math.max(1, Math.ceil((Date.parse(today) - Date.parse(x.since)) / (7 * 86400000)) || 1)) : 4;
    return {
      name: x.name,
      frequency: frequency(x.target),
      target: x.target,
      note: x.note,
      paused: x.paused,
      doneToday,
      streak,
      streakUnit: unit,
      thisWeek,
      rate28: Math.min(1, last28 / (x.target * weeks)),
      last7: Array.from({ length: 7 }, (_, i) => doneOn(h, x, addDays(today, i - 6))),
    };
  });
}

module.exports = { parse, serialize, addHabit, setDone, setPaused, stats, addDays, weekStart };
