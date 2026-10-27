// Calendar view: the user's schedule from Schedule.md in the vault (main/calendar.js), as a month
// grid, a week time grid or an agenda, with today's readout and the repeating rules on the side.
// The agent adds entries from what the user tells it; the user can add and edit them here too.
import { $, api, el, toast, toastError, modal, confirmDialog, on, emit } from './util.js';
import { switchView } from './nav.js';

const DAY = 86400000;
const HOUR_PX = 46;
const MODES = ['month', 'week', 'agenda'];
const MODE_KEY = 'nexus.calMode';
const PALETTE = ['--c1', '--c2', '--c3', '--ok', '--warn'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const local = (d) => `${ymd(d)}T00:00:00`;
const sameDay = (a, b) => ymd(a) === ymd(b);
const hm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const cal = {
  mode: readMode(),
  anchor: startOfDay(new Date()),
  selected: startOfDay(new Date()),
  events: [],
  entries: [],
  problems: [],
  upcoming: [],
  nowTimer: null,
  // Todoist / TickTick tasks (main/tasks.js): what the assistant last fetched with the connectors.
  tasks: { tasks: [], sources: {}, available: [], ready: false, reason: '', syncing: false },
};

// ------------------------------------------------------------ tasks from to-do apps
const SOURCE_NAME = { todoist: 'Todoist', ticktick: 'TickTick' };
const byTime = (a, b) => (a.time || '99').localeCompare(b.time || '99') || (b.priority || 0) - (a.priority || 0);
const tasksOn = (day) => cal.tasks.tasks.filter((t) => t.date === ymd(day) && !t.done).sort(byTime);
const overdueTasks = () => cal.tasks.tasks.filter((t) => t.date && t.date < ymd(new Date()) && !t.done).sort((a, b) => a.date.localeCompare(b.date));

function taskPill(t) {
  return el(
    'button',
    { class: `cal-pill cal-task ${t.source}`, title: `${SOURCE_NAME[t.source]} task${t.time ? ` · ${t.time}` : ''}${t.project ? ` · ${t.project}` : ''}: ${t.title}`, onclick: (ev) => (ev.stopPropagation(), taskDetails(t)) },
    el('i', { class: 'cal-check', 'aria-hidden': 'true' }),
    t.time ? el('b', {}, t.time) : null,
    el('span', {}, t.title),
  );
}

function taskRow(t, { showDate = false } = {}) {
  const late = t.date && t.date < ymd(new Date());
  return el(
    'button',
    { class: `cal-row cal-task-row ${t.source}${late ? ' late' : ''}`, onclick: () => taskDetails(t) },
    el('span', { class: 'tm' }, showDate || late ? new Date(`${t.date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : t.time || 'Task'),
    el('i', { class: 'cal-check', 'aria-hidden': 'true' }),
    el('span', { class: 'what' }, el('b', {}, t.title), el('small', {}, [SOURCE_NAME[t.source], t.project, t.priority >= 3 ? (t.priority === 4 ? '‼ urgent' : '! high') : ''].filter(Boolean).join(' · '))),
  );
}

function taskDetails(t) {
  modal((box, close) => {
    box.append(
      el('h3', { class: 'display' }, t.title),
      el('p', { class: 'muted' }, [`${SOURCE_NAME[t.source]} task`, t.project, t.date && `due ${new Date(`${t.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}${t.time ? ` at ${t.time}` : ''}`, t.priority ? `priority ${t.priority}` : ''].filter(Boolean).join(' · ')),
      el('p', { class: 'hint' }, `Shown from your last sync. Changes happen in ${SOURCE_NAME[t.source]}, or ask the assistant.`),
      el(
        'div',
        { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => close(null) }, 'Close'),
        el('button', { class: 'btn', onclick: () => (close(null), askAgent(`In ${SOURCE_NAME[t.source]}, move the task “${t.title}” to `)) }, 'Reschedule…'),
        t.url ? el('button', { class: 'btn', onclick: () => api.shell.openExternal(t.url) }, `Open in ${SOURCE_NAME[t.source]} ↗`) : null,
        el('button', { class: 'btn primary', onclick: () => (close(null), askAgent(`Mark the ${SOURCE_NAME[t.source]} task “${t.title}” as done.`)) }, 'Mark done…'),
      ),
    );
  });
}

