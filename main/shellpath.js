// macOS and Linux: an app started from Finder, the Dock or a desktop launcher gets a minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so the command-line tools the app uses (claude, gh, node/npx,
// tailscale, cloudflared from Homebrew, ~/.local/bin or nvm) wouldn't be found. At startup the PATH of
// the user's login shell is added, plus the usual install folders. Windows apps inherit it already.
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

/** Pure: the current PATH with the extra entries appended (no duplicates, order kept). */
function mergePath(current, extra, delimiter = ':') {
  const seen = new Set();
  const out = [];
  for (const p of [...String(current || '').split(delimiter), ...extra]) {
    const d = String(p || '').trim();
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out.join(delimiter);
}

/** Pure: the PATH between the markers in a login shell's output (shells may print banners). */
function parseShellPath(output) {
  const m = /__SIREN_PATH__(.*?)__SIREN_PATH__/s.exec(String(output || ''));
  return m ? m[1].split(':').filter(Boolean) : [];
}

function loginShellPath() {
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const r = spawnSync(shell, ['-ilc', 'printf "__SIREN_PATH__%s__SIREN_PATH__" "$PATH"'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return parseShellPath(r.stdout);
  } catch {
    return [];
  }
}

function setup() {
  if (process.platform === 'win32') return;
  const home = os.homedir();
  const common = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, 'bin')];
  process.env.PATH = mergePath(process.env.PATH, [...loginShellPath(), ...common]);
}

module.exports = { setup, mergePath, parseShellPath };
