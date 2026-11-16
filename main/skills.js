// Agent Skills: reusable workflows the user (or the agent, when asked) saves once and runs again by
// name, by a trigger phrase or as a slash command ("/morning-briefing"). A skill is a Markdown file in
// <userData>/skills/ with a small frontmatter block (name, description, triggers, input) and the steps
// as the body, so it can also be edited by hand; or, in the open Agent Skills format, a folder with a
// SKILL.md and companion files (references, templates) the agent loads on demand (readFile). Folders
// come from skillimport.js (GitHub) and are never executed: scripts in them are only text.
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const store = require('./store');

const MAX_SKILLS = 200;

function dir() {
  return path.join(store.dataDir(), 'skills');
}

function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

// "key: value" lines, plus what skills from elsewhere use: quoted values, folded or literal blocks
// ("key: >" / "key: |") and nested keys (read as text, unused).
function frontmatter(block) {
  const meta = {};
  const lines = String(block || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === '' || /^[>|][+-]?$/.test(v)) {
      const more = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || (lines[i + 1].trim() === '' && /^\s+\S/.test(lines[i + 2] || '')))) more.push(lines[++i].trim());
      v = v.startsWith('|') ? more.join('\n').trim() : more.join(' ').replace(/\s+/g, ' ').trim();
    }
    meta[kv[1]] = v.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return meta;
}

function parse(text, slug) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = frontmatter(m ? m[1] : '');
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

// Skills that ship with the app (main/skills/*.md: learning workflows) are copied into the user's
// folder, then they are the user's to edit or delete. .bundled.json remembers each with a hash of the
// text as placed: when a new version changes a skill, the copy is refreshed if it is still what was
// placed (the user never edited it) and left alone otherwise; a deleted skill doesn't come back.
// Installs from before the hashes (a list of names) are compared with what those versions shipped
// (SHIPPED): a skill that names tools the app no longer has must not stay behind.
const BUNDLED = path.join(__dirname, 'skills');
const hashOf = (text) => crypto.createHash('sha1').update(String(text).replace(/\r\n/g, '\n')).digest('hex'); // a Windows checkout has CRLF
const SHIPPED = {
  'goal.md': ['9eb13e44d5d60d9bad2b7e88ed300f66b9e678a5', '59d22c98333a2ae3eb7e8a40a228b50dd44064ff', 'ad798e2eb6a6406adc3c23abd5960ad6811e2180'],
  'reflect.md': ['bfb6ddc855f73440881a850bf5036e9f5ddee7d5'],
  'weekly-review.md': ['0268db1db0669b3272420c3cefeeb9e5c836c0d1'],
  'study-pack.md': ['fb3aa65571b1f5aa2799b9168175fc3d836a502d'],
};
let bundledOnce = null;

async function installBundled() {
  const marker = path.join(dir(), '.bundled.json');
  const raw = await store.readJson(marker, {});
  const seen = Array.isArray(raw) ? Object.fromEntries(raw.map((n) => [n, null])) : raw || {};
  const names = (await fsp.readdir(BUNDLED).catch(() => [])).filter((f) => f.endsWith('.md'));
  let changed = false;
  for (const f of names) {
    const src = path.join(BUNDLED, f);
    const text = await fsp.readFile(src, 'utf8').catch(() => null);
    if (text === null) continue;
    const h = hashOf(text);
    if (seen[f] === h) continue;
    const target = path.join(dir(), f);
    if (!(f in seen)) {
      await fsp.mkdir(dir(), { recursive: true });
      await fsp.copyFile(src, target, fs.constants.COPYFILE_EXCL).catch(() => {}); // never over a user's own skill
    } else {
      // Removed or edited by the user, it is theirs: only a copy that is still what was placed is replaced.
      const current = await fsp.readFile(target, 'utf8').catch(() => null);
      const placed = seen[f] ? [seen[f]] : SHIPPED[f] || [];
      const untouched = current !== null && placed.includes(hashOf(current));
      if (untouched && !(await fsp.copyFile(src, target).then(() => true, () => false))) continue; // tried again at the next start
    }
    seen[f] = h;
    changed = true;
  }
  if (changed) await store.writeJsonAtomic(marker, seen);
}

async function list() {
  bundledOnce ||= installBundled().catch(() => {}); // a read-only install folder must not break skills
  await bundledOnce;
  const entries = await fsp.readdir(dir(), { withFileTypes: true }).catch(() => []);
  const all = await Promise.all(
    entries.map(async (e) => {
      if (e.isFile() && e.name.endsWith('.md')) return parse(await fsp.readFile(path.join(dir(), e.name), 'utf8').catch(() => ''), e.name.slice(0, -3));
      if (!e.isDirectory() || e.name.startsWith('.')) return null;
      const folder = path.join(dir(), e.name);
      const text = await fsp.readFile(path.join(folder, 'SKILL.md'), 'utf8').catch(() => null);
      if (text === null) return null;
      const source = await store.readJson(path.join(folder, '.source.json'), null);
      return { ...parse(text, e.name), folder: true, files: await companionFiles(folder), source: source?.repo || '' };
    }),
  );
  return all.filter((s) => s && s.steps).sort((a, b) => a.name.localeCompare(b.name));
}

