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
  ['agent', 'personaSummary', 'personaSummary'],
  ['appearance', 'theme', 'theme'],
  ['appearance', 'personaNotes', 'personaNotes'],
  ['appearance', 'greeting', 'greeting'],
  ['appearance', 'scene', 'scene'],
  ['ui', 'face', 'face'],
  ['voice', 'voice', 'voice'],
  ['voice', 'localVoice', 'localVoice'],
];
const REPLACE = FIELDS.map(([section, key]) => [section, key]);
const MAX_PERSONAS = 24;
const FIRST_ID = 'p-main'; // the persona an install already had before personas existed

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** The active persona as it is in the live settings. */
function snapshot(settings) {
  const out = {};
  for (const [section, key, field] of FIELDS) out[field] = clone(settings[section]?.[key]) ?? null;
  return out;
}

/** The settings patch that makes `persona` live; fields it lacks come from `defaults` (store DEFAULTS). Save it with store.setSettings(patch, { replace: REPLACE }), so each field is set whole. */
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

/**
 * A tall scene drawing belongs with the wide one it was drawn for. Versions 2.6.0–2.6.3 could carry
 * the previous persona's tall drawing across a switch and save it into the next persona (switching to
 * the Ringmaster showed the Siren's cove behind him); this drops such a copy: when two personas hold
 * the same tall drawing over different wide ones, it stays with its owner (the one whose wide drawing
 * is the app's own default, else the first) and goes from the others.
 */
function repairScenes(list, defaultScene) {
  const keeper = new Map(); // tall drawing → the persona it stays with
  for (const x of list) {
    const sc = x.scene;
    if (!sc?.portrait) continue;
    const k = keeper.get(sc.portrait);
    if (!k || (defaultScene && sc.svg === defaultScene.svg)) keeper.set(sc.portrait, x);
  }
  return list.map((x) => {
    const sc = x.scene;
    if (!sc?.portrait) return x;
    const k = keeper.get(sc.portrait);
    return k === x || k.scene.svg === sc.svg ? x : { ...x, scene: { ...sc, portrait: '' } };
  });
}

