// View switching (kept separate so feature modules can navigate without circular imports).
import { $$, emit } from './util.js';

export let currentView = 'chat';

export function switchView(name, section) {
  currentView = name;
  $$('.rail-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name);
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  // A place under More (moremenu.js) open: the More button shows where you are.
  document.getElementById('railMore')?.classList.toggle('active', Boolean(document.querySelector(`#moreMenu [data-view="${name}"]`)));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  emit('view', { name, section });
}
