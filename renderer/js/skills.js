// Skills view: the user's reusable workflows. Create, edit, delete, and run one (it opens the chat and
// sends "/name", so the agent gets the steps). The agent can save skills too ("make this a skill").
import { $, api, el, toast, toastError, modal, confirmDialog, on, emit } from './util.js';
import { switchView } from './nav.js';
import { send } from './chat.js';

let all = [];

const EXAMPLES = [
  { name: 'Morning briefing', description: "Today's plan in one minute", triggers: ['start my day', 'morning briefing'], steps: "1. Read today's calendar events.\n2. Read Active Priorities.\n3. Search the web for the top 3 news headlines.\n4. Tell me: today's meetings, the 3 things to focus on, and the headlines, in under 150 words." },
  { name: 'Meeting notes', description: 'Turn rough notes into a clean summary', input: 'the rough notes', triggers: ['clean up my meeting notes'], steps: '1. Take the notes I give you.\n2. Write a summary with: decisions, action items (who, what, when) and open questions.\n3. Save it with vault_write_note in Meetings/<date> <topic>.md.\n4. Offer to make a PDF of it (create_pdf).' },
  { name: 'Weekly review', description: 'Wrap up the week', triggers: ['weekly review'], steps: "1. Read this week's daily notes.\n2. Update Active Priorities: move finished items to Done recently, add what's next.\n3. Give me a short summary of the week and the top 3 for next week." },
];

export function initSkills() {
  $('#skillNew').onclick = () => edit();
  $('#skillFolder').onclick = () => api.skills.openFolder().catch(toastError);
  $('#skillSearch').addEventListener('input', render);
  on('skills-changed', refresh);
}

export async function refresh() {
  all = await api.skills.list().catch(() => []);
  render();
}

function render() {
  const q = $('#skillSearch').value.toLowerCase();
  const grid = $('#skillGrid');
  grid.innerHTML = '';
  const list = all.filter((s) => !q || `${s.name} ${s.description} ${s.triggers.join(' ')} ${s.steps}`.toLowerCase().includes(q));
  if (!all.length) {
    grid.append(
      el(
        'div',
        { class: 'skill-empty glass' },
        el('h3', { class: 'display' }, 'No skills yet'),
        el('p', {}, 'A skill is a workflow you run again and again: a morning briefing, cleaning up meeting notes, a weekly review. Start from an example, write your own, or ask the agent to “save what you just did as a skill”.'),
        el('div', { class: 'examples' }, EXAMPLES.map((ex) => el('button', { class: 'btn', onclick: () => edit(ex, { isNew: true }) }, `＋ ${ex.name}`))),
      ),
    );
    return;
  }
  if (!list.length) grid.append(el('p', { class: 'muted' }, 'No skills match.'));
  for (const s of list) {
    grid.append(
      el(
        'div',
        { class: 'skill-card glass' },
        el('h4', {}, el('span', {}, s.name), el('code', { class: 'cmd' }, `/${s.slug}`)),
        s.description ? el('div', { class: 'sdesc' }, s.description) : '',
        s.triggers.length ? el('div', { class: 'trig' }, s.triggers.map((t) => el('span', { class: 'tag' }, `“${t}”`))) : '',
        el('div', { class: 'steps' }, s.steps),
        el(
          'div',
          { class: 'acts' },
          el('button', { class: 'btn primary small', onclick: () => run(s) }, '▶ Run'),
          el('button', { class: 'btn small', onclick: () => edit(s) }, 'Edit'),
          el('button', { class: 'btn small danger', onclick: () => remove(s) }, 'Delete'),
        ),
      ),
    );
  }
}

async function run(s) {
  let input = '';
  if (s.input) {
    input = await modal((card, close) => {
      const t = el('textarea', { class: 'input', rows: 6, placeholder: s.input });
      card.append(el('h3', {}, s.name), el('p', { class: 'muted', style: { margin: 0 } }, `Input: ${s.input}`), t, el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), el('button', { class: 'btn primary', onclick: () => close(t.value) }, '▶ Run')));
      setTimeout(() => t.focus(), 0);
    });
    if (input === null) return;
  }
  switchView('chat');
  send(`/${s.slug}${input ? ` ${input}` : ''}`);
}

async function edit(skill = {}, { isNew = !skill.slug } = {}) {
  const res = await modal((card, close) => {
    const name = el('input', { class: 'input', value: skill.name || '', placeholder: 'e.g. Morning briefing' });
    const desc = el('input', { class: 'input', value: skill.description || '', placeholder: 'One line: what it does' });
    const triggers = el('input', { class: 'input', value: (skill.triggers || []).join(', '), placeholder: 'start my day, morning briefing' });
    const input = el('input', { class: 'input', value: skill.input || '', placeholder: 'e.g. the rough notes (leave empty if it needs nothing)' });
    const steps = el('textarea', { class: 'input', rows: 9, placeholder: '1. …\n2. …\n3. …' });
    steps.value = skill.steps || '';
    const field = (label, control, hint) => el('div', { class: 'field' }, el('label', {}, label), control, hint ? el('div', { class: 'hint' }, hint) : '');
    card.classList.add('wide');
    card.append(
      el('h3', {}, isNew ? 'New skill' : `Edit “${skill.name}”`),
      el('div', { class: 'grid2' }, field('Name', name, 'Becomes the /command.'), field('Purpose', desc)),
      el('div', { class: 'grid2' }, field('Trigger phrases (comma-separated)', triggers, 'Saying one of these starts it.'), field('Input it needs', input, 'Asked for when you click Run.')),
      field('Steps', steps, 'Write them for the agent: what to read, which tools to use, what to give back. Numbered steps work best.'),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), el('button', { class: 'btn primary', onclick: () => close({ name: name.value, description: desc.value, triggers: triggers.value.split(',').map((t) => t.trim()).filter(Boolean), input: input.value, steps: steps.value }) }, 'Save skill')),
    );
    setTimeout(() => name.focus(), 0);
  });
  if (!res) return;
  try {
    const saved = await api.skills.save(res, isNew ? undefined : skill.slug);
    toast(`Saved — run it with /${saved.slug}`);
    emit('skills-changed');
  } catch (err) {
    toastError(err);
  }
}

async function remove(s) {
  if (!(await confirmDialog('Delete skill', `Delete “${s.name}”? This cannot be undone.`, 'Delete'))) return;
  await api.skills.delete(s.slug).catch(toastError);
  emit('skills-changed');
}
