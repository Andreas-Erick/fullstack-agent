// Library view (data-view 'knowledge'): every file the assistant keeps in its vault, to browse, search, read
// and edit. New notes are written in the Notes view, the one place for that (spec #17).
import { $, api, el, renderMarkdown, timeAgo, debounce, toast, toastError, confirmDialog, modal, on, plainError } from './util.js';
import { switchView, currentView } from './nav.js';
import { openDocument } from './docs.js';
import { firstStep, libraryAction, libraryOffText } from './firststep.js';

let notes = [];
let selected = null;
let listError = null; // the last list() failure: shown in the list instead of "No notes found."
let editing = null; // the open editor: { path, read (the note's text as opened), original (what the box held), ta }
const dirty = () => Boolean(editing?.ta.isConnected) && editing.ta.value !== editing.original;

/**
 * Before the note pane is replaced: true when nothing is unsaved, or the user chose to discard it. It leaves
 * `editing` alone: replacing the pane disconnects the editor, and when nothing replaces it (a note that
 * can't be read) the editor stays as it was, its Save working and its text guarded.
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
  const list = $('#kbList');
  const st = await api.obsidian.status().catch(() => ({}));
  if (!st.ok) {
    list.innerHTML = '';
    $('#kbNote').innerHTML = '';
    // Off or its folder gone: the switch or the folder picker right here, not a trip to Settings (spec #17).
    $('#kbNote').append(firstStep({ cls: 'cal-empty', title: st.enabled === false ? 'The notes library is off' : 'The notes library’s folder is missing', text: libraryOffText(st, 'notes, memories and your schedule'), action: libraryAction(st, refresh) }));
    return;
  }
  listError = null;
  notes = await api.obsidian.list().catch((e) => ((listError = e), []));
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
  if (!q) return renderList(notes, listError);
  try {
    renderList(await api.obsidian.search(q));
  } catch (err) {
    renderList([], err, search);
  }
}

function renderList(items, failure = null, again = refresh) {
  const list = $('#kbList');
  const hadFocus = list.contains(document.activeElement);
  list.innerHTML = '';
  if (failure) {
    const retry = el('button', { class: 'btn small', onclick: (ev) => ((ev.currentTarget.disabled = true), again()) }, 'Try again');
    list.append(el('div', { class: 'test-result err', role: 'alert', style: { margin: '6px' } }, `Couldn’t read the vault: ${plainError(failure)} `, retry));
    if (hadFocus) retry.focus();
    return;
  }
  if (!items.length) list.append(el('div', { class: 'muted', style: { padding: '10px' } }, 'No notes found.'));
  for (const n of items.slice(0, 500)) {
    list.append(
      el(
        'button',
        { type: 'button', class: `kb-item ${selected === n.path ? 'active' : ''}`, 'data-path': n.path, 'aria-current': selected === n.path ? 'true' : null, onclick: () => openNote(n.path) },
        el('span', { class: 't' }, n.title),
        el('span', { class: 'p' }, `${n.path}${n.modified ? ` · ${timeAgo(n.modified)}` : ''}`),
        n.snippet ? el('span', { class: 's' }, n.snippet) : '',
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
        el('div', { style: { minWidth: '0', overflowWrap: 'anywhere' } }, el('div', { class: 'muted', style: { fontSize: '12px' } }, n.path), n.tags.length ? el('div', {}, n.tags.map((t) => el('span', { class: 'tag', style: { marginRight: '4px' } }, `#${t}`))) : ''),
        el(
          'div',
          { class: 'row' },
          el('button', { class: 'btn small', onclick: () => editNote(n) }, '✎ Edit'),
          el('button', { class: 'btn small', onclick: () => showHistory(n) }, '⟲ History'),
          el('button', { class: 'btn small', onclick: () => openDocument(n.fullPath) }, 'Viewer'),
          el('button', { class: 'btn small', onclick: () => api.obsidian.openInObsidian(n.path).catch(toastError) }, 'Obsidian'),
          el('button', {
            class: 'btn small danger',
            style: { marginLeft: '14px' }, // apart from the everyday buttons: a slip doesn't land on it
            onclick: async () => {
              if (!(await confirmDialog('Delete note', `Move “${n.title}” to the Trash?`, 'Delete'))) return;
              // A delete that failed leaves the note open (it is still there).
              const ok = await api.obsidian.delete(n.path).then(() => true, (err) => (toastError(plainError(err)), false));
              if (!ok) return;
              selected = null;
              toast(`Moved “${n.title}” to the Trash.`);
              refresh();
            },
          }, 'Delete'),
        ),
      ),
      el('div', { html: renderMarkdown(body, { wikilinks: 'open' }) }),
    );
    backlinks(box, n.path);
    box.scrollTop = 0;
    document.querySelectorAll('.kb-item').forEach((i) => {
      i.classList.toggle('active', i.dataset.path === n.path);
      if (i.dataset.path === n.path) i.setAttribute('aria-current', 'true');
      else i.removeAttribute('aria-current');
    });
  } catch (err) {
    toastError(err);
  }
}

// Under the note: which notes link to it, and which it links to (main/linkindex.js), as buttons.
async function backlinks(box, rel) {
  const r = await api.obsidian.links(rel).catch(() => null); // no backlinks shown
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
      const fresh = await api.obsidian.read(n.path).catch(() => null); // unreadable: handled as null below
      if (fresh && fresh.content !== mine.read && !(await confirmDialog('Overwrite the newer version?', 'This note changed since you opened it (the assistant or another app wrote it). Your text replaces that version; the Library’s history keeps it.', 'Overwrite'))) return;
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
      list.append(el('button', { type: 'button', class: 'ob-choice', 'aria-pressed': 'false', onclick: async (ev) => {
        picked = v.sha;
        restoreBtn.disabled = false;
        // The picked version stands out (and says so to a screen reader).
        for (const b of list.children) {
          b.classList.toggle('sel', b === ev.currentTarget);
          b.setAttribute('aria-pressed', String(b === ev.currentTarget));
        }
        preview.textContent = await api.obsidian.showVersion(n.path, v.sha).catch((e) => plainError(e));
      } }, el('b', {}, new Date(v.date).toLocaleString()), el('small', {}, v.subject)));
    }
    card.append(el('h3', {}, `History · ${n.title}`), list, preview, el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close() }, 'Close'), restoreBtn));
  });
}
