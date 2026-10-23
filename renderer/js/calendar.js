// Calendar view: a 7-day board of Google Calendar events (read-only).
import { $, api, el, toastError, modal, renderMarkdown } from './util.js';
import { switchView } from './nav.js';

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
  if (!status.signedIn) {
    body.innerHTML = '';
    body.append(
      el(
        'div',
        { class: 'cal-empty glass' },
        el('h3', { class: 'display' }, 'Connect Google Calendar'),
        el('p', { class: 'muted' }, 'Read-only access. Your events are shown here and injected into the agent’s context.'),
        el(
          'ol',
          {},
          el('li', {}, 'In Google Cloud Console, enable the Google Calendar API.'),
          el('li', {}, 'Create OAuth credentials of type “Desktop app”.'),
          el('li', {}, 'Paste the Client ID and Client Secret in Configuration → Google Calendar.'),
          el('li', {}, 'Click “Sign in with Google”.'),
        ),
        el('button', { class: 'btn primary', onclick: () => switchView('settings', 'calendar') }, 'Open calendar settings'),
      ),
    );
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
