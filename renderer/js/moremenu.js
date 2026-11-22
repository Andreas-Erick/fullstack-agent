// The rail's More menu (spec #17): the places people open less often (Face, Skills & routines, Inner World,
// Library, How Siren works, Changes Siren made to itself), one click away. A real menu: the button says
// whether it is open, ↑ ↓ Home End move between the items, Esc (or Tab, a click outside, a choice) closes
// it and Esc gives the focus back to the button. The items are .rail-btn with their data-view, so app.js's
// rail wiring opens their view and nav.js marks the current one (and the More button while one is open).
import { $, on } from './util.js';

let button = null;
let menu = null;

const items = () => [...menu.querySelectorAll('[role="menuitem"]')];
export const moreOpen = () => Boolean(menu && !menu.classList.contains('hidden'));

function place() {
  // Beside the rail, level with the button, never past the bottom of the window.
  const r = button.getBoundingClientRect();
  menu.style.left = `${Math.round(r.right + 6)}px`;
  const top = Math.min(r.top, window.innerHeight - menu.offsetHeight - 8);
  menu.style.top = `${Math.max(8, Math.round(top))}px`;
}

function open() {
  if (moreOpen()) return;
  menu.classList.remove('hidden');
  button.setAttribute('aria-expanded', 'true');
  place();
  const list = items();
  (list.find((b) => b.getAttribute('aria-current') === 'page') || list[0])?.focus();
}

function close(refocus) {
  if (!moreOpen()) return;
  menu.classList.add('hidden');
  button.setAttribute('aria-expanded', 'false');
  if (refocus) button.focus();
}

export function initMoreMenu() {
  button = $('#railMore');
  menu = $('#moreMenu');
  if (!button || !menu) return;
  button.addEventListener('click', () => (moreOpen() ? close(true) : open()));
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      list[(to + list.length) % list.length].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (moreOpen() && !menu.contains(e.target) && !button.contains(e.target)) close(false);
  });
  window.addEventListener('resize', () => moreOpen() && place());
  // A choice (app.js's rail wiring opens the view) or any other view switch closes it; when the focus was
  // on an item, it goes back to More rather than into a hidden menu.
  on('view', () => close(menu.contains(document.activeElement)));
}
