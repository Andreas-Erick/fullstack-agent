// Personas: switching between the user's saved personas (the list itself is personacore.js), and
// their look & feel: asks the configured model to design a theme (colors, fonts, background, face
// shape) plus tone notes, a greeting and a voice that match the persona's master prompt, aesthetic
// description and image.
const store = require('./store');
const llm = require('./llm');
const core = require('./personacore');
const templates = require('./personatemplates');
const scenecore = require('./scenecore');
const log = require('./logger');

function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The model did not return a theme. Try again, or use a more capable model.');
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    // Common model slip: trailing commas.
    return JSON.parse(s.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
  }
}

function buildPrompt({ name, masterPrompt, aesthetic, palette, voices, options }) {
  return `You are an expert brand and UI designer. Design the complete look & feel of a desktop AI assistant app so that it embodies the assistant's persona and aesthetic below. The app has: a dark or light background with a subtle repeating pattern, translucent "glass" cards, a chat view, and a full-screen animated "face" (a glowing core with traces radiating out of it and energy pulses that change color when the assistant is idle / listening / thinking / speaking).

ASSISTANT NAME: ${name}

MASTER PROMPT (the persona):
"""
${String(masterPrompt || '').slice(0, 6000)}
"""

AESTHETIC / STYLE / THEME requested by the user:
"""
${String(aesthetic || '(none given — derive it from the persona)').slice(0, 3000)}
"""
${palette?.length ? `\nDOMINANT COLORS OF THE ASSISTANT'S IMAGE (harmonize with these): ${palette.join(', ')}\n` : ''}${options.imageAttached ? '\nThe assistant\'s image is attached — let it inform the palette and mood.\n' : ''}
Respond with ONLY one JSON object (no prose, no code fences) of this exact shape:
{
  "name": "short theme name",
  "colors": {
    "bg": "#hex page background", "bg2": "#hex", "bg3": "#hex (slightly lifted backgrounds)",
    "surface": "#hex card surface (shown semi-transparent over bg)",
    "text": "#hex main text", "text2": "#hex secondary text", "muted": "#hex hints",
    "accent": "#hex primary accent (glows, borders, highlights)", "accent2": "#hex secondary accent", "accent3": "#hex tertiary accent",
    "success": "#hex", "warning": "#hex", "danger": "#hex"
  },
  "fonts": { "display": one of ${JSON.stringify(options.fonts)}, "body": one of the same list (must be very readable) },
  "uppercaseDisplay": true/false,
  "radius": 0-28 (corner roundness in px),
  "glass": { "blur": 0-40, "opacity": 0.15-0.97 },
  "background": { "pattern": one of ${JSON.stringify(options.patterns)}, "intensity": 0-1 },
  "face": {
    "core": one of ${JSON.stringify(options.cores)},
    "traces": one of ${JSON.stringify(options.traces)},
    "density": 0.3-1.6, "glow": 0-1,
    "states": { "idle": ["#main","#accent"], "listening": ["#main","#accent"], "thinking": ["#main","#accent"], "speaking": ["#main","#accent"] }
  },
  "personaNotes": "2-4 sentences: how the assistant should talk and write to embody this aesthetic (tone, vocabulary, imagery, formatting habits)",
  "greeting": "a short welcome line (max 8 words) shown on the empty chat screen, in the persona's voice",
  "voice": ${voices?.length ? `the best-fitting voice id from ${JSON.stringify(voices.slice(0, 80))}` : 'null'}
}

