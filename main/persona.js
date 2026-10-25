// Personas: switching between the user's saved personas (the list itself is personacore.js), and
// their look & feel: asks the configured model to design a theme (colors, fonts, background, face
// shape) plus tone notes, a greeting and a voice that match the persona's master prompt, aesthetic
// description and image.
const store = require('./store');
const llm = require('./llm');
const core = require('./personacore');

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

/** A new persona (a copy of the active one, or fresh), switched to at once. */
async function create(opts = {}) {
  const s = await store.getSettings();
  const { personas, persona } = core.create(s, opts, { newId: store.newId, defaults: store.DEFAULTS });
  return store.setSettings({ ...core.patchFor(persona, store.DEFAULTS), personas: { ...personas, active: persona.id } });
}

async function remove(id) {
  const s = await store.getSettings();
  const { personas, next } = core.remove(s.personas, id);
  return store.setSettings(next ? { ...core.patchFor(next, store.DEFAULTS), personas } : { personas });
}

module.exports = { generate, extractJson, DEFAULT_OPTIONS, COLOR_KEYS, themeChange, list, activate, create, remove };
