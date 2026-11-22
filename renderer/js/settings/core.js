// The Settings view's shared state: saving (with the persona the cards were drawn for), the waiting saves
// and the redraw. Every card module imports these from here, so there is one copy of each.
import { $, api, toast, toastError } from '../util.js';
import { state, savePersonaSettings, loadSettings } from '../state.js';
import { stale, staleNow, createSaves } from '../settingsave.js';

// Redraws every card (index.js render, registered there): cards call it without importing index.js.
let renderer = null;
export const setRenderer = (fn) => (renderer = fn);
export const render = (opts) => renderer?.(opts);

export const get = (p) => p.split('.').reduce((o, k) => o?.[k], state.settings);
function patchFor(p, value) {
  const [section, key] = p.split('.');
  return { [section]: { [key]: value } };
}

let savedTimer;
export let renderedPersona = null; // the persona the cards on screen were drawn for (render)
export const setRenderedPersona = (persona) => (renderedPersona = persona);

export const PERSONA_CHANGED = 'Not saved: the persona changed meanwhile.';

// A change made in cards drawn for one persona never lands in another (switched in the title bar, by the
// agent, on the phone or the watch, or by a routine while Settings was open). Main decides inside its save
// queue (settings:set { persona } → persona.saveFor) and answers whether it saved; when it didn't, the
// settings that came back have the other persona active, and the studio redraws for it. Whether it saved.
export async function saveForPersona(patch, persona = renderedPersona) {
  const r = await savePersonaSettings(patch, persona);
  if (!r.dropped) return true;
  toast(PERSONA_CHANGED, 'error');
  return false;
}

// Before a model call made for the persona on screen (Generate look & feel, Draw the scene): whether that
// persona is no longer active, so the call would be wasted. This window's copy lags a switch made on the
// phone, the watch or by a routine, so main is asked too; a switch only main knew of reloads the settings.
export async function switchedAway(path, persona = renderedPersona) {
  const active = state.settings.personas?.active;
  if (!(await staleNow(path, persona, active, async () => (await api.settings.get())?.personas?.active))) return false;
  toast(PERSONA_CHANGED, 'error');
  if (!stale(path, persona, active)) loadSettings().catch(() => {});
  return true;
}

// Saves one setting for the persona whose cards it was typed into (main ignores the persona for a setting
// no persona keeps); whether it was saved (switches and selects flip back when it wasn't).
export async function save(p, value, persona = renderedPersona) {
  try {
    if (!(await saveForPersona(patchFor(p, value), persona))) return false;
    const s = $('#saveState');
    if (s) {
      s.classList.add('show');
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => s.classList.remove('show'), 1400);
    }
    return true;
  } catch (err) {
    toastError(err);
    return false;
  }
}
const saves = createSaves({ save });
export const queueSave = (p, value) => saves.queue(p, value, renderedPersona);
export const flushSaves = () => saves.flushAll();
