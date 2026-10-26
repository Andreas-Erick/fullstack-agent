// The agent's own Obsidian vault: its external, effectively unlimited memory, loaded on demand.
// Structure (inspired by ai-memory-vault):
//   VAULT-INDEX.md       operating manual: vault map + rules (the agent reads it, the user can edit it)
//   Profile.md           living profile of the user (some sections updated by the agent, changes logged)
//   Active Priorities.md the single list of open work, checked at the start of every session
//   Daily Notes/         one templated note per day, append-only session entries
//   Jobs/                procedures for recurring tasks with quality bar and lessons learned
//   Memory/ Notes/ Research/ Inbox/ Changelog/ — each with an auto-maintained folder index
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app } = require('electron');
const store = require('./store');
const log = require('./logger');
const { resolveInside, walk, toPosix, scoreText, queryTerms } = require('./files');

const IGNORE = ['.obsidian', '.trash', 'node_modules', '.git'];
const FOLDERS = {
  Inbox: 'Quick captures to sort later.',
  Notes: 'Topic notes, ideas and how-tos.',
  Research: 'Findings from the web and documents, always with sources.',
  Jobs: 'Procedures for recurring tasks: steps, quality bar, lessons learned.',
  Memory: 'Atomic long-term memories about the user (one note each).',
  Learning: 'One note per topic the user is learning: what they understood, what is shaky, misconceptions, open questions (learning_update).',
  Languages: 'Vocabulary decks with spaced repetition, one per language (vocab_add / vocab_review).',
  Diagrams: 'Diagrams and pages the agent drew (self-contained HTML + SVG, diagram_save); open them in the app or a browser.',
  Changelog: 'Changes the agent made to its own code.',
};
const DAILY = 'Daily Notes';
const PROFILE_AGENT_SECTIONS = ['Key People', 'How I Think', 'Health', 'Interests', 'Beliefs', 'Daily Routine'];
const PROFILE_SECTIONS = ['Who I Am', 'Key People', 'Projects', 'How I Think', 'Health', 'Interests', 'Beliefs', 'Daily Routine', 'Goals'];
const IDX_START = '<!-- nexus:index:start -->';
const IDX_END = '<!-- nexus:index:end -->';
// fullPath -> { mtime, text }; about 16M characters at most (~32 MB), least recently read notes go first.
const contentCache = new (require('./lru').SizedLru)(16e6);
let onChange = () => {};

const ymd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hm = (d = new Date()) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function defaultVaultPath() {
  return path.join(app.getPath('documents'), 'Nexus Vault');
}

// ------------------------------------------------------------- templates
function vaultIndexTemplate(name, root) {
  return `---
type: index
status: active
---
# VAULT-INDEX — ${name}'s operating manual

This is ${name}'s external memory. ${name} loads only what a task needs and finds the rest through this map, folder indexes, [[wikilinks]] and search. Edit anything here — ${name} follows it.

**Vault location:** \`${root}\`

## Start of every session
1. Read [[Profile]] and [[Active Priorities]] (they are loaded automatically).
2. Check yesterday's daily note. If it is missing but there were conversations, reconstruct a short one from history and say so.
3. Before acting on a priority, verify its real current state.

## Vault map
- [[Active Priorities]] — the single list of open work
- [[Profile]] — who the user is (living profile)
- ${DAILY}/ — one note per day, append-only session entries
${Object.entries(FOLDERS).map(([f, d]) => `- ${f}/ — ${d}`).join('\n')}

## Rules
- **Frontmatter:** every note starts with YAML frontmatter (\`type\`, \`status\`, \`created\`). Status: active, completed, parked, idea, archived. Type: note, reference, guide, plan, log, job, index.
- **No bloat:** update an existing note instead of creating a near-duplicate; remove superseded text. Daily notes are the exception: append-only.
- **Wikilinks:** link people, projects, products and notes this one depends on. Not generic words, not the same target twice.
- **Folder indexes** are maintained automatically; keep this map current when adding folders.
- **Jobs:** before doing a recurring task, read its job note; afterwards, add lessons learned.
- **Archive** only when asked: set \`status: archived\` and move the note to Archive/.
- **Renames** should be done in Obsidian so links update.
- **Never store secrets** (passwords, keys) — only references to where they are kept.

## How the user likes to work
- [Edit me] e.g. plain and direct, draft things at ~75% and iterate, push back on weak ideas.
`;
}

