// Evolution view: the history of changes the agent made to its own code, with diff, revert and restore.
import { $, api, el, timeAgo, toast, toastError, toastActions, confirmDialog, promptDialog, escapeHtml, on } from './util.js';
import { switchView } from './nav.js';

let selected = null;

export function initEvolution() {
  $('#evoReload').onclick = () => api.self.reload();
  $('#evoRestart').onclick = () => api.self.restart();
  // The history as a film: the Architecture view replays every commit on the map (renderer/js/replay.js).
  $('#evoReplay').onclick = () => switchView('arch', 'replay');

  // Changes recorded at the end of a turn (main process) or by the agent's self_change_commit tool.
  api.on('self:event', (ev) => {
    if (ev.type === 'committed') announce(ev.change);
    else if (ev.type === 'check_failed') {
      toastActions(`⚠ The agent's code changes failed their checks or tests and were not recorded.`, [['Review', () => openView()]]);
      refresh();
    }
  });
  on('self-changed', announce);
}

function openView() {
  document.querySelector('[data-view="evolution"]').click();
}

export function announce(change) {
  const what = change.restart ? 'Restart the app' : change.reload ? 'Reload the window' : null;
  const actions = [];
  if (change.restart) actions.push(['Restart now', () => api.self.restart()]);
  else if (change.reload) actions.push(['Reload now', () => api.self.reload()]);
  actions.push(['View change', () => openView()]);
  toastActions(`✦ Self-change recorded (${change.short}): ${change.subject?.replace('[self-change]', '').trim() || ''}${what ? ` — ${what.toLowerCase()} to use it.` : ''}`, actions);
  refresh();
}

export async function refresh() {
  const status = await api.self.status().catch((e) => ({ available: false, reason: e.message }));
  const box = $('#evoStatus');
  box.innerHTML = '';
  if (!status.available) {
    box.append(el('div', { class: 'evo-banner' }, `Change history unavailable: ${status.reason}`));
    $('#evoList').innerHTML = '';
    return;
  }
  if (!status.enabled) box.append(el('div', { class: 'evo-banner' }, 'Self-modification is turned off in Configuration → Self-improvement. History is still shown.'));
  if (!status.isRepo) {
    box.append(el('div', { class: 'evo-banner' }, 'No history yet.', el('button', { class: 'btn small', onclick: async () => (await api.self.ensure(), refresh()) }, 'Start tracking changes')));
    return;
  }
  if (status.dirty?.length) {
    box.append(
      el(
        'div',
        { class: 'evo-banner' },
        el('span', {}, `${status.dirty.length} uncommitted file change(s): ${status.dirty.slice(0, 4).map((d) => d.file).join(', ')}${status.dirty.length > 4 ? '…' : ''}`),
        el('button', {
          class: 'btn small',
          onclick: async () => {
            const summary = await promptDialog('Describe these changes', 'Manual changes');
            if (summary == null) return;
            const r = await api.self.commit(summary).catch(toastError);
            if (r && !r.ok) toastError(new Error(`Checks failed:\n${r.check.output}`));
            else if (r) announce(r);
          },
        }, 'Record'),
        el('button', {
          class: 'btn small danger',
          onclick: async () => {
            if (await confirmDialog('Discard changes', 'Throw away all uncommitted changes to the code? This cannot be undone.', 'Discard')) {
              await api.self.discard().catch(toastError);
              refresh();
              toastActions('Changes discarded.', [['Restart app', () => api.self.restart()]]);
            }
          },
        }, 'Discard'),
      ),
    );
  }

  // How the last self-change started up once it went live (checked by the app after a restart/reload).
  const v = await api.self.verification().catch(() => null);
  if (v?.state === 'problems') {
    box.append(
      el('div', { class: 'evo-banner warn' },
        el('div', {},
          el('b', {}, `“${v.subject}” (${v.short}) logged problems after it went live:`),
          el('ul', {}, v.problems.slice(0, 5).map((p) => el('li', {}, `${p.count}× ${p.event}: ${p.message.slice(0, 160)}${p.locations.length ? ` (${p.locations.join(', ')})` : ''}`))),
          el('div', { class: 'muted' }, 'Ask the assistant to fix it (it knows about these), or revert the change.'),
        ),
        el('button', {
          class: 'btn small danger',
          onclick: async () => {
            if (!(await confirmDialog('Revert change', `Undo “${v.subject}”? This is recorded as a new change and can itself be reverted.`, 'Revert'))) return;
            const r = await api.self.revert(v.sha).catch(toastError);
            if (r) toastActions('Change reverted.', r.restart ? [['Restart now', () => api.self.restart()]] : r.reload ? [['Reload now', () => api.self.reload()]] : []);
            refresh();
          },
        }, 'Revert'),
      ),
    );
  } else if (v?.state === 'pending') {
    box.append(el('div', { class: 'evo-banner' }, `“${v.subject}” (${v.short}) is not live yet: ${v.restart ? 'restart the app' : 'reload the window'} to use it. The app then checks that it started cleanly.`));
  } else if (v?.state === 'ok') {
    box.append(el('div', { class: 'evo-banner ok' }, `✓ The last self-change (“${v.subject}”, ${v.short}) started cleanly.`));
  }

  const log = await api.self.log(200).catch((e) => (toastError(e), []));
  const list = $('#evoList');
  list.innerHTML = '';
  for (const c of log) {
    list.append(
      el(
        'div',
        { class: `evo-item ${c.kind} ${selected === c.sha ? 'active' : ''}`, onclick: () => showChange(c) },
        el('span', { class: 'dot' }),
        el('div', { style: { minWidth: 0 } }, el('div', { class: 's' }, c.subject), el('div', { class: 'm' }, `${c.short} · ${timeAgo(c.date)} · ${c.files.length} file${c.files.length === 1 ? '' : 's'}`)),
      ),
    );
  }
  if (!log.length) list.append(el('div', { class: 'muted', style: { padding: '10px' } }, 'No changes yet.'));
}

