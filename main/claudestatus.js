// The Claude Code sign-in check (`claude auth status`) and the CLI's version, cached. claudecode.js makes
// one with its CLI lookup and runner (create) and exports status/invalidateStatus from it, so each load of
// claudecode.js has its own cache (the tests load it fresh with other stand-ins).
const fs = require('fs');

// The sign-in check starts the CLI, so its answer is cached: the title bar and multi-provider mode ask
// often. Settings' check, the wizard, setup, diagnose and testConnection ask { fresh: true }; an auth
// error in a turn and openLogin clear it.
const STATUS_TTL_MS = 10 * 60000; // signed in
const STATUS_RETRY_MS = 30000; // not installed or signed out: signing in shows quickly
const VERSION_TTL_MS = 24 * 3600000;
const AUTH_ERROR = /log ?in|auth|credential/i; // a turn failed on the sign-in ("Please run /login")

/** findCli(): the CLI's path or null; collect(cli, args, { timeout }): { code, out, err }. */
function create({ findCli, collect }) {
  let statusCache = null; // { value, at }
  let statusInflight = null; // { gen, promise }: one probe at a time
  let statusGen = 0; // bumped by invalidateStatus, so a probe that started before it is not cached

  async function status({ fresh = false, probe = probeStatus } = {}) {
    const c = statusCache;
    const ttl = c?.value.loggedIn ? STATUS_TTL_MS : STATUS_RETRY_MS;
    if (!fresh && !statusInflight && c && Date.now() - c.at < ttl) return { ...c.value };
    if (!statusInflight || statusInflight.gen !== statusGen) {
      const gen = statusGen;
      const promise = probe()
        .then((value) => {
          if (gen === statusGen) statusCache = { value, at: Date.now() };
          return value;
        })
        .finally(() => {
          if (statusInflight?.promise === promise) statusInflight = null;
        });
      statusInflight = { gen, promise };
    }
    return { ...(await statusInflight.promise) };
  }

  function invalidateStatus() {
    statusCache = null;
    statusGen++;
  }

  async function probeStatus() {
    const cli = await findCli();
    if (!cli) return { installed: false };
    const r = await collect(cli, ['auth', 'status', '--json'], { timeout: 20000 }).catch((e) => ({ err: e.message, out: '' }));
    let auth = null;
    try {
      auth = JSON.parse(r.out);
    } catch {
      /* not JSON */
    }
    const version = await cliVersion(cli);
    // The CLI's own words without the folders above a file (a crash trace starts with C:\Users\<name>\…\cli.js):
    // they reach the screen, Health and, through Test connection, the log.
    const words = (s) => String(s || '').replace(/\b[A-Za-z]:[\\/](?:[^\\/\r\n"<>|:*?]+[\\/])+/g, '').replace(/(?<![\w/.:-])\/(?:[^\s\\/'"()<>]+\/)+/g, '').trim();
    // A check that timed out, crashed or printed no JSON says nothing about the sign-in (it showed as "not
    // connected"). A signed-out CLI prints its JSON and exits 1: that one is checked.
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return { installed: true, cli, version, checked: false, loggedIn: false, authMethod: null, email: null, subscription: null, error: (words(r.err) || 'claude auth status gave no readable answer').slice(0, 300) };
    return { installed: true, cli, version, checked: true, loggedIn: Boolean(auth.loggedIn), authMethod: auth.authMethod || null, email: auth.email || null, subscription: auth.subscriptionType || null, error: auth.loggedIn ? null : words(r.err) || null };
  }

  // The version changes only when the CLI does: kept per path and modification time (a day at most).
  let versionCache = null; // { key, version, at }
  async function cliVersion(cli) {
    let mtime = null;
    try {
      mtime = fs.statSync(cli).mtimeMs;
    } catch {
      /* can't tell whether it changed: keep what this path gave */
    }
    const c = versionCache;
    if (c && (mtime === null ? c.key.startsWith(`${cli}|`) : c.key === `${cli}|${mtime}` && Date.now() - c.at < VERSION_TTL_MS)) return c.version;
    const ver = await collect(cli, ['--version'], { timeout: 15000 }).catch(() => ({ out: '' }));
    const version = ver.out.trim();
    if (version) versionCache = { key: `${cli}|${mtime}`, version, at: Date.now() };
    return version;
  }

  return { status, invalidateStatus, probeStatus, cliVersion };
}

module.exports = { create, STATUS_TTL_MS, STATUS_RETRY_MS, VERSION_TTL_MS, AUTH_ERROR };