async function syncTasks() {
  cal.tasks.syncing = true;
  $('.cal-side')?.replaceWith(sidePanel());
  try {
    await api.tasks.sync();
    toast('Tasks synced.');
  } catch (err) {
    toastError(err);
  }
  refresh();
}

function tasksPanel() {
  const t = cal.tasks;
  if (!t.available.length && !t.tasks.length) return null;
  const synced = Object.entries(t.sources).map(([s, v]) => `${SOURCE_NAME[s]} ${new Date(v.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`).join(' · ');
  const late = overdueTasks();
  const today = tasksOn(cal.selected);
  const why = { 'connectors-off': 'Turn on “Use my Claude connectors and plugins” in Settings → AI brain to sync.', 'no-claude': 'Syncing needs the Claude account brain (Settings → AI brain).' }[t.reason];
  return el(
    'section',
    { class: 'cal-tasks glass' },
    el('div', { class: 'cal-tasks-head' }, el('h4', { class: 'display' }, 'Tasks'), el('button', { class: 'btn small', disabled: !t.ready || t.syncing, onclick: syncTasks, title: 'The assistant fetches your tasks with the connector' }, t.syncing ? 'Syncing…' : '↻ Sync')),
    why ? el('p', { class: 'hint' }, why) : null,
    !t.tasks.length && t.ready && !t.syncing ? el('p', { class: 'muted' }, `Show your ${t.available.map((s) => SOURCE_NAME[s]).join(' and ')} tasks here: press Sync.`) : null,
    late.length ? el('div', { class: 'cal-task-group' }, el('small', { class: 'cal-late' }, `OVERDUE · ${late.length}`), late.slice(0, 6).map((x) => taskRow(x))) : null,
    t.tasks.length ? el('div', { class: 'cal-task-group' }, el('small', {}, sameDay(cal.selected, new Date()) ? 'TODAY' : cal.selected.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase()), today.length ? today.map((x) => taskRow(x)) : el('p', { class: 'muted' }, 'No tasks due.')) : null,
    synced ? el('small', { class: 'hint' }, `Last sync: ${synced}`) : null,
  );
}

function readMode() {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return MODES.includes(m) ? m : 'month';
  } catch {
    return 'month';
  }
}

// The locale's first day of the week (Monday in most of the world).
const FIRST_DAY = (() => {
  try {
    const l = new Intl.Locale(navigator.language);
    return ((l.getWeekInfo?.() || l.weekInfo)?.firstDay ?? 1) % 7;
  } catch {
    return 1;
  }
})();
const weekStart = (d) => addDays(startOfDay(d), -((d.getDay() - FIRST_DAY + 7) % 7));

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
}

// One theme color per entry, so a lecture keeps its color across the month.
function colorOf(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `--ev: var(${PALETTE[h % PALETTE.length]})`;
}

export function initCalendar() {
  $('#calPrev').onclick = () => shift(-1);
  $('#calNext').onclick = () => shift(1);
  $('#calToday').onclick = () => {
    cal.anchor = cal.selected = startOfDay(new Date());
    refresh();
  };
  $('#calNew').onclick = () => editor({ date: ymd(cal.selected) });
  $('#calObsidian').onclick = () => api.obsidian.openInObsidian('Schedule.md').catch(toastError);
  for (const b of document.querySelectorAll('#calModes button')) {
    b.onclick = () => {
      cal.mode = b.dataset.mode;
      try {
        localStorage.setItem(MODE_KEY, cal.mode);
      } catch {
        /* storage unavailable: the choice lasts for this session */
      }
      cal.anchor = cal.selected;
      refresh();
    };
  }
  on('calendar-changed', refresh);
  api.on('tasks:changed', () => $('#view-calendar').classList.contains('active') && refresh());
  on('vault-changed', (p) => p === 'Schedule.md' && $('#view-calendar').classList.contains('active') && refresh());
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !$('#view-calendar').classList.contains('active') || e.target.closest('input, textarea, select, [contenteditable]') || !$('#modal').classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') shift(-1);
    else if (e.key === 'ArrowRight') shift(1);
    else if (e.key.toLowerCase() === 't') $('#calToday').click();
    else if (e.key.toLowerCase() === 'n') $('#calNew').click();
  });
}

