// A tool's arguments checked against its schema before it runs (tools.js executeTool). Nothing checked
// them: skill_run takes `name`, its sibling skill_file takes `skill`, and the model called
// skill_run({ skill }) twice in a turn, each time told "No skill called "undefined"".
//  - a required parameter that is missing, sent under an obvious other name (ALIASES), is renamed;
//  - else the call stops with what the tool takes and what it was sent, so the model fixes it in one go.
// Pure (test/toolargs.test.js).

// Other names a model uses for a parameter. Only ever applied to a parameter the tool has, that is
// missing, from a key the tool doesn't have.
const ALIASES = {
  name: ['skill', 'slug', 'title', 'persona', 'routine', 'topic'],
  input: ['args', 'arguments', 'text', 'prompt'],
  query: ['q', 'search', 'term', 'text'],
  path: ['file', 'file_path', 'filePath', 'note', 'notePath'],
  persona: ['name', 'id', 'persona_id'],
  skill: ['name', 'slug'],
  text: ['content', 'body', 'message'],
  content: ['text', 'body'],
  id: ['entry_id', 'entryId', 'uid'],
  url: ['link', 'href'],
};

const describe = (props, required) =>
  Object.entries(props)
    .map(([k, p]) => `${k}${required.includes(k) ? ' (required)' : ''}${p?.type ? `: ${p.type}` : ''}`)
    .join(', ');

/**
 * { args, renamed } when the call can run (renamed: [[from, to]]), else { error }.
 * `args` is a copy; a tool without a schema of properties is left alone.
 */
function checkArgs(tool, args) {
  const props = tool?.parameters?.properties;
  const input = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  if (!props || typeof props !== 'object') return { args: input, renamed: [] };
  const required = Array.isArray(tool.parameters.required) ? tool.parameters.required : [];
  const blank = (v) => v === undefined || v === null; // '' can be meant (clearing a field)
  const renamed = [];
  for (const key of required) {
    if (!blank(input[key])) continue;
    const from = (ALIASES[key] || []).find((a) => !(a in props) && !blank(input[a]));
    if (!from) continue;
    input[key] = input[from];
    delete input[from];
    renamed.push([from, key]);
  }
  const missing = required.filter((k) => blank(input[k]));
  if (!missing.length) return { args: input, renamed };
  const sent = Object.keys(args || {});
  return {
    error: `${tool.name} needs ${missing.map((m) => `"${m}"`).join(' and ')}. It takes: ${describe(props, required)}. You sent: ${sent.length ? sent.join(', ') : 'nothing'}. Call it again with those names.`,
  };
}

module.exports = { checkArgs, ALIASES };
