// Imports Agent Skills (folders with a SKILL.md, the open format Claude Code, Codex and others use) from a
// public GitHub repository into the user's skills (skills.js). Three GitHub API calls find them (repo,
// commit, file tree); the chosen folders' text files come from raw.githubusercontent.com at that commit.
// Only text is copied and nothing in a skill is ever run. Each imported folder keeps the repository's
// license (LICENSE) and where it came from (.source.json), so an update replaces it in place.
const fsp = require('fs').promises;
const path = require('path');
const skills = require('./skills');
const log = require('./logger');

const TEXT_FILE = /\.(md|markdown|mdx|txt|json|ya?ml|toml|html?|css|svg|csv|tsv|xml|py|sh|ps1|js|mjs|cjs|ts|tsx|jsx|rb|go|rs|java|sql|ini|cfg)$/i;
const MAX_FILE_BYTES = 400000;
const MAX_SKILL_BYTES = 8000000;
const MAX_SKILL_FILES = 400;
const SCAN_TTL_MS = 15 * 60000;
const HEADERS = { 'User-Agent': 'Siren-Assistant (skill import)', Accept: 'application/vnd.github+json' };

/** "owner/repo", "https://github.com/owner/repo", "…/tree/main/skills" → { owner, repo }. */
function parseRepo(input) {
  const s = String(input || '').trim().replace(/\.git$/, '');
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/.*)?$/i.exec(s);
  if (!m || m[1] === '.' || m[2] === '.' || m[1] === '..' || m[2] === '..') throw new Error('Give a GitHub repository as owner/repo or its github.com link.');
  return { owner: m[1], repo: m[2] };
}

