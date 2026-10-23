// Memory vault view: browse, search, add, edit, delete, import/export.
import { $, api, el, escapeHtml, timeAgo, toast, toastError, modal, confirmDialog, debounce, on } from './util.js';

let entries = [];

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
        const n = await api.memory.import();
        if (n) toast(`Imported ${n} memories`);
        refresh();
      } else if (act === 'open-dir') await api.memory.openDir();
      else if (act === 'clear') {
        if (await confirmDialog('Delete all memories', 'This permanently deletes every memory in the vault.', 'Delete all')) {
          await api.memory.clear();
          refresh();
        }
      }
    } catch (err) {
      toastError(err);
    }
  };
  on('memory-changed', refresh);
  refresh();
}

export async function refresh() {
  entries = await api.memory.list().catch(() => []);
  const cats = [...new Set(entries.map((e) => e.category))].sort();
  const sel = $('#memCategory');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option ${c === cur ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
  render();
}

function highlight(text, terms) {
  let html = escapeHtml(text);
  for (const t of terms) html = html.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  return html;
}

function render() {
  const q = $('#memSearch').value.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const cat = $('#memCategory').value;
  const list = entries.filter((e) => (!cat || e.category === cat) && terms.every((t) => `${e.title} ${e.content} ${e.category}`.toLowerCase().includes(t)));
  $('#memSummary').textContent = `${entries.length} memories in the vault${list.length !== entries.length ? ` · ${list.length} shown` : ''} · every memory is injected into the agent's system prompt.`;
  const grid = $('#memGrid');
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
                    await api.memory.delete(e.id);
                    refresh();
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
