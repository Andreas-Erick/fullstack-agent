// History's search, the pure part: folding text so case and accents don't matter, the words of a query,
// what a message shows as plain text, which conversation matches, the snippet around the match, the
// status lines, the renderer's search state and what History's list shows. Shared by History (history.js) and
// the main process (main/historysearch.js, through main/historycore.js), so a query and a text are always
// folded the same way. No DOM, no app state.

export const MAX_QUERY = 200;
export const MAX_TERMS = 8;
export const MAX_TERM = 64;
export const MAX_MESSAGE = 20000;
export const SNIPPET = { width: 100, lead: 24 };
const MAX_MARKS = 40;
const MAX_COUNT = 20; // occurrences counted per term when ranking a conversation's messages
const SNAP = 15; // a snippet's cut moves to a space at most this far

// ------------------------------------------------------------------ folding
// One code point, folded: compatibility forms split (ﬁ → fi), lower case, accents dropped, ß → ss and
// final sigma → σ. Cached: most texts repeat the same few letters.
const folds = new Map();
function foldPoint(cp) {
  let f = folds.get(cp);
  if (f === undefined) {
    f = String.fromCodePoint(cp).normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/ß/g, 'ss').replace(/ς/g, 'σ');
    if (folds.size < 8192) folds.set(cp, f);
  }
  return f;
}

/** The text folded, and with `map` where each folded char came from: `start[i]`/`end[i]` are the original
 *  UTF-16 range of the code point that produced `folded[i]` (one code point can make several or none). */
export function foldMap(text, { map = false } = {}) {
  const s = String(text ?? '');
  // eslint-disable-next-line no-control-regex
  if (!map && /^[\x00-\x7f]*$/.test(s)) return { folded: s.toLowerCase(), start: null, end: null };
  let folded = '';
  const start = map ? [] : null;
  const end = map ? [] : null;
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i);
    const len = cp > 0xffff ? 2 : 1;
    const out = cp < 0x80 ? (cp >= 65 && cp <= 90 ? String.fromCharCode(cp + 32) : s[i]) : foldPoint(cp);
    folded += out;
    if (map) for (let k = 0; k < out.length; k++) (start.push(i), end.push(i + len));
    i += len;
  }
  return { folded, start, end };
}

/** The only fold: queries and texts always go through it. */
export const fold = (text) => foldMap(text).folded;

