// Read-only calendar feeds (iCalendar / .ics links): the quickest way to connect a calendar — Google
// Calendar's "secret address in iCal format", Outlook's published calendar link, iCloud's public
// calendar link — with no OAuth client and no sign-in. Events (including common repeat rules) are
// expanded into the requested range.
const log = require('./logger');

const cache = new Map(); // url -> { at, events: [parsed VEVENT] }
const TTL = 10 * 60 * 1000;
const MAX_BYTES = 10 * 1024 * 1024;
const DAY = 86400000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const COLORS = ['#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#eab308'];

function urls(text) {
  return String(text || '')
    .split(/[\s,]+/)
    .map((u) => u.trim().replace(/^webcal:\/\//i, 'https://'))
    .filter((u) => /^https?:\/\/\S+$/i.test(u));
}

// ------------------------------------------------------------------ parsing
function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

const unescape = (v) => String(v || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function prop(line) {
  const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (colon < 0) return null;
  const [name, ...params] = line.slice(0, colon).split(';');
  const p = {};
  for (const x of params) {
    const [k, v] = x.split('=');
    if (k) p[k.toUpperCase()] = String(v || '').replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params: p, value: line.slice(colon + 1) };
}

// A DTSTART/DTEND value as wall-clock parts plus its zone: 'UTC', an IANA zone, or null (floating = local).
function when(p) {
  const m = String(p.value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return null;
  const allDay = p.params.VALUE === 'DATE' || !m[4];
  return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0), tz: m[7] ? 'UTC' : p.params.TZID || null, allDay };
}

// Offset (ms) of an IANA zone at a moment; unknown zones (e.g. Outlook's Windows names) count as local.
function zoneOffset(ms, tz) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const v = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second) - ms;
  } catch {
    return -new Date(ms).getTimezoneOffset() * 60000;
  }
}

function toMs(t) {
  if (t.allDay || !t.tz) return new Date(t.y, t.mo - 1, t.d, t.h, t.mi, t.s).getTime();
  const guess = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s);
  if (t.tz === 'UTC') return guess;
  const first = guess - zoneOffset(guess, t.tz);
  return guess - zoneOffset(first, t.tz);
}