function shift(dir) {
  const a = cal.anchor;
  if (cal.mode === 'month') cal.anchor = new Date(a.getFullYear(), a.getMonth() + dir, 1);
  else cal.anchor = addDays(a, dir * (cal.mode === 'week' ? 7 : 28));
  if (cal.mode !== 'agenda') cal.selected = cal.mode === 'week' ? addDays(cal.selected, dir * 7) : cal.anchor;
  refresh();
}

function range() {
  if (cal.mode === 'month') {
    const from = weekStart(new Date(cal.anchor.getFullYear(), cal.anchor.getMonth(), 1));
    return [from, addDays(from, 42)];
  }
  if (cal.mode === 'week') {
    const from = weekStart(cal.anchor);
    return [from, addDays(from, 7)];
  }
  return [cal.anchor, addDays(cal.anchor, 28)];
}

function rangeLabel(from, to) {
  if (cal.mode === 'month') return cal.anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const last = addDays(to, -1);
  const opts = { day: 'numeric', month: 'short' };
  return `${from.toLocaleDateString(undefined, opts)} – ${last.toLocaleDateString(undefined, { ...opts, year: 'numeric' })}${cal.mode === 'week' ? ` · W${isoWeek(from)}` : ''}`;
}

export async function refresh() {
  const body = $('#calBody');
  for (const b of document.querySelectorAll('#calModes button')) b.classList.toggle('active', b.dataset.mode === cal.mode);
  const [from, to] = range();
  $('#calRange').textContent = rangeLabel(from, to);
  const status = await api.calendar.status().catch(() => ({}));
  $('#calObsidian').classList.toggle('hidden', !status.vault);
  if (!status.vault || !status.enabled) return body.replaceChildren(offPanel(status));
  try {
    const [events, list, upcoming, tasks] = await Promise.all([
      api.calendar.events({ start: local(from), end: local(to) }),
      api.calendar.entries(),
      api.calendar.events({ start: new Date(Date.now() - 6 * 3600000).toISOString(), end: local(addDays(new Date(), 8)) }),
      api.tasks.status().catch(() => cal.tasks),
    ]);
    Object.assign(cal, { events, entries: list.entries, problems: list.problems, upcoming, tasks });
  } catch (err) {
    body.replaceChildren(el('p', { class: 'muted' }, err.message));
    return toastError(err);
  }
  $('#calStamp').textContent = `${cal.entries.length} ENTR${cal.entries.length === 1 ? 'Y' : 'IES'} · ${cal.entries.filter((e) => e.repeats).length} REPEATING · W${isoWeek(new Date())}`;
  const main = el('div', { class: `cal-main glass cal-${cal.mode}` }, cal.mode === 'month' ? monthView(from) : cal.mode === 'week' ? weekView(from) : agendaView());
  body.replaceChildren(el('div', { class: 'cal-layout' }, main, sidePanel()));
  if (cal.mode === 'week') scrollWeek(main);
  clearInterval(cal.nowTimer);
  cal.nowTimer = setInterval(tickNow, 60000);
}

function offPanel(status) {
  const off = status.enabled === false;
  return el(
    'div',
    { class: 'cal-empty glass' },
    el('h3', { class: 'display' }, off ? 'The calendar is off' : 'Your schedule lives in the vault'),
    el('p', { class: 'muted' }, off ? 'Turn it on in Settings → Calendar to see your schedule and let the agent keep it.' : 'The agent keeps your schedule as a note (Schedule.md) in its vault. Turn the vault on to use the calendar.'),
    el('div', { class: 'row', style: { justifyContent: 'center' } }, el('button', { class: 'btn primary', onclick: () => switchView('settings', off ? 'calendar' : 'obsidian') }, 'Open settings')),
  );
}

// Occurrences on a day (all-day ones that span it too).
function onDay(list, day) {
  const a = local(day);
  const b = local(addDays(day, 1));
  return list.filter((e) => e.start < b && e.end > a);
}

function timeLabel(e) {
  if (e.allDay) return 'All day';
  const s = new Date(e.start);
  return e.openEnd ? hm(s) : `${hm(s)} – ${hm(new Date(e.end))}`;
}

