// New versions (main/updates.js): the title-bar pill "Update 2.1.0" while a newer release is out and not
// skipped; a click shows what's new, with the download (opens in the browser), Skip and Later.
import { $, api, el, modal, toast, toastError, renderMarkdown } from './util.js';

let current = null;

export function initUpdates() {
  $('#pillUpdate').addEventListener('click', () => current?.available && showUpdate(current));
  api.on('updates:state', (st) => {
    const fresh = st.available && !st.skipped && current?.version !== st.version;
    render(st);
    if (fresh) toast(`✨ Siren ${st.version} is available. Click “Update” in the title bar.`);
  });
  api.updates.status().then(render).catch(() => {});
}

function render(st) {
  current = st;
  const pill = $('#pillUpdate');
  const show = Boolean(st?.available && !st.skipped);
  pill.classList.toggle('hidden', !show);
  if (!show) return;
  pill.querySelector('span').textContent = `Update ${st.version}`;
  pill.title = `Siren ${st.version} is available (you have ${st.current}). Click for what’s new.`;
}

export function showUpdate(st) {
  return modal((card, close) => {
    card.classList.add('wide');
    const open = (url) => api.updates.open(url).then(() => close(true), toastError);
    card.append(
      el('h3', { class: 'display' }, `Siren ${st.version}`),
      el('p', { class: 'muted' }, `You have ${st.current}.${st.publishedAt ? ` Released ${new Date(st.publishedAt).toLocaleDateString()}.` : ''} The download opens in your browser; install it over this version and your settings, conversations and vault stay as they are.`),
      st.notes ? el('div', { class: 'update-notes', html: renderMarkdown(st.notes) }) : '',
      el(
        'div',
        { class: 'row', style: { justifyContent: 'flex-end', marginTop: '14px', flexWrap: 'wrap' } },
        el('button', { class: 'btn', onclick: () => close(null) }, 'Later'),
        el('button', { class: 'btn', onclick: () => api.updates.skip(st.version).then((s) => (render(s), close(false)), toastError) }, 'Skip this version'),
        st.page ? el('button', { class: 'btn', onclick: () => open(st.page) }, 'Release page') : '',
        st.desktop ? el('button', { class: 'btn primary', onclick: () => open(st.desktop) }, '⬇ Download') : '',
      ),
    );
  });
}

/** Settings → Data: "Check for updates now". */
export async function checkNow(out) {
  out.textContent = 'Checking…';
  try {
    const st = await api.updates.check();
    render(st);
    out.textContent = st.error ? `✕ ${st.error}` : st.available ? `✨ Siren ${st.version} is available.` : `✓ You have the newest version (${st.current}).`;
    if (st.available) showUpdate(st);
  } catch (err) {
    out.textContent = `✕ ${err.message}`;
  }
}