Rules: text must have strong contrast against bg and surface (WCAG AA). The four face states must be clearly distinguishable from each other. Make it distinctive and faithful to the aesthetic — not a generic dark theme unless that is what is asked.`;
}

async function generate({ masterPrompt, aesthetic, palette, voices, image, options }) {
  const settings = await store.getSettings();
  const text = await llm.complete(
    settings,
    buildPrompt({ name: settings.agent.name, masterPrompt, aesthetic, palette, voices, options: { ...options, imageAttached: Boolean(image) && settings.llm.provider !== 'openai' } }),
    { image: settings.llm.provider === 'openai' ? undefined : image },
  );
  const json = extractJson(text);
  return {
    theme: json,
    personaNotes: String(json.personaNotes || '').slice(0, 800),
    greeting: String(json.greeting || '').slice(0, 120),
    voice: json.voice && voices?.includes(json.voice) ? json.voice : null,
  };
}

/**
 * The scene behind the face (scenecore.js): the model draws the place the persona lives in as one
 * SVG in the theme's colors, twice at once: wide, and tall for narrow panels (optional: without it the
 * wide one is cropped). Returns { svg, portrait, caption } ready for appearance.scene.
 */
async function generateScene({ masterPrompt, aesthetic, theme }) {
  const settings = await store.getSettings();
  // The user's name hidden in the scene (scenecore's `userName`, obsidian.userName) is off for now: the
  // drawings made it either invisible or a typeset label; back when the lettering convinces.
  const draw = async (orientation) => {
    const text = await llm.complete(settings, scenecore.buildPrompt({ name: settings.agent.name, masterPrompt, aesthetic, colors: theme?.colors || {}, orientation }), { maxTokens: 20000, timeoutMs: 480000 });
    const scene = scenecore.cleanScene(text, { orientation });
    log.info('scene drawn', { orientation, bytes: scene.bytes, elements: scene.elements, layers: scene.layers });
    return scene;
  };
  const [wide, tall] = await Promise.allSettled([draw('landscape'), draw('portrait')]);
  if (wide.status === 'rejected') throw wide.reason;
  if (tall.status === 'rejected') log.warn('portrait scene failed', { error: tall.reason });
  return { svg: wide.value.svg, portrait: tall.status === 'fulfilled' ? tall.value.svg : '', caption: wide.value.caption };
}

// Same choices the renderer's theme engine supports (renderer/js/theme.js).
const DEFAULT_OPTIONS = {
  fonts: ['Orbitron', 'Exo 2', 'Rajdhani', 'Audiowide', 'Space Grotesk', 'Inter', 'Montserrat', 'Nunito', 'Quicksand', 'Syne', 'Playfair Display', 'Cormorant Garamond', 'Lora', 'Cinzel', 'JetBrains Mono', 'VT323', 'Press Start 2P', 'Caveat'],
  patterns: ['circuit', 'grid', 'dots', 'hex', 'waves', 'stars', 'none'],
  cores: ['octagon', 'circle', 'hexagon', 'diamond', 'triangle'],
  traces: ['circuit', 'organic', 'radial', 'constellation'],
};

// ------------------------------------------------- theme changes by the agent
const COLOR_KEYS = ['bg', 'bg2', 'bg3', 'surface', 'text', 'text2', 'muted', 'accent', 'accent2', 'accent3', 'success', 'warning', 'danger'];
const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (v, lo, hi, what) => {
  if (!Number.isFinite(+v)) throw new Error(`${what} must be a number (${lo}–${hi}).`);
  return Math.max(lo, Math.min(hi, +v));
};
const oneOf = (v, list, what) => {
  if (!list.includes(v)) throw new Error(`Unknown ${what} "${v}". Use one of: ${list.join(', ')}`);
  return v;
};

/**
 * The stored theme after the agent's partial `changes` (validated; the renderer's normalizeTheme fills
 * the rest). Colors that change re-derive the face's state colors unless the change sets those too.
 */
function themeChange(current, changes = {}) {
  const t = JSON.parse(JSON.stringify(current || {}));
  const c = changes || {};
  if (c.name !== undefined) t.name = String(c.name).slice(0, 60);
  if (c.colors) {
    for (const [k, v] of Object.entries(c.colors)) {
      if (!COLOR_KEYS.includes(k)) throw new Error(`Unknown color "${k}". Colors: ${COLOR_KEYS.join(', ')}`);
      if (!HEX.test(String(v).trim())) throw new Error(`Color ${k} must be a hex color like #1a2b3c (got "${v}").`);
      (t.colors ||= {})[k] = String(v).trim().toLowerCase();
    }
    if (t.face) delete t.face.states;
  }
  if (c.fonts?.display !== undefined) (t.fonts ||= {}).display = oneOf(c.fonts.display, DEFAULT_OPTIONS.fonts, 'font');
  if (c.fonts?.body !== undefined) (t.fonts ||= {}).body = oneOf(c.fonts.body, DEFAULT_OPTIONS.fonts, 'font');
  if (c.uppercaseDisplay !== undefined) t.uppercaseDisplay = Boolean(c.uppercaseDisplay);
  if (c.radius !== undefined) t.radius = clamp(c.radius, 0, 28, 'radius');
  if (c.glass?.blur !== undefined) (t.glass ||= {}).blur = clamp(c.glass.blur, 0, 40, 'glass.blur');
  if (c.glass?.opacity !== undefined) (t.glass ||= {}).opacity = clamp(c.glass.opacity, 0.15, 0.97, 'glass.opacity');
  if (c.background?.pattern !== undefined) (t.background ||= {}).pattern = oneOf(c.background.pattern, DEFAULT_OPTIONS.patterns, 'background pattern');
  if (c.background?.intensity !== undefined) (t.background ||= {}).intensity = clamp(c.background.intensity, 0, 1, 'background.intensity');
  const f = c.face || {};
  if (f.core !== undefined) (t.face ||= {}).core = oneOf(f.core, DEFAULT_OPTIONS.cores, 'face core');
  if (f.traces !== undefined) (t.face ||= {}).traces = oneOf(f.traces, DEFAULT_OPTIONS.traces, 'face traces');
  if (f.density !== undefined) (t.face ||= {}).density = clamp(f.density, 0.3, 1.6, 'face.density');
  if (f.glow !== undefined) (t.face ||= {}).glow = clamp(f.glow, 0, 1, 'face.glow');
  return t;
}