// ------------------------------------------------------------ month
function monthView(from) {
  const today = startOfDay(new Date());
  const head = el('div', { class: 'cal-dow' }, [...Array(7)].map((_, i) => el('div', {}, WEEKDAYS[(FIRST_DAY + i) % 7])));
  const cells = el('div', { class: 'cal-cells' });
  for (let i = 0; i < 42; i++) {
    const day = addDays(from, i);
    // Schedule entries first, then the day's tasks from the to-do apps.
    const list = [...onDay(cal.events, day).map((e) => ({ e })), ...tasksOn(day).map((t) => ({ t }))];
    const cls = ['cal-cell', day.getMonth() !== cal.anchor.getMonth() && 'out', sameDay(day, today) && 'today', sameDay(day, cal.selected) && 'sel', day < today && 'past'].filter(Boolean).join(' ');
    const cell = el(
      'div',
      { class: cls, tabindex: '0', 'aria-label': day.toDateString(), onclick: () => select(day), ondblclick: () => editor({ date: ymd(day) }), onkeydown: (e) => e.key === 'Enter' && editor({ date: ymd(day) }) },
      el('div', { class: 'cal-num' }, el('span', {}, day.getDate()), list.length ? el('i', { class: 'cal-count' }, list.length) : null),
      el('div', { class: 'cal-pills' }, list.slice(0, 3).map((x) => (x.e ? pill(x.e) : taskPill(x.t))), list.length > 3 ? el('button', { class: 'cal-more', onclick: (ev) => (ev.stopPropagation(), select(day)) }, `+${list.length - 3} more`) : null),
    );
    cells.append(cell);
  }
  return el('div', { class: 'cal-month-wrap' }, head, cells);
}

function pill(e) {
  return el(
    'button',
    { class: `cal-pill ${e.allDay ? 'all' : ''}`, style: colorOf(e.entryId), title: `${timeLabel(e)} · ${e.title}${e.location ? ` @ ${e.location}` : ''}`, onclick: (ev) => (ev.stopPropagation(), details(e)) },
    e.allDay ? null : el('b', {}, hm(new Date(e.start))),
    el('span', {}, e.title),
    e.recurring ? el('i', { class: 'rep', 'aria-label': 'repeats' }, '↻') : null,
  );
}

function select(day) {
  cal.selected = startOfDay(day);
  for (const c of document.querySelectorAll('.cal-cell.sel')) c.classList.remove('sel');
  const cells = [...document.querySelectorAll('.cal-cell')];
  const [from] = range();
  cells[Math.round((cal.selected - from) / DAY)]?.classList.add('sel');
  document.querySelectorAll('.cal-wk-day').forEach((b, i) => b.classList.toggle('sel', sameDay(addDays(from, i), cal.selected)));
  $('.cal-side')?.replaceWith(sidePanel());
}

// ------------------------------------------------------------ week
function weekView(from) {
  const today = startOfDay(new Date());
  const days = [...Array(7)].map((_, i) => addDays(from, i));
  const head = el(
    'div',
    { class: 'cal-wk-head' },
    el('div', { class: 'cal-wk-gutter' }, `W${isoWeek(from)}`),
    days.map((d) => el('button', { class: `cal-wk-day ${sameDay(d, today) ? 'today' : ''} ${sameDay(d, cal.selected) ? 'sel' : ''}`, onclick: () => select(d) }, el('span', {}, WEEKDAYS[d.getDay()]), el('b', {}, d.getDate()))),
  );
  const allDay = el('div', { class: 'cal-wk-allday' }, el('div', { class: 'cal-wk-gutter' }, 'all day'), days.map((d) => el('div', {}, onDay(cal.events, d).filter((e) => e.allDay).map(pill), tasksOn(d).map(taskPill))));
  const hours = el('div', { class: 'cal-wk-hours' }, [...Array(24)].map((_, h) => el('div', { style: { height: `${HOUR_PX}px` } }, h ? `${pad(h)}:00` : '')));
  const cols = days.map((d) => dayColumn(d, sameDay(d, today)));
  const grid = el('div', { class: 'cal-wk-grid', style: { height: `${24 * HOUR_PX}px` } }, hours, cols);
  return el('div', { class: 'cal-week-wrap' }, head, allDay, el('div', { class: 'cal-wk-scroll' }, grid));
}

