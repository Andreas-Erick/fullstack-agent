// Routines, in the Skills view: things the assistant does on a schedule, on its own (main/routines.js),
// each run its own conversation with a notification. (They lived beside the habits until those went.)
import { $, api, el, toast, toastError, modal, confirmDialog } from './util.js';
import { switchView } from './nav.js';
import { openConversation } from './chat.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Ready-made routines; the Plaud one needs the Plaud connector (Settings → AI brain → connectors).
export const ROUTINE_TEMPLATES = [
  {
    name: 'Check new Plaud recordings',
    schedule: { kind: 'daily', time: '08:00' },
    instructions:
      '1. With the Plaud connector, list my recordings and keep only the ones created since the last run.\n2. For each new one, read Plaud’s own note for it (get_note) and its transcript.\n3. Save it as one of my notes: vault_write_note to Notes/Recordings/"<date> <title>.md" (the Recordings notebook in the Notes view). Put Plaud’s note in it as Plaud wrote it, then a "## Action items" section (who, what, when) and the tags #plaud #recording. If Plaud has no note for it, write a short summary, key points and decisions from the transcript instead.\n4. Add action items that are mine to Active Priorities, and dates or deadlines to my schedule only if they are clearly stated.\n5. Report: how many new recordings, one line each, and my action items.',
    hint: 'Needs the Claude account brain with connectors on, and Plaud set to “always allow” in Settings → AI brain.',
  },
  {
    name: 'Morning briefing',
    schedule: { kind: 'weekdays', time: '07:30' },
    instructions: "1. Read today's schedule, Active Priorities and anything shaky in my learning tracker.\n2. Report in under 120 words: today's appointments, the 3 things to focus on, and one encouraging line.",
  },
  {
    name: 'Inbox tidy-up',
    schedule: { kind: 'weekly', time: '18:00', days: [5] },
    instructions: "1. Read the notes in my Inbox/ (quick captures).\n2. Report: each one in a line, with where it could go (a notebook in Notes/, a to-do, my schedule) and which ones look done. Don't move or change anything; I decide.",
  },
  {
    name: 'Weekly review prep',
    schedule: { kind: 'weekly', time: '18:00', days: [0] },
    instructions: "1. Read this week's daily notes, the notes I wrote this week (Notes/ and Inbox/), Active Priorities and next week's schedule.\n2. Report: the week in five lines (done, slipped, ideas I wrote down) and three questions for my weekly review (/weekly-review).",
  },
];

export function initRoutines() {
  $('#routineNew').onclick = () => editRoutine();
  api.on('routine:event', (ev) => {
    if (ev.type === 'changed' || ev.type === 'finished') refresh();
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
  const box = $('#routineList');
  if (!box) return;
  const list = await api.routines.list().catch(() => []);
  box.innerHTML = '';
  if (!list.length) {
    box.append(
      el('div', { class: 'routine-empty' }, el('p', {}, 'Routines are things the assistant does on a schedule, on its own: check new recordings every morning, prepare your weekly review… Start from one of these, or tell the assistant “every morning at 8, …”.'), el('div', { class: 'row', style: { flexWrap: 'wrap' } }, ...ROUTINE_TEMPLATES.map((t) => el('button', { class: 'btn', onclick: () => editRoutine(t, { isNew: true }) }, `＋ ${t.name}`)))),
    );
    return;
  }
  for (const r of list) {
    const toggle = el('input', { type: 'checkbox', checked: r.enabled, 'aria-label': `${r.name} on or off` });
    toggle.addEventListener('change', () => api.routines.setEnabled(r.id, toggle.checked).then(refresh, toastError));
    const last = r.lastRun ? `last ${new Date(r.lastRun).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}${r.lastStatus === 'error' ? ' ⚠' : r.lastStatus === 'skipped' ? ' (skipped)' : r.lastStatus === 'waiting' ? ' (waiting for the brain, tries again soon)' : ''}` : 'not run yet';
    const next = r.enabled && r.nextRun ? `next ${new Date(r.nextRun).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'paused';
    box.append(
      el(
        'div',
        { class: 'routine-row glass' },
        el('label', { class: 'toggle', title: 'On / off' }, toggle, el('span', { class: 'sw' })),
        el('div', { class: 'routine-main' }, el('b', {}, r.name), el('div', { class: 'hint' }, `${r.when} · ${next} · ${last}`), r.lastSummary ? el('div', { class: 'routine-summary' }, r.lastSummary) : ''),
        el('button', { class: 'btn small', title: 'Run it now', onclick: () => api.routines.run(r.id).then(refresh, toastError) }, '▶ Run'),
        r.conversationId ? el('button', { class: 'btn small', title: 'Its conversation', onclick: () => openRoutineChat(r.conversationId) }, 'Open') : '',
        el('button', { class: 'btn small', onclick: () => editRoutine(r) }, 'Edit'),
        el('button', {
          class: 'btn small danger',
          'aria-label': `Delete ${r.name}`,
          onclick: async () => {
            if (!(await confirmDialog(`Delete “${r.name}”?`, 'It stops running. Its past conversation stays in your chat history.', 'Delete'))) return;
            api.routines.remove(r.id).then(refresh, toastError);
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
  const field = (label, control) => {
    control.id ||= `routine-${label.toLowerCase().replace(/\W+/g, '-')}`;
    return el('div', { class: 'field' }, el('label', { for: control.id }, label), control);
  };
  const timeField = field('Time', time);
  const hoursField = field('Every … hours', hours);
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
      field('Name', name),
      el('div', { class: 'grid2' }, field('When', kind), timeField, hoursField),
      daysField,
      field('Instructions', instructions),
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
    refresh();
  } catch (err) {
    toastError(err);
  }
}
