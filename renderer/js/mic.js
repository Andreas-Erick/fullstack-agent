// The microphone: the configured device, resampling to 16 kHz, and the push-to-talk Recorder.
import { api, logEvent } from './util.js';
import { state } from './state.js';
import { ctx } from './voicecommon.js';

// Resolve the configured mic (label substring) to a deviceId; falls back to the default and logs why.
async function micConstraints() {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  const want = (state.settings.stt.micDevice || '').toLowerCase();
  if (!want) return base;
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const match = inputs.find((d) => d.label.toLowerCase().includes(want) || d.deviceId === state.settings.stt.micDevice);
  if (match) return { ...base, deviceId: { exact: match.deviceId } };
  logEvent('warn', 'configured mic not found, using default', { wanted: want, found: inputs.map((d) => d.label) });
  return base;
}

export async function listMics() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch {
    /* labels may stay empty without permission */
  }
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').map((d) => ({ id: d.deviceId, label: d.label || 'Microphone' }));
}

export async function openMic() {
  await api.mic.request().catch(() => true);
  return navigator.mediaDevices.getUserMedia({ audio: await micConstraints() });
}

export async function toMono16k(float32, sampleRate) {
  if (sampleRate === 16000) return float32;
  const length = Math.max(1, Math.ceil((float32.length * 16000) / sampleRate));
  const off = new OfflineAudioContext(1, length, 16000);
  const buf = off.createBuffer(1, float32.length, sampleRate);
  buf.copyToChannel(float32, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

// Push-to-talk recorder: raw PCM via an AudioWorklet while the key is held. The microphone and the
// worklet are opened ahead (at launch, and kept a while after each press): opening them on the press
// took a few hundred milliseconds, which lost the first word and made a short press record nothing.
const WARM_MS = 90000; // the mic stays open this long after a press (then the OS's mic light goes off)
export class Recorder {
  constructor() {
    this.keepTimer = 0;
    this.module = null; // the worklet, loaded once
    this.starting = null; // a start in progress, so a release that comes first still stops it
  }

  /** The mic stream and the worklet, ready; reopened when the chosen microphone changed. */
  async warm() {
    const ac = ctx();
    this.module ||= ac.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url)).catch(() => {}); // a worklet that did not load makes the node fail with its own error
    await this.module;
    const device = state.settings?.stt?.micDevice || '';
    if (this.stream && (device !== this.device || !this.stream.getTracks().some((t) => t.readyState === 'live'))) this.release();
    if (!this.stream) {
      this.stream = await openMic();
      this.device = device;
    }
    this.keep();
    return this.stream;
  }

  keep() {
    clearTimeout(this.keepTimer);
    this.keepTimer = setTimeout(() => !this.active && !this.starting && this.release(), WARM_MS);
  }

  release() {
    clearTimeout(this.keepTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  start() {
    if (this.active) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const stream = await this.warm();
      const ac = ctx();
      this.src = ac.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(ac, 'pcm-capture');
      this.chunks = [];
      this.node.port.onmessage = (e) => {
        this.chunks.push(e.data.samples);
        state.micLevel = Math.min(1, e.data.rms * 5);
      };
      this.src.connect(this.node);
      this.sink = silentSink(ac);
      this.node.connect(this.sink);
      this.startedAt = performance.now();
      this.active = true;
    })().finally(() => (this.starting = null));
    return this.starting;
  }

  async stop() {
    if (this.starting) await this.starting.catch(() => {}); // the earlier start failed for its own caller
    if (!this.active) return null;
    this.active = false;
    state.micLevel = 0;
    const duration = performance.now() - this.startedAt;
    this.teardown();
    if (duration < 350) return null;
    return toMono16k(concat(this.chunks), ctx().sampleRate);
  }

  // The capture graph goes; the mic stream stays open for the next press (release() after WARM_MS).
  teardown() {
    this.src?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    this.keep();
  }

  cancel() {
    if (!this.active) return;
    this.active = false;
    state.micLevel = 0;
    this.teardown();
  }
}

// Worklets must be connected through to the destination to be processed; a muted gain does that.
export function silentSink(ac) {
  const g = ac.createGain();
  g.gain.value = 0;
  g.connect(ac.destination);
  return g;
}

export function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export const recorder = new Recorder();
