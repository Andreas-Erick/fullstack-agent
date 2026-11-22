// Switching the brain from the chat ("switch to a local model", "use Claude again"): the choices,
// the model each one runs, and the settings a switch writes. Pure; the tools are in tools/brain.js, the
// brains themselves (names, readiness) in brains.js. Any id of router.js PROVIDERS can answer on its own
// as llm.provider (llm.js narrow()), and 'auto' is the multi-provider mode.

const brains = require('./brains');

// In the order they are offered (the rows live once, in brains.js's table). name = how brain_options
// offers it; section = where the brain's model is kept.
const CHOICES = brains.BRAINS.map((b) => ({ id: b.id, name: b.offer, section: b.section }));
const IDS = CHOICES.map((c) => c.id);
const choice = (id) => CHOICES.find((c) => c.id === id) || null;

// What the user set up for it, so a "not ready" answer can say what is missing.
const missing = brains.missingFor;

/** The model a brain runs now ('' = its default). */
const modelOf = brains.modelOf;

// A model name as the user (or a model list) gives it: no spaces, no paths outside a name.
function cleanModel(model) {
  const m = String(model ?? '').trim();
  if (!m) return '';
  if (m.length > 120 || !/^[\w.:/@+-]+$/.test(m) || m.includes('..')) throw new Error(`"${m.slice(0, 60)}" is not a model name.`);
  return m;
}

/**
 * The settings patch for a switch: { llm: { provider }, [section]: { model, baseUrl? } }.
 * local: the model must be one the servers offer (servers = localmodels.detect()), and its server's
 * address comes from that fixed list, never from the caller.
 */
function patchFor(id, { model, servers = [] } = {}) {
  const c = choice(id);
  if (!c) throw new Error(`Unknown brain "${id}". Choices: ${IDS.join(', ')}.`);
  const patch = { llm: { provider: id } };
  const m = cleanModel(model);
  if (!m || !c.section) return patch;
  if (id === 'local') {
    const server = servers.find((s) => s.running && s.models.some((x) => x.id === m));
    if (!server) {
      const offered = servers.flatMap((s) => s.models.map((x) => x.id));
      throw new Error(offered.length ? `No local model "${m}". Installed: ${offered.join(', ')}.` : 'No local model server is running (start Ollama or LM Studio first).');
    }
    patch.local = { model: m, baseUrl: server.baseUrl };
  } else if (id === 'claude-code') {
    if (!/^(default|opus|sonnet|haiku|fable|claude-[\w.-]+)$/.test(m)) throw new Error('For the Claude account, the model is default, opus, sonnet, haiku, fable or a full claude-… id.');
    patch.claudeCode = { model: m };
  } else if (id === 'anthropic') {
    if (!/^claude-[\w.-]+$/.test(m)) throw new Error('A Claude API model is a full id such as claude-opus-5-5.');
    patch.anthropic = { model: m };
  } else {
    patch[c.section] = { model: m };
  }
  return patch;
}

/** One line for the approval and the log: "Claude (your Claude account) → Local model (qwen3:8b)". */
function describe(settings, patch) {
  const from = settings.llm.provider;
  const to = patch.llm.provider;
  const c = choice(to);
  const toModel = (c?.section && patch[c.section]?.model) || modelOf(settings, to);
  return `${choice(from)?.name || from}${modelOf(settings, from) ? ` (${modelOf(settings, from)})` : ''} → ${c.name}${toModel ? ` (${toModel})` : ''}`;
}

module.exports = { CHOICES, IDS, choice, missing, modelOf, cleanModel, patchFor, describe };
