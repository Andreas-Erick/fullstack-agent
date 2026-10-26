// The user's schedule, kept in the vault as Schedule.md (format and rules: schedulecore.js). The user
// tells the agent about events and repeating ones ("I have Linear Algebra every Monday at 10 in
// H1"); the agent writes them here, and the user can edit the note in Obsidian too. No accounts, no
// sign-in, nothing leaves the computer.
const crypto = require('crypto');
const store = require('./store');
const obsidian = require('./obsidian');
const core = require('./schedulecore');
const log = require('./logger');

const FILE = 'Schedule.md';
let queue = Promise.resolve(); // read-modify-write, one change at a time

async function read() {
  const root = await obsidian.vaultPath();
  if (!root) return null;
  return { root, text: await obsidian.readOptional(FILE) };
}

async function load() {
  const r = await read();
  if (!r) throw new Error('The schedule lives in the vault, which is turned off. Turn it on in Settings → Vault.');
  return { ...r, ...core.parse(r.text) };
}

async function status() {
  const s = await store.getSettings();
  const r = await read().catch(() => null);
  const parsed = r ? core.parse(r.text) : { entries: [], problems: [] };
  return {
    enabled: s.calendar.enabled,
    vault: Boolean(r),
    connected: Boolean(s.calendar.enabled && r), // the tools and the view are available
    file: FILE,
    recurring: parsed.entries.filter((e) => e.repeat).length,
    events: parsed.entries.filter((e) => !e.repeat).length,
    problems: parsed.problems.length,
  };
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Occurrences in [start, end) (default: today and the next daysAhead days). */
async function events({ start, end } = {}) {
  const s = await store.getSettings();
  const from = start ? new Date(start) : startOfDay(new Date());
  const to = end ? new Date(end) : new Date(from.getTime() + (s.calendar.daysAhead || 7) * 86400000);
  if (isNaN(from) || isNaN(to) || to <= from) throw new Error('Give a start and an end date (YYYY-MM-DD), the end after the start.');
  const { entries } = await load();
  return core.occurrences(entries, from, to);
}

const forList = (e) => ({ id: e.id, title: e.title, when: core.formatWhen(e), description: core.describe(e), repeats: Boolean(e.repeat), repeat: e.repeat, date: e.date, endDate: e.endDate, start: e.start, end: e.end, location: e.location, notes: e.notes, from: e.from, until: e.until, except: e.except });

/** Every entry (rules and one-off events) with its id, plus lines that couldn't be read. */
async function entries() {
  const { entries: list, problems } = await load();
  return { entries: list.map(forList), problems };
}

function change(fn) {
  const next = queue.catch(() => {}).then(fn);
  queue = next;
  return next;
}

async function save(text, message) {
  await obsidian.writeNote(FILE, text, 'overwrite', { source: message });
}

function newId(e, taken) {
  for (;;) {
    const id = `${e.repeat ? 'r' : 'e'}${crypto.randomBytes(3).toString('hex').slice(0, 4)}`;
    if (!taken.has(id)) return id;
  }
}

/** input: { title, when, location?, notes?, from?, until?, except? } */
function add(input, { source = 'agent' } = {}) {
  return change(async () => {
    const s = await store.getSettings();
    const { text, entries: list } = await load();
    const e = core.normalize({ ...input, id: '' });
    // A rule repeating every 2+ weeks/days/months counts from its first day: today unless given.
    if (e.repeat && e.repeat.interval > 1 && !e.from) e.from = core.ymd(new Date());
    e.id = newId(e, new Set(list.map((x) => x.id)));
    await save(core.addEntry(text || core.template(s.agent.name || 'Siren'), e), `${source}: schedule add`);
    log.info('schedule add', { id: e.id, repeats: Boolean(e.repeat) });
    return forList(e);
  });
}

/** patch: any of { title, when, location, notes, from, until, except } ('' clears a field). */
function update(id, patch, { source = 'agent' } = {}) {
  return change(async () => {
    const { text, entries: list } = await load();
    const old = list.find((x) => x.id === id);
    if (!old) throw new Error(`No schedule entry with id "${id}". List them with calendar_list_entries.`);
    const pick = (k, fallback) => (patch[k] === undefined || patch[k] === null ? fallback : patch[k]);
    const e = core.normalize({
      id,
      title: pick('title', old.title),
      when: pick('when', core.formatWhen(old)),
      location: pick('location', old.location),
      notes: pick('notes', old.notes),
      from: pick('from', old.from),
      until: pick('until', old.until),
      except: pick('except', old.except),
    });
    await save(core.replaceEntry(text, id, e), `${source}: schedule change`);
    log.info('schedule change', { id });
    return { before: forList(old), after: forList(e) };
  });
}

/** Removes an entry, or with onlyDate skips one day of a repeating entry. */
function remove(id, { onlyDate, source = 'agent' } = {}) {
  return change(async () => {
    const { text, entries: list } = await load();
    const old = list.find((x) => x.id === id);
    if (!old) throw new Error(`No schedule entry with id "${id}". List them with calendar_list_entries.`);
    if (onlyDate) {
      if (!old.repeat) throw new Error('only_date is for repeating entries; this is a single event, so delete it without only_date.');
      const e = core.normalize({ ...old, when: core.formatWhen(old), except: [...old.except, onlyDate] });
      await save(core.replaceEntry(text, id, e), `${source}: schedule skip ${onlyDate}`);
      return { skipped: onlyDate, entry: forList(e) };
    }
    await save(core.removeEntry(text, id).text, `${source}: schedule delete`);
    log.info('schedule delete', { id });
    return { deleted: forList(old) };
  });
}

function fmtEvent(e) {
  const start = new Date(e.start);
  const day = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const when = e.allDay ? `${day} (all day)` : `${day} ${time(start)}${e.openEnd ? '' : `–${time(new Date(e.end))}`}`;
  return `- ${when}: ${e.title}${e.location ? ` @ ${e.location}` : ''}${e.recurring ? ' (repeats)' : ''}`;
}

// Text block for the system prompt: today's schedule + upcoming.
async function promptBlock() {
  const st = await status();
  if (!st.connected) return '';
  try {
    const list = await events();
    const todayEnd = startOfDay(new Date()).getTime() + 86400000;
    const today = list.filter((e) => new Date(e.start).getTime() < todayEnd);
    const upcoming = list.filter((e) => new Date(e.start).getTime() >= todayEnd).slice(0, 40);
    return [
      `## Schedule (${FILE} in your vault: ${st.recurring} repeating, ${st.events} single entries${st.problems ? `, ${st.problems} unreadable line(s): see calendar_list_entries` : ''})`,
      "Today's schedule:",
      today.length ? today.map(fmtEvent).join('\n') : '- Nothing scheduled today.',
      'Upcoming:',
      upcoming.length ? upcoming.map(fmtEvent).join('\n') : '- Nothing upcoming in the next days.',
    ].join('\n');
  } catch (err) {
    return `## Schedule\n(Schedule unavailable: ${err.message})`;
  }
}

// Google Calendar sign-ins from before 1.3: their token file is no longer used.
function removeLegacy() {
  return store.setSecretBlob('google-tokens', null).catch(() => {});
}

module.exports = { status, events, entries, add, update, remove, promptBlock, fmtEvent, removeLegacy, FILE };
