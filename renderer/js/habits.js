// Habits view: today's habits with one-click check-offs, streaks and the last 7 days (Habits.md in the
// vault, main/habits.js), and the user's routines: scheduled runs of the agent (main/routines.js).
import { $, api, el, toast, toastError, modal, confirmDialog, on } from './util.js';
import { switchView } from './nav.js';
import { openConversation } from './chat.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Ready-made routines; the Plaud one needs the Plaud connector (Settings → AI brain → connectors).
export const ROUTINE_TEMPLATES = [
  {
    name: 'Check new Plaud recordings',
    schedule: { kind: 'daily', time: '08:00' },
    instructions:
      '1. With the Plaud connector, list my recordings and keep only the ones created since the last run.\n2. For each new one, read its transcript or note.\n3. Write a vault note per recording in Recordings/ named "<date> <title>.md": a short summary, key points, decisions, and action items (who, what, when).\n4. Add action items that are mine to Active Priorities, and dates or deadlines to my schedule only if they are clearly stated.\n5. Report: how many new recordings, one line each, and my action items.',
    hint: 'Needs the Claude account brain with connectors on, and Plaud set to “always allow” in Settings → AI brain.',
  },
  {
    name: 'Morning briefing',
    schedule: { kind: 'weekdays', time: '07:30' },
    instructions: "1. Read today's schedule, Active Priorities, my habits (habit_status) and anything shaky in my learning tracker.\n2. Report in under 120 words: today's appointments, the 3 things to focus on, the habits for today, and one encouraging line.",
  },
  {
    name: 'Evening reflection reminder',
    schedule: { kind: 'daily', time: '21:00' },
    instructions: "1. Look at today's habits (habit_status) and today's daily note.\n2. Report in two or three lines: which habits are still open, one thing that went well today, and an invitation to a short reflection (/reflect) when I'm free.",
  },
  {
    name: 'Weekly review prep',
    schedule: { kind: 'weekly', time: '18:00', days: [0] },
    instructions: "1. Read this week's daily notes, Active Priorities, habit_status and next week's schedule.\n2. Report: the week in five lines (done, slipped, habits against targets) and three questions for my weekly review (/weekly-review).",
  },
];

export function initHabits() {
  $('#habitNew').onclick = () => editHabit();
  $('#routineNew').onclick = () => editRoutine();
  on('habits-changed', refresh);
  api.on('routine:event', (ev) => {
    if (ev.type === 'changed' || ev.type === 'finished') refreshRoutines();
    if (ev.type === 'started') toast(`⏰ ${ev.name}…`);
    if (ev.type === 'finished') toastResult(ev);
    if (ev.type === 'open' && ev.conversationId) openRoutineChat(ev.conversationId);
  });
}

function toastResult(ev) {
  const t = el('div', { class: `toast ${ev.ok ? '' : 'err'}` }, el('b', {}, `${ev.ok ? '⏰' : '⚠'} ${ev.name}`), el('div', {}, (ev.summary || '').slice(0, 220)));
  if (ev.conversationId) t.append(el('div', { class: 'toast-actions' }, el('button', { class: 'btn small', onclick: () => (t.remove(), openRoutineChat(ev.conversationId)) }, 'Open')));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 20000);
}

function openRoutineChat(id) {
  switchView('chat');
  openConversation(id);
}

export async function refresh() {
  await Promise.all([refreshHabits(), refreshRoutines()]);
}

