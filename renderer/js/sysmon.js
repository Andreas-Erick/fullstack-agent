// The system monitor in the title bar (main/sysmon.js): CPU, RAM and GPU load at a glance, and a panel
// with the details (models, GB used, disk, VRAM, temperature, connected Bluetooth devices, the internet
// connection) on click. The speed test (main/netspeed.js) runs only when the user clicks "Measure".
// For the user only: none of this goes to the assistant. Sampling runs only while the meter is on and
// the window is visible; Bluetooth is checked only while the panel is open.
import { $, api, el, on, toastError } from './util.js';
import { state } from './state.js';
import { switchView } from './nav.js';
import { speechStatus, unloadSpeech, offlineVoiceStatus, unloadOfflineVoice } from './voice.js';
import { profile } from './perfcore.js';

let stats = null;
let watching = false;
let bt = undefined; // undefined = not checked yet, null = not available, else { radio, devices }
let net = { adapter: null, lastSpeed: null, measuring: false };
let speedError = '';
let extrasTimer = null;
let usage = null; // what Nexus itself holds (main/resources.js), while the panel is open

export function initSysmon() {
  const pill = $('#pillSys');
  const panel = $('#sysPanel');
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.classList.contains('hidden')) openPanel();
    else closePanel();
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closePanel);
  api.on('system:stats', (s) => ((stats = s), render()));
  on('settings', update);
  document.addEventListener('visibilitychange', update);
  window.addEventListener('online', renderIfOpen);
  window.addEventListener('offline', renderIfOpen);
  update();
  render();
}

const enabled = () => state.settings?.ui?.showSystemStats !== false;
const isOpen = () => !$('#sysPanel').classList.contains('hidden');
const renderIfOpen = () => isOpen() && renderPanel();

// Watch while the meter is on and the window can be seen.
function update() {
  const want = enabled() && document.visibilityState === 'visible';
  $('#pillSys').classList.toggle('hidden', !enabled());
  if (!enabled()) closePanel();
  if (want === watching) return;
  watching = want;
  api.system
    .watch(want)
    .then((s) => s && ((stats = s), render()))
    .catch(() => (watching = false));
}

// Bluetooth and the network adapter: checked when the panel opens, then every 15 seconds while open.
function openPanel() {
  $('#sysPanel').classList.remove('hidden');
  renderPanel();
  refreshExtras();
  clearInterval(extrasTimer);
  extrasTimer = setInterval(refreshExtras, 15000);
}

function closePanel() {
  $('#sysPanel').classList.add('hidden');
  clearInterval(extrasTimer);
  extrasTimer = null;
}

async function refreshExtras() {
  // What Nexus uses comes right away; Bluetooth (a PowerShell query) can take a few seconds.
  api.system.usage().then((u) => ((usage = u), renderIfOpen()), () => {});
  const [b, n] = await Promise.all([api.system.bluetooth().catch(() => null), api.system.network().catch(() => null)]);
  bt = b;
  if (n) net = n;
  renderIfOpen();
}

async function measureSpeed() {
  speedError = '';
  net = { ...net, measuring: true };
  renderIfOpen();
  try {
    net = { ...net, lastSpeed: await api.system.speedtest() };
  } catch (err) {
    speedError = err.message;
  }
  net = { ...net, measuring: false };
  renderIfOpen();
}

const level = (pct) => (pct >= 90 ? 'high' : pct >= 70 ? 'mid' : '');

function meter(label, pct) {
  return el('span', { class: `sys-m ${level(pct)}` }, el('b', {}, label), el('i', {}, el('u', { style: { width: `${pct ?? 0}%` } })), el('em', {}, pct == null ? '–' : `${pct}%`));
}

// The busiest GPU is the one shown in the title bar.
const topGpu = () => (stats?.gpus || []).reduce((m, g) => (!m || g.load > m.load ? g : m), null);

function render() {
  const pill = $('#pillSys');
  // Before the first reading: the meters with dashes, not an empty pill.
  if (!stats) return pill.replaceChildren(meter('CPU', null), meter('RAM', null));
  pill.replaceChildren(meter('CPU', stats.cpu.load), meter('RAM', stats.ram.load), ...(stats.gpus?.length ? [meter('GPU', topGpu().load)] : []));
  pill.title = 'CPU, memory and GPU load (only you see this). Click for details.';
  renderIfOpen();
}

function row(label, pct, detail) {
  return el('div', { class: `sys-row ${level(pct)}` }, el('div', { class: 'sys-head' }, el('b', {}, label), el('span', {}, pct == null ? '' : `${pct}%`)), el('i', {}, el('u', { style: { width: `${pct ?? 0}%` } })), detail ? el('small', {}, detail) : null);
}

function bluetoothSection() {
  const head = el('div', { class: 'sys-head' }, el('b', {}, 'Bluetooth'), el('span', {}, bt?.devices?.length ? `${bt.devices.length} connected` : ''));
  let body;
  if (bt === undefined) body = el('small', {}, 'Checking…');
  else if (bt === null) body = el('small', {}, 'Not available on this computer.');
  else if (!bt.radio && !bt.devices.length) body = el('small', {}, 'No Bluetooth adapter found (or it is turned off).');
  else if (!bt.devices.length) body = el('small', {}, 'No devices connected.');
  else body = el('ul', { class: 'sys-list' }, ...bt.devices.map((d) => el('li', {}, el('span', {}, d.name), d.battery != null ? el('em', { class: d.battery <= 20 ? 'low' : '' }, `🔋 ${d.battery}%`) : null)));
  return el('div', { class: 'sys-row' }, head, body);
}