function profileTemplate() {
  return `---
type: reference
status: active
---
# Profile

${PROFILE_SECTIONS.map((s) => `## ${s}\n`).join('\n')}
## Profile Updates
<!-- The agent logs every change it makes to this profile here. -->
`;
}

const PRIORITIES_TEMPLATE = `---
type: plan
status: active
---
# Active Priorities

## Now

## Next

## Waiting on

## Done recently
`;

function dailyTemplate(date) {
  const d = new Date(`${date}T12:00:00`);
  return `---
type: log
status: active
created: ${date}
---
# ${d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

## Index

---
`;
}

function folderIndexTemplate(folder) {
  return `---
type: index
status: active
---
# ${folder}

${FOLDERS[folder] || ''}

${IDX_START}
${IDX_END}
`;
}

// --------------------------------------------------------------- setup
async function writeIfMissing(file, text) {
  if (fs.existsSync(file)) return false;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text, 'utf8');
  return true;
}

// Builds the structure without ever overwriting existing files (safe on adopted vaults).
async function scaffold(dir, agentName) {
  await fsp.mkdir(path.join(dir, '.obsidian'), { recursive: true });
  await writeIfMissing(path.join(dir, '.obsidian', 'app.json'), JSON.stringify({ alwaysUpdateLinks: true, newFileLocation: 'folder', newFileFolderPath: 'Inbox' }, null, 2));
  await writeIfMissing(path.join(dir, 'VAULT-INDEX.md'), vaultIndexTemplate(agentName, dir));
  await writeIfMissing(path.join(dir, 'Profile.md'), profileTemplate());
  await writeIfMissing(path.join(dir, 'Active Priorities.md'), PRIORITIES_TEMPLATE);
  await writeIfMissing(path.join(dir, DAILY, 'Daily Note Template.md'), dailyTemplate('{{date}}').replace(/^# .*$/m, '# {{weekday}}, {{month}} {{day}}, {{year}}'));
  for (const f of Object.keys(FOLDERS)) {
    await fsp.mkdir(path.join(dir, f), { recursive: true });
    if (await writeIfMissing(path.join(dir, f, `${f}.md`), folderIndexTemplate(f))) await refreshFolderIndex(dir, f);
  }
  // Older versions created Home.md as the map; point it at the index.
  const home = path.join(dir, 'Home.md');
  if (fs.existsSync(home)) {
    const t = await fsp.readFile(home, 'utf8');
    if (!t.includes('[[VAULT-INDEX]]')) await fsp.appendFile(home, '\n\nThe full map and rules now live in [[VAULT-INDEX]].\n');
  }
  require('./vaultgit').ensure(dir).catch((e) => log.warn('vault git', e.message));
}

let scaffolded = '';
async function vaultPath() {
  const s = await store.getSettings();
  if (!s.obsidian.enabled) return null;
  const dir = path.resolve(s.obsidian.vaultPath || defaultVaultPath());
  try {
    if (!fs.existsSync(dir)) await fsp.mkdir(dir, { recursive: true });
    if (scaffolded !== dir) {
      scaffolded = dir;
      await scaffold(dir, s.agent.name || 'Nexus');
    }
    return dir;
  } catch (err) {
    log.error('vault unavailable', { dir, error: err.message });
    return null;
  }
}

async function requireVault() {
  const root = await vaultPath();
  if (!root) throw new Error('The vault is disabled or unavailable. Check Settings → Vault.');
  return root;
}

// ------------------------------------------------------------- reading
async function readCached(full) {
  const st = await fsp.stat(full);
  const hit = contentCache.get(full);
  if (hit && hit.mtime === st.mtimeMs) return { text: hit.text, stat: st };
  const text = await fsp.readFile(full, 'utf8');
  contentCache.set(full, { mtime: st.mtimeMs, text });
  return { text, stat: st };
}

function tagsOf(text) {
  const tags = new Set();
  for (const m of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.add(m[1]);
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const tagLine = fm?.[1].match(/^tags:\s*\[?(.*?)\]?$/m);
  if (tagLine) tagLine[1].split(/[,\s]+/).filter(Boolean).forEach((t) => tags.add(t.replace(/^#/, '')));
  return [...tags].slice(0, 12);
}

async function listNotes(folder = '') {
  const root = await requireVault();
  const start = folder ? resolveInside(root, folder) : root;
  const files = await walk(start, { exts: ['.md'], ignore: IGNORE });
  const notes = await Promise.all(
    files.map(async (full) => {
      const st = await fsp.stat(full);
      return { path: toPosix(path.relative(root, full)), title: path.basename(full, '.md'), folder: toPosix(path.relative(root, path.dirname(full))) || '/', modified: st.mtimeMs, size: st.size };
    }),
  );
  return notes.sort((a, b) => b.modified - a.modified);
}

function normalizeRef(ref) {
  let rel = String(ref || '').replace(/^\[\[|\]\]$/g, '').split('|')[0].split('#')[0].trim().replace(/\\/g, '/');
  if (!rel) throw new Error('Note path is required');
  if (!rel.toLowerCase().endsWith('.md')) rel += '.md';
  return rel;
}

async function resolveNote(ref) {
  const root = await requireVault();
  const rel = normalizeRef(ref);
  const direct = resolveInside(root, rel);
  if (fs.existsSync(direct)) return { root, full: direct };
  const base = path.basename(rel).toLowerCase();
  const all = await walk(root, { exts: ['.md'], ignore: IGNORE });
  const match = all.find((f) => path.basename(f).toLowerCase() === base);
  if (!match) throw new Error(`Note "${ref}" not found in the vault`);
  return { root, full: match };
}

async function readNote(ref, maxChars = 40000) {
  const { root, full } = await resolveNote(ref);
  const { text, stat } = await readCached(full);
  return {
    path: toPosix(path.relative(root, full)),
    fullPath: full,
    title: path.basename(full, '.md'),
    modified: stat.mtimeMs,
    tags: tagsOf(text),
    links: [...new Set([...text.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1]))].slice(0, 50),
    content: text.length > maxChars ? `${text.slice(0, maxChars)}\n\n…[truncated, ${text.length} chars total]` : text,
  };
}

async function readOptional(rel) {
  const root = await vaultPath();
  if (!root) return '';
  const g = lockedNote(root, path.join(root, rel));
  try {
    const { text, stat } = await readCached(path.join(root, rel));
    if (g && g.mtime === undefined) g.mtime = stat.mtimeMs;
    return text;
  } catch {
    if (g && g.mtime === undefined) g.mtime = null;
    return '';
  }
}

// The locked change (notelock) working on this note, if any: its read time is remembered so the write
// can tell whether someone else changed the note in between.
function lockedNote(root, full) {
  const g = require('./notelock').current();
  if (!g) return null;
  try {
    return path.resolve(full) === path.resolve(root, normalizeRef(g.key)) ? g : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- writing
function withFrontmatter(rel, text) {
  if (/^---\r?\n/.test(text) || rel.startsWith(`${DAILY}/`)) return text;
  const type = rel.startsWith('Jobs/') ? 'job' : rel.startsWith('Research/') ? 'reference' : 'note';
  return `---\ntype: ${type}\nstatus: active\ncreated: ${ymd()}\n---\n${text}`;
}

function touchUpdated(text) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return text;
  const body = /^updated:/m.test(fm[1]) ? fm[1].replace(/^updated:.*$/m, `updated: ${ymd()}`) : `${fm[1]}\nupdated: ${ymd()}`;
  return text.replace(fm[0], `---\n${body}\n---`);
}

/** mode: "create" (fails if it exists), "overwrite", "append", "prepend" */
async function writeNote(ref, content, mode = 'overwrite', { source = 'agent' } = {}) {
  const root = await requireVault();
  const rel = normalizeRef(ref);
  if (rel.split('/').some((p) => IGNORE.includes(p))) throw new Error('That folder is reserved');
  const full = resolveInside(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  const g = lockedNote(root, full);
  if (g && g.mtime !== undefined) {
    const now = await fsp.stat(full).then((s) => s.mtimeMs, () => null);
    if (now !== g.mtime) throw require('./notelock').changedError(rel);
  }
  const exists = fs.existsSync(full);
  if (mode === 'create' && exists) throw new Error(`Note "${rel}" already exists (use mode "overwrite" or "append")`);
  let text = String(content ?? '');
  if (exists && (mode === 'append' || mode === 'prepend')) {
    const old = await fsp.readFile(full, 'utf8');
    text = mode === 'append' ? `${old.replace(/\s*$/, '')}\n\n${text}\n` : insertAfterFrontmatter(old, text);
  } else if (!exists) text = withFrontmatter(rel, text);
  if (exists) text = touchUpdated(text);
  // Atomic: a crash mid-write leaves the old note or the new one, never half of it.
  await store.writeTextAtomic(full, text);
  contentCache.delete(full);
  if (g) g.mtime = await fsp.stat(full).then((s) => s.mtimeMs, () => null); // a second write in the same change is ours
  await afterChange(root, rel, `${source}: ${exists ? 'update' : 'create'} ${rel}`);
  return { path: toPosix(path.relative(root, full)), created: !exists, mode };
}

// A quick note (from the chat's "Save as note", the quick-capture box or the agent): its own dated
// note in Inbox/, never overwriting one.
async function quickNote(text, title = '', { source = 'agent' } = {}) {
  const name = String(title || String(text).split('\n').find((l) => l.trim()) || 'Note').replace(/[#*_`>[\]]/g, '').replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Note';
  const now = new Date();
  const stamp = `${ymd(now)} ${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  for (let i = 1; ; i++) {
    try {
      return await writeNote(`Inbox/${stamp} ${name}${i > 1 ? ` ${i}` : ''}.md`, `# ${name}\n\n${String(text).trim()}\n`, 'create', { source });
    } catch (err) {
      if (!/already exists/.test(err.message) || i > 20) throw err;
    }
  }
}

