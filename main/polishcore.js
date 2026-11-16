// ✨ Polish for a note (the Notes view, main/notebook.js polish), pure: which other notes to offer as
// links, the prompt, and the checks on what comes back. The model rewrites the note's text; it never
// writes it: the user sees the result and accepts it or keeps theirs. test/polish.test.js.

const MAX_NOTE = 30000; // characters of a note sent to be polished
const MAX_CANDIDATES = 20; // other notes offered as possible links

const STOP = new Set('the and for with that this from have has are was were but not you your our their them they its his her she him into about what when where which who why how all any can will would should could also just than then there here more most some such very only over under after before while been being does did doing done into onto upon off out per via der die das und mit von den dem ein eine ist sind nicht auch auf für aus bei nach'.split(' '));
const words = (s) => new Set((String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !STOP.has(w)));

/**
 * The other notes most likely related to this one, by shared words (titles count more), plus the ones
 * it already links to: [{ title, snippet }]. `notes` = notebook.list() entries ({ title, snippet, text }).
 */
function candidates(note, notes, max = MAX_CANDIDATES) {
  const own = words(`${note.title} ${note.body}`);
  const linked = new Set([...String(note.body || '').matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim().toLowerCase()));
  return notes
    .filter((n) => n.title.toLowerCase() !== String(note.title || '').toLowerCase())
    .map((n) => {
      const title = words(n.title);
      const text = words(`${n.text || n.snippet || ''} ${(n.tags || []).join(' ')}`);
      let score = 0;
      for (const w of title) if (own.has(w)) score += 3;
      for (const w of text) if (own.has(w)) score += 1;
      if (linked.has(n.title.toLowerCase())) score += 100;
      return { title: n.title, snippet: String(n.snippet || '').slice(0, 140), score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ title, snippet }) => ({ title, snippet }));
}

/** The instruction for the model: rewrite clearly, keep everything, link only to listed notes. */
function prompt(note, related) {
  const list = related.length ? related.map((r) => `- ${r.title}${r.snippet ? ` — ${r.snippet}` : ''}`).join('\n') : '(none)';
  return `You are tidying up a personal note the user wrote quickly. Rewrite it so it reads clearly and is well organised, in the user's own voice and in the language the note is written in.

Rules:
- Keep every fact, idea, number, name, date, formula, link and #tag. Add no information that isn't in the note, don't answer questions it asks, and don't change what is done or open.
- Fix spelling, grammar and punctuation; turn fragments into clear sentences, or into tidy lists where the note lists things.
- Structure it: ## headings when it covers several topics, numbered lists for steps, - [ ] checklist items for to-dos (keep ticked ones ticked). Keep it about as long as it is; a short note stays short.
- Don't start with a title line: the note's title is shown separately.
- Keep existing [[links]] exactly as they are. Leave formulas ($…$), code and tables unchanged in meaning.
- Related notes: of the notes listed below, pick only those clearly related to this note (same project, topic, person or idea). End the note with a section "## Related" with one line per pick: - [[Exact title]] — a few words on how it relates. If the note already has a Related section, merge into it. If none fits, add no Related section. Never link a note that isn't in the list, and never change a listed title.

Return only the note's new Markdown text: no frontmatter, no title line, no remarks about what you changed.

NOTE TITLE: ${note.title}

NOTE:
<<<
${String(note.body || '').slice(0, MAX_NOTE)}
>>>

OTHER NOTES (exact title — how it starts):
${list}`;
}

/**
 * The model's answer, made safe to show: fences and a repeated title line taken off, links to notes that
 * don't exist turned back into plain text, and refused when it lost most of the note. Returns
 * { body, added } (added: the titles newly linked).
 */
function clean(reply, note, titles) {
  let t = String(reply || '').trim();
  const fence = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) t = fence[1].trim();
  t = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim(); // frontmatter is the note's own, kept by notebook.save
  const first = t.match(/^#{1,3}\s+(.+)\r?\n/); // the title repeated as the first heading, at any level
  if (first && first[1].trim().toLowerCase() === String(note.title || '').trim().toLowerCase()) t = t.slice(first[0].length).trimStart();
  if (!t) throw new Error('The assistant returned nothing; your note is unchanged.');
  const known = new Set(titles.map((x) => x.toLowerCase()));
  const before = new Set([...String(note.body || '').matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim().toLowerCase()));
  const added = new Set();
  t = t.replace(/\[\[([^\]|#]+)((?:#[^\]|]*)?)(?:\|([^\]]*))?\]\]/g, (m, target, _h, alias) => {
    const key = target.trim().split('/').pop().toLowerCase();
    if (before.has(target.trim().toLowerCase()) || before.has(key)) return m; // the user's own links stay as written
    if (!known.has(key)) return alias || target.trim(); // an invented note: plain text
    added.add(target.trim());
    return m;
  });
  // In the "Related" section, an entry whose link was invented goes (it is a list of links); a section
  // left empty goes too.
  const rel = t.match(/\n#{2,3}\s+Related\s*\n([\s\S]*)$/i);
  if (rel) {
    const kept = rel[1].split('\n').filter((l) => !/^\s*[-*+]\s+/.test(l) || /\[\[/.test(l));
    t = /\[\[/.test(kept.join('\n')) ? t.slice(0, rel.index) + rel[0].slice(0, rel[0].length - rel[1].length) + kept.join('\n') : t.slice(0, rel.index);
  }
  t = t.trimEnd();
  // Most of the note gone: something went wrong, nothing is offered.
  const plain = (s) => (String(s).match(/[\p{L}\p{N}]/gu) || []).length;
  const was = plain(note.body);
  if (was > 120 && plain(t.replace(/\n#{2,3}\s+Related[\s\S]*$/i, '')) < was * 0.45) throw new Error('The polished version left out too much of your note, so it was not offered. Your note is unchanged.');
  return { body: `${t}\n`, added: [...added] };
}

module.exports = { candidates, prompt, clean, MAX_NOTE, MAX_CANDIDATES };
