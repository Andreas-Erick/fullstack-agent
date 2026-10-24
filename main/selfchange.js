// Self-modification history. The app's own source folder is a git repository; every change the
// agent makes to itself is syntax-checked and committed, so any change can be inspected, reverted,
// or the whole app restored to an earlier version.
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');
const store = require('./store');

const AUTHOR = ['-c', 'user.name=Nexus Agent', '-c', 'user.email=nexus-agent@localhost', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false'];
const PREFIX = '[self-change]';

async function root() {
  const s = await store.getSettings();
  return path.resolve(s.code.rootPath || app.getAppPath());
}

function run(cmd, args, cwd, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, ...extraEnv }, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function git(args) {
  const r = await run('git', [...AUTHOR, ...args], await root());
  if (!r.ok) {
    const e = new Error((r.stderr || r.stdout || `git ${args[0]} failed`).trim());
    e.result = r;
    throw e;
  }
  return r.stdout;
}

async function status() {
  const s = await store.getSettings();
  const r = await root();
  const enabled = Boolean(s.code.allowSelfModify);
  if (r.includes('.asar')) return { enabled: false, available: false, reason: 'Self-modification needs the app to run from source (not a packaged build).', root: r };
  const gitCheck = await run('git', ['--version'], r);
  if (!gitCheck.ok) return { enabled, available: false, reason: 'Git is not installed. Install it from https://git-scm.com to enable change history.', root: r };
  const isRepo = fs.existsSync(path.join(r, '.git'));
  let dirty = [];
  let head = null;
  if (isRepo) {
    dirty = await dirtyFiles().catch(() => []);
    head = (await git(['rev-parse', '--short', 'HEAD']).catch(() => '')).trim() || null;
  }
  return { enabled, available: true, isRepo, root: r, dirty, head };
}

async function ensureRepo() {
  const st = await status();
  if (!st.available) return st;
  const r = st.root;
  if (!st.isRepo) {
    const ignore = path.join(r, '.gitignore');
    if (!fs.existsSync(ignore)) await fsp.writeFile(ignore, 'node_modules/\ndist/\n*.log\n.DS_Store\n');
    await git(['init', '-q']);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'Baseline: initial version of the assistant']);
  } else if (!st.head) {
    await git(['add', '-A']);
    await git(['commit', '-q', '--allow-empty', '-m', 'Baseline: initial version of the assistant']);
  }
  return status();
}

async function dirtyFiles() {
  const out = await git(['status', '--porcelain', '-uall']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ state: l.slice(0, 2).trim(), file: l.slice(3).replace(/^"|"$/g, '') }));
}

// Fingerprint of the working tree, used to detect whether a turn changed anything.
async function fingerprint() {
  try {
    const [st, diff] = await Promise.all([git(['status', '--porcelain', '-uall']), git(['diff', 'HEAD'])]);
    return `${st}\n${diff.length}:${hash(diff)}`;
  } catch {
    return null;
  }
}

function hash(s) {
  return require('crypto').createHash('sha1').update(s).digest('hex');
}

// Runs the project's syntax check with Electron's bundled Node.
async function check() {
  const r = await root();
  const script = path.join(r, 'scripts', 'check.js');
  if (!fs.existsSync(script)) return { ok: true, output: 'No check script found; skipped.' };
  const res = await run(process.execPath, [script], r, { ELECTRON_RUN_AS_NODE: '1' });
  const output = (res.stdout + res.stderr).split('\n').filter((l) => !/^ok\s/.test(l)).join('\n').trim();
  return { ok: res.ok, output: output || 'All files passed the syntax check.' };
}

