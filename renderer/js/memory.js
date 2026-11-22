// Memory vault view: browse, search, add, edit, delete, import/export.
import { $, api, el, escapeHtml, timeAgo, toast, toastActions, toastError, modal, confirmDialog, plainError, debounce, on } from './util.js';

let entries = [];

export function initMemory() {
  $('#memSearch').addEventListener('input', debounce(render, 120));
  $('#memCategory').addEventListener('change', render);
  $('#memAdd').onclick = () => edit();
  $('#memMore').onclick = (e) => {
    e.stopPropagation();
    setMenu(!$('#memMenu').classList.contains('open'));
  };
  document.addEventListener('click', () => setMenu(false));
  $('#memMenu').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    setMenu(false, { refocus: true });
  });
  $('#memMenu').addEventListener('focusout', (e) => {
    if (!e.relatedTarget || !e.currentTarget.closest('.dropdown').contains(e.relatedTarget)) setMenu(false);
  });
  $('#memMenu').onclick = async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    setMenu(false);
    try {
      if (act === 'export-md' || act === 'export-json') {
        const p = await api.memory.export(act === 'export-json' ? 'json' : 'md');
        if (p) toast(`Exported to ${p}`);
      } else if (act === 'import') {
        const r = await api.memory.import(); // null: the file picker was closed
        if (r) toast(r.imported ? `Imported ${r.imported} ${r.imported === 1 ? 'memory' : 'memories'}${r.skipped ? ` (${r.skipped} skipped)` : ''}` : 'Nothing to import from this file');
        refresh();
      } else if (act === 'open-dir') await api.memory.openDir();
      else if (act === 'clear') {
        if (await confirmDialog('Delete all memories', 'This permanently deletes every memory in the vault.', 'Delete all')) {
          await api.memory.clear();
          refresh();
        }
      }
    } catch (err) {
      toastError(plainError(err)); // e.g. "This file isn't a memory export…"
    }
  };
  $('#streamReflect').onclick = reflectNow;
  $('#streamOpen').onclick = () => stream?.note && api.obsidian.openInObsidian(stream.note).catch(toastError);
  on('memory-changed', refresh);
  refresh();
}

// The ⋯ menu: opening moves the focus to its first item; Esc closes it back to the button.
function setMenu(open, { refocus = false } = {}) {
  const menu = $('#memMenu');
  const btn = $('#memMore');
  if (menu.classList.contains('open') === open) return;
  menu.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', String(open));
  if (open) menu.querySelector('button')?.focus();
  else if (refocus) btn.focus();
}

// ------------------------------------------------------------ the memory stream
let stream = null;

async function refreshStream() {
  stream = await api.stream.recent().catch(() => null); // no stream: that section stays empty
  const panel = $('#streamPanel');
  panel.classList.toggle('hidden', !stream);
  if (!stream) return;
  const reflections = stream.records.filter((r) => r.kind === 'reflection').length;
  $('#streamSummary').textContent = stream.total
    ? `${stream.total} records · ${reflections} insight${reflections === 1 ? '' : 's'} shown · next reflection at ${stream.sinceReflection}/${stream.reflectAt} importance`
    : 'Empty so far: the assistant notes small observations here as you work together.';
  const list = $('#streamList');
  list.innerHTML = '';
  const byId = new Map(stream.records.map((r) => [r.id, r]));
  for (const r of stream.records) {
    const evidence = r.evidence.map((id) => byId.get(id)?.text).filter(Boolean);
    list.append(
      el(
        'li',
        { class: `stream-row ${r.kind}`, title: evidence.length ? `Because:\n• ${evidence.join('\n• ')}` : '' },
        el('span', { class: 'when' }, new Date(r.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })),
        el('span', { class: 'imp', style: { '--imp': r.importance / 10 } }, `★${r.importance}`),
        el('span', { class: 'text' }, r.kind === 'reflection' ? `✨ ${r.text}` : r.text),
        r.kind === 'reflection' && r.evidence.length ? el('span', { class: 'ev' }, `from ${r.evidence.length}`) : '',
      ),
    );
  }
}

async function reflectNow() {
  const btn = $('#streamReflect');
  btn.disabled = true;
  try {
    const r = await api.stream.reflect();
    toast(r.length ? `✨ ${r.length} new insight${r.length > 1 ? 's' : ''}` : 'Not enough new observations to reflect on yet.');
    refreshStream();
  } catch (err) {
    toastError(err);
  } finally {
    btn.disabled = false;
  }
}

let failed = null; // the last list() error: shown instead of the grid until a read works
let reads = 0; // only the latest read is shown: an older one can answer last
let retried = false; // Try again was pressed: a read that fails again puts the focus on the new button

