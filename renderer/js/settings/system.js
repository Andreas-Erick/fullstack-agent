// Safety & permissions, helper apps, health, performance and the interface.
import { api, el, toast, toastError, emit } from '../util.js';
import { state } from '../state.js';
import { setZoom } from '../layout.js';
import { scanInto } from '../hwscan.js';
import { detect } from '../perf.js';
import { profile } from '../perfcore.js';
import { text, toggle, select, field, card, debounceAfter } from './fields.js';

export function safetyCard() {
  return card(
    'safety',
    'Safety & permissions',
    'What the agent may do without asking. Approve requests by clicking or by saying a yes on its own — “yes”, “yeah”, “okay”, “go ahead” (anything else declines; no answer counts as no).',
    select('safety.permissionMode', 'Ask before acting?', [['ask', 'Ask me first — self-changes, settings changes, deletions (recommended)'], ['auto', 'Just do it — still asks before code changes, commands, publishing to GitHub, invitations and services you haven’t allowed (and, after reading outside content, before deleting or inviting in your services, opening new websites or saving routines and skills)']], { hint: 'Also by voice: “stop asking for permission” / “start asking again”.' }),
    toggle('safety.taintGuard', 'Extra caution after reading websites or files (recommended)', {
      hint: 'Pages and files can contain hidden instructions. After reading outside content (web pages, documents, your services’ data), warn on every approval and ask before changing my code, deleting or inviting through a service, opening a website nobody named, or saving a routine or skill — also in “Just do it” mode and at “Allow everything”.',
    }),
    toggle('screen.attachToMessages', 'While I share my screen, include a screenshot with each message (otherwise only when the agent asks to look)'),
    text('safety.approvalTimeoutSec', 'Approval timeout (seconds)', { type: 'number' }),
    el('div', { class: 'hint' }, 'External content (web pages, documents, tool results) is always treated as data — the agent is instructed never to follow instructions inside it.'),
  );
}

// Remote access (companion server, docs/ROADMAP-mobile.md): pair a phone or another computer.

const HELPER_STATUS = { running: ['ok', '●', 'Running'], starting: ['warn', '◌', 'Starting…'], failed: ['fail', '✕', 'Failed to start'], remote: ['off', '○', 'On another computer'], stopped: ['off', '○', 'Not running'] };
export let refreshHelperApps = null;
export function helperAppsCard() {
  const list = el('div', { class: 'health-list' });
  const refresh = async () => {
    const apps = await api.helperApps.status().catch(() => []);
    list.innerHTML = '';
    for (const a of apps) {
      const [cls, ic, word] = HELPER_STATUS[a.status] || HELPER_STATUS.stopped;
      const where = a.installedAt ? `Installed: ${a.installedAt}` : a.local ? 'Not found in its usual install folder; set its location below.' : '';
      const use = a.needed ? `Used for ${a.id === 'voicestudio' ? 'the natural voice' : 'the FreeLLMAPI brain'} at ${a.url}` : 'Not used with the current settings';
      list.append(el('div', { class: `health-item ${a.needed ? cls : 'off'}` },
        el('span', { class: 'ic' }, ic),
        el('div', { style: { flex: 1 } }, el('b', {}, `${a.name} · ${word}`), el('div', { class: 'd' }, [use, where, a.error].filter(Boolean).join('\n'))),
        a.local && a.installedAt && !['running', 'starting'].includes(a.status)
          ? el('button', { class: 'btn small', onclick: async () => (await api.helperApps.start(a.id).catch(toastError), refresh()) }, 'Start now')
          : null,
      ));
    }
  };
  refreshHelperApps = refresh;
  refresh();
  return card(
    'helperapps',
    'Helper apps',
    'VoiceStudio (the natural voice) and FreeLLMAPI (a local brain) are separate apps. Siren starts the ones your settings use, in the background, so you only open Siren. It only starts them when their address is on this computer, and only from their install folder or the location you set here.',
    toggle('helperApps.autoStart', 'Start them with Siren, and again when they are needed and not running'),
    toggle('helperApps.minimize', 'Keep their windows minimized (in the taskbar)'),
    toggle('helperApps.stopOnQuit', 'Close them when I quit Siren (only the ones Siren started)'),
    list,
    el('div', { class: 'grid2' },
      text('helperApps.voicestudioPath', 'VoiceStudio location (optional)', { placeholder: 'Found automatically', hint: 'The program file, e.g. VoiceStudio.exe.', onChange: debounceAfter(refresh) }),
      text('helperApps.freellmapiPath', 'FreeLLMAPI location (optional)', { placeholder: 'Found automatically', hint: 'The program file, e.g. FreeLLMAPI.exe.', onChange: debounceAfter(refresh) }),
    ),
  );
}