function dayColumn(day, isToday) {
  const col = el('div', { class: `cal-wk-col ${isToday ? 'today' : ''}` });
  col.addEventListener('click', (ev) => {
    if (ev.target !== col) return;
    const mins = Math.max(0, Math.min(23 * 60 + 30, Math.floor(ev.offsetY / HOUR_PX * 2) * 30));
    editor({ date: ymd(day), start: `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}` });
  });
  const dayStart = day.getTime();
  const timed = onDay(cal.events, day).filter((e) => !e.allDay).map((e) => ({ e, s: Math.max(dayStart, new Date(e.start).getTime()), t: Math.min(dayStart + DAY, new Date(e.end).getTime()) }));
  for (const { e, s, t, col: c, cols } of layout(timed)) {
    const top = ((s - dayStart) / 3600000) * HOUR_PX;
    const height = Math.max(20, ((t - s) / 3600000) * HOUR_PX - 2);
    col.append(
      el(
        'button',
        { class: `cal-block ${height < 40 ? 'short' : ''}`, style: `${colorOf(e.entryId)}; top: ${top}px; height: ${height}px; left: calc(${(c / cols) * 100}% + 2px); width: calc(${100 / cols}% - 4px)`, onclick: () => details(e) },
        el('b', {}, e.title),
        el('span', {}, `${timeLabel(e)}${e.location ? ` · ${e.location}` : ''}`),
      ),
    );
  }
  if (isToday) col.append(el('div', { class: 'cal-now', style: { top: `${nowOffset()}px` } }));
  return col;
}

// Overlapping blocks share the column side by side.
function layout(items) {
  items.sort((a, b) => a.s - b.s || b.t - a.t);
  const out = [];
  let group = [];
  let groupEnd = -Infinity;
  const flush = () => {
    const cols = Math.max(1, ...group.map((g) => g.col + 1));
    group.forEach((g) => out.push({ ...g, cols }));
    group = [];
  };
  for (const it of items) {
    if (it.s >= groupEnd && group.length) flush();
    const used = new Set(group.filter((g) => g.t > it.s).map((g) => g.col));
    let c = 0;
    while (used.has(c)) c++;
    group.push({ ...it, col: c });
    groupEnd = Math.max(groupEnd, it.t);
  }
  if (group.length) flush();
  return out;
}

const nowOffset = () => {
  const n = new Date();
  return (n.getHours() + n.getMinutes() / 60) * HOUR_PX;
};

function tickNow() {
  const line = document.querySelector('.cal-now');
  if (line) line.style.top = `${nowOffset()}px`;
  const next = document.querySelector('.cal-next');
  if (next) next.replaceWith(nextUp());
}

// Opens the week around the first thing of the week (or the current hour).
function scrollWeek(main) {
  const firstHour = Math.min(...cal.events.filter((e) => !e.allDay).map((e) => new Date(e.start).getHours()), new Date().getHours(), 8);
  requestAnimationFrame(() => (main.querySelector('.cal-wk-scroll').scrollTop = Math.max(0, firstHour - 1) * HOUR_PX));
}

// ------------------------------------------------------------ agenda
function agendaView() {
  const today = startOfDay(new Date());
  const list = el('div', { class: 'cal-agenda' });
  for (let i = 0; i < 28; i++) {
    const day = addDays(cal.anchor, i);
    const items = onDay(cal.events, day);
    const todo = tasksOn(day);
    if (!items.length && !todo.length) continue;
    list.append(
      el(
        'section',
        { class: `cal-ag-day ${sameDay(day, today) ? 'today' : ''}` },
        el('header', {}, el('b', {}, day.getDate()), el('span', {}, day.toLocaleDateString(undefined, { weekday: 'long', month: 'long' })), sameDay(day, today) ? el('i', {}, 'TODAY') : null),
        items.map(row),
        todo.map((t) => taskRow(t)),
      ),
    );
  }
  if (!list.childElementCount) list.append(emptyHint('Nothing in the next four weeks.'));
  return list;
}

function row(e) {
  return el(
    'button',
    { class: 'cal-row', style: colorOf(e.entryId), onclick: () => details(e) },
    el('span', { class: 'tm' }, timeLabel(e)),
    el('span', { class: 'bar' }),
    el('span', { class: 'what' }, el('b', {}, e.title), e.location || e.recurring ? el('small', {}, [e.location && `📍 ${e.location}`, e.recurring && `↻ ${e.rule.split(',')[0]}`].filter(Boolean).join('   ')) : null),
  );
}

