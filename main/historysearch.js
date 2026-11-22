// History's search through what was said (conv:search in main.js): the newest conversations first, in
// the order of the conversation index (main/store.js), each read once and kept as plain folded text in a
// small cache in memory (never on disk; conversations are sealed at rest). A call stops after LIMIT
// matching chats or BUDGET_MS with a cursor to go on from, and a newer call (an empty query too) stops an
// older one at its next file. It returns ids, titles, dates and a snippet, never a conversation.
// The matching itself is the pure renderer/js/historycore.mjs, shared with the chat.
const store = require('./store');
const core = require('./historycore');
const log = require('./logger');

const LIMIT = 30;
const MAX_LIMIT = 50;
const BUDGET_MS = 400;
let CACHE_CHARS = 8_000_000; // ≈ the newest few hundred chats

// ------------------------------------------------------------------ recency cache
// id → { stamp, updatedAt, doc, chars }. Full: the oldest conversations (lowest updatedAt) go first, and an
// entry older than all of them isn't stored, so a deep scan into old chats never pushes out the new ones.
// Reading never reorders it.
const cache = new Map();
let cachedChars = 0;

function cacheDelete(id) {
  const e = cache.get(id);
  if (!e) return;
  cachedChars -= e.chars;
  cache.delete(id);
}

function oldestCached() {
  let oldest = null;
  for (const [id, e] of cache) if (!oldest || e.updatedAt < oldest.e.updatedAt) oldest = { id, e };
  return oldest;
}

function cacheSet(id, entry) {
  cacheDelete(id);
  if (entry.chars > CACHE_CHARS / 4) return false;
  while (cachedChars + entry.chars > CACHE_CHARS && cache.size) {
    const oldest = oldestCached();
    if (entry.updatedAt < oldest.e.updatedAt) return false;
    cacheDelete(oldest.id);
  }
  cache.set(id, entry);
  cachedChars += entry.chars;
  return true;
}

// The conversation's text: from the cache while its index summary is unchanged (updatedAt and the message
// count: the journal saves without touching updatedAt), else read (unsealed) once. null = unreadable.
async function textOf(c) {
  const stamp = `${c.updatedAt}:${c.count}`;
  const hit = cache.get(c.id);
  if (hit && hit.stamp === stamp) return hit;
  const conv = await store.getConversation(c.id);
  if (!conv) return null;
  const doc = core.docOf(conv);
  const entry = { stamp, updatedAt: Number(c.updatedAt) || 0, doc, chars: doc.reduce((n, d) => n + d.plain.length + d.folded.length, 0) };
  cacheSet(c.id, entry);
  return entry;
}

// ------------------------------------------------------------------ search
let generation = 0;

const byRecency = (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

// A cursor from the window: { updatedAt, id } of the last conversation looked at, or ignored.
const validCursor = (c) => (c && Number.isFinite(c.updatedAt) && typeof c.id === 'string' && /^[a-z0-9_-]+$/i.test(c.id) ? { updatedAt: c.updatedAt, id: c.id } : null);

/** Conversations whose messages hold every word of `query` (2+ characters each), newest first. */
async function search(query, { cursor = null, limit = LIMIT, budgetMs = BUDGET_MS, now = Date.now } = {}) {
  const gen = ++generation;
  const ts = core.terms(query, { min: 2 });
  if (!ts.length) return { items: [], done: true, capped: false, cursor: null, scanned: 0, total: 0, unreadable: 0 };
  limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(limit)) || LIMIT));
  const t0 = now();
  const list = (await store.listConversations()).sort(byRecency);
  const ids = new Set(list.map((c) => c.id));
  for (const id of [...cache.keys()]) if (!ids.has(id)) cacheDelete(id);
  const from = validCursor(cursor);
  let i = 0;
  if (from) {
    i = list.findIndex((c) => byRecency(c, from) > 0);
    if (i < 0) i = list.length;
  }
  const items = [];
  let scanned = 0;
  let unreadable = 0;
  let last = null;
  let stopped = false;
  for (; i < list.length; i++) {
    if (gen !== generation) return { superseded: true };
    if (scanned && (items.length >= limit || now() - t0 > budgetMs)) {
      stopped = true;
      break;
    }
    const c = list[i];
    const entry = await textOf(c).catch(() => null); // an unreadable conversation is skipped (the store logs it)
    scanned++;
    last = { updatedAt: Number(c.updatedAt) || 0, id: c.id }; // as byRecency sorts it, or the cursor is refused
    if (!entry) {
      // Sealed for another user, or broken; a chat deleted meanwhile isn't counted.
      if ((await store.listConversations()).some((x) => x.id === c.id)) unreadable++;
      continue;
    }
    const m = core.matchConversation(entry.doc, ts);
    if (!m) continue;
    const msg = entry.doc[m.index];
    items.push({ id: c.id, title: c.title || '', updatedAt: c.updatedAt, messageId: msg.id, role: msg.role, persona: msg.persona, at: msg.at || c.updatedAt, snippet: core.snippet(msg.plain, ts), hits: m.hits });
  }
  if (gen !== generation) return { superseded: true };
  const capped = stopped && items.length >= limit;
  if (stopped && !capped) log.info('history search slow', { ms: now() - t0, scanned, total: list.length, items: items.length, cached: cache.size });
  return { items, done: !stopped, capped, cursor: stopped ? last : null, scanned, total: list.length, unreadable };
}

/** A deleted conversation: out of the cache. */
const forget = (id) => cacheDelete(id);

/** Every conversation deleted. */
function clear() {
  cache.clear();
  cachedChars = 0;
}

// Tests: a smaller cache, and what it holds.
function _setBudget(chars) {
  CACHE_CHARS = chars;
}
const _cached = () => [...cache.keys()];

module.exports = { LIMIT, MAX_LIMIT, BUDGET_MS, search, forget, clear, _setBudget, _cached };
