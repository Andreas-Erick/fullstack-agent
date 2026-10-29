// "Report a problem" (privacy.reportIssues, opt-in): a new error in the log is offered once as an
// anonymized GitHub issue. The user sees the exact text first; "Open on GitHub" opens it in the
// browser for them to submit. Nothing is sent by the app (main/issues.js, main/issuecore.js).
import { api, el, modal, toastActions, toastError } from './util.js';
import { state } from './state.js';

const FIRST_LOOK_MS = 90000; // after the start settles (the check after a self-change runs first)
const EVERY_MS = 30 * 60000;
let offering = false;

export function initIssues() {
  setTimeout(check, FIRST_LOOK_MS);
  setInterval(check, EVERY_MS);
}

async function check() {
  if (offering || !state.settings?.privacy?.reportIssues || document.hidden) return;
  const list = await api.issues.pending().catch(() => []);
  if (!list.length) return;
  offering = true;
  toastActions(
    list.length === 1 ? 'Something went wrong in Siren. Want to report it (anonymized) so it gets fixed?' : `${list.length} problems came up in Siren. Want to report them (anonymized) so they get fixed?`,
    [['Review', () => review(list)]],
  );
  setTimeout(() => (offering = false), 30000);
}

/** Shows each report exactly as it would be posted; the user opens it on GitHub or skips it. */
export async function review(list) {
  for (const r of list) {
    const choice = await modal((card, close) => {
      card.classList.add('wide');
      card.append(
        el('h3', { class: 'display' }, 'Report a problem'),
        el('p', { class: 'muted' }, 'This is everything the report contains. Your conversations, notes, names, folders and keys are not in it. "Open on GitHub" opens it in your browser, where you can still change it before you submit (a GitHub account is needed).'),
        el('div', { class: 'field' }, el('label', {}, 'Title'), el('div', { class: 'input', style: { whiteSpace: 'pre-wrap' } }, r.title)),
        el('div', { class: 'field' }, el('label', {}, 'Text'), el('pre', { class: 'log-box', style: { maxHeight: '320px', overflow: 'auto', whiteSpace: 'pre-wrap' } }, r.body)),
        el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => close('open') }, 'Open on GitHub'), el('button', { class: 'btn', onclick: () => close('skip') }, 'Don’t report this'), el('button', { class: 'btn', onclick: () => close('later') }, 'Later')),
      );
    });
    try {
      if (choice === 'open') await api.issues.open(r.key);
      else if (choice === 'skip') await api.issues.dismiss(r.key);
      else return; // later: offered again next time
    } catch (err) {
      toastError(err);
    }
  }
}