// ------------------------------------------------------------ side panel
function sidePanel() {
  const day = cal.selected;
  const items = onDay(cal.events, day).concat(cal.mode === 'agenda' || !inRange(day) ? onDay(cal.upcoming, day) : []);
  const unique = [...new Map(items.map((e) => [e.id, e])).values()];
  const rules = cal.entries.filter((e) => e.repeats);
  return el(
    'aside',
    { class: 'cal-side' },
    el(
      'section',
      { class: 'cal-today glass' },
      el('div', { class: 'cal-big' }, el('b', {}, day.getDate()), el('div', {}, el('span', {}, day.toLocaleDateString(undefined, { weekday: 'long' })), el('small', {}, day.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })))),
      nextUp(),
      el('div', { class: 'cal-day-list' }, unique.length ? unique.map(row) : el('p', { class: 'muted' }, sameDay(day, new Date()) ? 'Nothing scheduled today.' : 'Nothing scheduled.')),
      el('button', { class: 'btn small', onclick: () => editor({ date: ymd(day) }) }, '＋ Add to this day'),
    ),
    tasksPanel(),
    el(
      'section',
      { class: 'cal-rules glass' },
      el('h4', { class: 'display' }, 'Repeating'),
      rules.length
        ? rules.map((r) => el('button', { class: 'cal-rule', style: colorOf(r.id), onclick: () => editor(r) }, el('span', { class: 'bar' }), el('span', {}, el('b', {}, r.title), el('small', {}, `${r.description}${r.location ? ` · ${r.location}` : ''}`))))
        : emptyHint('No repeating entries yet.'),
    ),
    cal.problems.length
      ? el(
          'section',
          { class: 'cal-problems glass' },
          el('h4', { class: 'display' }, `${cal.problems.length} unreadable line${cal.problems.length > 1 ? 's' : ''}`),
          cal.problems.slice(0, 5).map((p) => el('div', {}, el('code', {}, `L${p.line}: ${p.text}`), el('small', { class: 'muted' }, p.error.split('. Use')[0]))),
          el('small', { class: 'muted' }, 'Fix them in Schedule.md, or ask the agent to.'),
        )
      : null,
  );
}

function inRange(day) {
  const [from, to] = range();
  return day >= from && day < to;
}

function nextUp() {
  const now = new Date();
  const next = cal.upcoming.find((e) => !e.allDay && new Date(e.end) > now);
  if (!next) return el('div', { class: 'cal-next muted' }, 'Nothing coming up this week.');
  const start = new Date(next.start);
  const mins = Math.round((start - now) / 60000);
  const when = mins <= 0 ? 'NOW' : mins < 60 ? `IN ${mins} MIN` : mins < 24 * 60 ? `IN ${Math.floor(mins / 60)} H ${pad(mins % 60)} MIN` : start.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase() + ` ${hm(start)}`;
  return el('button', { class: `cal-next ${mins <= 0 ? 'live' : ''}`, style: colorOf(next.entryId), onclick: () => details(next) }, el('small', {}, `NEXT · ${when}`), el('b', {}, next.title), el('span', {}, `${timeLabel(next)}${next.location ? ` · ${next.location}` : ''}`));
}

function emptyHint(text) {
  return el(
    'div',
    { class: 'cal-hint' },
    el('p', { class: 'muted' }, text),
    el('p', { class: 'muted' }, 'Tell the agent, for example:'),
    el('button', { class: 'chip-btn', onclick: () => askAgent('I have a lecture every Monday at 10:00 in room ') }, '“I have a lecture every Monday at 10:00 in …”'),
  );
}

function askAgent(text) {
  switchView('chat');
  const input = $('#input');
  input.value = text;
  input.dispatchEvent(new Event('input'));
  input.focus();
}

// ------------------------------------------------------------ details & editing
function details(e) {
  const entry = cal.entries.find((x) => x.id === e.entryId);
  const day = e.start.slice(0, 10);
  modal((card, close) => {
    card.classList.add('cal-modal');
    card.style.cssText = colorOf(e.entryId);
    // native append() would print a skipped (null) line as the text "null"
    const parts = [
      el('div', { class: 'cal-modal-head' }, el('span', { class: 'bar' }), el('div', {}, el('h3', {}, e.title), el('div', { class: 'muted' }, `${new Date(e.start).toLocaleDateString(undefined, { dateStyle: 'full' })} · ${timeLabel(e)}`))),
      e.recurring ? el('div', { class: 'cal-meta' }, '↻ ', e.rule) : null,
      e.location ? el('div', { class: 'cal-meta' }, '📍 ', e.location) : null,
      e.notes ? el('div', { class: 'cal-meta' }, '✎ ', e.notes) : null,
      el(
        'div',
        { class: 'modal-actions' },
        el('button', { class: 'btn danger', onclick: () => (close(), removeEntry(entry || { id: e.entryId, title: e.title })) }, 'Delete'),
        e.recurring ? el('button', { class: 'btn', onclick: () => (close(), skipDay(e, day)) }, 'Skip this day') : null,
        entry ? el('button', { class: 'btn', onclick: () => (close(), editor(entry)) }, 'Edit') : null,
        el('button', { class: 'btn primary', onclick: () => close() }, 'Close'),
      ),
    ];
    card.append(...parts.filter(Boolean));
  });
}

