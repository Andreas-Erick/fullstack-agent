// Agent Skills: reusable workflows the user (or the agent, when asked) saves once and runs again by
// name, by a trigger phrase or as a slash command ("/morning-briefing"). Each skill is a Markdown file
// in <userData>/skills/ with a small frontmatter block (name, description, triggers, input) and the
// steps as the body, so they can also be edited by hand.
const fsp = require('fs').promises;
const path = require('path');
const store = require('./store');

const MAX_SKILLS = 200;

function dir() {
  return path.join(store.dataDir(), 'skills');
}

function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

function parse(text, slug) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  for (const line of (m ? m[1] : '').split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return {
    slug,
    name: meta.name || slug,
    description: meta.description || '',
    triggers: (meta.triggers || '').split(',').map((t) => t.trim()).filter(Boolean),
    input: meta.input || '',
    steps: (m ? m[2] : String(text)).trim(),
    created: meta.created || '',
    updated: meta.updated || '',
  };
}

function serialize(skill) {
  const one = (v) => String(v || '').replace(/\s*\n\s*/g, ' ').trim();
  return `---\nname: ${one(skill.name)}\ndescription: ${one(skill.description)}\ntriggers: ${(skill.triggers || []).map(one).filter(Boolean).join(', ')}\ninput: ${one(skill.input)}\ncreated: ${skill.created}\nupdated: ${skill.updated}\n---\n${String(skill.steps || '').trim()}\n`;
}

async function list() {
  const names = (await fsp.readdir(dir()).catch(() => [])).filter((f) => f.endsWith('.md'));
  const all = await Promise.all(names.map(async (f) => parse(await fsp.readFile(path.join(dir(), f), 'utf8').catch(() => ''), f.slice(0, -3))));
  return all.filter((s) => s.steps).sort((a, b) => a.name.localeCompare(b.name));
}

/** By slug, slash command or (fuzzy) name. */
async function get(ref) {
  const want = slugify(String(ref || '').replace(/^\//, ''));
  if (!want) return null;
  const all = await list();
  return all.find((s) => s.slug === want) || all.find((s) => slugify(s.name) === want) || all.find((s) => s.slug.includes(want) || want.includes(s.slug)) || null;
}

// oldSlug: the skill being edited (renaming is allowed). replace: overwrite a same-named skill.
async function save({ name, description = '', triggers = [], input = '', steps }, { slug: oldSlug, replace = false } = {}) {
  if (!String(name || '').trim()) throw new Error('A skill needs a name.');
  if (!String(steps || '').trim()) throw new Error('A skill needs its steps.');
  const slug = slugify(name);
  if (!slug) throw new Error('Use letters or digits in the skill name.');
  // Exact matches only: a new "Review" must not replace an existing "Weekly review".
  const all = await list();
  const existing = all.find((s) => s.slug === (oldSlug || slug));
  if (all.some((s) => s.slug === slug) && slug !== oldSlug && !replace) throw new Error(`There is already a skill called /${slug}. Pick another name or edit that one.`);
  if (!existing && all.length >= MAX_SKILLS) throw new Error(`There are already ${MAX_SKILLS} skills; delete some first.`);
  const today = new Date().toISOString().slice(0, 10);
  const skill = { name: String(name).trim(), description, triggers: Array.isArray(triggers) ? triggers : String(triggers).split(','), input, steps, created: existing?.created || today, updated: today };
  await fsp.mkdir(dir(), { recursive: true });
  await fsp.writeFile(path.join(dir(), `${slug}.md`), serialize(skill), 'utf8');
  if (existing && existing.slug !== slug) await fsp.rm(path.join(dir(), `${existing.slug}.md`), { force: true });
  return { ...skill, slug, replaced: Boolean(existing) };
}

async function remove(ref) {
  const s = await get(ref);
  if (!s) throw new Error(`No skill called "${ref}".`);
  await fsp.rm(path.join(dir(), `${s.slug}.md`), { force: true });
  return { deleted: s.name };
}

/** "/slug rest of the line" → { skill, args } (null when the text is not a skill command). */
async function fromSlash(text) {
  const m = String(text || '').match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const all = await list();
  const skill = all.find((s) => s.slug === m[1].toLowerCase());
  return skill ? { skill, args: (m[2] || '').trim() } : null;
}

/** The message the agent receives when a skill is run. */
function instructions(skill, args = '') {
  return `Run my skill "${skill.name}"${args ? ` with this input: ${args}` : ''}.\n\n<skill name="${skill.name}">\n${skill.description ? `Purpose: ${skill.description}\n` : ''}${skill.input ? `Input it expects: ${skill.input}\n` : ''}Steps:\n${skill.steps}\n</skill>\n\nFollow the steps in order with your tools, then tell me briefly what you did.`;
}

/** Short list for the system prompt. */
async function promptBlock() {
  const all = await list().catch(() => []);
  if (!all.length) return '';
  const lines = all.slice(0, 40).map((s) => `- /${s.slug} — ${s.name}${s.description ? `: ${s.description}` : ''}${s.triggers.length ? ` (when the user says: ${s.triggers.map((t) => `"${t}"`).join(', ')})` : ''}`);
  return `## Skills (the user's saved workflows)\nWhen the user asks for one of these (by name, slash command or a trigger phrase), load it with skill_run and follow its steps.\n${lines.join('\n')}`;
}

module.exports = { dir, list, get, save, remove, fromSlash, instructions, promptBlock, slugify };
