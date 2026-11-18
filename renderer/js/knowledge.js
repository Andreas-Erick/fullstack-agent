// Vault view: the agent's own Obsidian vault — browse, search, read, create and edit notes.
import { $, api, el, renderMarkdown, timeAgo, debounce, toast, toastError, confirmDialog, promptDialog, modal, on } from './util.js';
import { state } from './state.js';
import { switchView, currentView } from './nav.js';
import { openDocument } from './docs.js';

let notes = [];
let selected = null;
let editing = null; // the open editor: { path, read (the note's text as opened), original (what the box held), ta }
const dirty = () => Boolean(editing?.ta.isConnected) && editing.ta.value !== editing.original;

/**
 * Before the note pane is replaced: true when nothing is unsaved, or the user chose to discard it. It leaves
 * `editing` alone: replacing the pane disconnects the editor, and when nothing replaces it (New note
 * cancelled, a note that can't be read) the editor stays as it was, its Save working and its text guarded.
 */
async function leaveEditor() {
  return !dirty() || Boolean(await confirmDialog('Discard your changes?', `Your edits to ${editing.path} aren’t saved.`, 'Discard'));
}

export function initKnowledge() {
  $('#kbSearch').addEventListener('input', debounce(search, 250));
  const follow = (e) => {
    const link = e.target.closest('a.wikilink');
    if (link && (e.type === 'click' || e.key === 'Enter')) {
      e.preventDefault();
      openNote(link.dataset.note);
    }
  };
  $('#kbNote').addEventListener('click', follow);
  $('#kbNote').addEventListener('keydown', follow);
  $('#kbNew').onclick = newNote;
  $('#kbObsidian').onclick = () => api.obsidian.openInObsidian(selected || null).catch(toastError);
  $('#kbGrowth').onclick = () => import('./growth.js').then((m) => m.openGrowth()).catch(toastError);
  $('#kbFolder').onclick = () => api.obsidian.openFolder().catch(toastError);
  // The agent wrote to its vault: refresh if the user is looking at it. An open editor is never replaced
  // under the user; when it is this note that changed, they hear about it.
  on('vault-changed', (p) => {
    if (currentView !== 'knowledge') return;
    refresh();
    if (editing?.ta.isConnected) {
      if (dirty() && editing.path === p) toast('This note changed elsewhere. Save to keep your version (you’ll be asked first), or Cancel to load the new one.');
      return;
    }
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
  if (!selected && !editing?.ta.isConnected) $('#kbNote').replaceChildren(el('p', { class: 'muted' }, `${notes.length} notes in `, el('code', {}, st.path), '. Select a note to read or edit it — the agent writes here too.'));
}

/** Opens a vault note (path or name) in this view, e.g. from a [[link]] in the chat. */
export function showVaultNote(ref) {
  switchView('knowledge');
  openNote(ref); // refresh fills the pane only while no note is selected, so the note shows whichever ends first
}

/** The vault search with `q` filled in (a [[link]] in the chat to a note that doesn't exist). */
export function searchVault(q) {
  $('#kbSearch').value = q; // before the view's refresh reads it, so the results aren't replaced by the full list
  switchView('knowledge');
  search();
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
  if (!(await leaveEditor())) return;
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
      el('div', { html: renderMarkdown(body, { wikilinks: 'open' }) }),
    );
    backlinks(box, n.path);
    box.scrollTop = 0;
    document.querySelectorAll('.kb-item').forEach((i) => i.classList.toggle('active', i.dataset.path === n.path));
  } catch (err) {
    toastError(err);
  }
}

// Under the note: which notes link to it, and which it links to (main/linkindex.js), as buttons.
async function backlinks(box, rel) {
  const r = await api.obsidian.links(rel).catch(() => null);
  if (!r || selected !== rel || (!r.backlinks.length && !r.links.length)) return;
  const list = (title, paths) =>
    paths.length
      ? el('div', { class: 'kb-links-group' }, el('b', {}, `${title} (${paths.length})`), el('div', { class: 'kb-links-list' }, ...paths.slice(0, 60).map((p) => el('button', { class: 'chip kb-link', title: p, onclick: () => openNote(p) }, p.split('/').pop().replace(/\.md$/i, '')))))
      : null;
  box.append(el('section', { class: 'kb-links', 'aria-label': 'Links' }, list('Linked from', r.backlinks), list('Links to', r.links)));
}

function editNote(n) {
  const box = $('#kbNote');
  const ta = el('textarea', { class: 'input' });
  ta.value = n.content;
  // What the box holds, read back: a textarea turns \r\n into \n, so a CRLF note isn't "edited" untouched.
  const mine = { path: n.path, read: n.content, original: ta.value, ta };
  editing = mine;
  selected = n.path; // a refresh meanwhile (New note) leaves the pane alone
  const saveBtn = el('button', { class: 'btn small primary' }, 'Save');
  let saving = false; // Ctrl+S pressed again while a save runs
  // This editor's own save: it never reads the module's slot, which a later editor may hold.
  const save = async () => {
    if (saving || !ta.isConnected) return;
    saving = true;
    saveBtn.disabled = true;
    try {
      const fresh = await api.obsidian.read(n.path).catch(() => null);
      if (fresh && fresh.content !== mine.read && !(await confirmDialog('Overwrite the newer version?', 'This note changed since you opened it (the assistant or another app wrote it). Your text replaces that version; the vault’s history keeps it.', 'Overwrite'))) return;
      editing = null; // the save's own vault-changed reloads the pane as usual
      await api.obsidian.write(n.path, ta.value, 'overwrite');
      toast('Saved');
      await refresh();
      openNote(n.path);
    } catch (err) {
      if (ta.isConnected) editing = mine; // still unsaved, still on screen
      toastError(err);
    } finally {
      saving = false;
      saveBtn.disabled = false;
    }
  };
  saveBtn.onclick = save;
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
      el('div', { class: 'row', style: { justifyContent: 'space-between' } }, el('span', { class: 'muted' }, `Editing ${n.path} · Ctrl+S to save`), el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => openNote(n.path) }, 'Cancel'), saveBtn)),
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
  if (!(await leaveEditor())) return;
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
