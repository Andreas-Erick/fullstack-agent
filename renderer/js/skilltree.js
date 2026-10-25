// Skill tree view: the skills the user is growing as a constellation (Skill Tree.md in the vault,
// main/skilltree.js). Columns go from foundations to advanced, colors are branches (areas), the ring
// around each star is its progress. Drag to pan, wheel to zoom, click a star for its evidence.
import { $, api, el, toast, toastError, modal, confirmDialog, promptDialog, on } from './util.js';
import { switchView } from './nav.js';
import { send } from './chat.js';

const SVG = 'http://www.w3.org/2000/svg';
const COL = 230; // px between depth columns
const ROW = 96; // px between stars in a column
const STATE_LABEL = { locked: 'Locked', ready: 'Ready to start', growing: 'Growing', mastered: 'Mastered' };

let data = null;
let selected = null;
let view = { x: 0, y: 0, k: 1 };

export function initSkillTree() {
  $('#treeAdd').onclick = () => editSkill();
  $('#treeGoal').onclick = () => mapGoal();
  on('skilltree-changed', refresh);
  on('habits-changed', () => data && refresh());
  setupPanZoom($('#treeCanvas'));
}

export async function refresh() {
  try {
    data = await api.skilltree.view();
  } catch (err) {
    $('#treeEmpty').classList.remove('hidden');
    $('#treeEmpty').textContent = `The skill tree lives in your vault (Skill Tree.md). ${err.message}`;
    return;
  }
  announce(data.skills);
  draw();
  showDetail(selected && data.skills.find((s) => s.name === selected) ? selected : null);
}

// "Unlocked" and "Mastered" moments, remembered per computer so they show once.
function announce(skills) {
  let before = {};
  try {
    before = JSON.parse(localStorage.getItem('skilltree.states') || '{}');
  } catch {
    /* storage unavailable: no announcements */
  }
  const now = Object.fromEntries(skills.map((s) => [s.name, s.state]));
  for (const s of skills) {
    const was = before[s.name];
    if (!was) continue;
    if (was === 'locked' && s.state !== 'locked') toast(`🌌 Unlocked: ${s.name}`);
    if (was !== 'mastered' && s.state === 'mastered') toast(`✨ Mastered: ${s.name}`);
  }
  try {
    localStorage.setItem('skilltree.states', JSON.stringify(now));
  } catch {
    /* fine */
  }
}

function svg(tag, attrs = {}, ...children) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  n.append(...children);
  return n;
}

function draw() {
  const canvas = $('#treeCanvas');
  const layer = $('#treeLayer');
  layer.innerHTML = '';
  const empty = !data.skills.length;
  $('#treeEmpty').classList.toggle('hidden', !empty);
  if (empty) {
    $('#treeEmpty').innerHTML = '';
    $('#treeEmpty').append(
      el('h3', { class: 'display' }, 'Your skill tree is empty'),
      el('p', {}, 'Map what you are growing: a subject, a language, a physical skill, a way of working. Each skill builds on others, and its progress comes from what you already track: concepts you understood in the learning tracker, mature cards in a vocabulary deck, a habit you keep.'),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => mapGoal() }, '🪄 Map a goal with the assistant'), el('button', { class: 'btn', onclick: () => editSkill() }, '＋ Add a skill')),
    );
    return;
  }
  const { pos, edges, depth, areas } = data.layout;
  const columns = new Map();
  for (const p of Object.values(pos)) columns.set(p.depth, (columns.get(p.depth) || 0) + 1);
  const height = Math.max(...columns.values()) * ROW;
  const at = (name) => ({ x: 90 + pos[name].x * depth * COL, y: 70 + pos[name].y * Math.max(0, height - ROW) });
  const byName = new Map(data.skills.map((s) => [s.name, s]));

  for (const e of edges) {
    const a = at(e.from);
    const b = at(e.to);
    const lit = byName.get(e.from)?.progress >= data.thresholds.unlock;
    const mx = (a.x + b.x) / 2;
    layer.append(svg('path', { d: `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`, class: `tree-edge ${lit ? 'lit' : ''}` }));
  }
  for (const s of data.skills) {
    const p = at(s.name);
    const area = Math.max(0, areas.indexOf(s.area || '')) % 5;
    const r = 15;
    const circ = 2 * Math.PI * (r + 6);
    const g = svg('g', { class: `tree-node ${s.state} area-${area} ${s.name === selected ? 'selected' : ''}`, transform: `translate(${p.x},${p.y})`, tabindex: 0 });
    g.append(
      svg('circle', { class: 'halo', r: r + 14 }),
      svg('circle', { class: 'ring-bg', r: r + 6 }),
      svg('circle', { class: 'ring', r: r + 6, 'stroke-dasharray': `${circ * s.progress} ${circ}`, transform: 'rotate(-90)' }),
      svg('circle', { class: 'core', r }),
      svg('text', { class: 'glyph', 'text-anchor': 'middle', dy: '0.35em' }, s.state === 'locked' ? '🔒' : s.state === 'mastered' ? '✓' : `${Math.round(s.progress * 100)}`),
      svg('text', { class: 'label', 'text-anchor': 'middle', y: r + 26 }, s.name),
    );
    g.addEventListener('click', (ev) => (ev.stopPropagation(), showDetail(s.name)));
    g.addEventListener('keydown', (ev) => ev.key === 'Enter' && showDetail(s.name));
    layer.append(g);
  }
  // Fit on first draw.
  if (!canvas.dataset.fitted) {
    canvas.dataset.fitted = '1';
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 500;
    const k = Math.min(1.4, Math.max(0.4, Math.min(w / (depth * COL + 180), h / (height + 120))));
    view = { k, x: (w - (depth * COL + 180) * k) / 2, y: Math.max(10, (h - (height + 100) * k) / 2) };
  }
  applyView();
  $('#treeLegend').innerHTML = '';
  areas.filter(Boolean).forEach((a, i) => $('#treeLegend').append(el('span', { class: `chip area-${i % 5}` }, a)));
}