// ------------------------------------------------------------ the persona list
async function list() {
  return core.summary((await store.getSettings()).personas);
}

/** Makes a saved persona (id or name) the live one. Returns the new settings. */
async function activate(query) {
  const s = await store.getSettings();
  const target = core.find(s.personas, query);
  if (!target) throw new Error(`No persona called "${query}". Personas: ${s.personas.list.map((x) => x.name).join(', ')}`);
  if (target.id === s.personas.active) return s;
  return store.setSettings({ ...core.patchFor(target, store.DEFAULTS), personas: { active: target.id } });
}

/**
 * A new persona (a copy of the active one, fresh, or from a template), switched to at once, or only
 * added to the list with activate: false (setup adds template personas without changing who is talking).
 */
async function create(opts = {}) {
  const s = await store.getSettings();
  let template = null;
  if (opts.template) {
    const t = templates.find(opts.template);
    if (!t) throw new Error(`No persona template "${opts.template}".`);
    template = templates.personaFields(t);
  }
  const { personas, persona } = core.create(s, { ...opts, template }, { newId: store.newId, defaults: store.DEFAULTS });
  if (opts.activate === false) return store.setSettings({ personas });
  return store.setSettings({ ...core.patchFor(persona, store.DEFAULTS), personas: { ...personas, active: persona.id } });
}

async function remove(id) {
  const s = await store.getSettings();
  const { personas, next } = core.remove(s.personas, id);
  return store.setSettings(next ? { ...core.patchFor(next, store.DEFAULTS), personas } : { personas });
}

// ------------------------------------------------------------ the summary for small models
// Written by the user's own local model (the deep one when set: the best writer), so the master
// prompt never leaves the computer for it; only local models read it (prompt.buildCompact), so
// without a local brain nothing is written. One at a time; dropped if the persona changed meanwhile.