// ----------------------------------------------------------------- habits
async function refreshHabits() {
  const box = $('#habitList');
  let data;
  try {
    data = await api.habits.status();
  } catch (err) {
    box.innerHTML = '';
    box.append(el('p', { class: 'muted' }, `Habits live in your vault (Habits.md). ${err.message}`));
    return;
  }
  box.innerHTML = '';
  const active = data.habits.filter((h) => !h.paused);
  if (!active.length) {
    box.append(el('div', { class: 'habit-empty' }, el('p', {}, 'No habits yet. Add one here, or tell the assistant what you want to build: it helps you make it small and concrete first.')));
  }
  const today = new Date(`${data.today}T12:00:00`);
  for (const h of active) {
    const check = el('button', {
      class: `habit-check ${h.doneToday ? 'done' : ''}`,
      title: h.doneToday ? 'Done today (click to undo)' : 'Mark as done today',
      onclick: async (ev) => {
        const btn = ev.currentTarget;
        if (btn.disabled) return; // a double click must not tick and untick
        btn.disabled = true;
        try {
          await api.habits.log(h.name, !h.doneToday);
          refreshHabits();
        } catch (err) {
          btn.disabled = false;
          toastError(err);
        }
      },
    }, h.doneToday ? '✓' : '');
    const dots = el('div', { class: 'habit-days' }, ...h.last7.map((d, i) => el('i', { class: d ? 'on' : '', title: DAYS[(today.getDay() + 1 + i) % 7] })));
    const streak = h.streak ? `${h.streak} ${h.streakUnit === 'days' ? (h.streak === 1 ? 'day' : 'days') : h.streak === 1 ? 'week' : 'weeks'}` : '—';
    box.append(
      el(
        'div',
        { class: 'habit-row glass' },
        check,
        el('div', { class: 'habit-main' }, el('b', {}, h.name), el('div', { class: 'hint' }, `${h.frequency}${h.target < 7 ? ` · ${h.thisWeek}/${h.target} this week` : ''}${h.note ? ` · ${h.note}` : ''}`)),
        dots,
        el('div', { class: 'habit-streak', title: 'Current streak' }, el('span', {}, '🔥'), streak),
        el('button', { class: 'btn small', title: 'Pause (history stays)', onclick: () => pause(h.name) }, 'Pause'),
      ),
    );
  }
  const paused = data.habits.filter((h) => h.paused);
  if (paused.length) {
    box.append(el('div', { class: 'hint', style: { marginTop: '6px' } }, 'Paused: ', ...paused.map((h) => el('button', { class: 'btn small', title: 'Resume', onclick: () => api.habits.pause(h.name, false).then(refreshHabits, toastError) }, `▶ ${h.name}`))));
  }
}

async function pause(name) {
  if (!(await confirmDialog(`Pause “${name}”?`, 'Its history stays in Habits.md; you can resume it any time.', 'Pause', false))) return;
  api.habits.pause(name, true).then(refreshHabits, toastError);
}

async function editHabit() {
  const name = el('input', { class: 'input', placeholder: 'e.g. Meditate, Run, Read 10 pages' });
  const target = el('select', { class: 'input' }, ...[7, 6, 5, 4, 3, 2, 1].map((n) => el('option', { value: n }, n === 7 ? 'Every day' : `${n}× a week`)));
  const note = el('input', { class: 'input', placeholder: 'The plan: when, where, the tiny version (e.g. after coffee, 2 minutes)' });
  const ok = await modal((card, close) => {
    card.append(
      el('h3', {}, 'New habit'),
      el('div', { class: 'field' }, el('label', {}, 'Habit'), name),
      el('div', { class: 'field' }, el('label', {}, 'How often'), target),
      el('div', { class: 'field' }, el('label', {}, 'Plan (optional)'), note),
      el('p', { class: 'hint' }, 'Start smaller than you think: a habit that takes two minutes and follows something you already do sticks.'),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'), el('button', { class: 'btn primary', onclick: () => close(true) }, 'Add')),
    );
    setTimeout(() => name.focus(), 30);
  });
  if (!ok || !name.value.trim()) return;
  try {
    await api.habits.add({ name: name.value.trim(), target: Number(target.value), note: note.value.trim() });
    refreshHabits();
  } catch (err) {
    toastError(err);
  }
}