function applyView() {
  $('#treeLayer').setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
}

function setupPanZoom(canvas) {
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.tree-node')) return;
    drag = { x: e.clientX - view.x, y: e.clientY - view.y };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    view.x = e.clientX - drag.x;
    view.y = e.clientY - drag.y;
    applyView();
  });
  canvas.addEventListener('pointerup', () => (drag = null));
  canvas.addEventListener('click', (e) => !e.target.closest('.tree-node') && showDetail(null));
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const k = Math.max(0.3, Math.min(2.5, view.k * (e.deltaY < 0 ? 1.1 : 0.9)));
      view.x = mx - ((mx - view.x) * k) / view.k;
      view.y = my - ((my - view.y) * k) / view.k;
      view.k = k;
      applyView();
    },
    { passive: false },
  );
}

function showDetail(name) {
  selected = name;
  document.querySelectorAll('.tree-node').forEach((n) => n.classList.toggle('selected', n.querySelector('.label')?.textContent === name));
  const box = $('#treeDetail');
  box.innerHTML = '';
  const s = name && data?.skills.find((x) => x.name === name);
  box.classList.toggle('hidden', !s);
  if (!s) return;
  const pct = Math.round(s.progress * 100);
  const ask = (q) => {
    switchView('chat');
    send(q);
  };
  box.append(
    el('div', { class: 'hint' }, `${s.area || 'No branch'} · ${STATE_LABEL[s.state]}`),
    el('h3', { class: 'display' }, s.name),
    s.description ? el('p', {}, s.description) : '',
    el('div', { class: 'tree-bar' }, el('i', { style: { width: `${pct}%` } })),
    el('div', { class: 'hint' }, `${pct}%${s.manual !== undefined ? ` (you set ${Math.round(s.manual * 100)}% as a starting point)` : ''}`),
    s.needs.length ? el('div', { class: 'tree-sec' }, el('b', {}, 'Builds on'), ...s.needs.map((n) => el('button', { class: `chip ${s.blockers.includes(n) ? 'warn' : 'ok'}`, onclick: () => showDetail(n) }, `${s.blockers.includes(n) ? '○' : '●'} ${n}`))) : '',
    el('div', { class: 'tree-sec' }, el('b', {}, 'Progress comes from'), ...(s.sources.length ? s.sources.map((x) => el('div', { class: 'tree-src' }, `${{ learning: '🎓', deck: '🗂', habit: '✅' }[x.type]} ${x.name}: ${x.detail}`)) : [el('div', { class: 'hint' }, 'Nothing linked yet: edit it to connect a learning topic, a deck or a habit.')])),
    el(
      'div',
      { class: 'tree-actions' },
      el('button', { class: 'btn primary', onclick: () => ask(`For my skill "${s.name}" in my skill tree: where do I stand, and what is the best next step this week?`) }, 'What next?'),
      s.sources.some((x) => x.type === 'learning') ? el('button', { class: 'btn', onclick: () => ask(`/study-session ${s.sources.find((x) => x.type === 'learning').name}`) }, 'Study session') : '',
      s.sources.some((x) => x.type === 'deck') ? el('button', { class: 'btn', onclick: () => ask(`/drill ${s.sources.find((x) => x.type === 'deck').name}`) }, 'Review cards') : '',
      el('button', { class: 'btn', onclick: () => ask(`Help me break down the skill "${s.name}" in my skill tree into the skills it builds on, and add them.`) }, 'Break it down'),
      el('button', { class: 'btn', onclick: () => editSkill(s) }, 'Edit'),
      el('button', {
        class: 'btn danger',
        onclick: async () => {
          if (!(await confirmDialog(`Remove “${s.name}”?`, 'Only the skill leaves the tree; your notes, decks and habits stay.', 'Remove'))) return;
          api.skilltree.remove(s.name).then(() => ((selected = null), refresh()), toastError);
        },
      }, 'Remove'),
    ),
  );
}

