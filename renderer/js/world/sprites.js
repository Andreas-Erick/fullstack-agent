// The Inner World's rendered sprites (renderer/assets/world/: made by tools/world-art from Kenney's CC0
// kits). manifest.json lists each sprite with its variants (summer, winter, autumn, glow), its size and
// anchor in image pixels (the anchor is the middle of its footprint on the ground) and named points
// (chimney tops, the forge, magic lights). The pictures are drawn at 1/scale (they are rendered at
// `scale` × world size so they stay sharp when zoomed in). Until they are loaded, or if they are missing,
// sprite() returns null and the village is drawn by code as before.

const BASE = new URL('../../assets/world/', import.meta.url);
let manifest = null;
let pending = null;
const images = new Map();

/** Loads the manifest and every picture once. Resolves true when the sprites can be used. */
export function loadSprites() {
  pending ||= (async () => {
    const res = await fetch(new URL('manifest.json', BASE));
    if (!res.ok) return false;
    const m = await res.json();
    const files = new Set();
    for (const s of Object.values(m.sprites || {})) for (const f of Object.values(s.variants || {})) files.add(f);
    await Promise.all(
      [...files].map(
        (f) =>
          new Promise((done) => {
            const img = new Image();
            img.onload = () => (images.set(f, img), done());
            img.onerror = () => done(); // a missing picture: that sprite falls back to code
            img.src = new URL(f, BASE).href;
          }),
      ),
    );
    manifest = m;
    return true;
  })().catch(() => false);
  return pending;
}

export const spritesReady = () => Boolean(manifest);

/**
 * A sprite for the season, or null: { img, glow (night windows, or null), w, h, ax, ay, k (world px per
 * image px), points }. Spring uses the summer picture.
 */
export function sprite(name, season = 'summer') {
  const s = manifest?.sprites?.[name];
  if (!s) return null;
  const want = s.variants[season] ? season : 'summer';
  const img = images.get(s.variants[want]) || images.get(s.variants.summer);
  if (!img) return null;
  return { img, glow: images.get(s.variants.glow) || null, mask: images.get(s.variants.roofmask) || null, w: s.w, h: s.h, ax: s.ax, ay: s.ay, k: 1 / (manifest.scale || 1), points: s.points || {} };
}

// Listed and its picture loaded (a picture can fail, e.g. over a phone's flaky connection).
export const has = (name) => Boolean(sprite(name));

// Tinted roof masks, made once per mask and colour.
const tints = new Map();
function tinted(mask, rgb) {
  const key = `${mask.src}|${rgb.join(',')}`;
  if (!tints.has(key)) {
    const cv = document.createElement('canvas');
    cv.width = mask.naturalWidth;
    cv.height = mask.naturalHeight;
    const c = cv.getContext('2d');
    c.drawImage(mask, 0, 0);
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = `rgb(${rgb.join(',')})`;
    c.fillRect(0, 0, cv.width, cv.height);
    tints.set(key, cv);
  }
  return tints.get(key);
}

/** Recolours the sprite's accent roofs (already drawn at x, y) with rgb, keeping their shading. */
export function tintRoofs(c, s, x, y, rgb, size = 1, strength = 0.85) {
  if (!s.mask) return;
  const k = s.k * size;
  c.save();
  c.globalCompositeOperation = 'color';
  c.globalAlpha = strength;
  c.drawImage(tinted(s.mask, rgb), x - s.ax * k, y - s.ay * k, s.w * k, s.h * k);
  c.restore();
}

/** How many numbered variants a family has (tree-oak-0, tree-oak-1 …). */
export function count(prefix) {
  if (!manifest) return 0;
  let n = 0;
  while (manifest.sprites[`${prefix}-${n}`]) n++;
  return n;
}

/** Draws a sprite with its anchor at world point (x, y); size: an extra scale. Returns its top (world y). */
export function drawSprite(c, s, x, y, size = 1) {
  const k = s.k * size;
  c.drawImage(s.img, x - s.ax * k, y - s.ay * k, s.w * k, s.h * k);
  return y - s.ay * k;
}

/** A named point of the sprite in world pixels (anchored at x, y). */
export function point(s, name, x, y, size = 1) {
  const p = s.points[name];
  if (!p) return null;
  const k = s.k * size;
  return { x: x + (p[0] - s.ax) * k, y: y + (p[1] - s.ay) * k };
}