// --------------------------------------------------------------- routines
async function refreshRoutines() {
  const box = $('#routineList');
  if (!box) return;
  const list = await api.routines.list().catch(() => []);
  box.innerHTML = '';
  if (!list.length) {
    box.append(
      el('div', { class: 'habit-empty' }, el('p', {}, 'Routines are things the assistant does on a schedule, on its own: check new recordings every morning, prepare your weekly review… Start from one of these, or tell the assistant “every morning at 8, …”.'), el('div', { class: 'row', style: { flexWrap: 'wrap' } }, ...ROUTINE_TEMPLATES.map((t) => el('button', { class: 'btn', onclick: () => editRoutine(t, { isNew: true }) }, `＋ ${t.name}`)))),
    );
    return;
  }
  for (const r of list) {
    const toggle = el('input', { type: 'checkbox', checked: r.enabled });
    toggle.addEventListener('change', () => api.routines.setEnabled(r.id, toggle.checked).then(refreshRoutines, toastError));
    const last = r.lastRun ? `last ${new Date(r.lastRun).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}${r.lastStatus === 'error' ? ' ⚠' : r.lastStatus === 'skipped' ? ' (skipped)' : ''}` : 'not run yet';
    const next = r.enabled && r.nextRun ? `next ${new Date(r.nextRun).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'paused';
    box.append(
      el(
        'div',
        { class: 'routine-row glass' },
        el('label', { class: 'toggle', title: 'On / off' }, toggle, el('span', { class: 'sw' })),
        el('div', { class: 'habit-main' }, el('b', {}, r.name), el('div', { class: 'hint' }, `${r.when} · ${next} · ${last}`), r.lastSummary ? el('div', { class: 'routine-summary' }, r.lastSummary) : ''),
        el('button', { class: 'btn small', title: 'Run it now', onclick: () => api.routines.run(r.id).then(refreshRoutines, toastError) }, '▶ Run'),
        r.conversationId ? el('button', { class: 'btn small', title: 'Its conversation', onclick: () => openRoutineChat(r.conversationId) }, 'Open') : '',
        el('button', { class: 'btn small', onclick: () => editRoutine(r) }, 'Edit'),
        el('button', {
          class: 'btn small danger',
          onclick: async () => {
            if (!(await confirmDialog(`Delete “${r.name}”?`, 'It stops running. Its past conversation stays in your chat history.', 'Delete'))) return;
            api.routines.remove(r.id).then(refreshRoutines, toastError);
          },
        }, '✕'),
      ),
    );
  }
  box.append(el('div', { class: 'row', style: { flexWrap: 'wrap', marginTop: '6px' } }, el('span', { class: 'hint' }, 'Templates:'), ...ROUTINE_TEMPLATES.filter((t) => !list.some((r) => r.name === t.name)).map((t) => el('button', { class: 'btn small', onclick: () => editRoutine(t, { isNew: true }) }, `＋ ${t.name}`))));
}

async function editRoutine(r = null, { isNew = !r?.id } = {}) {
  const s = r?.schedule || { kind: 'daily', time: '08:00' };
  const name = el('input', { class: 'input', value: r?.name || '', placeholder: 'e.g. Check new Plaud recordings' });
  const kind = el('select', { class: 'input' }, ...[['daily', 'Every day'], ['weekdays', 'Weekdays (Mon–Fri)'], ['weekly', 'On chosen days'], ['interval', 'Every few hours']].map(([v, l]) => el('option', { value: v, selected: v === s.kind }, l)));
  const time = el('input', { class: 'input', type: 'time', value: s.time || '08:00' });
  const hours = el('input', { class: 'input', type: 'number', min: 1, max: 168, value: s.hours || 3 });
  const days = el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, ...[1, 2, 3, 4, 5, 6, 0].map((d) => el('label', { class: 'day-pick' }, el('input', { type: 'checkbox', value: d, checked: (s.days || []).includes(d) }), DAYS[d])));
  const instructions = el('textarea', { class: 'input', rows: 8, placeholder: 'What the assistant does on each run, step by step, and what it reports.' });
  instructions.value = r?.instructions || '';
  const timeField = el('div', { class: 'field' }, el('label', {}, 'Time'), time);
  const hoursField = el('div', { class: 'field' }, el('label', {}, 'Every … hours'), hours);
  const daysField = el('div', { class: 'field' }, el('label', {}, 'Days'), days);
  const sync = () => {
    timeField.style.display = kind.value === 'interval' ? 'none' : '';
    hoursField.style.display = kind.value === 'interval' ? '' : 'none';
    daysField.style.display = kind.value === 'weekly' ? '' : 'none';
  };
  kind.addEventListener('change', sync);
  sync();
  const ok = await modal((card, close) => {
    card.classList.add('wide');
    card.append(
      el('h3', {}, isNew ? 'New routine' : 'Edit routine'),
      el('div', { class: 'field' }, el('label', {}, 'Name'), name),
      el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', {}, 'When'), kind), timeField, hoursField),
      daysField,
      el('div', { class: 'field' }, el('label', {}, 'Instructions'), instructions),
      r?.hint ? el('p', { class: 'hint' }, r.hint) : '',
      el('p', { class: 'hint' }, 'Each run is a conversation of its own, and you get a notification with the result. If the app was closed at the time, it runs once when you open it (same day).'),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'), el('button', { class: 'btn primary', onclick: () => close(true) }, 'Save')),
    );
  });
  if (!ok) return;
  const schedule = { kind: kind.value };
  if (kind.value === 'interval') schedule.hours = Number(hours.value);
  else schedule.time = time.value;
  if (kind.value === 'weekly') schedule.days = [...days.querySelectorAll('input:checked')].map((i) => Number(i.value));
  try {
    await api.routines.save({ ...(isNew ? {} : { id: r.id }), name: name.value, schedule, instructions: instructions.value });
    toast('Routine saved');
    refreshRoutines();
  } catch (err) {
    toastError(err);
  }
}
