// Agent tools: Personas and the agent's own look: theme, face, name.
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const store = require('../store');
const { FACES, obj, str, bool, requireApproval } = require('./common');

module.exports = [
  {
    name: 'persona_list',
    group: 'appearance',
    description: 'List the personas the user created (each has its own master prompt, image, theme, face, greeting and voice) and which one you are right now.',
    parameters: obj({}),
    run: async () => ({ personas: await require('../persona').list() }),
  },
  {
    name: 'persona_switch',
    group: 'appearance',
    description: 'Become another of the user\'s personas when they ask ("switch to Aria", "be my study coach"). Changes your master prompt, look, face and voice; your memory, vault and conversations stay the same. It takes effect from your next reply, so finish this one briefly in your current voice. You cannot create personas or edit their master prompts; the user does that in Settings → Persona studio.',
    parameters: obj({ persona: str('The persona\'s name or id (persona_list)') }, ['persona']),
    run: async (a, ctx) => {
      const persona = require('../persona');
      if (ctx.turn?.tainted) await requireApproval(ctx, 'settings', `Switch to the persona "${a.persona}"`, 'Asked after reading external content.');
      const s = await persona.activate(a.persona);
      ctx.emit({ type: 'settings_changed' });
      return { switched: true, now: s.agent.name, note: 'From your next reply on you are this persona.' };
    },
  },
  {
    name: 'theme_get',
    group: 'appearance',
    description: 'Your current look (the active persona\'s theme: colors, fonts, background, face shape; and the face) and the choices theme_update accepts. Call it before changing only part of the look.',
    parameters: obj({}),
    run: async () => {
      const s = await store.getSettings();
      const o = require('../persona').DEFAULT_OPTIONS;
      return { theme: s.appearance.theme || '(the default "Neon Circuit" theme: dark navy, cyan/blue/violet accents)', face: s.ui.face, options: { faces: [...FACES, ...(await require('../faces').list().catch(() => [])).map((f) => f.id)], fonts: o.fonts, patterns: o.patterns, cores: o.cores, traces: o.traces } };
    },
  },
  {
    name: 'theme_update',
    group: 'appearance',
    description:
      'Change your own look when the user asks ("make yourself darker", "go 80s synthwave", "use the companion face", "warmer colors"): colors, fonts, background, corner roundness, glass, face shape, and which face. Applies at once and is saved with the current persona. Give only what changes; for a whole new style give the full palette (bg, bg2, bg3, surface, text, text2, muted, accent, accent2, accent3, success, warning, danger) with strong text contrast. reset returns to the default theme. Say in a few words what you changed; the result has the previous theme if the user wants it back.',
    parameters: obj({
      name: str('Theme name, e.g. "Midnight Synthwave"'),
      colors: obj(Object.fromEntries(['bg', 'bg2', 'bg3', 'surface', 'text', 'text2', 'muted', 'accent', 'accent2', 'accent3', 'success', 'warning', 'danger'].map((k) => [k, str('#rrggbb')]))),
      fonts: obj({ display: str('Headings font (theme_get lists them)'), body: str('Body text font, very readable') }),
      uppercaseDisplay: bool('Headings in UPPERCASE'),
      radius: { type: 'number', description: 'Corner roundness 0–28 px' },
      glass: obj({ blur: { type: 'number', description: '0–40' }, opacity: { type: 'number', description: '0.15–0.97' } }),
      background: obj({ pattern: str('circuit | grid | dots | hex | waves | stars | none'), intensity: { type: 'number', description: '0–1' } }),
      face_shape: obj({ core: str('octagon | circle | hexagon | diamond | triangle'), traces: str('circuit | organic | radial | constellation'), density: { type: 'number', description: '0.3–1.6' }, glow: { type: 'number', description: '0–1' } }),
      face: str(`Which face to show: ${FACES.join(' | ')} or custom:<folder> (theme_get lists them)`),
      reset: bool('Back to the default theme (other changes are ignored)'),
    }),
    run: async (a, ctx) => {
      const persona = require('../persona');
      const s = await store.getSettings();
      if (ctx.turn?.tainted) await requireApproval(ctx, 'settings', 'Change my look', 'Asked after reading external content.');
      const patch = {};
      if (a.reset) patch.appearance = { theme: null };
      else {
        const { face: _f, face_shape: faceShape, reset: _r, ...rest } = a;
        if (Object.keys(rest).length || faceShape) patch.appearance = { theme: persona.themeChange(s.appearance.theme, { ...rest, face: faceShape }) };
      }
      if (a.face !== undefined) {
        const custom = (await require('../faces').list().catch(() => [])).map((f) => f.id);
        if (!FACES.includes(a.face) && !custom.includes(a.face)) throw new Error(`Unknown face "${a.face}". Faces: ${[...FACES, ...custom].join(', ')}`);
        patch.ui = { face: a.face };
      }
      if (!Object.keys(patch).length) throw new Error('Nothing to change: give colors, fonts, background, face_shape, face or reset.');
      await store.setSettings(patch);
      ctx.emit({ type: 'settings_changed' });
      return { applied: true, persona: s.agent.name, previous: { theme: s.appearance.theme || 'default', face: s.ui.face } };
    },
  },
];