async function skipDay(e, day) {
  try {
    await api.calendar.remove(e.entryId, { onlyDate: day });
    toast(`Skipped ${e.title} on ${new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`);
    refresh();
  } catch (err) {
    toastError(err);
  }
}

async function removeEntry(entry) {
  const what = entry.repeats ? `“${entry.title}” and every repeat of it` : `“${entry.title}”`;
  if (!(await confirmDialog('Delete from your schedule', `${what} will be removed from Schedule.md (the vault keeps its history).`, 'Delete'))) return;
  try {
    await api.calendar.remove(entry.id);
    refresh();
  } catch (err) {
    toastError(err);
  }
}

// Builds the "when" text main/schedulecore.js reads ("2026-10-28 14:00-15:00", "every Monday 10:00").
function whenOf(f) {
  const time = f.allDay ? '' : ` ${f.start}${f.end ? `-${f.end}` : ''}`;
  if (!f.repeats) return `${f.date}${f.allDay && f.endDate && f.endDate > f.date ? ` to ${f.endDate}` : ''}${time}`;
  const n = Math.max(1, Math.round(Number(f.interval) || 1));
  const d = new Date(`${f.date}T12:00:00`);
  if (f.freq === 'daily') return `every ${n === 1 ? 'day' : `${n} days`}${time}`;
  if (f.freq === 'monthly') return `every ${n === 1 ? 'month' : `${n} months`} on the ${d.getDate()}${time}`;
  if (f.freq === 'yearly') return `every year on ${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}${time}`;
  const days = f.days.length ? f.days : [d.getDay()];
  const names = days.map((i) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]).join(', ');
  return n === 1 ? `every ${names}${time}` : `every ${n} weeks on ${names}${time}`;
}

// The form's starting values from an entry (or a new one on a date / at a time).
function formOf(x) {
  const r = x.repeat;
  return {
    title: x.title || '',
    repeats: Boolean(r),
    date: x.date || x.from || ymd(cal.selected),
    endDate: x.endDate || '',
    allDay: Boolean(x.id) && !x.start,
    start: x.start || '09:00',
    end: x.end || (x.start ? `${pad(Math.min(23, Number(x.start.slice(0, 2)) + 1))}:${x.start.slice(3)}` : '10:00'),
    freq: r?.freq || 'weekly',
    interval: r?.interval || 1,
    days: r?.days || [],
    from: x.from || '',
    until: x.until || '',
    location: x.location || '',
    notes: x.notes || '',
  };
}

