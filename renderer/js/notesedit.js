// Formatting in the Notes editor (notes.js), pure: what a toolbar button or a key does to the Markdown
// text and the selection. Each function takes { text, start, end } (the selection) and returns an edit
// { from, to, insert, start, end }: replace text[from, to) with insert, then select [start, end). The
// editor applies it as typing, so Ctrl+Z undoes it. test/notesedit.test.js.

const LIST = /^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|(\d+)[.)]\s+)/;
const HEADING = /^(\s{0,3})(#{1,6})\s+/;
const QUOTE = /^(\s*)>\s?/;

/** The whole lines the selection touches: [lineStart, lineEnd). */
function linesOf(text, start, end) {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  let to = text.indexOf('\n', end > start && text[end - 1] === '\n' ? end - 1 : end);
  if (to < 0) to = text.length;
  return { from, to, lines: text.slice(from, to).split('\n') };
}

function lineEdit(text, start, end, map) {
  const { from, to, lines } = linesOf(text, start, end);
  const out = map(lines);
  const insert = out.join('\n');
  // Keep the caret on the same text: shift it by how much its line's start changed.
  const firstDelta = out[0].length - lines[0].length;
  const single = lines.length === 1;
  return {
    from,
    to,
    insert,
    start: single ? Math.max(from, start + firstDelta) : from,
    end: single ? Math.max(from, end + firstDelta) : from + insert.length,
  };
}

/** Title (1), subtitle (2), heading 3: sets the level, or takes it away when it already has it. */
function heading({ text, start, end }, level) {
  const mark = '#'.repeat(level);
  return lineEdit(text, start, end, (lines) => {
    const all = lines.every((l) => (l.match(HEADING)?.[2] || '') === mark);
    return lines.map((l) => {
      const bare = l.replace(HEADING, '$1').replace(LIST, '$1');
      return all ? bare : `${mark} ${bare.trimStart()}`;
    });
  });
}

/** Bullets, numbers or a checklist on the selected lines; again on the same kind takes them off. */
function list({ text, start, end }, kind) {
  return lineEdit(text, start, end, (lines) => {
    const isKind = (l) => {
      const m = l.match(LIST);
      if (!m) return false;
      if (kind === 'task') return /\[[ xX]\]/.test(m[2]);
      if (kind === 'number') return Boolean(m[3]);
      return !m[3] && !/\[[ xX]\]/.test(m[2]);
    };
    const content = lines.filter((l) => l.trim());
    const all = content.length > 0 && content.every(isKind);
    let n = 0;
    return lines.map((l) => {
      if (!l.trim() && lines.length > 1) return l;
      const indent = l.match(/^\s*/)[0];
      const bare = l.replace(LIST, '$1').replace(HEADING, '$1').trimStart();
      if (all) return indent + bare;
      n++;
      return `${indent}${kind === 'number' ? `${n}. ` : kind === 'task' ? '- [ ] ' : '- '}${bare}`;
    });
  });
}

/** A quote on the selected lines, or off again. */
function quote({ text, start, end }) {
  return lineEdit(text, start, end, (lines) => {
    const all = lines.filter((l) => l.trim()).every((l) => QUOTE.test(l));
    return lines.map((l) => (all ? l.replace(QUOTE, '$1') : `> ${l}`));
  });
}

/** **bold** / *italic* around the selection (or the word at the caret); again takes it off. */
function wrap({ text, start, end }, mark) {
  let s = start;
  let e = end;
  if (s === e) {
    // No selection: the word at the caret, or an empty pair to type into.
    while (s > 0 && /[\p{L}\p{N}_'-]/u.test(text[s - 1])) s--;
    while (e < text.length && /[\p{L}\p{N}_'-]/u.test(text[e])) e++;
  }
  const inner = text.slice(s, e);
  const n = mark.length;
  if (text.slice(s - n, s) === mark && text.slice(e, e + n) === mark && !(mark === '*' && text.slice(s - 2, s) === '**' && text.slice(e, e + 2) === '**')) {
    return { from: s - n, to: e + n, insert: inner, start: start - n, end: end - n };
  }
  if (inner.startsWith(mark) && inner.endsWith(mark) && inner.length >= 2 * n) {
    return { from: s, to: e, insert: inner.slice(n, -n), start: s, end: e - 2 * n };
  }
  return { from: s, to: e, insert: `${mark}${inner}${mark}`, start: start + n, end: end + n + (start === end && s === e ? 0 : 0) };
}

/** A link to another note: [[ ]] around the selection, or [[ at the caret (the suggestions open). */
function link({ text, start, end }) {
  const inner = text.slice(start, end);
  if (inner) return { from: start, to: end, insert: `[[${inner}]]`, start: start + 2, end: end + 2 };
  return { from: start, to: end, insert: '[[', start: start + 2, end: start + 2 };
}

/**
 * Enter at the end of a list item: the next item (numbers count up, checkboxes come back empty); on an
 * empty item the list ends. null when Enter should just be Enter.
 */
function enter({ text, start, end }) {
  if (start !== end) return null;
  const from = text.lastIndexOf('\n', start - 1) + 1;
  let to = text.indexOf('\n', start);
  if (to < 0) to = text.length;
  const line = text.slice(from, to);
  const m = line.match(LIST);
  const q = !m && line.match(QUOTE);
  if (!m && !q) return null;
  const marker = m ? m[0] : q[0];
  if (start - from < marker.length) return null; // caret inside the marker
  if (!line.slice(marker.length).trim() && start === to) {
    // An empty item: end the list (the marker goes, the line stays).
    return { from, to, insert: '', start: from, end: from };
  }
  let next = marker;
  if (m?.[3]) next = marker.replace(/\d+/, String(Number(m[3]) + 1));
  else if (m && /\[[xX]\]/.test(marker)) next = marker.replace(/\[[xX]\]/, '[ ]');
  const insert = `\n${next}`;
  return { from: start, to: start, insert, start: start + insert.length, end: start + insert.length };
}

/** Tab / Shift+Tab on list items: two spaces in or out. null on other lines (Tab leaves the editor). */
function indent({ text, start, end }, out = false) {
  const { lines } = linesOf(text, start, end);
  if (!lines.every((l) => LIST.test(l) || !l.trim())) return null;
  return lineEdit(text, start, end, (ls) => ls.map((l) => (!l.trim() ? l : out ? l.replace(/^ {1,2}/, '') : `  ${l}`)));
}

/** Which formats the caret's line has (to light up the toolbar). */
function formatsAt(text, pos) {
  const from = text.lastIndexOf('\n', pos - 1) + 1;
  let to = text.indexOf('\n', pos);
  if (to < 0) to = text.length;
  const line = text.slice(from, to);
  const h = line.match(HEADING);
  const m = line.match(LIST);
  return { heading: h ? h[2].length : 0, list: m ? (m[3] ? 'number' : /\[[ xX]\]/.test(m[2]) ? 'task' : 'bullet') : '', quote: QUOTE.test(line) };
}

/** Where in the Markdown a click on the rendered note lands: the block's text found in the source. */
function sourceOffset(text, blockText, offsetInBlock) {
  const clean = String(blockText || '').replace(/\s+/g, ' ').trim();
  if (!clean) return -1;
  for (const len of [40, 20, 10]) {
    const probe = clean.slice(0, len);
    if (probe.length < Math.min(len, clean.length)) continue;
    const at = text.indexOf(probe);
    if (at >= 0) {
      const lineEnd = text.indexOf('\n', at);
      return Math.min(at + Math.max(0, offsetInBlock), lineEnd < 0 ? text.length : lineEnd);
    }
  }
  return -1;
}

/** The text with its n-th checklist item (0-based, in order) ticked or unticked; unchanged if there is none. */
function toggleTask(text, n) {
  let i = -1;
  return String(text).replace(/^(\s*[-*+]\s+\[)([ xX])(\])/gm, (m, a, box, b) => (++i === n ? `${a}${box === ' ' ? 'x' : ' '}${b}` : m));
}

export { heading, list, quote, wrap, link, enter, indent, formatsAt, sourceOffset, linesOf, toggleTask };