/** The local brain that writes the summary (its strongest model), or null when no local brain is set. */
function summaryWriter(settings) {
  const router = require('./router');
  const localcore = require('./localcore');
  const id = settings.llm.provider;
  let s = null;
  if (id === 'auto') s = settings.local?.model ? router.concrete(settings, 'local') : null;
  else {
    const narrowed = router.PROVIDERS[id]?.openai ? router.concrete(settings, id) : settings;
    s = narrowed.llm.provider === 'openai' && localcore.isLocal(narrowed) ? narrowed : null;
  }
  if (!s?.llm?.model) return null;
  return { ...s, llm: { ...s.llm, provider: 'openai', model: s.llm.deepModel || s.llm.model, modelMode: 'default' } };
}

/** What the Persona studio shows. */
async function summaryStatus() {
  const s = await store.getSettings();
  const writer = summaryWriter(s);
  const sum = s.agent.personaSummary || null;
  return {
    needed: core.needsSummary(s.agent),
    text: sum?.text || '',
    by: sum?.by || '',
    model: sum?.model || '',
    fresh: core.summaryFresh(s.agent),
    stale: Boolean(sum?.text && sum.by === 'user' && sum.for !== core.fingerprint(s.agent.personality)),
    writer: writer?.llm.model || '',
    writing: Boolean(summarizing),
    chars: String(s.agent.personality || '').trim().length,
  };
}

let summarizing = null;
/**
 * Writes the summary when the active persona needs one and has none for its current master prompt
 * (force: write a new one now, replacing the user's own too). Returns summaryStatus().
 */
function ensureSummary(opts = {}) {
  if (!summarizing) {
    summarizing = writeSummary(opts).finally(() => {
      summarizing = null;
    });
  }
  return summarizing.then(summaryStatus);
}

async function writeSummary({ force = false }) {
  const settings = await store.getSettings();
  const { agent } = settings;
  if (!core.needsSummary(agent) || (!force && core.summaryFresh(agent))) return;
  const writer = summaryWriter(settings);
  if (!writer) {
    if (force) throw new Error('Writing the short version needs a local model (Settings → AI brain): it is written on this computer.');
    return;
  }
  const fp = core.fingerprint(agent.personality);
  const started = Date.now();
  const text = core.cleanSummary(await llm.complete(writer, core.summaryPrompt(agent.name, agent.personality), { maxTokens: 4000, timeoutMs: 300000 }));
  if (!text) throw new Error('The local model’s short version came back empty or too short. Try again, or write it yourself.');
  const now = (await store.getSettings()).agent;
  if (core.fingerprint(now.personality) !== fp || (!force && now.personaSummary?.by === 'user')) {
    log.info('persona summary dropped', { reason: 'the persona changed meanwhile' });
    return;
  }
  await store.setSettings({ agent: { personaSummary: { text, for: fp, by: 'model', model: writer.llm.model, at: Date.now() } } });
  log.info('persona summary written', { persona: agent.name, model: writer.llm.model, ms: Date.now() - started, chars: text.length });
}

/** The user's own short version (kept until they change it); empty text goes back to the written one. */
async function setSummary(text) {
  const s = await store.getSettings();
  const t = String(text || '').trim().slice(0, core.SUMMARY_MAX * 2);
  await store.setSettings({ agent: { personaSummary: t ? { text: t, for: core.fingerprint(s.agent.personality), by: 'user', at: Date.now() } : null } });
  if (!t) ensureSummary().catch((error) => log.warn('persona summary failed', { error }));
  return summaryStatus();
}

module.exports = { generate, generateScene, extractJson, DEFAULT_OPTIONS, COLOR_KEYS, themeChange, list, activate, create, remove, templates: templates.list, summaryWriter, summaryStatus, ensureSummary, setSummary };