function renderDiff(text) {
  const pre = el('pre', { class: 'diff' });
  pre.innerHTML = text
    .split('\n')
    .map((l) => {
      const cls = l.startsWith('diff --git') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : '';
      return `<span class="${cls}">${escapeHtml(l) || ' '}</span>`;
    })
    .join('');
  return pre;
}

async function showChange(c) {
  selected = c.sha;
  document.querySelectorAll('.evo-item').forEach((i) => i.classList.toggle('active', i.querySelector('.m')?.textContent.startsWith(c.short)));
  const box = $('#evoDetail');
  box.innerHTML = '<p class="muted">Loading…</p>';
  const diff = await api.self.show(c.sha).catch((e) => `Error: ${e.message}`);
  box.innerHTML = '';
  const after = (r, verb) => {
    if (r?.nothing) return toast('Already at that version.');
    refresh();
    const actions = r.restart ? [['Restart now', () => api.self.restart()]] : r.reload ? [['Reload now', () => api.self.reload()]] : [];
    toastActions(`${verb} (${r.head}).${r.restart ? ' Restart the app to apply.' : r.reload ? ' Reload the window to apply.' : ''}`, actions);
  };
  box.append(
    el('div', { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'wrap' } },
      el('div', {}, el('h3', { style: { margin: 0 } }, c.subject), el('div', { class: 'muted', style: { fontSize: '12px' } }, `${new Date(c.date).toLocaleString()} · ${c.short}`)),
      el('div', { class: 'row' },
        c.kind === 'baseline'
          ? ''
          : el('button', {
              class: 'btn',
              onclick: async () => {
                if (!(await confirmDialog('Revert this change', `Undo “${c.subject}”? Later changes are kept. The revert itself is recorded, so it can be undone too.`, 'Revert', false))) return;
                try {
                  after(await api.self.revert(c.sha), 'Change reverted');
                } catch (err) {
                  toastError(err);
                }
              },
            }, '↶ Revert this change'),
        el('button', {
          class: 'btn',
          onclick: async () => {
            if (!(await confirmDialog('Restore this version', `Make the app’s code exactly as it was at “${c.subject}”? Every later change is undone (but stays in history, so you can come back).`, 'Restore', false))) return;
            try {
              after(await api.self.restore(c.sha), 'Restored');
            } catch (err) {
              toastError(err);
            }
          },
        }, '⏮ Restore to this version'),
      ),
    ),
    renderDiff(diff),
  );
}
