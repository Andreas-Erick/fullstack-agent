// History replays: the app's own git history for the Architecture view's replay (files appearing and
// growing commit by commit, self-changes marked) and the vault's git history (main/vaultgit.js) for
// the Growth replay in the Vault view. Runs git read-only and hands the output to the pure
// main/replaycore.js. Nothing here is reachable by tools or devices: the window asks over IPC.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const core = require('./replaycore');
const log = require('./logger');

const ID = ['-c', 'core.quotepath=false', '-c', 'log.showSignature=false'];
const FORMAT = '--pretty=format:%H%x1f%ct%x1f%an%x1f%s';

function git(root, args) {
  return new Promise((resolve, reject) => {
    execFile('git', [...ID, ...args], { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(String(stdout));
    });
  });
}

const isRepo = (root) => Boolean(root) && fs.existsSync(path.join(root, '.git'));

/** The app's commits, oldest first, with line counts per file (only the files on the map matter to the view). */
async function appHistory(root) {
  if (!isRepo(root)) return { commits: [], reason: 'The app folder is not a git repository.' };
  const out = await git(root, ['log', '--reverse', `-n${core.MAX_COMMITS}`, FORMAT, '--numstat', '--no-renames']);
  const commits = core.parseLog(out, { kinds: core.classifyApp }).map((c) => ({ ...c, subject: core.cleanSubject(c.subject) }));
  log.info('arch history read', { commits: commits.length });
  return { commits };
}

/**
 * The vault's history as a laid-out map of every note it ever had plus the commits that added, changed
 * or removed them. Only notes (.md) inside the vault: no contents, no paths outside it.
 */
async function vaultHistory(root) {
  if (!isRepo(root)) return { commits: [], map: null, reason: 'The vault has no version history yet (Settings → Memory vault → version history).' };
  const out = await git(root, ['log', '--reverse', `-n${core.MAX_COMMITS}`, FORMAT, '--numstat', '--', '*.md']);
  const commits = core.parseLog(out, { kinds: core.classifyVault }).map((c) => ({ ...c, subject: core.cleanSubject(c.subject) })).filter((c) => c.files.length || c.kind === 'baseline');
  const { paths, lines } = core.pathsOf(commits);
  const { links } = await require('./linkindex').get(root).catch(() => ({ links: {} }));
  const map = core.vaultMap(paths, { lines, links });
  log.info('vault history read', { commits: commits.length, notes: map.stats.files });
  return { commits, map };
}

module.exports = { appHistory, vaultHistory };
