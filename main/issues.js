// "Report a problem" (privacy.reportIssues, opt-in, user-only): errors from the log, offered once each
// as an anonymized GitHub issue that the user reviews and submits themselves in the browser. Nothing is
// sent by the app. Remembered in <userData>/issue-reports.json (which problems were offered or
// reported). The anonymizing and the issue text are in the pure issuecore.js.
const os = require('os');
const path = require('path');
const store = require('./store');
const log = require('./logger');
const core = require('./issuecore');

const file = () => path.join(store.dataDir(), 'issue-reports.json');
const KEEP = 200;

async function known(settings) {
  const vault = await require('./obsidian').vaultPath().catch(() => null);
  const names = [settings.agent?.name, ...(settings.personas?.list || []).map((p) => p?.agent?.name || p?.name)].filter(Boolean);
  return { home: os.homedir(), user: os.userInfo().username, root: path.join(__dirname, '..'), vault, names };
}

function env(settings) {
  return { version: require('electron').app?.getVersion?.() || '?', os: `${os.type()} ${os.release()} (${process.arch})`, electron: process.versions.electron, brain: settings.llm?.provider };
}

async function seen() {
  const j = await store.readJson(file(), {});
  return j && typeof j.offered === 'object' ? j : { offered: {} };
}

/** The errors of the last day not offered yet: [{ key, title, body }] (empty while reporting is off). */
async function pending() {
  const s = await store.getSettings();
  if (!s.privacy?.reportIssues) return [];
  const { offered } = await seen();
  const groups = require('./errorinsight').fromLog({ limit: 15 }).filter((g) => g.level === 'error');
  const [k, e] = [await known(s), env(s)];
  return groups.map((g) => core.report(g, e, k)).filter((r) => !offered[r.key]).map((r) => ({ ...r, body: log.redact(r.body), title: log.redact(r.title) }));
}

async function mark(key, how) {
  const j = await seen();
  j.offered[String(key).slice(0, 20)] = { at: Date.now(), how };
  const keep = Object.entries(j.offered).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP);
  await store.writeJsonAtomic(file(), { offered: Object.fromEntries(keep) });
}

/** Opens the filled-in issue in the browser (the user submits it there); only for a pending problem. */
async function open(key) {
  const r = (await pending()).find((x) => x.key === key);
  if (!r) throw new Error('That problem is no longer in the log.');
  const url = core.issueUrl(require('./updates').REPO, r);
  await require('electron').shell.openExternal(url);
  await mark(key, 'opened');
  log.info('problem report opened on GitHub', { key });
  return { opened: true };
}

const dismiss = (key) => mark(key, 'dismissed').then(() => ({ dismissed: true }));

module.exports = { pending, open, dismiss };
