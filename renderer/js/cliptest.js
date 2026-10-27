// Finds text that is cut off on the screen (a visual bug): an element that hides its overflow while its
// text is wider or taller than it (no deliberate "…" ellipsis or line clamp), or text pushed past the edge
// of a parent that clips it. Pure DOM reading, run by the launch check (main/smoke.js) on every view, at
// a few window sizes and in the dialogs; nothing in the app imports it.

const SKIP = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'CANVAS', 'SVG', 'svg', 'IMG', 'VIDEO', 'AUDIO', 'IFRAME', 'SCRIPT', 'STYLE', 'KBD']);

function visible(el, cs) {
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

/** The element's own text (its direct text nodes), trimmed. */
function ownText(el) {
  let t = '';
  for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
  return t.replace(/\s+/g, ' ').trim();
}

const clips = (v) => v === 'hidden' || v === 'clip';
const describe = (el) => {
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
};

/** Every place where text is cut off in `root` (default: the document): [{ where, text, how }]. */
export function findClippedText(root = document.body) {
  const out = [];
  const seen = new Set();
  for (const el of root.querySelectorAll('*')) {
    if (SKIP.has(el.tagName) || el.closest('svg, [aria-hidden="true"], .hud-splash, [data-clip-ok]')) continue;
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) continue;
    const text = el.innerText?.replace(/\s+/g, ' ').trim() || '';
    if (!text) continue;
    // Deliberate: a "…", a line clamp, or a fade-out mask (a preview that says there is more).
    const deliberate = cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') || (cs.maskImage && cs.maskImage !== 'none');
    // 1. Its own box hides text that doesn't fit.
    if (!deliberate && ownText(el)) {
      const wide = clips(cs.overflowX) && el.scrollWidth > el.clientWidth + 2;
      const tall = clips(cs.overflowY) && el.scrollHeight > el.clientHeight + 2;
      if (wide || tall) {
        out.push({ where: describe(el), text: text.slice(0, 60), how: wide ? `${el.scrollWidth - el.clientWidth}px too wide` : `${el.scrollHeight - el.clientHeight}px too tall` });
        seen.add(el);
        continue;
      }
    }
    // 1b. Its text spills out of its own box without being clipped (a long address or word that can't
    // break): a block with visible overflow whose content is wider than it. Scroll boxes are fine.
    if (ownText(el) && !/inline/.test(cs.display) && !clips(cs.overflowX) && !/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      out.push({ where: describe(el), text: text.slice(0, 60), how: `spills ${el.scrollWidth - el.clientWidth}px out of its box` });
      seen.add(el);
      continue;
    }
    // 2. Its text runs past the edge of the nearest parent that clips (a leaf with text of its own).
    if (!ownText(el) || [...el.children].some((c) => c.innerText?.trim())) continue;
    const r = el.getBoundingClientRect();
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      const cx = clips(pcs.overflowX);
      const cy = clips(pcs.overflowY);
      if (!cx && !cy) {
        if (/auto|scroll/.test(pcs.overflowX + pcs.overflowY)) break; // scrolled into view by the user
        continue;
      }
      if ([...seen].some((s) => s.contains(el))) break;
      const pr = p.getBoundingClientRect();
      const over = Math.max(cx ? r.right - pr.right : 0, cx ? pr.left - r.left : 0, cy ? r.bottom - pr.bottom : 0);
      if (over > 2 && pcs.textOverflow !== 'ellipsis') out.push({ where: `${describe(el)} in ${describe(p)}`, text: text.slice(0, 60), how: `${Math.round(over)}px outside` });
      break;
    }
  }
  return out;
}