function editor(x = {}) {
  const f = formOf(x);
  if (x.repeat?.freq === 'yearly') f.date = `${new Date().getFullYear()}-${pad(x.repeat.month)}-${pad(x.repeat.monthDay)}`;
  if (x.repeat?.freq === 'monthly') f.date = `${ymd(new Date()).slice(0, 8)}${pad(x.repeat.monthDay)}`;
  modal((card, close) => {
    card.classList.add('cal-modal', 'cal-editor');
    const input = (key, attrs = {}) => {
      const i = el('input', { class: 'input', value: f[key], ...attrs });
      i.addEventListener('input', () => ((f[key] = attrs.type === 'checkbox' ? i.checked : i.value), update()));
      if (attrs.type === 'checkbox') i.checked = f[key];
      return i;
    };
    const err = el('div', { class: 'test-result err hidden' });
    const preview = el('div', { class: 'cal-preview' });
    const type = el('div', { class: 'seg' }, ['One-time', 'Repeats'].map((label, i) => el('button', { type: 'button', onclick: () => ((f.repeats = Boolean(i)), update()) }, label)));
    const freq = el('select', { class: 'input' }, [['weekly', 'Weekly'], ['daily', 'Daily'], ['monthly', 'Monthly (same day of the month)'], ['yearly', 'Yearly (same date)']].map(([v, l]) => el('option', { value: v }, l)));
    freq.value = f.freq;
    freq.onchange = () => ((f.freq = freq.value), update());
    const dayBtns = el('div', { class: 'cal-daypick' }, [...Array(7)].map((_, i) => {
      const d = (FIRST_DAY + i) % 7;
      const toggle = () => {
        const cur = f.days.length ? f.days : [new Date(`${f.date}T12:00:00`).getDay()];
        const next = cur.includes(d) ? cur.filter((v) => v !== d) : [...cur, d];
        if (next.length) f.days = next; // at least one day
        update();
      };
      return el('button', { type: 'button', 'data-d': d, onclick: toggle }, WEEKDAYS[d].slice(0, 2));
    }));
    const times = el('div', { class: 'grid2' }, field('Starts', input('start', { type: 'time' })), field('Ends (optional)', input('end', { type: 'time' })));
    const repeatBox = el('div', { class: 'cal-repeat' },
      el('div', { class: 'grid2' }, field('Repeats', freq), field('Every', el('div', { class: 'row' }, input('interval', { type: 'number', min: 1, max: 52 }), el('span', { class: 'muted unit' })))),
      field('On', dayBtns),
      el('div', { class: 'grid2' }, field('From (optional)', input('from', { type: 'date' })), field('Until (optional)', input('until', { type: 'date' }))),
    );
    const endDate = field('Until (for several days)', input('endDate', { type: 'date' }));
    const dateField = field('Date', input('date', { type: 'date' }));
    const update = () => {
      type.children[0].classList.toggle('active', !f.repeats);
      type.children[1].classList.toggle('active', f.repeats);
      repeatBox.classList.toggle('hidden', !f.repeats);
      dayBtns.parentElement.classList.toggle('hidden', f.freq !== 'weekly');
      repeatBox.querySelector('.unit').textContent = { daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)', yearly: 'year' }[f.freq];
      for (const b of dayBtns.children) b.classList.toggle('active', (f.days.length ? f.days : [new Date(`${f.date}T12:00:00`).getDay()]).includes(Number(b.dataset.d)));
      times.classList.toggle('hidden', f.allDay);
      endDate.classList.toggle('hidden', !f.allDay || f.repeats);
      // A rule needs a date only for "same day of the month / same date"; weekly uses the days.
      dateField.classList.toggle('hidden', f.repeats && !['monthly', 'yearly'].includes(f.freq));
      dateField.firstChild.textContent = f.repeats ? 'Which date' : 'Date';
      preview.textContent = f.title || f.date ? `→ ${whenOf(f)}` : '';
    };
    const title = input('title', { placeholder: 'e.g. Linear Algebra lecture', maxlength: 120 });
    const save = async () => {
      if (!f.title.trim()) return title.focus();
      const payload = { title: f.title, when: whenOf(f), location: f.location, notes: f.notes, from: f.repeats ? f.from : '', until: f.repeats ? f.until : '' };
      try {
        if (x.id) await api.calendar.update(x.id, payload);
        else await api.calendar.add(payload);
        close();
        emit('status-refresh');
        refresh();
      } catch (e) {
        err.textContent = `✕ ${String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
        err.classList.remove('hidden');
      }
    };
    title.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    card.append(
      el('h3', {}, x.id ? 'Edit entry' : 'New entry'),
      field('Title', title),
      el('div', { class: 'row' }, type, el('label', { class: 'toggle-inline' }, input('allDay', { type: 'checkbox' }), ' All day')),
      dateField,
      endDate,
      times,
      repeatBox,
      el('div', { class: 'grid2' }, field('Where (optional)', input('location', { maxlength: 160 })), field('Notes (optional)', input('notes', { maxlength: 500 }))),
      preview,
      err,
      el(
        'div',
        { class: 'modal-actions' },
        x.id ? el('button', { class: 'btn danger', style: { marginRight: 'auto' }, onclick: () => (close(), removeEntry(x)) }, 'Delete') : null,
        el('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: save }, x.id ? 'Save' : 'Add'),
      ),
    );
    update();
    setTimeout(() => title.focus(), 0);
  });
}

function field(label, control) {
  return el('label', { class: 'field' }, el('span', { class: 'muted' }, label), control);
}