// Runs the automated tests (scripts/test.js → test/*.test.js) with Electron's bundled Node.
async function runTests(filter = '') {
  const r = await root();
  const script = path.join(r, 'scripts', 'test.js');
  if (!fs.existsSync(script)) return { ok: true, output: 'No test runner found; skipped.' };
  const res = await run(process.execPath, [script, ...(filter ? [String(filter)] : [])], r, { ELECTRON_RUN_AS_NODE: '1' });
  const output = (res.stdout + res.stderr).trim();
  // Keep the summary and the failures; passing tests are noise for the agent.
  const lines = output.split('\n');
  const summary = lines.filter((l) => /^# (tests|pass|fail|cancelled|duration_ms)/.test(l)).join('\n');
  const failures = res.ok ? '' : output.slice(-6000);
  return { ok: res.ok, summary: summary || output.slice(-400), ...(failures ? { failures } : {}) };
}

/** Uncommitted changes: the diff of changed files and the list of new ones (to review before committing). */
async function diff(file = '') {
  const dirty = await dirtyFiles();
  const args = ['diff', 'HEAD', '--no-color', '--stat', '--patch', ...(file ? ['--', file] : [])];
  let patch = await git(args).catch((e) => e.message);
  if (patch.length > 60000) patch = `${patch.slice(0, 60000)}\n…[diff truncated; pass a file to see one at a time]`;
  return { files: dirty, newFiles: dirty.filter((d) => d.state === '??').map((d) => d.file), patch: patch || '(no changes to tracked files)' };
}

function impact(files) {
  const restart = files.some((f) => /^(main\/|preload\.js|package\.json)/.test(f));
  const reload = !restart && files.some((f) => /^renderer\//.test(f));
  return { restart, reload };
}

async function commit(summary, { source = 'agent' } = {}) {
  const dirty = await dirtyFiles();
  if (!dirty.length) return { ok: true, nothing: true };
  const chk = await check();
  if (!chk.ok) return { ok: false, check: chk, files: dirty.map((d) => d.file) };
  const tests = await runTests();
  if (!tests.ok) return { ok: false, check: { ok: false, output: `Tests fail:\n${tests.failures || tests.summary}` }, files: dirty.map((d) => d.file) };
  const subject = `${PREFIX} ${String(summary || 'Update').replace(/\s+/g, ' ').trim().slice(0, 100)}`;
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', subject, '-m', `Source: ${source}\nFiles:\n${dirty.map((d) => `  ${d.state} ${d.file}`).join('\n')}`]);
  const sha = (await git(['rev-parse', 'HEAD'])).trim();
  const files = dirty.map((d) => d.file);
  const change = { ok: true, sha, short: sha.slice(0, 7), subject, files, ...impact(files) };
  logToVault(change).catch(() => {});
  await markPending(change).catch(() => {});
  return change;
}

// ------------------------------------------------ did the change start cleanly?
// A committed change is "pending" until it is live: after an app restart (main/, preload.js) or a
// window reload (renderer/). Then main.js calls verifyAfterLoad(), which looks at what the log
// recorded since loading. Problems are shown to the user and put in the agent's context.
const verifyFile = () => path.join(app.getPath('userData'), 'selfchange-verify.json');

async function markPending(change) {
  const rec = { sha: change.sha, short: change.short, subject: change.subject.replace(PREFIX, '').trim(), files: change.files, restart: change.restart, reload: change.reload, at: Date.now(), state: 'pending' };
  await store.writeJsonAtomic(verifyFile(), rec);
}

async function lastVerification() {
  return store.readJson(verifyFile(), null);
}

// processStartedAt / loadedAt: when the main process started and the window last finished loading.
async function verifyAfterLoad({ processStartedAt, loadedAt }) {
  const rec = await lastVerification();
  if (!rec || rec.state !== 'pending') return null;
  const live = rec.restart ? processStartedAt > rec.at : rec.reload ? loadedAt > rec.at : true;
  if (!live) return null;
  const since = Math.min(processStartedAt, loadedAt);
  const groups = require('./errorinsight').fromLog({ sinceMs: Date.now() - since + 1000, limit: 10 });
  // Errors count; warnings only when they point into the files this change touched.
  const touched = (g) => g.locations.some((l) => rec.files.some((f) => l.startsWith(`${f}:`)));
  const problems = groups.filter((g) => g.level === 'error' || touched(g));
  const done = { ...rec, state: problems.length ? 'problems' : 'ok', checkedAt: Date.now(), problems };
  await store.writeJsonAtomic(verifyFile(), done);
  return done;
}

// Mirror self-changes into the agent's vault (Changelog/YYYY-MM.md) so they're part of its knowledge.
async function logToVault(change) {
  const obsidian = require('./obsidian');
  if (!(await obsidian.vaultPath())) return;
  const month = new Date().toISOString().slice(0, 7);
  await obsidian.writeNote(
    `Changelog/${month}.md`,
    `## ${new Date().toLocaleString()} · \`${change.short}\`\n${change.subject.replace(PREFIX, '').trim()}\n\nFiles: ${change.files.map((f) => `\`${f}\``).join(', ')}`,
    'append',
  );
}

async function log(limit = 100) {
  const out = await git(['log', `-n${limit}`, '--name-only', '--pretty=format:%x1e%H%x1f%h%x1f%ct%x1f%s']);
  return out
    .split('\x1e')
    .filter((b) => b.trim())
    .map((block) => {
      const [head, ...rest] = block.split('\n');
      const [sha, short, ts, subject] = head.split('\x1f');
      const files = rest.map((l) => l.trim()).filter(Boolean);
      return {
        sha,
        short,
        date: Number(ts) * 1000,
        subject: subject.replace(/\[self-change\]\s*/, '').trim(),
        kind: subject.startsWith(PREFIX) ? 'self' : /^Revert|^Restore/.test(subject) ? 'revert' : /^Baseline/.test(subject) ? 'baseline' : 'manual',
        files,
      };
    });
}

async function show(sha) {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error('Invalid change id');
  const out = await git(['show', '--stat', '--patch', '--no-color', '--format=%H%n%an, %cd%n%n%B', sha]);
  return out.length > 400000 ? `${out.slice(0, 400000)}\n…[diff truncated]` : out;
}

async function requireClean() {
  const dirty = await dirtyFiles();
  if (dirty.length) throw new Error('There are uncommitted changes. Commit or discard them first.');
}

async function revert(sha) {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error('Invalid change id');
  await requireClean();
  const files = (await git(['show', '--name-only', '--pretty=format:', sha])).split('\n').filter(Boolean);
  try {
    await git(['revert', '--no-edit', sha]);
  } catch (err) {
    await git(['revert', '--abort']).catch(() => {});
    throw new Error(`Could not revert automatically (later changes touch the same code). Try "Restore to this version" on an earlier entry instead.\n${err.message}`);
  }
  const head = (await git(['rev-parse', '--short', 'HEAD'])).trim();
  return { ok: true, head, files, ...impact(files) };
}

// Make the working tree identical to a past version, recorded as a new commit (history is kept).
async function restore(sha) {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error('Invalid change id');
  await requireClean();
  const files = (await git(['diff', '--name-only', sha, 'HEAD'])).split('\n').filter(Boolean);
  if (!files.length) return { ok: true, nothing: true, files: [] };
  await git(['restore', `--source=${sha}`, '--staged', '--worktree', '--', '.']);
  const subject = (await git(['log', '-1', '--pretty=%s', sha])).trim();
  await git(['commit', '-q', '-m', `Restore to ${sha.slice(0, 7)}: ${subject.replace(PREFIX, '').trim()}`.slice(0, 120)]);
  const head = (await git(['rev-parse', '--short', 'HEAD'])).trim();
  return { ok: true, head, files, ...impact(files) };
}

async function discard() {
  await git(['restore', '--staged', '--worktree', '--', '.']);
  await git(['clean', '-fd']);
  return status();
}

module.exports = { root, status, ensureRepo, dirtyFiles, fingerprint, check, runTests, diff, commit, log, show, revert, restore, discard, impact, lastVerification, verifyAfterLoad };