async function get(url, { json = true } = {}) {
  const res = await fetch(url, { headers: json ? HEADERS : { 'User-Agent': HEADERS['User-Agent'] }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
  if (res.status === 403 || res.status === 429) throw new Error('GitHub is rate-limiting this computer (60 lookups an hour without signing in). Try again in a while.');
  if (res.status === 404) throw new Error('Not found on GitHub (a private repository, or a typo).');
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url.replace(/^https:\/\/[^/]+/, '')}`);
  return json ? res.json() : Buffer.from(await res.arrayBuffer());
}

const raw = (r, sha, p) => `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${sha}/${p.split('/').map(encodeURIComponent).join('/')}`;

// Runs fn over items, a few at a time.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

const scans = new Map(); // owner/repo → { at, ...scan }

/** The skills a repository offers: [{ path, slug, name, description, files, bytes }]. */
async function scan(input) {
  const r = parseRepo(input);
  const key = `${r.owner}/${r.repo}`.toLowerCase();
  const cached = scans.get(key);
  if (cached && Date.now() - cached.at < SCAN_TTL_MS) return cached;
  const meta = await get(`https://api.github.com/repos/${r.owner}/${r.repo}`);
  const commit = await get(`https://api.github.com/repos/${r.owner}/${r.repo}/commits/${encodeURIComponent(meta.default_branch)}`);
  const tree = await get(`https://api.github.com/repos/${r.owner}/${r.repo}/git/trees/${commit.sha}?recursive=1`);
  const files = (tree.tree || []).filter((t) => t.type === 'blob').map((t) => ({ path: t.path, size: t.size || 0 }));
  const dirs = files.filter((f) => /(^|\/)SKILL\.md$/.test(f.path) && !/(^|\/)(node_modules|\.git)\//.test(f.path)).map((f) => path.posix.dirname(f.path));
  const found = await pool(dirs, 8, async (d) => {
    const prefix = d === '.' ? '' : `${d}/`;
    const own = files.filter((f) => f.path.startsWith(prefix) && importable(f.path.slice(prefix.length), f.size));
    const text = (await get(raw(r, commit.sha, `${prefix}SKILL.md`), { json: false }).catch(() => Buffer.from(''))).toString('utf8');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const fm = skills.frontmatter(m ? m[1] : '');
    return { path: d, slug: skills.slugify(d === '.' ? r.repo : path.posix.basename(d)), name: fm.name || path.posix.basename(d), description: String(fm.description || '').slice(0, 400), files: own.length, bytes: own.reduce((n, f) => n + f.size, 0) };
  });
  const license = files.find((f) => /^(LICENSE|LICENCE|COPYING)(\.(md|txt))?$/i.test(f.path));
  const out = { at: Date.now(), repo: `${r.owner}/${r.repo}`, owner: r.owner, name: r.repo, sha: commit.sha, files, license: meta.license?.spdx_id || null, licensePath: license?.path || null, description: meta.description || '', truncated: Boolean(tree.truncated), skills: found.sort((a, b) => a.path.localeCompare(b.path)) };
  scans.set(key, out);
  return out;
}

// Inside a skill folder: text files only, not too big, no hidden folders (.github, .git…).
function importable(rel, size) {
  return Boolean(rel) && TEXT_FILE.test(rel) && size <= MAX_FILE_BYTES && !rel.split('/').some((p) => p.startsWith('.') || p === '..' || /[:*?"<>|]/.test(p));
}

/** Installs the chosen skill folders (paths from scan). Returns what was installed and skipped. */
async function install(input, paths) {
  const s = await scan(input);
  const r = { owner: s.owner, repo: s.name };
  const want = (Array.isArray(paths) ? paths : [paths]).map(String);
  const chosen = s.skills.filter((k) => want.includes(k.path) || want.includes(k.slug) || want.includes(k.name));
  if (!chosen.length) throw new Error(`None of those are skills in ${s.repo}. Skills: ${s.skills.map((k) => k.slug).join(', ')}`);
  const root = skills.dir();
  await fsp.mkdir(root, { recursive: true });
  const existing = await skills.list();
  const licenseText = s.licensePath ? (await get(raw(r, s.sha, s.licensePath), { json: false }).catch(() => null))?.toString('utf8') : null;
  const done = [];
  for (const k of chosen) {
    // A skill of the user's own (or from another repository) with that name is never replaced.
    const clash = existing.find((x) => x.slug === k.slug && x.source !== s.repo);
    const slug = clash ? skills.slugify(`${k.slug}-${s.owner}`) : k.slug;
    const prefix = k.path === '.' ? '' : `${k.path}/`;
    let bytes = 0;
    const files = s.files.filter((f) => f.path.startsWith(prefix) && importable(f.path.slice(prefix.length), f.size)).filter((f) => (bytes += f.size) <= MAX_SKILL_BYTES).slice(0, MAX_SKILL_FILES);
    const skipped = s.files.filter((f) => f.path.startsWith(prefix)).length - files.length;
    const tmp = path.join(root, `.importing-${slug}-${Date.now().toString(36)}`);
    try {
      await pool(files, 6, async (f) => {
        const rel = f.path.slice(prefix.length);
        const target = path.resolve(tmp, ...rel.split('/'));
        if (!target.startsWith(tmp + path.sep)) return; // never outside the skill folder
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, await get(raw(r, s.sha, f.path), { json: false }));
      });
      if (licenseText && !files.some((f) => /^(LICENSE|LICENCE|COPYING)/i.test(f.path.slice(prefix.length)))) await fsp.writeFile(path.join(tmp, 'LICENSE'), licenseText);
      await fsp.writeFile(path.join(tmp, '.source.json'), JSON.stringify({ repo: s.repo, path: k.path, commit: s.sha, license: s.license, importedAt: new Date().toISOString() }, null, 2));
      const final = path.join(root, slug);
      await fsp.rm(final, { recursive: true, force: true }); // an update of the same skill from the same repository
      await fsp.rename(tmp, final);
      done.push({ slug, name: k.name, files: files.length, skipped, ...(clash ? { renamed: `/${k.slug} already exists, so this one is /${slug}` } : {}) });
      log.info('skill imported', { repo: s.repo, skill: k.path, slug, files: files.length });
    } catch (err) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Importing ${k.name} failed: ${err.message}`);
    }
  }
  return { repo: s.repo, license: s.license, commit: s.sha.slice(0, 7), installed: done };
}

module.exports = { parseRepo, scan, install, importable };
