// The scene behind the face (appearance.scene, drawn by the model: main/scenecore.js): the place the
// persona lives in, shown behind the big face and the chat's face panel. Its three layers (#far, #mid,
// #near) drift at different speeds (styles.css), and the whole scene dims while the assistant sleeps
// (body[data-agent]). The SVG was cleaned in the main process; DOMPurify's SVG profile cleans it again
// here before it joins the page.
import { $$ } from './util.js';

const PURIFY = {
  USE_PROFILES: { svg: true },
  FORBID_TAGS: ['style', 'foreignObject', 'image', 'use', 'a', 'script', 'filter', 'animate', 'animateTransform', 'animateMotion', 'set'],
  FORBID_ATTR: ['href', 'xlink:href', 'filter'],
};

let shown = null; // the SVG text on screen, to skip a redraw when nothing changed

/** Puts the scene (or none) into every .face-scene holder. */
export function applyScene(scene) {
  const svg = scene?.svg ? String(scene.svg) : '';
  if (svg === shown) return;
  shown = svg;
  const clean = svg ? window.DOMPurify.sanitize(svg, PURIFY) : '';
  for (const holder of $$('.face-scene')) {
    holder.innerHTML = clean;
    holder.classList.toggle('on', Boolean(clean));
    holder.parentElement?.classList.toggle('has-scene', Boolean(clean));
    if (scene?.caption) holder.title = scene.caption;
    else holder.removeAttribute('title');
  }
}
