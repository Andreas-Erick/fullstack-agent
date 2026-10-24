// Calendar view: a 7-day board of Google Calendar events. The agent adds and changes events; the
// board refreshes when it does.
import { $, api, el, toastError, modal, renderMarkdown, on, emit } from './util.js';
import { switchView } from './nav.js';
import { saveSettings } from './state.js';

let weekStart = startOfDay(new Date());

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function initCalendar() {
  $('#calPrev').onclick = () => shift(-7);
  $('#calNext').onclick = () => shift(7);
  $('#calToday').onclick = () => {
    weekStart = startOfDay(new Date());
    refresh();
  };
  $('#calRefresh').onclick = refresh;
  on('calendar-changed', refresh);
}

function shift(days) {
  weekStart = new Date(weekStart.getTime() + days * 86400000);
  refresh();
}

export async function refresh() {
  const body = $('#calBody');
  const end = new Date(weekStart.getTime() + 7 * 86400000);
  $('#calRange').textContent = `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${new Date(end - 1).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const status = await api.calendar.status().catch(() => ({}));
  if (!status.connected) {
    body.innerHTML = '';
    body.append(connectPanel());
    return;
  }
  body.innerHTML = '<p class="muted">Loading events…</p>';
  try {
    const events = await api.calendar.events({ start: weekStart.toISOString(), end: end.toISOString() });
    body.innerHTML = '';
    const grid = el('div', { class: 'cal-days' });
    const todayKey = startOfDay(new Date()).getTime();
    for (let i = 0; i < 7; i++) {
      const day = new Date(weekStart.getTime() + i * 86400000);
      const next = day.getTime() + 86400000;
      const dayEvents = events.filter((e) => {
        const s = new Date(e.start).getTime();
        const en = new Date(e.end).getTime();
        return e.allDay ? s < next && en > day.getTime() : s >= day.getTime() && s < next;
      });
      const col = el(
        'div',
        { class: `cal-day glass ${day.getTime() === todayKey ? 'today' : ''}` },
        el('h4', {}, day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })),
      );
      if (!dayEvents.length) col.append(el('div', { class: 'muted', style: { fontSize: '12px' } }, 'Free'));
      for (const e of dayEvents) {
        const time = e.allDay ? 'All day' : `${new Date(e.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${new Date(e.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        col.append(el('div', { class: 'cal-ev', style: { borderLeftColor: e.color }, onclick: () => details(e, time) }, el('div', { class: 'tm' }, time), el('div', {}, e.title)));
      }
      grid.append(col);
    }
    body.append(grid);
  } catch (err) {
    body.innerHTML = '';
    body.append(el('p', { class: 'muted' }, err.message));
    toastError(err);
  }
}

// Not connected yet: the quick way (paste an iCal link, read-only) right here, or Google sign-in
// (read and write) in the settings.
function connectPanel() {
  const input = el('input', { class: 'input', placeholder: 'Paste the iCal link (https://… or webcal://…)', spellcheck: 'false' });
  const out = el('div', { class: 'test-result hidden' });
  const connect = el('button', {
    class: 'btn primary',
    onclick: async () => {
      const url = input.value.trim();
      if (!url) return input.focus();
      out.className = 'test-result';
      out.textContent = 'Checking the link…';
      try {
        const r = await api.calendar.testFeed(url);
        await saveSettings({ calendar: { icsUrls: url, enabled: true } });
        out.className = 'test-result ok';
        out.textContent = `✓ Connected “${r.name}” (${r.events} events)`;
        emit('status-refresh');
        setTimeout(refresh, 600);
      } catch (err) {
        out.className = 'test-result err';
        out.textContent = `✕ ${err.message}`;
      }
    },
  }, 'Connect');
  input.addEventListener('keydown', (e) => e.key === 'Enter' && connect.click());
  return el(
    'div',
    { class: 'cal-connect' },
    el(
      'section',
      { class: 'card glass' },
      el('h3', {}, el('span', { class: 'dot' }), 'Quick connect', el('span', { class: 'badge' }, '1 MINUTE')),
      el('p', { class: 'desc' }, 'Read-only: your events show here and in the agent’s context. No sign-in.'),
      el(
        'ol',
        {},
        el('li', {}, el('b', {}, 'Google: '), 'calendar.google.com → ⚙ Settings → your calendar → “Secret address in iCal format” → copy.'),
        el('li', {}, el('b', {}, 'Outlook: '), 'Settings → Calendar → Shared calendars → Publish a calendar → copy the ICS link.'),
        el('li', {}, el('b', {}, 'iCloud: '), 'Calendar → share the calendar → Public Calendar → copy the link.'),
      ),
      el('div', { class: 'row' }, input, connect),
      out,
    ),
    el(
      'section',
      { class: 'card glass' },
      el('h3', {}, el('span', { class: 'dot' }), 'Google sign-in'),
      el('p', { class: 'desc' }, 'Read and write: the agent can also add, move and delete events (it asks first, and always before anything that emails other people).'),
      el('ol', {}, el('li', {}, 'Create a free Google Cloud project and turn on the Calendar API.'), el('li', {}, 'Create a “Desktop app” OAuth client and download its JSON file.'), el('li', {}, 'Import the file and sign in. The settings walk you through it with direct links.')),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => switchView('settings', 'calendar') }, 'Set up Google sign-in')),
    ),
  );
}

function details(e, time) {
  modal((card, close) => {
    card.append(
      el('h3', {}, e.title),
      el('div', { class: 'muted' }, `${new Date(e.start).toLocaleDateString(undefined, { dateStyle: 'full' })} · ${time}`),
      e.location ? el('div', {}, `📍 ${e.location}`) : '',
      el('div', { class: 'muted' }, `Calendar: ${e.calendar}`),
      e.description ? el('div', { class: 'bubble', html: renderMarkdown(e.description) }) : '',
      el(
        'div',
        { class: 'modal-actions' },
        e.meet ? el('button', { class: 'btn', onclick: () => api.shell.openExternal(e.meet) }, 'Join meeting') : '',
        e.link ? el('button', { class: 'btn', onclick: () => api.shell.openExternal(e.link) }, 'Open in Google Calendar') : '',
        el('button', { class: 'btn primary', onclick: () => close() }, 'Close'),
      ),
    );
  });
}
