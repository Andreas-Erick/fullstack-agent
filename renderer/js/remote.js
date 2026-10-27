// Remote access on the desktop side: the title-bar pill (visible whenever remote access is on; one
// click turns it off; its tooltip lists the paired devices and when each was last seen), toasts when a
// device connects or has been gone a while, and speech-to-text for push-to-talk from paired devices.
import { $, api, on, toast, logEvent } from './util.js';
import { state, saveSettings } from './state.js';
import { transcribe, offlineVoiceWav } from './voice.js';
import { switchView } from './nav.js';
import { deviceSummary } from './remotecore.js';

let tunnel = null;
let devices = [];

export function initRemote() {
  const pill = $('#pillRemote');
  pill.addEventListener('click', async () => {
    await saveSettings({ remote: { enabled: false } });
    toast('Remote access is off. Paired devices can no longer reach the assistant until you turn it on again.');
  });
  on('settings', () => (render(), refreshDevices()));
  api.on('remote:event', (ev) => {
    if (ev.type === 'paired') toast(`New device paired: ${ev.name}. Not you? Remove it in Settings → Remote access.`);
    if (ev.type === 'new-network') toast(`${ev.name} connected from a new network (${ev.via}, ${ev.ip}). Not you? Remove it in Settings → Remote access.`);
    if (ev.type === 'connected') toast(`📱 ${ev.name} connected`);
    if (ev.type === 'disconnected') toast(`📱 ${ev.name} has been disconnected for a few minutes`);
    if (ev.type === 'open-settings') switchView('settings');
    if (['paired', 'connected', 'disconnected', 'moved'].includes(ev.type)) refreshDevices();
    if (ev.type !== 'tunnel') return;
    tunnel = ev.tunnel;
    render();
  });
  refreshDevices();
  api.on('remote:transcribe', handleTranscribe);
  api.on('remote:speak', handleSpeak);
  // "last seen 5 min ago" stays true while the window is open.
  setInterval(() => !document.hidden && render(), 60000);
  render();
}

async function refreshDevices() {
  if (!state.settings?.remote?.enabled) return;
  const st = await api.remote.status().catch(() => null);
  if (!st) return;
  tunnel = st.tunnel;
  devices = st.devices || [];
  render();
}

function render() {
  const pill = $('#pillRemote');
  const r = state.settings?.remote;
  pill.classList.toggle('hidden', !r?.enabled);
  if (!r?.enabled) return;
  const online = tunnel?.connected && tunnel.url;
  const sum = deviceSummary(devices, Date.now());
  pill.classList.toggle('online', Boolean(online));
  pill.classList.toggle('linked', sum.connected > 0);
  pill.querySelector('span').textContent = online ? 'Remote: online' : r.lan ? 'Remote: network' : 'Remote';
  const reach = online ? `Reachable from the internet at ${tunnel.url}` : r.lan ? 'Reachable from your local network' : 'Reachable from this computer only';
  pill.title = `${reach}.\n${sum.lines.join('\n')}\nClick to turn remote access off.`;
  pill.setAttribute('aria-label', `Remote access: ${sum.headline}. Click to turn it off.`);
}

// The phone sends 16 kHz mono 16-bit PCM WAV (checked by the server); find the data chunk.
function wavSamples(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 12;
  while (off + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    const size = v.getUint32(off + 4, true);
    if (id === 'data') {
      const n = Math.floor(Math.min(size, v.byteLength - off - 8) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getInt16(off + 8 + i * 2, true) / 0x8000;
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('No audio in the recording');
}

async function handleSpeak({ id, text }) {
  try {
    await api.remote.spoken(id, await offlineVoiceWav(text), null);
  } catch (err) {
    logEvent('warn', 'remote speech failed', err?.message || String(err));
    await api.remote.spoken(id, null, err?.message || 'The offline voice failed').catch(() => {});
  }
}

async function handleTranscribe({ id, wav }) {
  try {
    const text = await transcribe(wavSamples(new Uint8Array(wav)));
    await api.remote.transcribed(id, text, null);
  } catch (err) {
    logEvent('warn', 'remote transcription failed', err?.message || String(err));
    await api.remote.transcribed(id, '', err?.message || 'Speech-to-text failed').catch(() => {});
  }
}
