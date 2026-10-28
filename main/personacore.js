// Personas: the user's saved agents, each with its own master prompt, image, look (theme + face),
// greeting and voice. The live settings (agent.*, appearance.*, ui.face, voice.voice/localVoice) are
// always the active persona: everything else in the app keeps reading them. This module keeps the
// saved list in step with them and builds the settings patch for a switch. Pure (no Electron, no I/O).

// [settings section, settings key, persona field]
const FIELDS = [
  ['agent', 'name', 'name'],
  ['agent', 'personality', 'personality'],
  ['agent', 'aesthetic', 'aesthetic'],
  ['agent', 'avatar', 'avatar'],
  ['appearance', 'theme', 'theme'],
  ['appearance', 'personaNotes', 'personaNotes'],
  ['appearance', 'greeting', 'greeting'],
  ['appearance', 'scene', 'scene'],
  ['ui', 'face', 'face'],
  ['voice', 'voice', 'voice'],
  ['voice', 'localVoice', 'localVoice'],
];
const MAX_PERSONAS = 24;
const FIRST_ID = 'p-main'; // the persona an install already had before personas existed

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** The active persona as it is in the live settings. */
function snapshot(settings) {
  const out = {};
  for (const [section, key, field] of FIELDS) out[field] = clone(settings[section]?.[key]) ?? null;
  return out;
}

/** The settings patch that makes `persona` live; fields it lacks come from `defaults` (store DEFAULTS). */
function patchFor(persona, defaults) {
  const patch = {};
  for (const [section, key, field] of FIELDS) {
    const v = persona[field] ?? defaults[section]?.[key] ?? null;
    (patch[section] ||= {})[key] = whole(field, clone(v));
  }
  return patch;
}

// The store merges a patch key by key, so a persona that lacks a key would keep the previous persona's
// (a scene drawn before tall drawings existed kept the last persona's tall one behind the new face).
// The keys a switch must always set are named here, empty when the persona has none.
function whole(field, v) {
  if (!v || typeof v !== 'object') return v;
  if (field === 'scene') return { svg: '', portrait: '', caption: '', ...v };
  if (field === 'theme') return { ...v, face: { states: null, ...(v.face || {}) } };
  return v;
}

/** settings.personas, valid: never empty (the live settings become the first persona), active in the list. */
function ensure(settings) {
  const p = settings.personas || {};
  let list = Array.isArray(p.list) ? p.list.filter((x) => x && typeof x.id === 'string') : [];
  if (!list.length) list = [{ id: FIRST_ID, ...snapshot(settings) }];
  const active = list.some((x) => x.id === p.active) ? p.active : list[0].id;
  return { active, list };
}

/** settings.personas with the active entry updated from the live settings. */
function sync(settings) {
  const p = ensure(settings);
  return { active: p.active, list: p.list.map((x) => (x.id === p.active ? { id: x.id, ...snapshot(settings) } : x)) };
}

/** A persona by id, or by name (case and spacing don't matter). */
function find(personas, query) {
  const q = String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return null;
  return personas.list.find((x) => x.id === query) || personas.list.find((x) => String(x.name || '').trim().toLowerCase().replace(/\s+/g, ' ') === q) || null;
}

/**
 * A new persona: a copy of the active one (copy) or a fresh one from the defaults that keeps the
 * current voice. Returns { personas, persona }; the caller switches to it.
 */
function create(settings, { name, copy = false, template = null } = {}, { newId, defaults }) {
  const p = sync(settings);
  if (p.list.length >= MAX_PERSONAS) throw new Error(`You can keep up to ${MAX_PERSONAS} personas. Delete one first.`);
  // A template (personatemplates.js) fills in prompt, look, face and greeting; the voice stays the current one.
  const base = { ...snapshot(copy ? settings : { agent: defaults.agent, appearance: defaults.appearance, ui: defaults.ui, voice: settings.voice }), ...(template || {}) };
  const wanted = String(name || '').trim().slice(0, 40) || (template?.name ? template.name : copy ? `${base.name || 'Persona'} (copy)` : 'New persona');
  const persona = { ...base, id: newId('p-'), name: uniqueName(p.list, wanted) };
  return { personas: { active: p.active, list: [...p.list, persona] }, persona };
}

function uniqueName(list, name) {
  const taken = new Set(list.map((x) => String(x.name || '').toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

/** The list without `id`; the last persona can't be removed. Returns { personas, next } (next = the one to switch to if `id` was active). */
function remove(personas, id) {
  if (!personas.list.some((x) => x.id === id)) throw new Error('No such persona.');
  if (personas.list.length < 2) throw new Error('This is your only persona. Create another one before deleting it.');
  const list = personas.list.filter((x) => x.id !== id);
  const next = personas.active === id ? list[0] : null;
  return { personas: { active: next ? next.id : personas.active, list }, next };
}

/** What the agent and the UI list: no images, no full prompts. */
function summary(personas) {
  return personas.list.map((x) => ({
    id: x.id,
    name: x.name || 'Unnamed',
    active: x.id === personas.active,
    aesthetic: String(x.aesthetic || '').slice(0, 160),
    persona: String(x.personality || '').replace(/\s+/g, ' ').slice(0, 160),
    theme: x.theme?.name || 'default',
    face: x.face || 'circuit',
    hasImage: Boolean(x.avatar),
  }));
}

module.exports = { FIELDS, FIRST_ID, MAX_PERSONAS, snapshot, patchFor, ensure, sync, find, create, remove, summary };