/** settings.personas, valid: never empty (the live settings become the first persona), active in the list. */
function ensure(settings, { defaultScene = null } = {}) {
  const p = settings.personas || {};
  let list = Array.isArray(p.list) ? p.list.filter((x) => x && typeof x.id === 'string') : [];
  if (!list.length) list = [{ id: FIRST_ID, ...snapshot(settings) }];
  list = repairScenes(list, defaultScene);
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

/** The persona that wrote the latest reply in `history` (stored on it since 2.7.10), or ''. */
function lastPersona(history) {
  return [...(Array.isArray(history) ? history : [])].reverse().find((m) => m?.role === 'assistant' && m.persona)?.persona || '';
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

// ------------------------------------------------------------------ the persona, short
// A small local model gets the master prompt's essence, not its first lines: who it is, how it talks
// (the style section) and lines it would say (quoted examples). A long prompt cut after 900 characters
// kept only the opening of "Core identity", and replies came out in a generic assistant voice.
const STYLE_HEADING = /communicat|style|voice|tone|speech|how (you|to) (talk|speak|write)|manner/i;
const EXAMPLE_HEADING = /example|sample|dialog/i;

function sectionsOf(text) {
  return String(text || '')
    .split(/\n(?=#{1,4}\s)/)
    .map((s) => {
      const [first, ...rest] = s.split('\n');
      const heading = /^#{1,4}\s/.test(first) ? first.replace(/^#+\s*/, '').trim() : '';
      return { heading, body: (heading ? rest.join('\n') : s).trim() };
    });
}

const tidy = (s) => s.replace(/\*\*|__/g, '').replace(/^---+$/gm, '').replace(/\n{2,}/g, '\n').trim();

// At most `max` characters, ending at a sentence or line where possible.
function clip(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('\n'));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut).trim();
}

/** The master prompt in at most `max` characters: identity, style, example lines; as is when it fits. */
function digest(text, { max = 2400 } = {}) {
  const all = String(text || '').trim();
  if (all.length <= max) return all;
  const parts = sectionsOf(all).filter((p) => p.body);
  const style = parts.find((p) => STYLE_HEADING.test(p.heading));
  const examples = parts.find((p) => EXAMPLE_HEADING.test(p.heading));
  const intro = parts.find((p) => p !== style && p !== examples);
  if (!style && !examples) return clip(tidy(all), max);
  const lines = examples ? (examples.body.match(/^\s*["“][^\n]{8,}["”]\s*$/gm) || []).map((l) => `- ${clip(l.trim(), 220)}`) : [];
  const quotes = [];
  // Three at most: a small model copied a sample word for word when it had more of them.
  for (const l of lines) if (quotes.length < 3 && quotes.join('\n').length + l.length < max * 0.25) quotes.push(l);
  const room = max - (quotes.length ? quotes.join('\n').length + 40 : 0);
  const out = [
    intro && clip(tidy(intro.body), Math.round(room * (style ? 0.45 : 0.95))),
    style && `How you speak:\n${clip(tidy(style.body), Math.round(room * (intro ? 0.5 : 0.95)))}`,
    quotes.length && `The tone of things you say (samples of the voice only: never reply with one of them, always answer the actual message):\n${quotes.join('\n')}`,
  ].filter(Boolean);
  return clip(out.join('\n\n'), max);
}

// ------------------------------------------------------------------ the summary for small models
// A long master prompt gets a short version written once by the user's own local model (persona.js
// ensureSummary), kept with the persona as agent.personaSummary = { text, for, by }: `for` is the
// master prompt's fingerprint (a changed prompt needs a new one), `by` is 'model' or 'user' (the
// user's own wording is never replaced). Local models read it instead of the whole prompt.
const SUMMARY_FROM = 3000; // a master prompt this long or longer gets a summary (shorter ones, like the default Siren, go in whole)
const SUMMARY_MAX = 1400;

const fingerprint = (text) => require('crypto').createHash('sha256').update(String(text || '').trim()).digest('hex').slice(0, 16);

const needsSummary = (agent) => String(agent?.personality || '').trim().length >= SUMMARY_FROM;

/** The summary is current: written for this master prompt (or by the user, which always stands). */
function summaryFresh(agent) {
  const s = agent?.personaSummary;
  return Boolean(s?.text && (s.by === 'user' || s.for === fingerprint(agent.personality)));
}

/** What a local model reads as the persona: the master prompt when short, else its summary, else the digest. */
function forSmallModels(agent) {
  const text = String(agent?.personality || '').trim();
  if (!needsSummary(agent)) return text;
  return summaryFresh(agent) ? agent.personaSummary.text : digest(text);
}

function summaryPrompt(name, masterPrompt) {
  return [
    `Below is the master prompt of "${name}", a persona for a personal AI assistant. A small AI model will play this persona, and it can only read a short version. Write that short version.`,
    '',
    'Rules:',
    `- 800 to ${SUMMARY_MAX - 200} characters, written to the model in the second person ("You are…").`,
    '- Keep what shapes every reply: who you are in one or two sentences, how you speak (tone, rhythm, word choice, what kind of remarks you make), what you never do or say, and how you treat the user.',
    '- Then two or three short typical phrases in quotes, as samples of the voice.',
    '- Leave out lore, backstory details, appearance and long lists, unless one detail is what makes the voice.',
    '- Keep the persona’s own instructions on being genuinely helpful and honest, in one sentence.',
    '- Write only the short version: no title, no introduction, no notes, no Markdown headings.',
    '',
    'The master prompt:',
    '"""',
    String(masterPrompt || '').trim(),
    '"""',
  ].join('\n');
}

/** The model's reply → the summary text, or '' when it is unusable (too short, empty). */
function cleanSummary(reply) {
  let t = String(reply || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```\w*\n?|\n?```$/g, '')
    .trim();
  t = t.replace(/^(here is|here's)[^\n]*:\s*\n/i, '').replace(/^#+\s.*\n/gm, '').replace(/^"""|"""$/g, '').trim();
  if (t.length < 200) return '';
  return clip(t, SUMMARY_MAX);
}

module.exports = { FIELDS, REPLACE, FIRST_ID, MAX_PERSONAS, snapshot, patchFor, ensure, repairScenes, sync, find, create, remove, lastPersona, summary, digest, SUMMARY_FROM, SUMMARY_MAX, fingerprint, needsSummary, summaryFresh, forSmallModels, summaryPrompt, cleanSummary };
