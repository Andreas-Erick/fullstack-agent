// Where a turn may send a request once it has read outside content (approvals.askOutbound): hosts the
// user's own message named (or a subdomain of one), hosts this turn fetched or searched before the
// taint, and hosts the user allowed in this turn. Pure (test/outbound.test.js).
const MAX_HOSTS = 64;
const MAX_TEXT = 100000;
const URLISH = /\bhttps?:\/\/[^\s"'<>()[\]{}`]+/gi;
const TOKEN_SPLIT = /[\s"'<>()[\]{},;!?`|]+/;
const HOSTLIKE = /^[a-z0-9.-]+\.[a-z]{2,24}$/i;

function hostOf(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase().replace(/\.$/, ''); // punycode for IDN, no user@ or port
  } catch {
    return '';
  }
}

/** The hosts a text names: its links, and (bare) names such as docs.python.org. Linear in the text. */
function hostsIn(text, { bare = true } = {}) {
  const s = String(text || '').slice(0, MAX_TEXT);
  const out = new Set();
  for (const m of s.matchAll(URLISH)) {
    if (out.size >= MAX_HOSTS) return out;
    const h = hostOf(m[0]);
    if (h) out.add(h);
  }
  if (!bare) return out;
  for (const raw of s.split(TOKEN_SPLIT)) {
    if (out.size >= MAX_HOSTS) break;
    // A name is at most 253 characters (checked before any regex: trimming a long run of dots is
    // quadratic); an address with an "@" is not a host.
    if (raw.length > 260 || raw.includes('@')) continue;
    const tok = raw.replace(/^[.:/]+|[.:/]+$/g, '');
    if (!HOSTLIKE.test(tok)) continue;
    const h = hostOf(`https://${tok}`);
    if (h) out.add(h);
  }
  return out;
}

// Claude Code's WebSearch result: `Links: ${JSON.stringify([{ title, url }…])}` lines between the
// search's own text, or search_result blocks.
const LINKS_LINE = /^Links: (\[.*\])/gm;

/**
 * The hosts of a web search's own result links: its "Links: […]" lines or its search_result blocks'
 * sources, never the summary or snippet text around them (a page's own words). Anything else gives nothing.
 */
function resultLinkHosts(content) {
  const out = new Set();
  const add = (url) => {
    const h = out.size < MAX_HOSTS && hostOf(url);
    if (h) out.add(h);
  };
  const fromText = (text) => {
    for (const m of String(text ?? '').slice(0, MAX_TEXT).matchAll(LINKS_LINE)) {
      let links = null;
      try {
        links = JSON.parse(m[1]);
      } catch {
        continue; // not a list of links: nothing from this line
      }
      if (Array.isArray(links)) for (const link of links.slice(0, MAX_HOSTS * 4)) add(link?.url);
    }
  };
  if (typeof content === 'string') fromText(content);
  else if (Array.isArray(content)) {
    for (const block of content.slice(0, 200)) {
      if (block?.type === 'search_result') add(block.source);
      else if (block?.type === 'text') fromText(block.text);
    }
  }
  return out;
}

/** Hosts the turn met before it read anything outside (later ones could be a page's choice). */
function noteHosts(turn, hosts) {
  if (!turn || turn.tainted) return;
  turn.knownHosts ||= new Set();
  for (const h of hosts || []) if (h && turn.knownHosts.size < MAX_HOSTS * 4) turn.knownHosts.add(h);
}

const covers = (named, host) => host === named || host.endsWith(`.${named}`);

/** { decision: 'allow' | 'ask', host } for a request to `url` in this turn. */
function check(turn, url, { tainted = Boolean(turn?.tainted) } = {}) {
  const host = hostOf(url);
  if (!tainted) return { decision: 'allow', host };
  if (!host) return { decision: 'ask', host: '' };
  if ([...(turn?.userHosts || [])].some((n) => covers(n, host))) return { decision: 'allow', host };
  if (turn?.knownHosts?.has(host) || turn?.outboundApproved?.has(host)) return { decision: 'allow', host };
  return { decision: 'ask', host };
}

module.exports = { MAX_HOSTS, hostOf, hostsIn, resultLinkHosts, noteHosts, check };
