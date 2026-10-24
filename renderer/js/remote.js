// Remote access on the desktop side: the title-bar pill (visible whenever remote access is on; one
// click turns it off) and speech-to-text for push-to-talk from paired devices.
import { $, api, on, toast, logEvent } from './util.js';
import { state, saveSettings } from './state.js';
import { transcribe } from './voice.js';

let tunnel = null;

export function initRemote() {
  const pill = $('#pillRemote');
  pill.addEventListener('click', async () => {
    await saveSettings({ remote: { enabled: false } });
    toast('Remote access is off. Paired devices can no longer reach the assistant until you turn it on again.');
  });
  on('settings', render);
  api.on('remote:event', (ev) => {
    if (ev.type !== 'tunnel') return;
    tunnel = ev.tunnel;
    render();
  });
  api.remote.status().then((st) => ((tunnel = st.tunnel), render())).catch(() => {});
  api.on('remote:transcribe', handleTranscribe);
  render();
}

function render() {
  const pill = $('#pillRemote');
  const r = state.settings?.remote;
  pill.classList.toggle('hidden', !r?.enabled);
  if (!r?.enabled) return;
  const online = tunnel?.connected && tunnel.url;
  pill.classList.toggle('online', Boolean(online));
  pill.querySelector('span').textContent = online ? 'Remote: online' : r.lan ? 'Remote: network' : 'Remote';
  pill.title = `${online ? `Reachable from the internet at ${tunnel.url}` : r.lan ? 'Reachable from your local network' : 'Reachable from this computer only'}. Click to turn remote access off.`;
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

async function handleTranscribe({ id, wav }) {
  try {
    const text = await transcribe(wavSamples(new Uint8Array(wav)));
    await api.remote.transcribed(id, text, null);
  } catch (err) {
    logEvent('warn', 'remote transcription failed', err?.message || String(err));
    await api.remote.transcribed(id, '', err?.message || 'Speech-to-text failed').catch(() => {});
  }
}