export async function healthCard() {
  const list = el('div', { class: 'health-list' }, el('div', { class: 'muted' }, 'Run diagnostics to check every part of the agent.'));
  const logBox = el('pre', { class: 'log-view hidden' });
  const hwBox = el('div', { class: 'field hidden' });
  const ICON = { ok: '✓', warn: '!', fail: '✕', off: '–' };
  const run = async () => {
    list.innerHTML = '<div class="muted">Checking…</div>';
    try {
      const results = await api.diag.run();
      list.innerHTML = '';
      for (const r of results) {
        list.append(el('div', { class: `health-item ${r.status}` }, el('span', { class: 'ic' }, ICON[r.status] || '?'), el('div', {}, el('b', {}, r.label), el('div', { class: 'd' }, r.detail), r.fix ? el('div', { class: 'f' }, `Fix: ${r.fix}`) : '')));
      }
    } catch (err) {
      list.innerHTML = '';
      list.append(el('div', { class: 'test-result err' }, err.message));
    }
  };
  return card(
    'health',
    'Health & the mechanic',
    'The agent is its own mechanic: it can run these checks, read its log and fix its configuration. Ask it “what’s wrong with your voice?” — or check here.',
    el('div', { class: 'row', style: { flexWrap: 'wrap' } },
      el('button', { class: 'btn primary', onclick: run }, '🩺 Run diagnostics'),
      el('button', { class: 'btn', onclick: async () => { logBox.classList.toggle('hidden'); logBox.textContent = await api.log.tail(300); logBox.scrollTop = logBox.scrollHeight; } }, '📜 Show log'),
      el('button', { class: 'btn', onclick: () => api.log.open() }, 'Open log folder'),
      el('button', {
        class: 'btn',
        title: 'One file with the environment, health checks, recent errors and log, and settings without secrets',
        onclick: async () => {
          try {
            const r = await api.log.report('');
            toast(`Bug report saved (${r.problemsLast24h} problems in the last 24 h).`);
          } catch (err) {
            toastError(err);
          }
        },
      }, '🐞 Create bug report'),
      el('button', { class: 'btn', onclick: () => (hwBox.classList.remove('hidden'), scanInto(hwBox)) }, '🖥 Scan hardware'),
      el('button', { class: 'btn', onclick: async () => (await import('../setup.js')).startSetup() }, '✦ Set me up by conversation'),
      el('button', { class: 'btn', onclick: async () => (await import('../onboarding.js')).startOnboarding() }, 'Setup form'),
    ),
    toggle('logging.debug', 'Detailed logging (more lines, for hunting a bug; turn off afterwards)'),
    hwBox,
    list,
    logBox,
  );
}

// Performance (perf.js, perfcore.js): the profile, what the hardware check found, and checking again.
function performanceControls() {
  const info = el('div', { class: 'hint' });
  const show = () => {
    const p = state.settings.perf || {};
    const hw = p.hw || {};
    const using = profile(state.settings) === 'balanced' ? 'Balanced' : 'Full';
    const found = p.detectedAt ? `This computer: ${hw.ramGB ?? '?'} GB of memory${hw.gpu ? `, ${hw.gpu}` : ''}${hw.vramGB ? ` (${hw.vramGB} GB)` : ''}${p.detected === 'low' ? ` — lighter (${hw.reason})` : ''}.` : 'This computer has not been checked yet.';
    info.textContent = `${found} In use: ${using}.`;
  };
  show();
  const again = el('button', {
    class: 'btn small',
    onclick: async () => {
      again.disabled = true;
      try {
        await detect();
        show();
        toast(`Checked: ${profile(state.settings) === 'balanced' ? 'Balanced' : 'Full'} performance is in use.`);
      } catch (err) {
        toastError(err);
      } finally {
        again.disabled = false;
      }
    },
  }, 'Check this computer again');
  return [
    select('perf.mode', 'Performance', [['auto', 'Auto — chosen for this computer'], ['full', 'Full — everything, for a strong computer'], ['balanced', 'Balanced — for lighter computers']], {
      hint: 'Balanced: speech recognition runs on the processor with a smaller model, loads only when you talk and unloads after 10 quiet minutes (in-app recognition needs over 1 GB while loaded, whatever the model; cloud recognition in Voice input avoids that entirely). Effects keep their look without motion or blur and pause while the window is in the background; faces draw at 30 fps without glow; at most two Claude sessions stay alive. Full keeps everything.',
      onChange: show,
    }),
    el('div', { class: 'row' }, info, again),
  ];
}

export function uiCard() {
  const zoom = el('input', { type: 'range', min: '0.5', max: '2', step: '0.05', value: state.settings.ui.zoom || 1, style: { flex: 1 } });
  const zoomLabel = el('span', { class: 'muted num' }, `${Math.round((state.settings.ui.zoom || 1) * 100)}%`);
  zoom.addEventListener('input', () => {
    zoomLabel.textContent = `${Math.round(Number(zoom.value) * 100)}%`;
    setZoom(Number(zoom.value));
  });
  return card(
    'ui',
    'Interface',
    'Zoom: Ctrl + / Ctrl − / Ctrl 0, or Ctrl + mouse wheel. Layouts: Ctrl+Shift+1 chat only, 2 side by side, 3 face. F11: full screen.',
    field('Zoom', el('div', { class: 'row' }, zoom, zoomLabel)),
    ...performanceControls(),
    select('ui.fx', 'Visual effects', [['hud', 'Futuristic — HUD frames, ambient grid, boot sequence, animations'], ['subtle', 'Subtle — HUD frames and readouts, no motion'], ['off', 'Off — the plain look']], { hint: 'Follows the theme colors. With “reduce motion” on in your system, animations stay off.' }),
    select('ui.chatLayout', 'Chat layout', [['chat', 'Chat only (full width)'], ['split', 'Chat and face side by side'], ['face', 'Face full size, chat underneath']], { onChange: () => emit('layout') }),
    toggle('ui.captions', 'Show captions on the face'),
    toggle('ui.showClaudeUsage', 'Show how much of the Claude plan is left (title bar, when the Claude account brain is used)'),
    toggle('ui.showSystemStats', 'Show CPU, RAM and GPU load in the title bar (click it for details; only you see these, they never go to the AI)'),
    text('ui.sleepAfterMin', 'Face dozes off after (minutes without activity; 0 = never)', { type: 'number' }),
    toggle('ui.sleepOnLaunch', 'Asleep when the app starts, until the greeting or the first thing you do'),
  );
}