function insertAfterFrontmatter(old, text) {
  const fm = old.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return fm ? `${fm[0]}${text}\n\n${old.slice(fm[0].length)}` : `${text}\n\n${old}`;
}

async function deleteNote(ref) {
  const { root, full } = await resolveNote(ref);
  const trash = path.join(root, '.trash');
  await fsp.mkdir(trash, { recursive: true });
  await fsp.rename(full, path.join(trash, `${Date.now()}-${path.basename(full)}`));
  contentCache.delete(full);
  const rel = toPosix(path.relative(root, full));
  await afterChange(root, rel, `delete ${rel}`);
  return { deleted: rel, movedTo: '.trash' };
}

async function afterChange(root, rel, message) {
  const top = rel.split('/')[0];
  if (FOLDERS[top] && rel !== `${top}/${top}.md`) await refreshFolderIndex(root, top).catch(() => {});
  require('./vaultgit').commitSoon(root, message);
  onChange(rel);
}

// Keeps the auto-generated list in <Folder>/<Folder>.md in sync with the folder's notes.
async function refreshFolderIndex(root, folder) {
  const idx = path.join(root, folder, `${folder}.md`);
  const files = (await walk(path.join(root, folder), { exts: ['.md'], ignore: IGNORE })).filter((f) => f !== idx);
  const lines = files
    .map((f) => toPosix(path.relative(path.join(root, folder), f)).replace(/\.md$/, ''))
    .sort((a, b) => a.localeCompare(b))
    .map((n) => `- [[${n.split('/').pop()}]]${n.includes('/') ? ` (${n.split('/').slice(0, -1).join('/')})` : ''}`);
  let text = fs.existsSync(idx) ? await fsp.readFile(idx, 'utf8') : folderIndexTemplate(folder);
  const block = `${IDX_START}\n${lines.join('\n') || '_(empty)_'}\n${IDX_END}`;
  text = text.includes(IDX_START) && text.includes(IDX_END) ? text.replace(new RegExp(`${IDX_START}[\\s\\S]*?${IDX_END}`), block) : `${text.trimEnd()}\n\n${block}\n`;
  await store.writeTextAtomic(idx, text);
  contentCache.delete(idx);
}