export async function refresh() {
  const read = ++reads;
  const got = await api.memory.list().then((list) => ({ list }), (err) => ({ err }));
  if (read !== reads) return;
  if (got.err) failed = got.err; // the previous entries stay for the category list and the editor
  else {
    entries = got.list;
    failed = null;
  }
  const cats = [...new Set(entries.map((e) => e.category))].sort();
  const sel = $('#memCategory');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option ${c === cur ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
  render();
  refreshStream();
}

function highlight(text, terms) {
  let html = escapeHtml(text);
  for (const t of terms) html = html.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  return html;
}

function render() {
  const grid = $('#memGrid');
  const wasRetry = retried;
  retried = false;
  if (failed) {
    // The old button had the focus (or lost it when Try again disabled it): the new one gets it, unless the
    // user has moved to another control meanwhile.
    const active = document.activeElement;
    const refocus = grid.contains(active) || (wasRetry && (!active || active === document.body));
    $('#memSummary').textContent = 'Memories couldn’t be read just now.';
    grid.innerHTML = '';
    const again = el('button', { class: 'btn small', onclick: (ev) => ((ev.currentTarget.disabled = true), (retried = true), refresh()) }, 'Try again');
    grid.append(el('div', { class: 'test-result err', role: 'alert' }, `Couldn’t read your memories: ${plainError(failed)} `, again));
    if (refocus) again.focus();
    return;
  }
  const q = $('#memSearch').value.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const cat = $('#memCategory').value;
  const list = entries.filter((e) => (!cat || e.category === cat) && terms.every((t) => `${e.title} ${e.content} ${e.category}`.toLowerCase().includes(t)));
  $('#memSummary').textContent = `${entries.length} memories in the vault${list.length !== entries.length ? ` · ${list.length} shown` : ''} · every memory is injected into the agent's system prompt.`;
  grid.innerHTML = '';
  if (!list.length) {
    if (entries.length) grid.append(el('div', { class: 'muted mem-empty' }, 'No memories match.'));
    else {
      grid.append(
        el(
          'div',
          { class: 'mem-empty glass' },
          el('h3', { class: 'display' }, 'Nothing remembered yet'),
          el('p', { class: 'muted' }, 'Tell the assistant about yourself in the chat and it keeps what matters here, or write a memory yourself.'),
          el('button', { class: 'btn primary', onclick: () => edit() }, '＋ Add memory'),
        ),
      );
    }
    return;
  }
  for (const e of list) {
    grid.append(
      el(
        'div',
        { class: 'mem-card glass' },
        el('span', { class: 'tag' }, e.category),
        el('h4', { html: highlight(e.title, terms) }),
        el('div', { class: 'content', html: highlight(e.content, terms) }),
        el(
          'div',
          { class: 'foot' },
          el('span', { title: new Date(e.updated).toLocaleString() }, `updated ${timeAgo(e.updated)}`),
          el(
            'span',
            { class: 'acts' },
            el('button', { class: 'btn small', onclick: () => edit(e) }, 'Edit'),
            el(
              'button',
              {
                class: 'btn small danger',
                onclick: async () => {
                  if (await confirmDialog('Delete memory', `Forget “${e.title}”?`, 'Delete')) {
                    try {
                      await api.memory.delete(e.id);
                      // The entry is still in hand: Undo writes it back as it was (memory:restore).
                      toastActions(`Forgot “${e.title}”`, [['Undo', () => api.memory.restore(e).then(() => toast(`“${e.title}” is back.`), (err) => toastError(plainError(err))).finally(refresh)]]);
                    } catch (err) {
                      toastError(plainError(err));
                    } finally {
                      refresh();
                    }
                  }
                },
              },
              'Delete',
            ),
          ),
        ),
      ),
    );
  }
}

// The editor checks and saves before it closes: a refusal shows in it, and every field is kept.
async function edit(entry) {
  let dirty = () => false; // set once the fields exist
  await modal((card, close) => {
    const title = el('input', { class: 'input', id: 'memEditTitle', value: entry?.title || '', placeholder: 'Title' });
    const category = el('input', { class: 'input', id: 'memEditCategory', value: entry?.category || 'general', placeholder: 'Category', list: 'memCats' });
    const datalist = el('datalist', { id: 'memCats' }, [...new Set(entries.map((e) => e.category))].map((c) => el('option', { value: c })));
    const content = el('textarea', { class: 'input', id: 'memEditContent', rows: 8, placeholder: 'What should the agent remember?' });
    content.value = entry?.content || '';
    const snapshot = () => JSON.stringify([title.value, category.value, content.value]);
    const start = snapshot();
    dirty = () => snapshot() !== start;
    const error = el('div', { class: 'test-result err hidden', role: 'alert' });
    const fail = (msg, field) => {
      error.textContent = msg;
      error.classList.remove('hidden');
      field?.focus();
    };
    let busy = false;
    const saveBtn = el('button', { class: 'btn primary' }, 'Save');
    saveBtn.onclick = async () => {
      if (busy) return; // a second click while the first save runs
      const result = { title: title.value.trim(), category: category.value.trim() || 'general', content: content.value.trim() };
      if (!result.content) return fail('Write what the agent should remember.', content);
      busy = true;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        if (entry) await api.memory.update(entry.id, result);
        else await api.memory.save(result);
        refresh(); // the list first: a save that lands after Esc → Discard still shows
        close(true);
      } catch (err) {
        busy = false;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        fail(plainError(err), saveBtn); // the focus is kept in the card (a disabled button may lose it)
      }
    };
    card.append(
      el('h3', {}, entry ? 'Edit memory' : 'New memory'),
      el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', { for: 'memEditTitle' }, 'Title'), title), el('div', { class: 'field' }, el('label', { for: 'memEditCategory' }, 'Category'), category, datalist)),
      el('div', { class: 'field' }, el('label', { for: 'memEditContent' }, 'Content'), content),
      error,
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), saveBtn),
    );
    setTimeout(() => (entry ? content : title).focus(), 0);
  }, { dirty: () => dirty() });
}
