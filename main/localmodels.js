// Finds local brains on this computer: Ollama and LM Studio on their usual ports, and the models
// they have. Only localhost, a short time limit per server, nothing is downloaded. The parsing and
// the suggestions are in the pure localcore.js.
const core = require('./localcore');
const log = require('./logger');

async function getJson(url, ms = 1500) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** [{ id, name, baseUrl, running, models: [{ id, name, params, bytes, small }] }] for every known server. */
async function detect() {
  return Promise.all(
    core.SERVERS.map(async (s) => {
      try {
        const json = await getJson(s.list);
        const models = (s.id === 'ollama' ? core.parseOllama(json) : core.parseOpenAIModels(json)).map((m) => ({ ...m, small: m.params !== null && m.params <= core.SMALL_B }));
        return { id: s.id, name: s.name, baseUrl: s.baseUrl, running: true, models };
      } catch (err) {
        log.debug('local model server not found', { server: s.id, error: err });
        return { id: s.id, name: s.name, baseUrl: s.baseUrl, running: false, models: [] };
      }
    }),
  );
}

module.exports = { detect };