// ---------------------------------------------------------- daily notes
function dailyRel(date = ymd()) {
  const d = new Date(`${date}T12:00:00`);
  const month = `${date.slice(0, 7)} ${d.toLocaleDateString('en-US', { month: 'long' })}`;
  return `${DAILY}/${month}/${date}.md`;
}

async function ensureDaily(date = ymd()) {
  const root = await requireVault();
  const rel = dailyRel(date);
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, dailyTemplate(date), 'utf8');
  }
  return { root, rel, full };
}

const bullets = (items) => (items || []).filter(Boolean).map((i) => `- ${i}`).join('\n') || '- —';

/** Appends a session entry (and an Index line) to a daily note. Never overwrites. */
async function logSession({ date = ymd(), time = hm(), topic, outcome, done, inProgress, decisions, notesTouched, profileUpdates }) {
  if (!topic) throw new Error('topic is required');
  const { root, rel, full } = await ensureDaily(date);
  let text = await fsp.readFile(full, 'utf8');
  const sessionNo = (text.match(/^## Session \d+/gm) || []).length + 1;
  const indexLine = `- **${topic}** — ${outcome || 'worked on it'}`;
  const idxPos = text.indexOf('## Index');
  if (idxPos !== -1) {
    const end = text.indexOf('\n---', idxPos);
    const insertAt = end === -1 ? text.length : end;
    text = `${text.slice(0, insertAt).replace(/\s*$/, '')}\n${indexLine}\n${text.slice(insertAt)}`;
  } else text += `\n## Index\n${indexLine}\n`;
  text += `\n## Session ${sessionNo} — ${time}: ${topic}\n### What got done\n${bullets(done)}\n### Still in progress\n${bullets(inProgress)}\n### Decisions\n${bullets(decisions)}\n### Notes touched\n${bullets((notesTouched || []).map((n) => (n.startsWith('[[') ? n : `[[${n.replace(/\.md$/, '')}]]`)))}\n${profileUpdates?.length ? `### Profile updates\n${bullets(profileUpdates)}\n` : ''}\n---\n`;
  await store.writeTextAtomic(full, text);
  contentCache.delete(full);
  await afterChange(root, rel, `daily note ${date}`);
  return { path: rel, session: sessionNo };
}

async function readDailyIndex(date) {
  const text = await readOptional(dailyRel(date));
  if (!text) return null;
  const m = text.match(/## Index\n([\s\S]*?)(\n---|\n## |$)/);
  return (m?.[1] || '').trim() || '(no entries)';
}

// --------------------------------------------- priorities, profile, jobs
async function readPriorities() {
  return readOptional('Active Priorities.md');
}

async function writePriorities(content) {
  return writeNote('Active Priorities.md', content, 'overwrite');
}

// `anySection` is used during first-run setup, where the user is dictating their own profile.
async function updateProfile(section, content, mode = 'append', { anySection = false } = {}) {
  const root = await requireVault();
  if (anySection && !PROFILE_SECTIONS.includes(section)) throw new Error(`Unknown profile section. Use one of: ${PROFILE_SECTIONS.join(', ')}`);
  if (!anySection && !PROFILE_AGENT_SECTIONS.includes(section)) {
    throw new Error(`You may only update these profile sections yourself: ${PROFILE_AGENT_SECTIONS.join(', ')}. Ask the user to change "${section}".`);
  }
  const full = path.join(root, 'Profile.md');
  let text = fs.existsSync(full) ? await fsp.readFile(full, 'utf8') : profileTemplate();
  const re = new RegExp(`(## ${section}\\n)([\\s\\S]*?)(?=\\n## |$)`);
  if (!re.test(text)) text = text.replace('## Profile Updates', `## ${section}\n\n## Profile Updates`);
  text = text.replace(re, (_m, head, body) => `${head}${mode === 'replace' ? `${content.trim()}\n` : `${body.trimEnd()}${body.trim() ? '\n' : ''}${content.trim()}\n`}`);
  text = `${text.trimEnd()}\n- ${ymd()}: ${mode === 'replace' ? 'rewrote' : 'added to'} **${section}** — ${content.trim().replace(/\s+/g, ' ').slice(0, 120)}\n`;
  await store.writeTextAtomic(full, text);
  contentCache.delete(full);
  await afterChange(root, 'Profile.md', `profile: ${section}`);
  return { section, mode };
}

async function listJobs() {
  const root = await vaultPath();
  if (!root || !fs.existsSync(path.join(root, 'Jobs'))) return [];
  const files = (await walk(path.join(root, 'Jobs'), { exts: ['.md'], ignore: IGNORE })).filter((f) => path.basename(f) !== 'Jobs.md');
  return Promise.all(
    files.map(async (f) => {
      const t = (await readCached(f)).text;
      const purpose = t.match(/## Purpose\n+([^\n]+)/)?.[1] || t.replace(/^---[\s\S]*?---/, '').split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
      return { name: path.basename(f, '.md'), path: toPosix(path.relative(root, f)), purpose: purpose.trim().slice(0, 160) };
    }),
  );
}

async function saveJob({ name, purpose, procedure, qualityBar, lessons, related }) {
  if (!name) throw new Error('name is required');
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '-').trim();
  const list = (v) => (Array.isArray(v) ? v.map((x, i) => (/^\d+\./.test(x) ? x : `${i + 1}. ${x}`)).join('\n') : String(v || ''));
  const text = `---\ntype: job\nstatus: active\ncreated: ${ymd()}\n---\n# ${safe}\n\n## Purpose\n${purpose || ''}\n\n## Procedure\n${list(procedure)}\n\n## Quality bar\n${Array.isArray(qualityBar) ? qualityBar.map((q) => `- ${q}`).join('\n') : qualityBar || ''}\n\n## Read first\n${(related || []).map((r) => `- [[${r}]]`).join('\n')}\n\n## Lessons learned\n${(lessons || []).map((l) => `- ${ymd()}: ${l}`).join('\n')}\n`;
  return writeNote(`Jobs/${safe}.md`, text, 'overwrite');
}

async function addJobLesson(name, lesson) {
  const { root, full } = await resolveNote(`Jobs/${name}`);
  let text = await fsp.readFile(full, 'utf8');
  const line = `- ${ymd()}: ${String(lesson).trim()}`;
  text = text.includes('## Lessons learned') ? text.replace(/## Lessons learned\n?/, (m) => `${m}${line}\n`) : `${text.trimEnd()}\n\n## Lessons learned\n${line}\n`;
  await store.writeTextAtomic(full, text);
  contentCache.delete(full);
  const rel = toPosix(path.relative(root, full));
  await afterChange(root, rel, `job lesson ${name}`);
  return { job: name, added: lesson };
}

// --------------------------------------------------------------- search
async function search(query, limit = 10) {
  const root = await requireVault();
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const files = await walk(root, { exts: ['.md'], ignore: IGNORE });
  const results = [];
  for (const full of files) {
    try {
      const { text } = await readCached(full);
      const title = path.basename(full, '.md');
      const { score, snippet } = scoreText(text, terms, title);
      if (score > 0) results.push({ path: toPosix(path.relative(root, full)), title, score, snippet });
    } catch {
      /* unreadable note */
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function status() {
  const s = await store.getSettings();
  const root = await vaultPath();
  if (!root) return { enabled: s.obsidian.enabled, ok: false, count: 0, own: !s.obsidian.vaultPath };
  const files = await walk(root, { exts: ['.md'], ignore: IGNORE });
  return { enabled: true, ok: true, path: root, count: files.length, own: !s.obsidian.vaultPath, registered: await isRegistered(root) };
}

// Startup context: what the agent "reads at the start of a session" (loaded on demand, not the whole vault).
async function startupContext() {
  const root = await vaultPath();
  if (!root) return '';
  const strip = (t) => t.replace(/^---[\s\S]*?---\s*/, '').trim();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - (yesterday.getDay() === 1 ? 3 : 1)); // Monday → last Friday
  const [profile, priorities, yIdx, tIdx, jobs] = await Promise.all([readOptional('Profile.md'), readPriorities(), readDailyIndex(ymd(yesterday)), readDailyIndex(ymd()), listJobs()]);
  const profileBody = strip(profile).replace(/## Profile Updates[\s\S]*$/, '').replace(/\n## [^\n]+\n(?=\n## |$)/g, '\n').trim();
  const parts = [
    `## Your vault (${root})`,
    'Your external memory. Load what a task needs: vault_search / vault_read_note, folder indexes, [[wikilinks]]. VAULT-INDEX.md is the operating manual — read it before reorganizing anything.',
    `### Profile\n${profileBody.length > 30 ? profileBody.slice(0, 5000) : '(mostly empty — learn about the user naturally and fill it in with profile_update)'}`,
    `### Active Priorities\n${strip(priorities).replace(/^# Active Priorities\s*/, '').slice(0, 4000) || '(none yet)'}`,
    `### Yesterday's daily note (${ymd(yesterday)})\n${yIdx || '(missing — if there were conversations then, reconstruct a short one with daily_note_log and history_search, and mention it)'}`,
    `### Today so far (${ymd()})\n${tIdx || '(nothing logged yet)'}`,
  ];
  if (jobs.length) parts.push(`### Jobs (read the job note before doing one of these)\n${jobs.map((j) => `- ${j.name}: ${j.purpose}`).join('\n')}`);
  const folders = Object.keys(FOLDERS).map((f) => `${f}/`).join(', ');
  parts.push(`### Vault map\nVAULT-INDEX.md, Profile.md, Active Priorities.md, Schedule.md (the user's schedule: use the calendar_* tools), Habits.md (habit_* tools), Skill Tree.md (skilltree_* tools), ${DAILY}/, ${folders}`);
  return parts.join('\n\n');
}

// ------------------------------------------------ Obsidian app registry
function registryFile() {
  if (process.env.NEXUS_OBSIDIAN_REGISTRY) return process.env.NEXUS_OBSIDIAN_REGISTRY; // tests / portable setups
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  return path.join(home, '.config', 'obsidian', 'obsidian.json');
}

async function knownVaults() {
  try {
    const json = JSON.parse(await fsp.readFile(registryFile(), 'utf8'));
    return Object.entries(json.vaults || {}).map(([id, v]) => ({ id, path: v.path, name: path.basename(v.path), exists: fs.existsSync(v.path) }));
  } catch {
    return [];
  }
}

async function isRegistered(dir) {
  const norm = (p) => path.resolve(p).toLowerCase();
  return (await knownVaults()).some((v) => norm(v.path) === norm(dir));
}

function obsidianRunning() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') execFile('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe', '/NH'], { windowsHide: true }, (_e, out) => resolve(/obsidian\.exe/i.test(String(out))));
    else execFile('pgrep', ['-if', 'obsidian'], (_e, out) => resolve(Boolean(String(out || '').trim())));
  });
}

// Registers the vault in Obsidian's vault list so it opens directly (backup first; Obsidian must be closed).
async function registerVault() {
  const root = await requireVault();
  if (await isRegistered(root)) return { registered: true, already: true };
  if (await obsidianRunning()) throw new Error('Close Obsidian first (it rewrites its vault list on exit), then try again. Or use "Open folder as vault" inside Obsidian.');
  const file = registryFile();
  let json = { vaults: {} };
  if (fs.existsSync(file)) {
    await fsp.copyFile(file, `${file}.bak-${Date.now()}`);
    json = JSON.parse(await fsp.readFile(file, 'utf8'));
    json.vaults ||= {};
  } else await fsp.mkdir(path.dirname(file), { recursive: true });
  json.vaults[require('crypto').randomBytes(8).toString('hex')] = { path: root, ts: Date.now() };
  await store.writeTextAtomic(file, JSON.stringify(json));
  log.info('vault registered in obsidian.json', root);
  return { registered: true };
}

function setChangeListener(fn) {
  onChange = fn;
}

// For files written by other modules (e.g. memories): keep indexes and history in sync.
async function notifyExternalChange(full, message) {
  const root = await vaultPath();
  if (!root) return;
  const rel = toPosix(path.relative(root, full));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  contentCache.delete(full);
  await afterChange(root, rel, message || `update ${rel}`);
}

module.exports = {
  vaultPath,
  defaultVaultPath,
  listNotes,
  readNote,
  readOptional,
  writeNote,
  quickNote,
  deleteNote,
  search,
  status,
  resolveNote,
  logSession,
  readPriorities,
  writePriorities,
  updateProfile,
  listJobs,
  saveJob,
  addJobLesson,
  startupContext,
  knownVaults,
  registerVault,
  setChangeListener,
  notifyExternalChange,
  dailyRel,
  ymd,
  PROFILE_AGENT_SECTIONS,
  PROFILE_SECTIONS,
};
