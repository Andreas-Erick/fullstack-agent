// Empty views offer a first step (spec #17, ONB-11): one sentence and one action, the pattern Notes, Memories
// and Skills already use. Calendar, Documents, Library and "Changes Siren made to itself" draw theirs with
// firstStep(); the notes-library-off case (Calendar and Library) gets its action from libraryAction(), which
// turns the library on or picks its folder right here instead of sending the user to Settings.
import { $, api, el, emit, toastError, plainError } from './util.js';
import { switchView } from './nav.js';
import { saveSettings } from './state.js';

/**
 * The empty state: a heading, one sentence, one action button and, optionally, something to say to the
 * assistant instead (`ask`: { label, text }, prefilled in the message box, never sent).
 */
export function firstStep({ title, text, action = null, ask = null, cls = '', glass = false }) {
  return el(
    'div',
    { class: ['first-step', glass && 'glass', cls].filter(Boolean).join(' ') },
    el('h3', { class: 'display' }, title),
    el('p', { class: 'muted' }, text),
    action || ask ? el('div', { class: 'first-step-acts' }, action, ask ? el('span', { class: 'muted' }, action ? 'or ask:' : 'Ask:') : null, ask ? el('button', { type: 'button', class: 'chip-btn', onclick: () => prefillChat(ask.text) }, ask.label) : null) : null,
  );
}

/** Puts `text` in the chat's message box (the user reads it, finishes it and sends it). */
export function prefillChat(text) {
  switchView('chat');
  const input = $('#input');
  input.value = text;
  input.dispatchEvent(new Event('input')); // the box grows and the send button wakes, as when typed
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/**
 * The one action for a notes library that is off (`status` from obsidian:status): turned off → turn it on;
 * on but its folder is gone → choose a folder. `done` runs after a change was saved (the view refreshes).
 */
export function libraryAction(status, done) {
  const off = status?.enabled === false;
  const btn = el('button', { type: 'button', class: 'btn primary' }, off ? 'Turn on the notes library' : '📁 Choose a folder…');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      if (off) await saveSettings({ obsidian: { enabled: true } });
      else {
        const dir = await api.dialog.pickFolder('Folder for the notes library');
        if (!dir) return;
        await saveSettings({ obsidian: { enabled: true, vaultPath: dir } });
      }
      emit('status-refresh');
      await done?.();
    } catch (err) {
      toastError(plainError(err));
    } finally {
      btn.disabled = false;
    }
  };
  return btn;
}

/** The sentence for a notes library that is off, by why. */
export function libraryOffText(status, what) {
  return status?.enabled === false
    ? `The notes library is turned off. The assistant keeps ${what} as plain files in a folder on this PC; turn it on to use them here.`
    : `The notes library’s folder can’t be found (moved, renamed or on a drive that isn’t connected). Choose the folder to use ${what} here.`;
}
