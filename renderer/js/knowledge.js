// Vault view: the agent's own Obsidian vault — browse, search, read, create and edit notes.
import { $, api, el, renderMarkdown, timeAgo, debounce, toast, toastError, confirmDialog, promptDialog, modal, on } from './util.js';
import { state } from './state.js';
import { switchView, currentView } from './nav.js';
import { openDocument } from './docs.js';

let notes = [];
let selected = null;

export function initKnowledge() {
  $('#kbSearch').addEventListener('input', debounce(search, 250));
  $('#kbNote').addEventListener('click', (e) => {
    const link = e.target.closest('a.wikilink');
    if (link) {
      e.preventDefault();
      openNote(link.dataset.note);
    }
  });
  $('#kbNew').onclick = newNote;
  $('#kbObsidian').onclick = () => api.obsidian.openInObsidian(selected || null).catch(toastError);
  $('#kbFolder').onclick = () => api.obsidian.openFolder().catch(toastError);
  // The agent wrote to its vault: refresh if the user is looking at it.
  on('vault-changed', (p) => {
    if (currentView !== 'knowledge') return;
    refresh();
    if (p && p === selected) openNote(p);
  });
}

export async function refresh() {
  $('#kbTitle').textContent = `${state.settings.agent.name}'s Vault`;
  const list = $('#kbList');
  const st = await api.obsidian.status().catch(() => ({}));
  if (!st.ok) {
    list.innerHTML = '';
    $('#kbNote').innerHTML = '';
    $('#kbNote').append(
      el(
        'div',
        { class: 'cal-empty' },
        el('h3', { class: 'display' }, 'Vault disabled'),
        el('p', { class: 'muted' }, 'The agent’s own Obsidian vault is turned off or its folder is unavailable.'),
        el('button', { class: 'btn primary', onclick: () => switchView('settings', 'obsidian') }, 'Vault settings'),
      ),
    );
    return;
  }
  notes = await api.obsidian.list().catch((e) => (toastError(e), []));
  if (!$('#kbSearch').value.trim()) renderList(notes);
  if (!selected) $('#kbNote').replaceChildren(el('p', { class: 'muted' }, `${notes.length} notes in `, el('code', {}, st.path), '. Select a note to read or edit it — the agent writes here too.'));
}

async function search() {
  const q = $('#kbSearch').value.trim();
  if (!q) return renderList(notes);
  try {
    renderList(await api.obsidian.search(q));
  } catch (err) {
    toastError(err);
  }
}

function renderList(items) {
  const list = $('#kbList');
  list.innerHTML = '';
  if (!items.length) list.append(el('div', { class: 'muted', style: { padding: '10px' } }, 'No notes found.'));
  for (const n of items.slice(0, 500)) {
    list.append(
      el(
        'div',
        { class: `kb-item ${selected === n.path ? 'active' : ''}`, 'data-path': n.path, onclick: () => openNote(n.path) },
        el('div', { class: 't' }, n.title),
        el('div', { class: 'p' }, `${n.path}${n.modified ? ` · ${timeAgo(n.modified)}` : ''}`),
        n.snippet ? el('div', { class: 's' }, n.snippet) : '',
      ),
    );
  }
}

async function openNote(ref) {
  try {
    const n = await api.obsidian.read(ref);
    selected = n.path;
    const body = n.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    const box = $('#kbNote');
    box.innerHTML = '';
    box.append(
      el(
        'div',
        { class: 'row', style: { justifyContent: 'space-between', marginBottom: '10px', flexWrap: 'wrap' } },
        el('div', {}, el('div', { class: 'muted', style: { fontSize: '12px' } }, n.path), n.tags.length ? el('div', {}, n.tags.map((t) => el('span', { class: 'tag', style: { marginRight: '4px' } }, `#${t}`))) : ''),
        el(
          'div',
          { class: 'row' },
          el('button', { class: 'btn small', onclick: () => editNote(n) }, '✎ Edit'),
          el('button', { class: 'btn small', onclick: () => showHistory(n) }, '⟲ History'),
          el('button', { class: 'btn small', onclick: () => openDocument(n.fullPath) }, 'Viewer'),
          el('button', { class: 'btn small', onclick: () => api.obsidian.openInObsidian(n.path).catch(toastError) }, 'Obsidian'),
          el('button', {
            class: 'btn small danger',
            onclick: async () => {
              if (!(await confirmDialog('Delete note', `Move “${n.title}” to the vault’s trash?`, 'Delete'))) return;
              await api.obsidian.delete(n.path).catch(toastError);
              selected = null;
              refresh();
            },
          }, 'Delete'),
        ),
      ),
      el('div', { html: renderMarkdown(body, { wikilinks: true }) }),
    );
    box.scrollTop = 0;
    document.querySelectorAll('.kb-item').forEach((i) => i.classList.toggle('active', i.dataset.path === n.path));
  } catch (err) {
    toastError(err);
  }
}

function editNote(n) {
  const box = $('#kbNote');
  const ta = el('textarea', { class: 'input' });
  ta.value = n.content;
  const save = async () => {
    try {
      await api.obsidian.write(n.path, ta.value, 'overwrite');
      toast('Saved');
      await refresh();
      openNote(n.path);
    } catch (err) {
      toastError(err);
    }
  };
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });
  box.innerHTML = '';
  box.append(
    el(
      'div',
      { class: 'kb-editor' },
      el('div', { class: 'row', style: { justifyContent: 'space-between' } }, el('span', { class: 'muted' }, `Editing ${n.path} · Ctrl+S to save`), el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => openNote(n.path) }, 'Cancel'), el('button', { class: 'btn small primary', onclick: save }, 'Save'))),
      ta,
    ),
  );
  ta.focus();
}

// Every change to the vault is versioned; browse a note's versions and restore one.
async function showHistory(n) {
  const versions = await api.obsidian.history(n.path).catch((e) => (toastError(e), []));
  modal((card, close) => {
    const preview = el('pre', { class: 'log-view', style: { maxHeight: '320px' } }, versions.length ? 'Select a version to preview it.' : 'No history yet (history starts with the first change after it was enabled).');
    let picked = null;
    const restoreBtn = el('button', { class: 'btn primary', disabled: true, onclick: async () => {
      try {
        await api.obsidian.restoreVersion(n.path, picked);
        toast('Restored');
        close();
        openNote(n.path);
      } catch (e) {
        toastError(e);
      }
    } }, 'Restore this version');
    const list = el('div', { class: 'health-list', style: { maxHeight: '220px', overflow: 'auto' } });
    for (const v of versions) {
      list.append(el('button', { class: 'ob-choice', onclick: async () => {
        picked = v.sha;
        restoreBtn.disabled = false;
        preview.textContent = await api.obsidian.showVersion(n.path, v.sha).catch((e) => e.message);
      } }, el('b', {}, new Date(v.date).toLocaleString()), el('small', {}, v.subject)));
    }
    card.append(el('h3', {}, `History · ${n.title}`), list, preview, el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close() }, 'Close'), restoreBtn));
  });
}

async function newNote() {
  const name = await promptDialog('New note (path inside the vault)', 'Notes/Untitled.md');
  if (!name) return;
  try {
    const title = name.split('/').pop().replace(/\.md$/i, '');
    const r = await api.obsidian.write(name, `# ${title}\n\n`, 'create');
    await refresh();
    const n = await api.obsidian.read(r.path);
    editNote(n);
  } catch (err) {
    toastError(err);
  }
}