function internetSection() {
  const online = navigator.onLine;
  const s = net.lastSpeed;
  const head = el('div', { class: 'sys-head' }, el('b', {}, 'Internet'), el('span', { class: online ? 'ok' : 'off' }, online ? `Connected${net.adapter ? ` · ${net.adapter}` : ''}` : 'Offline'));
  const result = s
    ? el(
        'div',
        { class: 'sys-speed' },
        el('span', {}, el('small', {}, 'Download'), el('b', {}, `${s.downMbps}`), el('small', {}, 'Mbit/s')),
        el('span', {}, el('small', {}, 'Upload'), el('b', {}, `${s.upMbps}`), el('small', {}, 'Mbit/s')),
        el('span', {}, el('small', {}, 'Ping'), el('b', {}, `${s.pingMs}`), el('small', {}, 'ms')),
      )
    : null;
  const when = s ? `Measured ${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${s.server})` : 'Not measured yet.';
  const button = el('button', { class: 'btn small', disabled: net.measuring || !online, onclick: measureSpeed }, net.measuring ? 'Measuring… (about 20 s)' : s ? '⟳ Measure again' : '⚡ Measure speed');
  return el('div', { class: 'sys-row' }, head, result, el('div', { class: 'sys-speed-foot' }, el('small', {}, speedError || when), button));
}

// What Nexus itself uses, with a button to free each part that can go (it comes back when needed).
const shortModel = (m) => String(m || '').split('/').pop().replace(/^whisper-/, 'Whisper ');

function nexusSection() {
  const u = usage;
  const sp = speechStatus();
  const ov = offlineVoiceStatus();
  const item = (label, detail, action) => el('li', {}, el('span', {}, label), el('em', {}, detail), action || '');
  const freeing = (text, fn) =>
    el('button', { class: 'btn small', onclick: async () => {
      try {
        await fn();
      } catch (err) {
        toastError(err);
      }
      setTimeout(refreshExtras, 600); // processes take a moment to exit
      renderIfOpen();
    } }, text);
  const lines = [
    ...(u?.processes || []).map((p) => item(p.name, `${p.mb} MB`)),
    item('Speech model', sp.loaded ? `${shortModel(sp.model)}${sp.device ? ` · ${sp.device.split(/[ (·]/)[0]}` : ''}` : sp.on ? 'loads when you talk' : 'off', sp.loaded ? freeing('Unload', unloadSpeech) : null),
    ov.loaded ? item('Offline voice', ov.device || 'loading', freeing('Unload', unloadOfflineVoice)) : null,
    u?.claude.live ? item('Claude sessions', `${u.claude.live} live${u.claude.busy ? `, ${u.claude.busy} answering` : ''}`, u.claude.live > u.claude.busy ? freeing('Close idle', () => api.system.free('claude')) : null) : null,
    u?.agentWindow ? item('Agent window', 'open', freeing('Close', () => api.system.free('agentWindow'))) : null,
    u?.globe ? item('Globe server', 'running', freeing('Stop', () => api.system.free('globe'))) : null,
  ];
  const settings = el('a', { href: '#', onclick: (e) => (e.preventDefault(), closePanel(), switchView('settings', 'ui')) }, 'change');
  return el(
    'div',
    { class: 'sys-row' },
    el('div', { class: 'sys-head' }, el('b', {}, 'Siren'), el('span', {}, u ? `${(u.totalMb / 1024).toFixed(1)} GB` : '…')),
    el('ul', { class: 'sys-list sys-nexus' }, ...lines),
    el('small', {}, `Performance: ${profile(state.settings) === 'balanced' ? 'Balanced' : 'Full'} · `, settings),
  );
}

function renderPanel() {
  const panel = $('#sysPanel');
  if (!stats) return panel.replaceChildren(el('div', { class: 'muted' }, 'Measuring…'));
  const s = stats;
  const gpuRows = (s.gpus || []).map((g) =>
    row(
      g.name || 'GPU',
      g.load,
      [g.vramTotalMB ? `VRAM ${(g.vramUsedMB / 1024).toFixed(1)} / ${(g.vramTotalMB / 1024).toFixed(1)} GB` : '', g.tempC != null ? `${g.tempC} °C` : ''].filter(Boolean).join(' · '),
    ),
  );
  panel.replaceChildren(
    el('h4', {}, 'This computer'),
    row('CPU', s.cpu.load, `${s.cpu.model}${s.cpu.cores ? ` · ${s.cpu.cores} threads` : ''}`),
    row('Memory (RAM)', s.ram.load, `${s.ram.usedGB} / ${s.ram.totalGB} GB in use`),
    ...gpuRows,
    ...(gpuRows.length ? [] : [el('div', { class: 'sys-row' }, el('small', {}, s.gpuSource === null ? 'GPU: measuring…' : 'GPU load is not available on this computer.'))]),
    s.disk ? row(`Disk ${s.disk.root}`, s.disk.load, `${s.disk.usedGB} / ${s.disk.totalGB} GB used`) : null,
    nexusSection(),
    bluetoothSection(),
    internetSection(),
    el('p', { class: 'sys-note' }, 'Load updates every 2 seconds; the speed test runs only when you click it (via Cloudflare). Only shown here; never sent to the assistant.'),
  );
}
