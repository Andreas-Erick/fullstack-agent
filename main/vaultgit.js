// Version history for the vault: every change the agent (or the app) makes is committed to a local
// git repository inside the vault, so any note can be restored to an earlier version.
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const store = require('./store');
const log = require('./logger');

const ID = ['-c', 'user.name=Siren Assistant', '-c', 'user.email=nexus-agent@localhost', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'core.quotepath=false'];
const timers = new Map();
const pendingMsgs = new Map();

function git(root, args) {
  return new Promise((resolve, reject) => {
    execFile('git', [...ID, ...args], { cwd: root, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(String(stdout));
    });
  });
}

async function enabled() {
  const s = await store.getSettings();
  return s.obsidian.gitHistory !== false;
}

async function ensure(root) {
  if (!(await enabled())) return false;
  if (fs.existsSync(path.join(root, '.git'))) return true;
  const ignore = path.join(root, '.gitignore');
  if (!fs.existsSync(ignore)) await fsp.writeFile(ignore, '.trash/\n.obsidian/workspace*.json\n.obsidian/cache\n.DS_Store\n');
  await git(root, ['init', '-q']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '--allow-empty', '-m', 'Vault history started']);
  log.info('vault git initialized', root);
  return true;
}

// Debounced commit so a burst of writes becomes one history entry.
function commitSoon(root, message) {
  const msgs = pendingMsgs.get(root) || [];
  msgs.push(message);
  pendingMsgs.set(root, msgs);
  clearTimeout(timers.get(root));
  timers.set(root, setTimeout(() => flush(root).catch((e) => log.warn('vault commit', e.message)), 4000));
}

async function flush(root) {
  const msgs = pendingMsgs.get(root) || [];
  pendingMsgs.delete(root);
  timers.delete(root);
  if (!(await enabled()) || !fs.existsSync(path.join(root, '.git'))) return;
  const status = await git(root, ['status', '--porcelain']);
  if (!status.trim()) return;
  await git(root, ['add', '-A']);
  const subject = msgs.length === 1 ? msgs[0] : `${msgs.length} changes: ${[...new Set(msgs)].slice(0, 3).join('; ')}`;
  await git(root, ['commit', '-q', '-m', subject.slice(0, 200)]);
  maintain(root).catch((e) => log.warn('vault git gc', e.message));
}

// The history only grows: about once a week, after a commit, git packs it (gc --auto does nothing when
// there is little to do). The time of the last run is a marker file inside .git.
const GC_EVERY_MS = 7 * 24 * 3600000;

async function maintain(root, now = Date.now()) {
  const marker = path.join(root, '.git', 'nexus-last-gc');
  const last = await fsp.stat(marker).then((s) => s.mtimeMs, () => 0);
  if (now - last < GC_EVERY_MS) return false;
  await fsp.writeFile(marker, new Date(now).toISOString());
  await git(root, ['gc', '--auto', '--quiet']);
  return true;
}

async function flushAll() {
  await Promise.all([...pendingMsgs.keys()].map((r) => flush(r).catch(() => {})));
}

async function history(root, rel, limit = 30) {
  if (!fs.existsSync(path.join(root, '.git'))) return [];
  await flush(root).catch(() => {});
  const out = await git(root, ['log', `-n${limit}`, '--follow', '--pretty=format:%H%x1f%ct%x1f%s', '--', rel]).catch(() => '');
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, ts, subject] = l.split('\x1f');
      return { version: sha.slice(0, 10), sha, date: Number(ts) * 1000, subject };
    });
}

async function showVersion(root, rel, version) {
  if (!/^[0-9a-f]{6,40}$/i.test(version)) throw new Error('Invalid version id');
  return git(root, ['show', `${version}:${rel}`]);
}

async function restore(root, rel, version) {
  const text = await showVersion(root, rel, version);
  await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fsp.writeFile(path.join(root, rel), text, 'utf8');
  pendingMsgs.set(root, [...(pendingMsgs.get(root) || []), `restore ${rel} to ${version.slice(0, 7)}`]);
  await flush(root);
  return { restored: rel, version };
}

module.exports = { ensure, commitSoon, flushAll, history, showVersion, restore, maintain };