// A string cut to at most `n` UTF-16 units, never inside a surrogate pair.
function cut(s, n) {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

// ------------------------------------------------------------------ queries
const QUOTE = /["“”„]([^"“”„]*)["“”„]|(\S+)/g;
const LEADING = /^[\s"'“”„‘’‚«»()[\]{}<>]+/;
const TRAILING = /[\s"'“”„‘’‚«»()[\]{}<>,.;:!?]+$/;

/** The words of a query, folded: "quoted phrases" stay one term, punctuation at the ends goes (inner
 *  punctuation stays: c++, some_function), duplicates and terms shorter than `min` are dropped. */
export function terms(query, { min = 1 } = {}) {
  const q = String(query ?? '').slice(0, MAX_QUERY);
  const out = [];
  for (const m of q.matchAll(QUOTE)) {
    let t = fold(m[1] ?? m[2]).replace(/\s+/g, ' ').replace(LEADING, '').replace(TRAILING, '');
    t = cut(t, MAX_TERM).trim();
    if ([...t].length < min || out.includes(t)) continue;
    out.push(t);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/** True when the message search has something to look for (a word of 2+ characters). */
export const searchable = (query) => terms(query, { min: 2 }).length > 0;

/** Every term occurs in the text (a title), ignoring case and accents; true for no terms. */
export function matchesAll(text, ts) {
  if (!ts?.length) return true;
  const f = fold(text);
  return ts.every((t) => f.includes(t));
}

// Sorted, overlapping or touching ranges joined.
function merge(ranges) {
  const out = [];
  for (const [s, e] of ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// Every occurrence of the terms in a folded text, as original ranges: [{ s, e, term }].
function occurrences(fm, ts, cap) {
  const out = [];
  ts.forEach((t, term) => {
    if (!t) return;
    for (let i = fm.folded.indexOf(t); i !== -1 && out.length < cap; i = fm.folded.indexOf(t, i + t.length)) out.push({ s: fm.start[i], e: fm.end[i + t.length - 1], term });
  });
  return out.sort((a, b) => a.s - b.s);
}

/** Where the terms occur in `text`: original [start, end) ranges, sorted and merged (at most 40 found). */
export function marks(text, ts) {
  if (!ts?.length) return [];
  return merge(occurrences(foldMap(text, { map: true }), ts, MAX_MARKS).map((o) => [o.s, o.e]));
}

// ------------------------------------------------------------------ messages
/** Markdown as the words a reader sees: no fences, images, link targets, markers or emphasis. */
export function plainText(md) {
  const lines = [];
  for (let line of String(md ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) continue; // the fence line; the code inside stays
    if (/^[\s|:-]*-[\s|:-]*$/.test(line) && /-{3}/.test(line)) continue; // a table's separator row, a rule
    line = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, (_, a) => a.split('/').pop().replace(/\.md$/i, ''))
      .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, '')
      .replace(/^\s*(?:(?:#{1,6}(?=\s)|>|[-*+](?=\s)|\d+[.)](?=\s)|\[[ xX]\](?=\s))\s*)+/, '');
    if (line.includes('|')) line = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\|/g, ' · ');
    lines.push(line);
  }
  return lines
    .join('\n')
    .replace(/\*\*|~~|`/g, '')
    .replace(/\*(\S[^*]*?)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What a message shows in its bubble, as plain text; '' for one that isn't searched (hidden, a tool's,
 *  a stopped reply with nothing in it). A user message is found by what was typed (its display: a /skill
 *  as typed, a routine's run as '⏰ name', a message with files by its own words, never the files' text:
 *  files sent without a word have nothing to find, as their bubble shows no text). */
export function messageText(m) {
  if (!m || m.hidden || (m.role !== 'user' && m.role !== 'assistant')) return '';
  const raw = m.role !== 'user' ? m.content : m.attachments?.length ? m.display || '' : m.display || m.content;
  if (typeof raw !== 'string' || raw.trim() === '*(stopped)*') return '';
  return cut(plainText(raw.length > MAX_MESSAGE * 2 ? cut(raw, MAX_MESSAGE * 2) : raw), MAX_MESSAGE);
}

/** A conversation as the search reads it: one entry per message with text. */
export function docOf(conv) {
  const out = [];
  for (const m of conv?.messages || []) {
    const plain = messageText(m);
    if (!plain) continue;
    out.push({ id: m.id || null, role: m.role, at: Number(m.createdAt) || Number(conv.updatedAt) || 0, persona: m.role === 'assistant' ? m.persona || '' : '', plain, folded: fold(plain) });
  }
  return out;
}

function count(folded, t, cap) {
  let n = 0;
  for (let i = folded.indexOf(t); i !== -1 && n < cap; i = folded.indexOf(t, i + t.length)) n++;
  return n;
}

/** Every term in at least one message (not the title) → { index: the best message, hits: messages with a
 *  term }, else null. Best: the most distinct terms, then the most occurrences, then the earliest. */
export function matchConversation(doc, ts) {
  if (!ts?.length || !doc?.length) return null;
  const found = new Set();
  let best = null;
  let hits = 0;
  doc.forEach((d, index) => {
    let distinct = 0;
    let occ = 0;
    for (const t of ts) {
      const n = count(d.folded, t, MAX_COUNT);
      if (!n) continue;
      distinct++;
      occ += n;
      found.add(t);
    }
    if (!distinct) return;
    hits++;
    if (!best || distinct > best.distinct || (distinct === best.distinct && occ > best.occ)) best = { index, distinct, occ };
  });
  return found.size === ts.length ? { index: best.index, hits } : null;
}

const isLow = (s, i) => {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
};

/** About `width` characters of `text` around the terms → { text, marks } (marks relative to that text).
 *  The window holding the most distinct terms wins; its start is `lead` characters before the match,
 *  cuts move to a nearby space, '…' marks a cut end. */
export function snippet(text, ts, { width = SNIPPET.width, lead = SNIPPET.lead } = SNIPPET) {
  const s = String(text ?? '');
  const fm = foldMap(s, { map: true });
  const occ = ts?.length ? occurrences(fm, ts, 200) : [];
  if (!occ.length) {
    const head = cut(s, width);
    return { text: head.length < s.length ? `${head}…` : head, marks: [] };
  }
  // The anchor: the occurrence whose window holds the most distinct terms (ties: the earliest).
  let anchor = occ[0];
  let most = 0;
  for (const o of occ) {
    const from = o.s - lead;
    const to = from + width;
    const n = new Set(occ.filter((x) => x.s >= from && x.e <= to).map((x) => x.term)).size;
    if (n > most) (most = n), (anchor = o);
  }
  let start = Math.max(0, anchor.s - lead);
  let end = Math.min(s.length, start + width);
  start = Math.max(0, end - width); // near the end: shifted left to keep the width
  if (start > 0) {
    const sp = s.slice(start, Math.min(start + SNAP, anchor.s)).search(/\s/);
    if (sp >= 0) start += sp + 1;
  }
  if (end < s.length) {
    const from = Math.max(end - SNAP, anchor.e);
    const sp = s.slice(from, end).search(/\s\S*$/);
    if (sp >= 0) end = from + sp;
  }
  if (start > 0 && isLow(s, start)) start++;
  if (end < s.length && isLow(s, end)) end--;
  const pre = start > 0 ? '…' : '';
  const body = s.slice(start, end);
  const ranges = occ.filter((o) => o.e > start && o.s < end).map((o) => [Math.max(o.s, start) - start + pre.length, Math.min(o.e, end) - start + pre.length]);
  return { text: `${pre}${body}${end < s.length ? '…' : ''}`, marks: merge(ranges) };
}

// ------------------------------------------------------------------ status lines
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** The line under the message results: searching, stopped early (and why), unreadable files, a failure. */
export function hitStatus({ state = 'idle', shown = 0, done = true, capped = false, scanned = 0, total = 0, unreadable = 0 } = {}) {
  if (state === 'searching') return 'Searching the messages…';
  if (state === 'error') return 'Couldn’t search the messages.';
  if (state !== 'done') return '';
  const parts = [];
  if (!done && capped) parts.push(`The ${shown.toLocaleString('en-US')} newest chat${shown === 1 ? '' : 's'} with these words.`);
  else if (!done) parts.push(`Looked through the newest ${scanned.toLocaleString('en-US')} of ${plural(total, 'chat')}.`);
  if (unreadable > 0) parts.push(`${plural(unreadable, 'chat')} couldn’t be read.`);
  return parts.join(' ');
}

/** What the live region says when a message search finishes: "2 chats by title and 3 more by what was said."
 *  Then the list's status line (hitStatus) when there is one: a search that stopped early says so, and
 *  "No matches." only once every chat was looked through. `shown`: the message hits listed (not already
 *  found by title); `found`: all of them. */
export function resultSummary({ titles = 0, shown = 0, found = shown, state = 'done', done = true, capped = false, scanned = 0, total = 0, unreadable = 0 } = {}) {
  if (state === 'error') return 'Couldn’t search the messages.';
  if (state !== 'done') return '';
  let line;
  if (!titles && !shown) line = done ? 'No matches.' : 'No matches so far.';
  else if (!shown) line = `${plural(titles, 'chat')} by title.`;
  else if (!titles) line = `${plural(shown, 'chat')} by what was said.`;
  else line = `${plural(titles, 'chat')} by title and ${shown.toLocaleString('en-US')} more by what was said.`;
  const status = hitStatus({ state, shown: found, done, capped, scanned, total, unreadable });
  return status ? `${line} ${status}` : line;
}

// ------------------------------------------------------------------ the renderer's search state
// itemsQuery: the query the items were found for (query is the latest one asked).
export const HITS = Object.freeze({ query: '', itemsQuery: '', token: 0, state: 'idle', items: [], done: true, capped: false, cursor: null, scanned: 0, total: 0, unreadable: 0, error: '' });

function dedupe(items) {
  const seen = new Set();
  return items.filter((x) => !seen.has(x.id) && seen.add(x.id));
}

/** The message search's state in the window. A result counts only for the query it was asked for (its
 *  token); a newer query drops what an older one found once it isn't searchable. */
export function hitsReducer(hits = HITS, action = {}) {
  switch (action.type) {
    case 'query':
      if (!action.searchable) return { ...HITS, token: hits.token + 1 };
      return { ...hits, query: String(action.query ?? ''), token: hits.token + 1, state: 'searching', error: '' };
    case 'more': // "Search older chats": the same query, from its cursor
      return hits.cursor && hits.state === 'done' ? { ...hits, state: 'searching' } : hits;
    case 'result': {
      const r = action.result;
      if (action.token !== hits.token || !r || r.superseded || !Array.isArray(r.items)) return hits;
      const append = Boolean(action.append);
      return {
        ...hits,
        state: 'done',
        itemsQuery: hits.query,
        items: append ? dedupe([...hits.items, ...r.items]) : r.items,
        done: Boolean(r.done),
        capped: Boolean(r.capped),
        cursor: r.done ? null : r.cursor || null,
        scanned: (append ? hits.scanned : 0) + (Number(r.scanned) || 0),
        total: Number(r.total) || 0,
        unreadable: (append ? hits.unreadable : 0) + (Number(r.unreadable) || 0),
        error: '',
      };
    }
    case 'error':
      // The rows stay only when they are this query's (a failed "Search older chats"), never as matches
      // for words they weren't found for.
      if (action.token !== hits.token) return hits;
      return { ...hits, state: 'error', error: String(action.message || ''), items: hits.itemsQuery === hits.query ? hits.items : [] };
    case 'forget':
      return { ...hits, items: hits.items.filter((x) => x.id !== action.id) };
    default:
      return hits;
  }
}

/** The message results to show for `query`: null when it isn't searchable or nothing was asked yet.
 *  `listed` (a Set or Map of ids): only the chats still in the list (not one deleted since, as by Settings →
 *  Clear all conversations). `stale`: the rows were found for other words (dimmed until this query's
 *  result comes). */
export function messageHits(hits, query, listed = null) {
  if (!searchable(query) || !hits || hits.state === 'idle') return null;
  const items = listed ? hits.items.filter((x) => listed.has(x.id)) : hits.items;
  return { ...hits, items, stale: hits.itemsQuery !== String(query ?? '') };
}

// ------------------------------------------------------------------ the list
export const LIST_PAGE = 100; // rows of titles at a time: years of chats shouldn't all become rows
const DAY = 86400000;
const GROUPS = [
  ['Today', (t, d0) => t >= d0],
  ['Yesterday', (t, d0) => t >= d0 - DAY && t < d0],
  ['This week', (t, d0) => t >= d0 - 7 * DAY && t < d0 - DAY],
  ['Earlier', (t, d0) => t < d0 - 7 * DAY],
];

/** What History's list shows for the conversation index and the search box: the chats whose titles hold
 *  every word, a page of them (`limit`) in date groups (`startToday`: local midnight), how many older
 *  ones "Show more" adds; then the message hits not already found by title (each with its index entry,
 *  only chats still listed), their status line, whether "Search older chats" continues, whether the rows
 *  are stale, the empty line, and the counts for the live region. */
export function listModel(conversations, { query = '', limit = LIST_PAGE, startToday = 0, hits = HITS } = {}) {
  const q = String(query ?? '');
  const words = terms(q);
  const all = Array.isArray(conversations) ? conversations : [];
  const titled = all.filter((c) => matchesAll(c.title || '', words));
  const page = titled.slice(0, limit);
  const groups = [];
  for (const [label, test] of GROUPS) {
    const items = page.filter((c) => test(c.updatedAt, startToday));
    if (items.length) groups.push({ label, items });
  }
  const byId = new Map(all.map((c) => [c.id, c]));
  const h = messageHits(hits, q, byId);
  const titledIds = new Set(titled.map((c) => c.id));
  const found = h ? h.items.filter((x) => !titledIds.has(x.id)).map((hit) => ({ conv: byId.get(hit.id), hit })) : [];
  const status = h ? hitStatus({ state: h.state, shown: h.items.length, done: h.done, capped: h.capped, scanned: h.scanned, total: h.total, unreadable: h.unreadable }) : '';
  const older = Boolean(h && h.state === 'done' && !h.done && h.cursor);
  const pending = Boolean(h && (h.state !== 'done' || h.cursor));
  const empty = titled.length || found.length || pending ? '' : q.trim() ? 'No matches.' : 'No conversations yet.';
  return {
    words,
    groups,
    more: titled.length - page.length,
    searched: Boolean(h),
    found,
    status,
    older,
    stale: Boolean(h?.stale || h?.state === 'searching'),
    empty,
    counts: { titles: titled.length, shown: found.length, found: h?.items.length || 0 },
  };
}

/** Deleting row `id` from History (rows: [{ id, kind }] in list order): where the focus goes once it is
 *  gone (`next`: the row after it, else the one before, else null for the search) and, when the delete is
 *  cancelled, back to the row itself (`self`). */
export function afterDelete(rows, id) {
  const list = Array.isArray(rows) ? rows : [];
  const i = list.findIndex((r) => r.id === id);
  const near = list[i + 1] || list[i - 1] || null;
  return {
    next: near ? { id: near.id, kind: near.kind, part: 'open' } : null,
    self: { id, kind: list[i]?.kind, part: 'open' },
  };
}

/** A key on row `i` of `n`: the row to focus (↓ ↑ Home End; past the last stays on it), -1 for the search
 *  box (↑ from the first), undefined for any other key. */
export function rowTarget(key, i, n) {
  const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[key];
  if (to === undefined) return undefined;
  return to < 0 ? -1 : Math.min(to, n - 1);
}
