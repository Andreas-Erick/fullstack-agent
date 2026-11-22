// The schedule screen (read-only).
import { $, state } from './state.js';
import { el, icon, AuthError, plainLoadError } from './ui.js';
import { api } from './net.js';
import { prefill } from './chatview.js';
import { showView } from './nav.js';

// ------------------------------------------------------------------ schedule
// The schedule the assistant keeps on the computer (Schedule.md in its vault), read-only here: a week
// strip, the chosen day as a timeline, and what's next. New entries go through the assistant.
const DAY_MS = 86400000;
const TINTS = ['--accent', '--accent2', '--ok'];
export const sched = { week: null, day: null, cache: new Map(), loading: null };
const FIRST_DAY = (() => {
  try {
    const l = new Intl.Locale(navigator.language);
    return ((l.getWeekInfo?.() || l.weekInfo)?.firstDay ?? 1) % 7;
  } catch {
    return 1;
  }
})();
export const dayOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const plusDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const weekOf = (d) => plusDays(dayOf(d), -((d.getDay() - FIRST_DAY + 7) % 7));
const clock = (s) => new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// One theme color per entry (CSSOM, since the page's CSP allows no inline styles).
function tint(node, id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  node.style.setProperty('--ev', `var(${TINTS[h % TINTS.length]})`);
  return node;
}

async function weekEvents(week, fresh = false) {
  const key = ymd(week);
  if (!fresh && sched.cache.has(key)) return sched.cache.get(key);
  const data = await api(`/api/schedule?from=${key}&to=${ymd(plusDays(week, 7))}`);
  sched.cache.set(key, data.events);
  return data.events;
}

const onDate = (list, day) => {
  const a = `${ymd(day)}T00:00:00`;
  const b = `${ymd(plusDays(day, 1))}T00:00:00`;
  return list.filter((e) => e.start < b && e.end > a);
};

export async function renderSchedule(fresh = false) {
  const week = sched.week;
  const today = dayOf(new Date());
  // The week strip and the day's heading right away (known without loading), so nothing jumps when the
  // events arrive; then the dots and the list.
  if (!sched.cache.has(ymd(week)) || fresh) {
    drawWeek(week, today, []);
    $('#schedList').replaceChildren(el('div', { class: 'muted sched-loading' }, 'Loading…'));
  }
  let list;
  try {
    list = await weekEvents(week, fresh);
  } catch (err) {
    if (err instanceof AuthError) return;
    if (week !== sched.week || state.view !== 'sched') return;
    return $('#schedList').replaceChildren(el('div', { class: 'sched-empty load-failed' }, el('p', {}, plainLoadError(err, 'The schedule didn’t load.')), el('button', { class: 'btn small', type: 'button', onclick: () => renderSchedule(true) }, 'Try again')));
  }
  if (week !== sched.week || state.view !== 'sched') return; // moved on meanwhile
  const items = drawWeek(week, today, list);
  const day = sched.day;
  const isToday = ymd(day) === ymd(today);
  const next = isToday && items.find((e) => !e.allDay && new Date(e.end) > new Date());
  const rows = items.filter((e) => e !== next).map((e) => schedRow(e, isToday));
  if (next) {
    const mins = Math.round((new Date(next.start) - Date.now()) / 60000);
    rows.unshift(tint(el('div', { class: `sched-next ${mins <= 0 ? 'live' : ''}` }, el('small', {}, mins <= 0 ? 'NOW' : mins < 60 ? `NEXT · IN ${mins} MIN` : `NEXT · IN ${Math.floor(mins / 60)} H ${String(mins % 60).padStart(2, '0')}`), el('b', {}, next.title), next.location ? el('span', {}, next.location) : null), next.entryId));
  }
  $('#schedList').replaceChildren(...(rows.length ? rows : [el('div', { class: 'sched-empty' }, el('p', {}, isToday ? 'Nothing scheduled today.' : 'Nothing scheduled.'), el('p', { class: 'muted' }, 'Tell the assistant about lectures, shifts or appointments, and it keeps them here.'))]));
}

/** The week strip (dots from `list`) and the selected day's heading; returns that day's events. */
function drawWeek(week, today, list) {
  $('#schedDays').replaceChildren(...[...Array(7)].map((_, i) => {
    const d = plusDays(week, i);
    const n = onDate(list, d).length;
    const cls = ['sched-day', ymd(d) === ymd(today) && 'today', ymd(d) === ymd(sched.day) && 'sel', d < today && 'past'].filter(Boolean).join(' ');
    return el('button', { class: cls, type: 'button', 'aria-label': d.toDateString(), 'aria-pressed': String(ymd(d) === ymd(sched.day)), onclick: () => pickDay(d) },
      el('span', {}, d.toLocaleDateString(undefined, { weekday: 'narrow' })),
      el('b', {}, d.getDate()),
      el('i', { class: n ? 'dots' : 'dots none' }, '•'.repeat(Math.min(3, n)) || '·'),
    );
  }));
  const day = sched.day;
  const isToday = ymd(day) === ymd(today);
  $('#schedHead').replaceChildren(
    el('div', { class: 'sched-date' }, el('b', {}, day.getDate()), el('div', {}, el('span', {}, day.toLocaleDateString(undefined, { weekday: 'long' })), el('small', {}, day.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })))),
    isToday ? el('i', { class: 'sched-badge' }, 'TODAY') : el('button', { class: 'sched-today', type: 'button', onclick: () => pickDay(today) }, 'Today'),
  );
  return onDate(list, day);
}

function schedRow(e, isToday) {
  const past = isToday && new Date(e.end) < new Date();
  return tint(el('div', { class: `sched-row ${past ? 'past' : ''}` },
    el('div', { class: 'tm' }, e.allDay ? el('b', {}, 'ALL DAY') : [el('b', {}, clock(e.start)), e.openEnd ? null : el('span', {}, clock(e.end))]),
    el('span', { class: 'bar' }),
    el('div', { class: 'what' },
      el('b', {}, e.title),
      e.location ? el('span', {}, icon('pin'), e.location) : null,
      e.recurring ? el('span', { class: 'rule' }, icon('repeat'), e.rule.split(' (')[0]) : null,
      e.notes ? el('span', { class: 'notes' }, e.notes) : null,
    ),
  ), e.entryId);
}

function pickDay(d) {
  sched.day = dayOf(d);
  const week = weekOf(d);
  if (ymd(week) !== ymd(sched.week)) sched.week = week;
  navigator.vibrate?.(8);
  renderSchedule();
}

$('#schedBtn').addEventListener('click', () => showView(state.view === 'sched' ? 'chat' : 'sched'));
$('#schedPrev').addEventListener('click', () => pickDay(plusDays(sched.day, -7)));
$('#schedNext').addEventListener('click', () => pickDay(plusDays(sched.day, 7)));
$('#schedTell').addEventListener('click', () => {
  showView('chat');
  prefill('Add to my schedule: ');
});
// Swipe the day list sideways for the next or previous day.
let swipe = null;
$('#schedList').addEventListener('pointerdown', (e) => (swipe = { x: e.clientX, y: e.clientY }), { passive: true });
$('#schedList').addEventListener('pointerup', (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) pickDay(plusDays(sched.day, dx < 0 ? 1 : -1));
}, { passive: true });

