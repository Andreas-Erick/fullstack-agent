// Agent tools: Which brain answers. The user switches by asking ("switch to a local model");
// the choices and the settings a switch writes are in the pure ../braincore.js.
// Registered in ../tools.js (TOOLS).
const store = require('../store');
const log = require('../logger');
const core = require('../braincore');
const { obj, str, requireApproval } = require('./common');

// Every choice with whether it can answer now; local models from Ollama / LM Studio.
async function options(settings) {
  const router = require('../router');
  const [status, servers] = await Promise.all([router.status(settings), require('../localmodels').detect().catch(() => [])]);
  const byId = Object.fromEntries(status.map((p) => [p.id, p]));
  const autoReady = status.some((p) => p.enabled && p.configured && !p.resting);
  const localModels = servers.filter((s) => s.running).flatMap((s) => s.models.map((m) => ({ id: m.id, server: s.name, small: m.small })));
  return {
    current: { id: settings.llm.provider, name: core.choice(settings.llm.provider)?.name || settings.llm.provider, model: core.modelOf(settings, settings.llm.provider) || 'default' },
    options: core.CHOICES.map((c) => {
      const p = byId[c.id];
      const ready = c.id === 'auto' ? autoReady : Boolean(p?.configured);
      const out = { id: c.id, name: c.name, ready, model: core.modelOf(settings, c.id) || undefined };
      if (!ready && !(c.id === 'local' && localModels.length)) out.missing = core.missing(c.id);
      if (c.id === 'local' && localModels.length) out.installedModels = localModels.slice(0, 30);
      if (p?.resting) out.resting = `hit a limit; skipped for ${p.resting.minutes} more min`;
      return out;
    }),
  };
}

module.exports = [
  {
    name: 'brain_options',
    group: 'brain',
    description:
      'Which brains (AI models) can answer the user: the current one, every choice with ready / what is missing, and the local models installed in Ollama or LM Studio. Use it when the user asks to switch brains or models ("switch to a local model", "use Claude", "which brains do I have?"): offer the ready ones briefly by name (spoken: a short list, no ids) and ask which one, unless they already named one that is ready.',
    parameters: obj({}),
    run: async () => options(await store.getSettings()),
  },
  {
    name: 'brain_switch',
    group: 'brain',
    description:
      'Switch which brain (AI model) answers, from the next message on (not a persona: for the user’s personas, such as a character by name, use persona_switch): "claude-code" (Claude account), "anthropic" (Claude API key), "local" (Ollama / LM Studio on this computer), "gemini", "deepseek", "groq", "perplexity", "openai" (FreeLLMAPI), or "auto" (multi-provider). model is optional: for local one of the installed models from brain_options (required the first time), for Claude "opus", "sonnet", "haiku", "fable" or "default". Only when the user asked for the switch. Afterwards say in one line which brain answers now.',
    parameters: obj({ brain: { type: 'string', enum: core.IDS, description: 'Which brain' }, model: str('Model (optional)') }, ['brain']),
    run: async (a, ctx) => {
      const settings = await store.getSettings();
      const servers = a.brain === 'local' && a.model ? await require('../localmodels').detect().catch(() => []) : [];
      const patch = core.patchFor(a.brain, { model: a.model, servers });
      const next = { ...settings, llm: { ...settings.llm, ...patch.llm }, ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'llm').map(([k, v]) => [k, { ...settings[k], ...v }])) };
      const { current, options: list } = await options(next);
      const target = list.find((o) => o.id === a.brain);
      if (!target.ready) {
        const models = target.installedModels?.map((m) => m.id);
        throw new Error(`${target.name} can't answer yet: ${models?.length ? `pick a model: ${models.join(', ')}` : core.missing(a.brain)}.`);
      }
      const change = core.describe(settings, patch);
      if (settings.llm.provider === a.brain && JSON.stringify(patch) === JSON.stringify({ llm: { provider: a.brain } })) return { unchanged: true, current };
      await requireApproval(ctx, 'settings', 'Switch brain', change);
      await store.setSettings(patch);
      log.info('brain switched', { to: a.brain, model: current.model });
      ctx.emit({ type: 'settings_changed' });
      return { switched: change, now: current, note: 'Takes effect from the next message; this reply still comes from the previous brain.' };
    },
  },
];
