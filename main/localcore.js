// Local brains (Ollama, LM Studio): reading what they list, how big a model is, which ones suit this
// computer, and when a model is small enough to get the compact prompt (prompt.buildCompact). Pure.
//
// Why a compact prompt: a 3–8B model follows a short, plain prompt far better than the full one
// (thousands of tokens of capabilities and dozens of tool schemas fill its context and blur what
// matters). What works for small models: the role first, a few numbered rules in plain words, the most
// important rule repeated at the end, one example of the answer's shape, and few tools.

const SERVERS = [
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', list: 'http://localhost:11434/api/tags' },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', list: 'http://localhost:1234/v1/models' },
];

const SMALL_B = 14; // up to this many billion parameters a model gets the compact prompt (auto)

/** Billions of parameters from Ollama's details ("8.0B", "3.2B", "567M") or the name ("qwen3:4b", "phi-3-mini-4k"). */
function paramsOf(name, details = {}) {
  const fromSize = /^([\d.]+)\s*([BM])$/i.exec(String(details.parameter_size || '').trim());
  if (fromSize) return Number(fromSize[1]) / (fromSize[2].toUpperCase() === 'M' ? 1000 : 1);
  const m = /(?:^|[:\-_/ ])(\d+(?:\.\d+)?)\s*b(?:$|[\-_:. ])/i.exec(String(name || ''));
  if (m) return Number(m[1]);
  if (/\b(mini|tiny|small|nano)\b|phi-?\d/i.test(String(name || ''))) return 4;
  return null;
}

const isSmall = (name, details) => {
  const b = paramsOf(name, details);
  return b !== null && b <= SMALL_B;
};

/** Ollama's /api/tags → [{ id, name, params, bytes }]. */
function parseOllama(json) {
  return (Array.isArray(json?.models) ? json.models : [])
    .filter((m) => m && typeof m.name === 'string' && !/embed/i.test(m.name))
    .map((m) => ({ id: m.name, name: m.name, params: paramsOf(m.name, m.details), bytes: Number(m.size) || 0 }));
}

/** An OpenAI-style /v1/models (LM Studio) → the same shape. */
function parseOpenAIModels(json) {
  return (Array.isArray(json?.data) ? json.data : [])
    .filter((m) => m && typeof m.id === 'string' && !/embed/i.test(m.id))
    .map((m) => ({ id: m.id, name: m.id, params: paramsOf(m.id), bytes: 0 }));
}

// Small models that use tools well, by the memory they need (GB, at the usual 4-bit quantization).
const SUGGESTED = [
  { model: 'qwen3:4b', needGb: 4, why: 'Fast and good with tools for its size.' },
  { model: 'llama3.2:3b', needGb: 3, why: 'The quickest option; fine for short chats and lookups.' },
  { model: 'qwen3:8b', needGb: 7, why: 'Noticeably smarter, still quick on a mid-range graphics card.' },
  { model: 'gemma3:12b', needGb: 10, why: 'Strong answers when there is memory to spare.' },
  { model: 'qwen3:14b', needGb: 12, why: 'The largest that still counts as "small" here.' },
];

/** Suggestions for this computer: what fits in the graphics memory (or a third of the RAM without one). */
function suggest({ vramGb = 0, ramGb = 0 } = {}) {
  const room = vramGb > 0 ? vramGb : ramGb / 3;
  const fits = SUGGESTED.filter((s) => s.needGb <= room);
  return (fits.length ? fits : SUGGESTED.slice(0, 2)).sort((a, b) => b.needGb - a.needGb).slice(0, 3);
}

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

/** Does this turn get the compact prompt? llm.compactPrompt: 'on' | 'off' | 'auto' (a small local model). */
function compactWanted(settings, model) {
  const mode = settings?.llm?.compactPrompt || 'auto';
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  const local = settings?.llm?.via === 'local' || LOCAL_URL.test(String(settings?.llm?.baseUrl || ''));
  return local && isSmall(model || settings?.llm?.model);
}

// The tools a small model gets: the everyday ones, each easy to call right. (A model this size
// calling a tool wrongly is worse than not having it; the user can switch to the full prompt.)
const COMPACT_TOOLS = [
  'memory_save', 'memory_search', 'calendar_get_events', 'calendar_add_event', 'habit_log', 'habit_status',
  'vault_search', 'vault_read_note', 'daily_note_log', 'web_search', 'web_fetch', 'history_search', 'app_guide',
  'priorities_update', 'learning_overview', 'brain_switch',
];

module.exports = { SERVERS, SMALL_B, SUGGESTED, COMPACT_TOOLS, paramsOf, isSmall, parseOllama, parseOpenAIModels, suggest, compactWanted };
