// GitHub through the user's signed-in GitHub CLI (gh) and git: read repos, issues and pull requests;
// clone repos into a workspace folder, work on a branch, commit, push and open pull requests.
// Work happens only on branches (never the default branch); there is no merge.
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const store = require('./store');

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,100}$/;
const MAX_TEXT = 40000;

function run(cmd, args, { cwd, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new Error(cmd === 'gh' ? 'The GitHub CLI (gh) is not installed. Install it from cli.github.com, then run "gh auth login".' : 'git is not installed.'));
        const e = new Error(String(stderr || err.message).trim().slice(0, 1500));
        e.exitCode = err.code;
        return reject(e);
      }
      resolve(String(stdout));
    });
  });
}

const gh = (args, opts) => run('gh', args, opts);
// Long paths on Windows: deep repos otherwise fail with "Filename too long".
const git = (repo, args, opts) => run('git', ['-c', 'core.longpaths=true', ...args], { cwd: localPath(repo), ...opts });
const json = async (args) => JSON.parse(await gh(args));
const clip = (t, n = MAX_TEXT) => (t.length > n ? `${t.slice(0, n)}\n… (cut at ${n} characters)` : t);

function checkRepo(repo) {
  if (!REPO_RE.test(String(repo || ''))) throw new Error(`"${repo}" is not a repository name; use owner/name, e.g. octocat/hello-world.`);
  return repo;
}

// ------------------------------------------------------------- status
let authCache = { at: 0, value: null };
let checking = null;

function checkAuth() {
  checking ||= (async () => {
    let value;
    try {
      const login = (await gh(['api', 'user', '--jq', '.login'], { timeout: 15000 })).trim();
      value = { connected: true, login };
    } catch (err) {
      value = { connected: false, error: /auth login|not logged/i.test(err.message) ? 'Not signed in. Run "gh auth login" in a terminal.' : err.message };
    }
    authCache = { at: Date.now(), value };
    return value;
  })().finally(() => (checking = null));
  return checking;
}

// Every turn asks (tools.activeTools), so a known answer comes back at once; when it is older than
// 10 minutes it is checked again in the background (a network call that can take seconds).
async function status({ fresh = false } = {}) {
  await refreshWorkspace();
  if (fresh || !authCache.value) return checkAuth();
  if (Date.now() - authCache.at > 10 * 60 * 1000) checkAuth().catch(() => {});
  return authCache.value;
}

async function workspace() {
  const s = await store.getSettings();
  return path.resolve(s.github?.workspace || path.join(os.homedir(), 'NexusRepos'));
}

let wsCache = path.join(os.homedir(), 'NexusRepos');
function localPath(repo) {
  const [owner, name] = checkRepo(repo).split('/');
  return path.join(wsCache, owner, name);
}

async function refreshWorkspace() {
  wsCache = await workspace();
  return wsCache;
}

