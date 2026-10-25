// Persona switching from the UI (title-bar switcher, Persona studio). The list and the switch itself
// live in the main process (main/persona.js, main/personacore.js); each call returns the new settings.
import { api, emit, toast, toastError } from './util.js';
import { state } from './state.js';
import { speaker } from './voice.js';

function took(settings, { greet = false } = {}) {
  state.settings = settings;
  emit('settings', settings);
  const name = settings.agent.name || 'Nexus';
  toast(`🎭 ${name}`);
  // The new persona says hello in its own voice.
  if (greet && settings.voice.ttsEnabled && settings.voice.autoSpeak) speaker.say(settings.appearance.greeting || `Hi, ${name} here.`);
  return settings;
}

export async function switchPersona(id) {
  if (!id || id === state.settings.personas?.active) return state.settings;
  try {
    return took(await api.persona.switch(id), { greet: true });
  } catch (err) {
    toastError(err);
    return state.settings;
  }
}

export async function createPersona({ copy = false, name = '', template = null } = {}) {
  try {
    return took(await api.persona.create({ copy, name, template }), { greet: Boolean(template) });
  } catch (err) {
    toastError(err);
    return state.settings;
  }
}

export async function removePersona(id) {
  try {
    return took(await api.persona.remove(id));
  } catch (err) {
    toastError(err);
    return state.settings;
  }
}