async function mapGoal() {
  const goal = await promptDialog('What do you want to grow? (e.g. “understand measure theory”, “speak Spanish at B2”, “run a half marathon”)');
  if (!goal?.trim()) return;
  switchView('chat');
  send(`Map this into my skill tree: ${goal.trim()}. Propose the skill, the skills it builds on and where progress should come from (my learning topics, decks or habits, or new ones), ask me if anything is unclear, then add it with skilltree_update.`);
}

async function editSkill(s = null) {
  const opts = data?.options || { learning: [], deck: [], habit: [] };
  const others = (data?.skills || []).filter((x) => x.name !== s?.name).map((x) => x.name);
  const areas = [...new Set((data?.skills || []).map((x) => x.area).filter(Boolean))];
  // The name is fixed once a skill exists: other skills refer to it by name as a prerequisite.
  const name = el('input', { class: 'input', value: s?.name || '', placeholder: 'e.g. Real Analysis, Spanish B1, Running a 10k', readonly: s ? true : null });
  const description = el('input', { class: 'input', value: s?.description || '', placeholder: 'One short line (optional)' });
  const area = el('input', { class: 'input', value: s?.area || '', placeholder: 'Branch, e.g. Math, Languages, Body', list: 'treeAreas' });
  const areaList = el('datalist', { id: 'treeAreas' }, ...areas.map((a) => el('option', { value: a })));
  const checks = (items, isOn) => el('div', { class: 'tree-checks' }, ...(items.length ? items.map((v) => el('label', { class: 'day-pick' }, el('input', { type: 'checkbox', value: v, checked: isOn(v) }), v)) : [el('span', { class: 'hint' }, 'none yet')]));
  const has = (type) => (v) => (s?.from || []).some((f) => f.type === type && f.name === v);
  const needs = checks(others, (v) => (s?.needs || []).includes(v));
  const fromLearning = checks(opts.learning, has('learning'));
  const fromDeck = checks(opts.deck, has('deck'));
  const fromHabit = checks(opts.habit, has('habit'));
  const manual = el('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round((s?.manual ?? 0) * 100) });
  const manualLabel = el('span', { class: 'muted' }, `${manual.value}%`);
  manual.addEventListener('input', () => (manualLabel.textContent = `${manual.value}%`));
  const picked = (box) => [...box.querySelectorAll('input:checked')].map((i) => i.value);
  const ok = await modal((card, close) => {
    card.classList.add('wide');
    card.append(
      el('h3', {}, s ? `Edit “${s.name}”` : 'New skill'),
      el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', {}, 'Skill'), name), el('div', { class: 'field' }, el('label', {}, 'Branch'), area, areaList)),
      el('div', { class: 'field' }, el('label', {}, 'Description'), description),
      el('div', { class: 'field' }, el('label', {}, 'Builds on'), needs),
      el('div', { class: 'field' }, el('label', {}, 'Progress from learning topics (concepts understood)'), fromLearning),
      el('div', { class: 'field' }, el('label', {}, 'Progress from vocabulary decks (mature cards)'), fromDeck),
      el('div', { class: 'field' }, el('label', {}, 'Progress from habits (consistency)'), fromHabit),
      el('div', { class: 'field' }, el('label', {}, 'Already know from before'), el('div', { class: 'row' }, manual, manualLabel)),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'), el('button', { class: 'btn primary', onclick: () => close(true) }, 'Save')),
    );
  });
  if (!ok || !name.value.trim()) return;
  const from = [...picked(fromLearning).map((n) => ({ type: 'learning', name: n })), ...picked(fromDeck).map((n) => ({ type: 'deck', name: n })), ...picked(fromHabit).map((n) => ({ type: 'habit', name: n }))];
  // Keep targets the agent set on sources that stay linked.
  for (const f of from) Object.assign(f, (s?.from || []).find((x) => x.type === f.type && x.name === f.name) || {});
  try {
    await api.skilltree.upsert({ name: name.value.trim(), description: description.value.trim(), area: area.value.trim(), needs: picked(needs), from, manual: Number(manual.value) ? Number(manual.value) / 100 : null });
    selected = name.value.trim();
    refresh();
  } catch (err) {
    toastError(err);
  }
}
