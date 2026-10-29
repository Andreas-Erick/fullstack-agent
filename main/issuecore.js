// Anonymized problem reports for the app's public GitHub repository (privacy.reportIssues, opt-in).
// The app never sends one: it builds the text, the user reads it, and "Open on GitHub" opens a new
// issue in their browser, filled in, for them to submit. Pure (test/issues.test.js).
//
// What a report holds: the app version, the operating system and Electron version, the brain kind,
// the problem's event name, message, count and where in the app's code it happened. What it never
// holds: conversations, notes, file names outside the app, the user's name or home folder, emails,
// addresses, keys or tokens (removed below, and again by the logger's redact()).

const MAX_BODY = 5500; // a GitHub "new issue" link stays well under the browsers' URL limits

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Removes what could identify the user. known: { home, user, root, vault, names: [] } (the user's
 * home folder, account name, the app's folder, the vault, other names such as the persona's).
 */
function anonymize(text, known = {}) {
  let t = String(text ?? '');
  const kind = (p) => (/\.(\w{1,6})$/.test(p) ? ` .${/\.(\w{1,6})$/.exec(p)[1]}` : '');
  const rest = "[^\\s'\"`)<>,;]*"; // the remainder of a path
  // Web addresses first (only the host is kept), so their "s://" is never taken for a drive.
  t = t.replace(/\bhttps?:\/\/[^\s'"`)<>]+/gi, (u) => {
    try {
      const x = new URL(u);
      return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(x.hostname) ? `${x.protocol}//${x.hostname}:${x.port || ''}` : `${x.protocol}//${x.hostname}`;
    } catch {
      return '<url>';
    }
  });
  // The app's own files keep their path inside the app: "main/llm.js:120".
  for (const root of [known.root].filter(Boolean)) t = t.replace(new RegExp(`${escapeRe(root).replace(/\\\\|\//g, '[\\\\/]')}[\\\\/]?`, 'gi'), '');
  // A note in the vault, or anything in the home folder: neither its folder nor its name.
  for (const [dir, label] of [[known.vault, 'vault'], [known.home, 'home']]) if (dir) t = t.replace(new RegExp(`${escapeRe(dir).replace(/\\\\|\//g, '[\\\\/]')}${rest}`, 'gi'), (p) => `<${label}${kind(p)}>`);
  // Any other absolute path: only its file type.
  t = t.replace(new RegExp(`(?:(?<![A-Za-z])[A-Za-z]:[\\\\/]|\\\\\\\\|\\/(?:Users|home|var|tmp|private|mnt|opt)\\/)${rest}`, 'g'), (p) => `<path${kind(p)}>`);
  t = t
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => (ip === '127.0.0.1' ? ip : '<ip>'))
    .replace(/\b(?:sk|gsk|pk|rk|xai|ghp|gho|github_pat|AIza)[-_A-Za-z0-9]{12,}\b/g, '<key>')
    // Long runs of letters and digits mixed are tokens; a long tool name (mcp__service__tool) is not.
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])(?![A-Za-z0-9_-]*__)[A-Za-z0-9_-]{32,}\b/g, '<token>')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<token>');
  for (const n of [known.user, ...(known.names || [])].filter((x) => x && String(x).length >= 3)) t = t.replace(new RegExp(`\\b${escapeRe(n)}\\b`, 'gi'), '<name>');
  return t;
}

// Details logged as data ({ name, ms, input, preview… }) keep only what describes the failure, never
// what went into it or came out of it (a tool's input can be the user's own words).
const SAFE_FIELDS = ['name', 'tool', 'kind', 'mode', 'code', 'status', 'statusCode', 'reason', 'channel', 'ms', 'attempt', 'engine', 'provider', 'server', 'type', 'level'];
function message(raw) {
  const s = String(raw || '').trim();
  if (!s.startsWith('{')) return s;
  let data;
  try {
    data = JSON.parse(s);
  } catch {
    return '(details not included)'; // cut off: can't tell what is in it
  }
  const kept = Object.entries(data && typeof data === 'object' ? data : {}).filter(([k, v]) => SAFE_FIELDS.includes(k) && ['string', 'number', 'boolean'].includes(typeof v) && String(v).length <= 80);
  const dropped = Object.keys(data || {}).length - kept.length;
  return `${kept.map(([k, v]) => `${k}=${v}`).join(', ')}${dropped ? `${kept.length ? ' ' : ''}(+${dropped} detail${dropped > 1 ? 's' : ''} not included)` : ''}`;
}

/** A stable id for a problem (its event and message without paths and numbers), to offer it once. */
function keyOf(problem) {
  const msg = String(problem.message || '').replace(/https?:\/\/\S+/g, '<url>').replace(/\b(?:[A-Za-z]:)?[\\/][\w\\/.-]+/g, '<path>').replace(/\d+/g, '#');
  const s = `${problem.event}|${msg.slice(0, 200)}`;
  let h = 7;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

/**
 * The issue for one problem group (errorinsight.analyze). env: { version, os, electron, brain }.
 * Returns { key, title, body }, already anonymized.
 */
function report(problem, env = {}, known = {}) {
  const a = (s) => anonymize(s, known);
  const where = (problem.locations || []).slice(0, 6).map((l) => `- \`${a(l)}\``);
  const body = [
    '_Reported from the app with "Report a problem" (anonymized; the reporter reviewed this text before sending)._',
    '',
    '### What went wrong',
    `- Event: \`${a(problem.event)}\``,
    `- Message: ${a(message(problem.message)) || '(none)'}`,
    `- Seen ${problem.count || 1}× (first ${String(problem.first || '').slice(0, 10) || '?'}, last ${String(problem.last || '').slice(0, 10) || '?'})`,
    problem.where ? `- Logged in: \`${a(problem.where)}\`` : '',
    where.length ? `\n### Where in the code\n${where.join('\n')}` : '',
    '',
    '### Environment',
    `- Siren ${a(env.version || '?')} · ${a(env.os || '?')} · Electron ${a(env.electron || '?')}`,
    env.brain ? `- Brain: ${a(env.brain)}` : '',
    '',
    '### What I was doing (optional)',
    '<!-- Anything that helps reproduce it. Please don\'t paste private content. -->',
  ]
    .filter((x) => x !== '')
    .join('\n');
  const title = `[auto] ${a(problem.event)}: ${a(message(problem.message)).slice(0, 90)}`.trim();
  return { key: keyOf(problem), title: title.slice(0, 140), body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n…` : body };
}

/** The "new issue" link on GitHub, filled in. Only for owner/name repositories. */
function issueUrl(repo, { title, body }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ''))) throw new Error('Not a GitHub repository name');
  return `https://github.com/${repo}/issues/new?${new URLSearchParams({ title, body, labels: 'auto-report' })}`;
}

module.exports = { anonymize, message, keyOf, report, issueUrl, MAX_BODY };
