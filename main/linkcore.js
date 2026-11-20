// The vault's links, pure (linkindex.js does the reading): [[wikilinks]] in a note, resolved to notes the
// way Obsidian does it, and the index of links and backlinks over every note. Used for the Growth map's
// edges (replay.js), the backlinks under a note in the Vault view, and the vault_links tool.

/** The link targets written in a note: [[Target]], [[Target|alias]], [[Target#Heading]], ![[embeds]].
 *  Links inside code (fenced blocks and `inline code`) are not links. */
function linksOf(text) {
  const plain = String(text || '')
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
  const out = [];
  const seen = new Set();
  for (const m of plain.matchAll(/!?\[\[([^\]\n]+?)\]\]/g)) {
    const target = m[1].split('|')[0].split('#')[0].trim().replace(/\\/g, '/');
    if (!target || seen.has(target.toLowerCase())) continue;
    seen.add(target.toLowerCase());
    out.push(target);
  }
  return out;
}

const stem = (p) => p.replace(/\.md$/i, '');
const base = (p) => stem(p).split('/').pop().toLowerCase();

/** A lookup over the vault's note paths ("Folder/Note.md"): by full path and by note name. */
function resolver(paths) {
  const byPath = new Map();
  const byName = new Map();
  for (const p of paths) {
    byPath.set(stem(p).toLowerCase(), p);
    const n = base(p);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(p);
  }
  // Several notes with one name: the one with the shortest path (closest to the root), as Obsidian.
  for (const list of byName.values()) list.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return (target) => {
    const t = stem(String(target).replace(/^\/+/, '')).toLowerCase();
    if (byPath.has(t)) return byPath.get(t);
    if (/\.(png|jpe?g|gif|svg|webp|pdf|mp3|mp4|canvas)$/i.test(t)) return null; // attachments
    return byName.get(t.split('/').pop())?.[0] || null;
  };
}

/** One note's link targets resolved: `to` (no self-links or duplicates) and how many point to no note. */
function linkNote(notePath, targets, resolve) {
  const to = [];
  let unresolved = 0;
  for (const target of targets || []) {
    const p = resolve(target);
    if (!p) {
      unresolved++;
      continue;
    }
    if (p === notePath || to.includes(p)) continue;
    to.push(p);
  }
  return { to, unresolved };
}

/**
 * The index over notes [{ path, text }] (or { path, targets } from linksOf, as linkindex.js keeps them):
 * links (path → the notes it links to), backlinks (path → the notes linking to it), and how many links
 * point to no note yet.
 */
function build(notes, resolve = resolver(notes.map((n) => n.path))) {
  const links = {};
  const backlinks = {};
  let unresolved = 0;
  for (const n of notes) {
    const r = linkNote(n.path, n.targets || linksOf(n.text), resolve);
    unresolved += r.unresolved;
    for (const p of r.to) (backlinks[p] ||= []).push(n.path);
    if (r.to.length) links[n.path] = r.to;
  }
  for (const list of Object.values(backlinks)) list.sort();
  return { links, backlinks, unresolved, notes: notes.length };
}

/**
 * The index after one note's links changed while the set of notes stayed the same (an edit): a new index,
 * the given one untouched (a caller may still hold its lists). `before`/`after` are linkNote results;
 * equal to build() over the changed notes.
 */
function relinkNote(index, notePath, before, after) {
  const links = { ...index.links };
  const backlinks = { ...index.backlinks };
  for (const p of before.to) {
    const list = (backlinks[p] || []).filter((x) => x !== notePath);
    if (list.length) backlinks[p] = list;
    else delete backlinks[p];
  }
  for (const p of after.to) backlinks[p] = [...(backlinks[p] || []), notePath].sort();
  if (after.to.length) links[notePath] = after.to;
  else delete links[notePath];
  return { links, backlinks, unresolved: index.unresolved + after.unresolved - before.unresolved, notes: index.notes };
}

/** The links as map edges between notes on a vault map (replaycore.vaultMap): f:<path> → f:<path>. */
function edges(links, present) {
  const out = [];
  for (const [from, list] of Object.entries(links || {})) {
    if (!present.has(from)) continue;
    for (const to of list) if (present.has(to)) out.push({ from: `f:${from}`, to: `f:${to}`, kind: 'link', count: 1, labels: [] });
  }
  return out;
}

module.exports = { linksOf, resolver, linkNote, build, relinkNote, edges };
