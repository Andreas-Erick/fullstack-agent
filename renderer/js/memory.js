// Memory vault view: browse, search, add, edit, delete, import/export.
import { $, api, el, escapeHtml, timeAgo, toast, toastError, modal, confirmDialog, debounce, on } from './util.js';

let entries = [];
// What main said, without Electron's "Error invoking remote method '…': Error: " in front.
const ipcMessage = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function initMemory() {
  $('#memSearch').addEventListener('input', debounce(render, 120));
  $('#memCategory').addEventListener('change', render);
  $('#memAdd').onclick = () => edit();
  $('#memMore').onclick = (e) => {
    e.stopPropagation();
    $('#memMenu').classList.toggle('open');
  };
  document.addEventListener('click', () => $('#memMenu').classList.remove('open'));
  $('#memMenu').onclick = async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
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
      toastError(ipcMessage(err)); // e.g. "This file isn't a memory export…"
    }
  };
  $('#streamReflect').onclick = reflectNow;
  $('#streamOpen').onclick = () => stream?.note && api.obsidian.openInObsidian(stream.note).catch(toastError);
  on('memory-changed', refresh);
  refresh();
}

// ------------------------------------------------------------ the memory stream
let stream = null;

async function refreshStream() {
  stream = await api.stream.recent().catch(() => null);
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
    grid.append(el('div', { class: 'test-result err', role: 'alert' }, `Couldn’t read your memories: ${ipcMessage(failed)} `, again));
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
    grid.append(el('div', { class: 'muted' }, entries.length ? 'No memories match.' : 'The vault is empty. Tell the agent about yourself, or add a memory manually.'));
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
                    } catch (err) {
                      toastError(ipcMessage(err));
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

async function edit(entry) {
  const result = await modal((card, close) => {
    const title = el('input', { class: 'input', value: entry?.title || '', placeholder: 'Title' });
    const category = el('input', { class: 'input', value: entry?.category || 'general', placeholder: 'Category', list: 'memCats' });
    const datalist = el('datalist', { id: 'memCats' }, [...new Set(entries.map((e) => e.category))].map((c) => el('option', { value: c })));
    const content = el('textarea', { class: 'input', rows: 8, placeholder: 'What should the agent remember?' });
    content.value = entry?.content || '';
    card.append(
      el('h3', {}, entry ? 'Edit memory' : 'New memory'),
      el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', {}, 'Title'), title), el('div', { class: 'field' }, el('label', {}, 'Category'), category, datalist)),
      el('div', { class: 'field' }, el('label', {}, 'Content'), content),
      el(
        'div',
        { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: () => close({ title: title.value.trim(), category: category.value.trim() || 'general', content: content.value.trim() }) }, 'Save'),
      ),
    );
    setTimeout(() => (entry ? content : title).focus(), 0);
  });
  if (!result) return;
  if (!result.content) return toast('Content is required', 'error');
  try {
    if (entry) await api.memory.update(entry.id, result);
    else await api.memory.save(result);
    refresh();
  } catch (err) {
    toastError(err);
  }
}
