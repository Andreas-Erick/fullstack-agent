// New versions of Siren (rules in updatecore.js): one request to GitHub's releases API on start and once
// a day, only while `updates.check` is on (the user's setting, never SETTABLE). Nothing is downloaded or
// installed here: the title bar offers the new version and the download opens in the browser. Paired
// phones learn the newest APK through /api/info (companion.js), so they never ask GitHub themselves.
// The last answer is kept in <userData>/updates.json.
const path = require('path');
const { app, net } = require('electron');
const store = require('./store');
const log = require('./logger');
const core = require('./updatecore');

const REPO = 'Andreas-Erick/fullstack-agent'; // package.json build.publish
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000; // after launch, so the check never competes with the start
const TIMEOUT_MS = 15000;

const file = () => path.join(store.dataDir(), 'updates.json');
let notify = () => {};
let timer = null;
let last = null; // { checkedAt, latest, error }

async function saved() {
  if (!last) last = await store.readJson(file(), {});
  return last;
}

async function fetchLatest() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await net.fetch(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Siren-Assistant/${app.getVersion()}` }, signal: ctl.signal });
    if (res.status === 404) return null; // no release yet
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return core.fromRelease(await res.json());
  } finally {
    clearTimeout(t);
  }
}

/** Asks GitHub now (the daily check, or the user's "Check now"); returns the state. */
async function check({ manual = false } = {}) {
  const s = await store.getSettings();
  if (!manual && s.updates?.check === false) return status();
  const prev = await saved();
  try {
    const latest = await fetchLatest();
    last = { checkedAt: Date.now(), latest };
    log.info('update check', { current: app.getVersion(), latest: latest?.version || null, manual });
  } catch (err) {
    last = { ...prev, checkedAt: Date.now(), error: err.message };
    log.warn('update check failed', { error: err });
  }
  await store.writeJsonAtomic(file(), last).catch(() => {});
  const st = await status();
  notify(st);
  return st;
}

/** The current state: is a newer version out (and not skipped), when it was last checked. */
async function status() {
  const s = await store.getSettings();
  const l = await saved();
  return { ...core.state(l.latest, app.getVersion(), { skipped: s.updates?.skipped }), checkedAt: l.checkedAt || null, error: l.error || '', enabled: s.updates?.check !== false };
}

/** For paired phones (/api/info): the newest Android and watch APKs, nothing else. */
async function forDevices() {
  const l = await saved();
  return l.latest?.android ? { version: l.latest.version, android: l.latest.android, wear: l.latest.wear || null, page: l.latest.page } : null;
}

function start(opts = {}) {
  notify = opts.notify || notify;
  clearInterval(timer);
  const due = async () => {
    const l = await saved();
    if (Date.now() - (l.checkedAt || 0) >= DAY_MS - 60000) await check();
  };
  setTimeout(() => due().catch(() => {}), FIRST_CHECK_MS).unref?.();
  timer = setInterval(() => due().catch(() => {}), 60 * 60 * 1000);
  timer.unref?.();
}

module.exports = { start, check, status, forDevices, REPO };