const MAX_LISTED_FILES = 300;

// A folder skill's other files (relative, forward slashes), for the agent to load on demand.
async function companionFiles(folder) {
  const out = [];
  const walk = async (rel) => {
    for (const e of await fsp.readdir(path.join(folder, rel), { withFileTypes: true }).catch(() => [])) {
      if (out.length >= MAX_LISTED_FILES || e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile() && r !== 'SKILL.md') out.push(r);
    }
  };
  await walk('');
  return out.sort();
}

const MAX_READ = 60000; // characters per read; longer files are read in parts (offset)

/** A companion file of a folder skill, as text (path inside the skill only). */
async function readFile(ref, rel, offset = 0) {
  const s = await get(ref);
  if (!s) throw new Error(`No skill called "${ref}".`);
  if (!s.folder) throw new Error(`/${s.slug} is a single-file skill; it has no other files.`);
  const folder = path.join(dir(), s.slug);
  const full = path.resolve(folder, String(rel || '').replace(/^[/\\]+/, ''));
  if (!full.startsWith(folder + path.sep)) throw new Error('That path is outside the skill.');
  const text = await fsp.readFile(full, 'utf8').catch(() => {
    throw new Error(`No file "${rel}" in /${s.slug}. Files: ${s.files.slice(0, 40).join(', ')}`);
  });
  const from = Math.max(0, Number(offset) || 0);
  const part = text.slice(from, from + MAX_READ);
  return { skill: s.slug, path: rel, content: part, ...(from + MAX_READ < text.length ? { more: `continues: read again with offset ${from + MAX_READ} (of ${text.length})` } : {}) };
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
  // A folder skill keeps its folder (and name): its companion files refer to it.
  if (existing?.folder) {
    await fsp.writeFile(path.join(dir(), existing.slug, 'SKILL.md'), serialize({ ...skill, name: existing.name }), 'utf8');
    return { ...skill, name: existing.name, slug: existing.slug, replaced: true };
  }
  await fsp.writeFile(path.join(dir(), `${slug}.md`), serialize(skill), 'utf8');
  if (existing && existing.slug !== slug) await fsp.rm(path.join(dir(), `${existing.slug}.md`), { force: true });
  return { ...skill, slug, replaced: Boolean(existing) };
}

async function remove(ref) {
  const s = await get(ref);
  if (!s) throw new Error(`No skill called "${ref}".`);
  if (s.folder) await fsp.rm(path.join(dir(), s.slug), { recursive: true, force: true });
  else await fsp.rm(path.join(dir(), `${s.slug}.md`), { force: true });
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
  const files = skill.folder && skill.files?.length
    ? `\n\nThis skill has companion files. When a step names one (e.g. "references/style-guide.md"), load it with skill_file (skill "${skill.slug}", the path): ${skill.files.slice(0, 80).join(', ')}${skill.files.length > 80 ? ', …' : ''}. Scripts among them are for reference only; you can't run them here, so do their job with your own tools or skip them.`
    : '';
  return `Run my skill "${skill.name}"${args ? ` with this input: ${args}` : ''}.\n\n<skill name="${skill.name}">\n${skill.description ? `Purpose: ${skill.description}\n` : ''}${skill.input ? `Input it expects: ${skill.input}\n` : ''}Steps:\n${skill.steps}\n</skill>${files}\n\nFollow the steps in order with your tools, then tell me briefly what you did.`;
}

/** Short list for the system prompt. */
async function promptBlock() {
  const all = await list().catch(() => []);
  if (!all.length) return '';
  const short = (t) => (t.length > 220 ? `${t.slice(0, 217)}…` : t);
  const lines = all.slice(0, 80).map((s) => `- /${s.slug} — ${s.name}${s.description ? `: ${short(s.description)}` : ''}${s.triggers.length ? ` (when the user says: ${s.triggers.map((t) => `"${t}"`).join(', ')})` : ''}`);
  return `## Skills (the user's saved workflows)\nWhen the user asks for one of these (by name, slash command or a trigger phrase), or a request fits one's purpose without naming it, load it with skill_run and follow its steps.\n${lines.join('\n')}`;
}

module.exports = { dir, list, get, save, remove, readFile, fromSlash, instructions, promptBlock, slugify, frontmatter, SHIPPED };