function duration(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = (+(m[2] || 0) * 7 + +(m[3] || 0)) * DAY + (+(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

function parse(text) {
  const events = [];
  let cur = null;
  let calName = '';
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') cur = { exdates: [] };
    else if (line === 'END:VEVENT') {
      if (cur?.start) events.push(cur);
      cur = null;
    } else if (!cur) {
      const p = prop(line);
      if (p?.name === 'X-WR-CALNAME') calName = unescape(p.value);
    } else {
      const p = prop(line);
      if (!p) continue;
      if (p.name === 'UID') cur.uid = p.value;
      else if (p.name === 'SUMMARY') cur.title = unescape(p.value);
      else if (p.name === 'LOCATION') cur.location = unescape(p.value);
      else if (p.name === 'DESCRIPTION') cur.description = unescape(p.value).slice(0, 500);
      else if (p.name === 'STATUS') cur.cancelled = /CANCELLED/i.test(p.value);
      else if (p.name === 'DTSTART') cur.start = when(p);
      else if (p.name === 'DTEND') cur.end = when(p);
      else if (p.name === 'DURATION') cur.duration = duration(p.value);
      else if (p.name === 'RRULE') cur.rrule = Object.fromEntries(p.value.split(';').map((kv) => kv.split('=')));
      else if (p.name === 'EXDATE') for (const v of p.value.split(',')) cur.exdates.push(when({ value: v, params: p.params }));
      else if (p.name === 'RECURRENCE-ID') cur.recurrenceId = when(p);
      else if (p.name === 'URL') cur.link = p.value;
    }
  }
  return { name: calName, events };
}

// ---------------------------------------------------------------- expanding
const ymdKey = (t) => `${t.y}-${t.mo}-${t.d}`;
function addDaysParts(t, n) {
  const d = new Date(Date.UTC(t.y, t.mo - 1, t.d + n));
  return { ...t, y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
const weekday = (t) => new Date(Date.UTC(t.y, t.mo - 1, t.d)).getUTCDay();
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

// The dates (as wall-clock parts) of the nth weekday ("2MO", "-1FR", "MO") in a month.
function monthWeekdays(y, mo, spec, base) {
  const m = spec.match(/^([+-]?\d+)?([A-Z]{2})$/);
  if (!m) return [];
  const wd = WEEKDAYS.indexOf(m[2]);
  const all = [];
  for (let d = 1; d <= daysInMonth(y, mo); d++) if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === wd) all.push({ ...base, y, mo, d });
  if (!m[1]) return all;
  const n = Number(m[1]);
  const pick = n > 0 ? all[n - 1] : all[all.length + n];
  return pick ? [pick] : [];
}

// Occurrence starts (wall-clock parts) of a repeating event, from about `fromMs` up to `toMs_`.
function occurrences(ev, fromMs, toMs_) {
  const r = ev.rrule;
  const start = ev.start;
  if (!r) return [start];
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = Number(r.COUNT) || Infinity;
  const until = r.UNTIL ? toMs(when({ value: r.UNTIL, params: {} })) : Infinity;
  const byDay = r.BYDAY ? r.BYDAY.split(',') : null;
  const byMonthDay = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null;
  const out = [];
  const startMs = toMs(start);
  const push = (t) => {
    const ms = toMs(t);
    if (ms < startMs || ms > until) return ms > until;
    out.push(t);
    return out.length >= count || ms > toMs_;
  };
  // Old open-ended series: jump close to the requested range instead of walking from the first date.
  // (With COUNT every occurrence since the start counts, so no jump.)
  const periodDays = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 }[r.FREQ] * interval;
  const first = count === Infinity && periodDays ? Math.max(0, Math.floor((fromMs - startMs) / (periodDays * DAY)) - 2) : 0;
  for (let i = first, guard = 0; guard < 5000; i++, guard++) {
    let batch = [];
    if (r.FREQ === 'DAILY') batch = [addDaysParts(start, i * interval)];
    else if (r.FREQ === 'WEEKLY') {
      const weekStart = addDaysParts(start, i * interval * 7 - weekday(start));
      batch = byDay ? byDay.map((d) => addDaysParts(weekStart, WEEKDAYS.indexOf(d.slice(-2)))).sort((a, b) => toMs(a) - toMs(b)) : [addDaysParts(start, i * interval * 7)];
    } else if (r.FREQ === 'MONTHLY') {
      const total = start.mo - 1 + i * interval;
      const y = start.y + Math.floor(total / 12);
      const mo = (total % 12) + 1;
      if (byDay) batch = byDay.flatMap((d) => monthWeekdays(y, mo, d, start));
      else batch = (byMonthDay || [start.d]).map((d) => (d < 0 ? daysInMonth(y, mo) + d + 1 : d)).filter((d) => d >= 1 && d <= daysInMonth(y, mo)).map((d) => ({ ...start, y, mo, d }));
      batch.sort((a, b) => toMs(a) - toMs(b));
    } else if (r.FREQ === 'YEARLY') {
      const y = start.y + i * interval;
      if (start.d <= daysInMonth(y, start.mo)) batch = [{ ...start, y }];
    } else return [start];
    let done = false;
    for (const t of batch) if ((done = push(t))) break;
    if (done) break;
  }
  return out;
}

function expand(ev, from, to) {
  if (ev.cancelled) return [];
  const startMs = toMs(ev.start);
  const length = ev.end ? toMs(ev.end) - startMs : ev.duration ?? (ev.start.allDay ? DAY : 3600000);
  const skip = new Set(ev.exdates.filter(Boolean).map(ymdKey));
  return occurrences(ev, from - length, to)
    .filter((t) => !skip.has(ymdKey(t)))
    .map((t) => ({ t, s: toMs(t) }))
    .filter(({ s }) => s < to && s + length > from)
    .map(({ t, s }) => ({ start: t.allDay ? isoDate(t) : new Date(s).toISOString(), end: t.allDay ? isoDate(addDaysParts(t, Math.max(1, Math.round(length / DAY)))) : new Date(s + length).toISOString(), key: ymdKey(t) }));
}

const isoDate = (t) => `${t.y}-${String(t.mo).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;

// ------------------------------------------------------------------ fetching
async function load(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { Accept: 'text/calendar, */*' } });
  if (!res.ok) throw new Error(`Calendar feed answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('Calendar feed is too large');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link is not an iCal (.ics) calendar');
  const parsed = { at: Date.now(), ...parse(text) };
  cache.set(url, parsed);
  return parsed;
}

function feedLabel(url, name) {
  if (name) return name;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Calendar feed';
  }
}

/** Events from every feed in [from, to), normalized like Google events (read-only). */
async function events(text, from, to) {
  const list = urls(text);
  const out = await Promise.all(
    list.map(async (url, i) => {
      try {
        const feed = await load(url);
        const calendar = feedLabel(url, feed.name);
        // Changed single occurrences (RECURRENCE-ID) replace the generated ones.
        const overrides = new Set(feed.events.filter((e) => e.recurrenceId).map((e) => `${e.uid}|${ymdKey(e.recurrenceId)}`));
        return feed.events.flatMap((ev) =>
          expand(ev, from.getTime(), to.getTime())
            .filter((o) => ev.recurrenceId || !overrides.has(`${ev.uid}|${o.key}`))
            .map((o) => ({ id: `ics:${ev.uid || ''}:${o.key}`, calendarId: `feed${i + 1}`, title: ev.title || '(no title)', start: o.start, end: o.end, allDay: ev.start.allDay, location: ev.location || '', description: ev.description || '', link: ev.link || '', meet: '', calendar, color: COLORS[i % COLORS.length], readOnly: true })),
        );
      } catch (err) {
        log.warn('calendar feed failed', { feed: i + 1, error: err.message });
        return [];
      }
    }),
  );
  return out.flat();
}

/** Checks a link before it is saved: { ok, name, events } or throws. */
async function test(url) {
  const [u] = urls(url);
  if (!u) throw new Error('Paste an https:// or webcal:// link to an .ics calendar.');
  cache.delete(u);
  const feed = await load(u);
  return { ok: true, name: feedLabel(u, feed.name), events: feed.events.length };
}

function clearCache() {
  cache.clear();
}

module.exports = { urls, events, test, clearCache, parse };