/** Which cloned repo a file belongs to ("owner/name"), or null when it is outside the workspace. */
function repoOf(file) {
  const rel = path.relative(wsCache, path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const [owner, name] = rel.split(path.sep);
  return owner && name ? `${owner}/${name}` : null;
}

// ---------------------------------------------------------- reading
function listRepos({ owner, limit = 30 } = {}) {
  const args = ['repo', 'list'];
  if (owner) args.push(owner);
  args.push('--limit', String(Math.min(100, limit)), '--json', 'nameWithOwner,description,visibility,updatedAt,primaryLanguage,isFork,isArchived');
  return json(args).then((list) =>
    list.map((r) => ({ repo: r.nameWithOwner, description: r.description || '', visibility: r.visibility, language: r.primaryLanguage?.name || '', updated: r.updatedAt?.slice(0, 10), fork: r.isFork || undefined, archived: r.isArchived || undefined })),
  );
}

async function repoInfo(repo) {
  const r = await json(['repo', 'view', checkRepo(repo), '--json', 'nameWithOwner,description,url,defaultBranchRef,visibility,primaryLanguage,stargazerCount,issues,pullRequests,pushedAt']);
  const local = fs.existsSync(path.join(localPath(repo), '.git')) ? localPath(repo) : null;
  return {
    repo: r.nameWithOwner,
    description: r.description || '',
    url: r.url,
    defaultBranch: r.defaultBranchRef?.name,
    visibility: r.visibility,
    language: r.primaryLanguage?.name || '',
    openIssues: r.issues?.totalCount,
    openPullRequests: r.pullRequests?.totalCount,
    lastPush: r.pushedAt,
    clonedAt: local,
  };
}

function listIssues(repo, { state = 'open', limit = 20 } = {}) {
  return json(['issue', 'list', '-R', checkRepo(repo), '--state', state, '--limit', String(Math.min(100, limit)), '--json', 'number,title,author,labels,updatedAt,comments']).then((list) =>
    list.map((i) => ({ number: i.number, title: i.title, author: i.author?.login, labels: i.labels.map((l) => l.name).join(', '), updated: i.updatedAt?.slice(0, 10), comments: i.comments?.length })),
  );
}

async function viewIssue(repo, number) {
  const i = await json(['issue', 'view', String(number), '-R', checkRepo(repo), '--json', 'number,title,state,author,body,labels,comments,url']);
  return { number: i.number, title: i.title, state: i.state, author: i.author?.login, url: i.url, labels: i.labels.map((l) => l.name), body: clip(i.body || '', 12000), comments: i.comments.slice(-20).map((c) => ({ author: c.author?.login, body: clip(c.body || '', 3000) })) };
}

function listPullRequests(repo, { state = 'open', limit = 20 } = {}) {
  return json(['pr', 'list', '-R', checkRepo(repo), '--state', state, '--limit', String(Math.min(100, limit)), '--json', 'number,title,author,headRefName,baseRefName,isDraft,updatedAt,reviewDecision']).then((list) =>
    list.map((p) => ({ number: p.number, title: p.title, author: p.author?.login, branch: `${p.headRefName} → ${p.baseRefName}`, draft: p.isDraft || undefined, review: p.reviewDecision || undefined, updated: p.updatedAt?.slice(0, 10) })),
  );
}

async function viewPullRequest(repo, number, { diff = false } = {}) {
  const p = await json(['pr', 'view', String(number), '-R', checkRepo(repo), '--json', 'number,title,state,author,body,headRefName,baseRefName,isDraft,url,files,comments,reviews,statusCheckRollup']);
  const out = {
    number: p.number,
    title: p.title,
    state: p.state,
    draft: p.isDraft,
    author: p.author?.login,
    branch: `${p.headRefName} → ${p.baseRefName}`,
    url: p.url,
    body: clip(p.body || '', 12000),
    files: p.files.map((f) => `${f.path} (+${f.additions} −${f.deletions})`),
    checks: (p.statusCheckRollup || []).map((c) => `${c.name || c.context}: ${c.conclusion || c.state || c.status}`),
    reviews: p.reviews.slice(-10).map((r) => ({ author: r.author?.login, state: r.state, body: clip(r.body || '', 2000) })),
    comments: p.comments.slice(-15).map((c) => ({ author: c.author?.login, body: clip(c.body || '', 2000) })),
  };
  if (diff) out.diff = clip(await gh(['pr', 'diff', String(number), '-R', repo]), 30000);
  return out;
}

async function readRemoteFile(repo, file, ref) {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const p = String(file).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  return clip(await gh(['api', `repos/${checkRepo(repo)}/contents/${p}${q}`, '-H', 'Accept: application/vnd.github.raw']));
}

function searchCode(repo, query, limit = 20) {
  return json(['search', 'code', String(query), '--repo', checkRepo(repo), '--limit', String(Math.min(50, limit)), '--json', 'path,textMatches']).then((list) =>
    list.map((r) => ({ path: r.path, matches: (r.textMatches || []).map((m) => m.fragment.slice(0, 300)) })),
  );
}

// -------------------------------------------------------- local work
async function defaultBranch(repo) {
  const ref = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
  return ref.trim().replace(/^origin\//, '') || (await repoInfo(repo)).defaultBranch;
}

async function currentBranch(repo) {
  return (await git(repo, ['branch', '--show-current'])).trim();
}

/** Throws unless the clone exists and is on a work branch (not the default branch). */
async function requireWorkBranch(repo) {
  if (!fs.existsSync(path.join(localPath(repo), '.git'))) throw new Error(`${repo} is not cloned yet; use github_clone first.`);
  const [branch, main] = await Promise.all([currentBranch(repo), defaultBranch(repo)]);
  if (!branch || branch === main) throw new Error(`${repo} is on ${branch || 'a detached HEAD'}; start a work branch first (github_start_branch). Changes never go on ${main} directly.`);
  return { branch, main };
}

async function clone(repo) {
  await refreshWorkspace();
  const dir = localPath(repo);
  if (fs.existsSync(path.join(dir, '.git'))) {
    await git(repo, ['fetch', '--prune', 'origin'], { timeout: 120000 });
    return { path: dir, already: true, branch: await currentBranch(repo), status: await repoStatus(repo) };
  }
  await fsp.mkdir(path.dirname(dir), { recursive: true });
  await gh(['repo', 'clone', repo, dir, '--', '--config', 'core.longpaths=true'], { timeout: 600000 });
  return { path: dir, already: false, branch: await currentBranch(repo) };
}

async function startBranch(repo, name) {
  if (!BRANCH_RE.test(String(name || ''))) throw new Error(`"${name}" is not a valid branch name.`);
  const main = await defaultBranch(repo);
  if (name === main) throw new Error(`Work happens on a new branch, not on ${main}.`);
  const dirty = (await git(repo, ['status', '--porcelain'])).trim();
  if (dirty) throw new Error(`${repo} has uncommitted changes; commit them on their branch first (github_commit), or ask the user.`);
  await git(repo, ['fetch', 'origin', main], { timeout: 120000 });
  const exists = (await git(repo, ['branch', '--list', name])).trim();
  if (exists) await git(repo, ['switch', name]);
  else await git(repo, ['switch', '--no-track', '-c', name, `origin/${main}`]);
  return { repo, branch: name, from: exists ? '(existing branch)' : `origin/${main}` };
}

async function repoStatus(repo) {
  const branch = await currentBranch(repo);
  const short = (await git(repo, ['status', '--short'])).trim();
  const ahead = await git(repo, ['rev-list', '--left-right', '--count', `HEAD...@{upstream}`]).catch(() => '');
  const [a, b] = ahead.trim().split(/\s+/);
  return { branch, changes: short ? short.split('\n').slice(0, 100) : [], aheadOfRemote: ahead ? Number(a) : 'not pushed yet', behindRemote: ahead ? Number(b) : undefined };
}

async function diff(repo) {
  const unstaged = await git(repo, ['diff']);
  const staged = await git(repo, ['diff', '--cached']);
  const untracked = (await git(repo, ['ls-files', '--others', '--exclude-standard'])).trim();
  return clip(`${staged}${unstaged}${untracked ? `\nNew files:\n${untracked}` : ''}`.trim() || 'No changes.', 30000);
}

/** A file inside the clone; never .git. */
function fileIn(repo, rel) {
  const root = localPath(repo);
  const full = path.resolve(root, String(rel || ''));
  const r = path.relative(root, full);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new Error(`"${rel}" is outside ${repo}.`);
  if (/^\.git(\/|\\|$)/.test(r)) throw new Error('.git must not be touched directly.');
  return full;
}

async function listFiles(repo, pattern = '') {
  const out = (await git(repo, ['ls-files', ...(pattern ? ['--', pattern] : [])])).trim();
  const files = out ? out.split('\n') : [];
  return { count: files.length, files: files.slice(0, 400), more: files.length > 400 ? files.length - 400 : undefined };
}

async function readFile(repo, rel) {
  return clip(await fsp.readFile(fileIn(repo, rel), 'utf8'));
}

async function search(repo, query) {
  // git grep exits with 1 when nothing matches.
  const out = await git(repo, ['grep', '-n', '-I', '-i', '--max-count', '5', '-e', String(query)]).catch((e) => (e.exitCode === 1 ? '' : Promise.reject(e)));
  return clip(out.trim() || 'No matches.', 20000);
}

async function writeFile(repo, rel, content) {
  const full = fileIn(repo, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, 'utf8');
  return path.relative(localPath(repo), full).split(path.sep).join('/');
}

async function editFile(repo, rel, oldText, newText) {
  const full = fileIn(repo, rel);
  const text = await fsp.readFile(full, 'utf8');
  const count = text.split(oldText).length - 1;
  if (!oldText || count === 0) throw new Error('The text to replace was not found; read the file again and copy it exactly.');
  if (count > 1) throw new Error(`The text to replace occurs ${count} times; include more surrounding lines so it is unique.`);
  await fsp.writeFile(full, text.replace(oldText, () => newText), 'utf8');
  return path.relative(localPath(repo), full).split(path.sep).join('/');
}

// Commit author: the user's git identity, or, when none is configured, their GitHub account with
// GitHub's private no-reply address (so no real email is published).
let identityCache = null;
async function identity(repo) {
  const email = (await git(repo, ['config', 'user.email']).catch(() => '')).trim();
  if (email) return [];
  identityCache ||= await json(['api', 'user']).then((u) => ({ name: u.name || u.login, email: `${u.id}+${u.login}@users.noreply.github.com` }));
  return ['-c', `user.name=${identityCache.name}`, '-c', `user.email=${identityCache.email}`];
}

async function commit(repo, message) {
  await requireWorkBranch(repo);
  await git(repo, ['add', '-A']);
  const staged = (await git(repo, ['diff', '--cached', '--stat'])).trim();
  if (!staged) throw new Error('Nothing to commit.');
  await git(repo, [...(await identity(repo)), 'commit', '-m', String(message)]);
  return { commit: (await git(repo, ['log', '-1', '--format=%h %s'])).trim(), files: staged.split('\n').slice(-1)[0] };
}

/** What a push would publish: commits not on the remote yet and the files they touch. */
async function pendingPush(repo) {
  const { branch, main } = await requireWorkBranch(repo);
  const upstream = (await git(repo, ['rev-parse', '--abbrev-ref', '@{upstream}']).catch(() => '')).trim();
  const base = upstream || `origin/${main}`;
  const commits = (await git(repo, ['log', '--format=%h %s', `${base}..HEAD`])).trim();
  const stat = (await git(repo, ['diff', '--stat', `${base}...HEAD`])).trim();
  const dirty = (await git(repo, ['status', '--porcelain'])).trim();
  return { branch, main, commits: commits ? commits.split('\n') : [], stat, uncommitted: Boolean(dirty) };
}

async function push(repo) {
  const p = await pendingPush(repo);
  if (!p.commits.length) throw new Error('Nothing to push: no commits that are not on GitHub yet.');
  await git(repo, ['push', '-u', 'origin', `HEAD:refs/heads/${p.branch}`], { timeout: 180000 });
  return { pushed: p.branch, commits: p.commits.length };
}

async function createPullRequest(repo, { title, body = '', base, draft = false }) {
  const { branch, main } = await requireWorkBranch(repo);
  const args = ['pr', 'create', '-R', repo, '--head', branch, '--base', base || main, '--title', String(title), '--body', String(body)];
  if (draft) args.push('--draft');
  const url = (await gh(args, { cwd: localPath(repo), timeout: 120000 })).trim().split('\n').pop();
  return { url, branch, base: base || main };
}

module.exports = {
  status,
  workspace,
  refreshWorkspace,
  localPath,
  repoOf,
  listRepos,
  repoInfo,
  listIssues,
  viewIssue,
  listPullRequests,
  viewPullRequest,
  readRemoteFile,
  searchCode,
  clone,
  startBranch,
  repoStatus,
  diff,
  listFiles,
  readFile,
  search,
  writeFile,
  editFile,
  commit,
  pendingPush,
  push,
  createPullRequest,
  requireWorkBranch,
  currentBranch,
};
