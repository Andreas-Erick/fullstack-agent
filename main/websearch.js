// Internet access for the agent: web search (DuckDuckGo by default, no key needed; or SearXNG,
// Brave Search, Tavily) and fetching a page as readable text.
const dns = require('dns').promises;
const net = require('net');
const store = require('./store');
const { isPrivateAddress } = require('./netcore');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
function decode(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const stripTags = (s) => decode(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ search
async function search(query, limit) {
  const s = await store.getSettings();
  if (!s.web.enabled) throw new Error('Internet access is disabled in Settings.');
  const max = Math.min(15, limit || s.web.maxResults || 6);
  const provider = s.web.provider || 'duckduckgo';
  let results;
  if (provider === 'searxng') results = await searxng(query, s.web.searxngUrl);
  else if (provider === 'brave') results = await brave(query, s.web.braveKey);
  else if (provider === 'tavily') results = await tavily(query, s.web.tavilyKey, max);
  else results = await duckduckgo(query);
  return { query, provider, results: results.slice(0, max) };
}

async function duckduckgo(query) {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
    body: new URLSearchParams({ q: query, kl: 'wt-wt' }),
    signal: AbortSignal.timeout(15000),
  });
  const html = await res.text();
  const results = [];
  const blocks = html.split(/<div class="result results_links/).slice(1);
  for (const b of blocks) {
    const a = b.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decode(a[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    const snip = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    results.push({ title: stripTags(a[2]), url, snippet: stripTags(snip?.[1]) });
  }
  if (!results.length && /anomaly|captcha/i.test(html)) throw new Error('DuckDuckGo is rate-limiting requests right now. Try again shortly or configure another search provider in Settings.');
  return results;
}

async function searxng(query, base) {
  if (!base) throw new Error('Set your SearXNG URL in Settings → Internet.');
  const url = `${base.replace(/\/+$/, '')}/search?${new URLSearchParams({ q: query, format: 'json' })}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`SearXNG error ${res.status} (is the JSON format enabled on your instance?)`);
  const json = await res.json();
  return (json.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content || '' }));
}

async function brave(query, key) {
  if (!key) throw new Error('Add your Brave Search API key in Settings → Internet.');
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: '15' })}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Brave Search error ${res.status}`);
  const json = await res.json();
  return (json.web?.results || []).map((r) => ({ title: stripTags(r.title), url: r.url, snippet: stripTags(r.description) }));
}

async function tavily(query, key, max) {
  if (!key) throw new Error('Add your Tavily API key in Settings → Internet.');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: max }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Tavily error ${res.status}`);
  const json = await res.json();
  return (json.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}

// ------------------------------------------------------------------- fetch
// Refuse private/loopback addresses so a malicious page or prompt can't make the agent probe the local network.
async function assertPublic(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs can be fetched');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new Error(`Could not resolve ${host}`);
  for (const a of addrs) {
    if (isPrivateAddress(a)) throw new Error('Fetching local or private network addresses is not allowed');
  }
  return u;
}

/**
 * True for any address that isn't the public internet: loopback, private and link-local ranges, the
 * shared range 100.64/10 (Tailscale and carrier NAT: the user's other devices), multicast and reserved,
 * the unspecified address, and IPv4 written inside IPv6 (::ffff:127.0.0.1, which URLs turn into
 * ::ffff:7f00:1). Anything that doesn't parse counts as private. In netcore.js, shared with the agent window.
 */

function htmlToText(html) {
  let h = String(html);
  const title = stripTags(h.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const main = h.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i);
  if (main && main[2].length > 500) h = main[2];
  h = h
    .replace(/<(script|style|noscript|svg|iframe|nav|footer|header|form|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n\n${'#'.repeat(Number(n))} ${stripTags(t)}\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<a[^>]+href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => {
      const text = stripTags(t);
      return text ? `[${text}](${decode(href)})` : '';
    })
    .replace(/<(p|div|section|br|tr|blockquote|pre)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decode(h)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { title, text };
}

async function fetchPage(url, maxChars = 20000) {
  const s = await store.getSettings();
  if (!s.web.enabled) throw new Error('Internet access is disabled in Settings.');
  // Redirects one hop at a time, each checked before it is requested: with redirect 'follow', a public
  // page could bounce the request to a local address, which was then sent before res.url was checked.
  let res;
  let at = url;
  for (let hop = 0; ; hop++) {
    await assertPublic(at);
    res = await fetch(at, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    const next = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!next) break;
    if (hop >= 5) throw new Error(`Too many redirects fetching ${url}`);
    at = new URL(next, at).href;
  }
  url = at;
  const type = res.headers.get('content-type') || '';
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  if (!/text|json|xml/.test(type)) throw new Error(`Unsupported content type "${type}"`);
  const body = (await res.text()).slice(0, 3_000_000);
  const { title, text } = /html/.test(type) ? htmlToText(body) : { title: '', text: body };
  return {
    url: res.url || url,
    title,
    chars: text.length,
    content: text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated, ${text.length} chars total]` : text,
  };
}

module.exports = { search, fetchPage, htmlToText, assertPublic, isPrivateAddress };
