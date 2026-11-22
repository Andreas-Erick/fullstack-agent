// Hands-free listening: the open microphone, the neural voice detector (Silero in vad-worker.js on the
// model host) with the energy detector as fallback, and the segments it hands to voice.js.
import { emit, toastError, logEvent } from './util.js';
import { state, setCaption } from './state.js';
import { segmentEnd, endSilence } from './utterance.js';
import { createModelHost } from './modelhost.js';
import { ctx, timers, byProfile } from './voicecommon.js';
import { openMic, toMono16k, silentSink, concat } from './mic.js';

// The voice-input arbiter (voiceinput.js) and the utterance writer live in voice.js, which makes the one
// HandsFree with them (createHandsFree).
let input = null;
let finishUtterance = null;

const NEURAL_IDLE_MS = 60000; // how long the voice detector stays loaded after hands-free ends

// Neural voice detector (Silero VAD in a worker). Scores arrive about one frame behind the audio,
// which the pre-roll absorbs. Until it is ready, or if it fails to load, the energy detector is used.
const neural = {
  prob: 0,
  // modelhost.js: loaded at a hands-free start, gone NEURAL_IDLE_MS after hands-free ends (stopSoon) on
  // any profile; a failure falls back to the energy detector until the next start.
  host: createModelHost({
    name: 'voice detector',
    create: () => new Worker(new URL('./vad-worker.js', import.meta.url), { type: 'module' }),
    configure: (w) => w.postMessage({ type: 'load' }),
    onMessage: (msg) => {
      if (msg.type === 'prob') neural.prob = msg.prob;
      else if (msg.type === 'ready') {
        neural.host.ready();
        logEvent('info', 'neural voice detection ready');
      } else if (msg.type === 'error') neural.host.fail(msg.error);
    },
    onStop: (reason, kind) => {
      if (kind === 'failed') logEvent('warn', 'neural voice detection unavailable, using the energy detector', reason);
      neural.prob = 0;
    },
    failText: 'worker failed',
    idleMs: () => NEURAL_IDLE_MS,
    profile: byProfile,
    clock: timers,
    log: logEvent,
  }),
  get ready() {
    return this.host.loaded;
  },
  start() {
    this.host.use(); // a pending stopSoon is off
    this.host.load();
  },
  feed(samples, rate) {
    const copy = new Float32Array(samples);
    this.host.worker.postMessage({ type: 'frame', samples: copy, rate }, [copy.buffer]);
  },
  reset() {
    this.prob = 0;
    this.host.worker?.postMessage({ type: 'reset' });
  },
  // Hands-free ended: the model and its ONNX runtime (tens of MB) go after a grace period, so a device
  // change's restart or a quick toggle doesn't reload them. A later start loads it again (energy meanwhile).
  stopSoon() {
    this.host.idle();
  },
};

// Hands-free: always listening. Speech is found by the neural detector (or, as a fallback, by energy
// with an adaptive noise floor plus a voicing check). While the agent speaks the mic is ignored (it
// would hear itself) unless headphones are declared, in which case speaking over the agent interrupts it.
class HandsFree {
  // Concurrent starts (settings change + device change) share one, so the mic never opens twice.
  start() {
    if (this.running) return Promise.resolve();
    this.starting ||= this.open().finally(() => (this.starting = null));
    return this.starting;
  }

  // The mic stream ends on sleep or when a USB mic is unplugged; without this, listening would
  // silently stop. Retries for a while, since the device may come back a moment later.
  async recover(attempt = 0) {
    logEvent('warn', 'microphone stream ended; reopening it', { attempt });
    this.stop();
    try {
      await this.start();
    } catch (err) {
      if (attempt < 5) setTimeout(() => state.settings.stt.micMode === 'open' && !this.running && this.recover(attempt + 1), 2000 * (attempt + 1));
      else toastError(new Error(`Hands-free: the microphone is gone (${err.message}). Reconnect it, then say or click to listen again.`));
    }
  }

  async open() {
    this.stream = await openMic();
    const ac = ctx();
    await ac.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url)).catch(() => {});
    this.src = ac.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ac, 'pcm-capture');
    this.rate = ac.sampleRate;
    this.noise = 0.01;
    this.pre = []; // ~400 ms pre-roll so the first syllable isn't cut
    this.seg = null;
    this.gen = (this.gen || 0) + 1;
    const gen = this.gen;
    this.node.port.onmessage = (e) => gen === this.gen && this.onFrame(e.data.samples, e.data.rms, e.data.voiced);
    this.stream.getAudioTracks()[0]?.addEventListener('ended', () => gen === this.gen && this.running && this.recover());
    this.src.connect(this.node);
    this.sink = silentSink(ac);
    this.node.connect(this.sink);
    if (state.settings.stt.vadEngine !== 'energy') neural.start();
    this.running = true;
    emit('handsfree', true);
    logEvent('info', 'hands-free listening started');
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.gen++;
    this.src?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.seg = null;
    input.openStopped(); // only the open microphone's segment: a talk-key recording goes on
    state.micLevel = 0;
    neural.stopSoon();
    emit('handsfree', false);
  }

  async restart() {
    this.stop();
    await this.start();
  }

  onFrame(samples, rms, voiced) {
    const s = state.settings.stt;
    const sens = Math.min(1, Math.max(0, Number(s.vadSensitivity ?? 0.5)));
    if (!this.seg) this.noise = this.noise * 0.995 + Math.min(rms, 0.05) * 0.005; // learn the room
    state.micLevel = this.seg ? Math.min(1, rms * 5) : 0;

    // Paused while words are written down, a clip records, the talk key holds the mic, or the agent
    // speaks without headphones (it would hear itself); the agent speaking drops a segment in progress.
    const gate = input.openGate({ headphones: s.headphones });
    if (!gate.listen) {
      if (gate.drop) this.seg = null;
      if (!this.paused) neural.reset();
      this.paused = true;
      return;
    }
    this.paused = false;

    // speaking = this frame is speech; held = still inside speech (a lower bar, so words aren't split).
    let speaking, held;
    if (neural.ready && s.vadEngine !== 'energy') {
      neural.feed(samples, this.rate);
      const threshold = 0.75 - sens * 0.5;
      speaking = neural.prob > threshold;
      held = neural.prob > threshold - 0.15;
      voiced = speaking;
    } else {
      speaking = rms > Math.max(0.012, this.noise * (3.2 - sens * 1.8));
      held = speaking;
    }
    this.pre.push(samples);
    const frameMs = (samples.length / this.rate) * 1000;
    while (this.pre.length * frameMs > 400) this.pre.shift();

    if (!this.seg) {
      if (speaking) {
        this.loud = (this.loud || 0) + frameMs;
        if (voiced) this.onsetVoiced = (this.onsetVoiced || 0) + frameMs;
        this.gap = 0;
        // Interrupting the agent needs clearly voiced speech (voiceinput.js, with utterance.js onset).
        const start = input.openOnset({ loudMs: this.loud, voicedMs: this.onsetVoiced || 0 });
        if (start) {
          this.seg = { chunks: [...this.pre], silence: 0, length: 0, voiced: this.onsetVoiced || 0, start };
          setCaption('Listening…', 'user');
        }
      } else if ((this.gap = (this.gap || 0) + frameMs) > 80) {
        this.loud = 0;
        this.onsetVoiced = 0;
      }
      return;
    }
    this.seg.chunks.push(samples);
    this.seg.length += frameMs;
    this.seg.silence = held ? 0 : this.seg.silence + frameMs;
    if (speaking && voiced) this.seg.voiced += frameMs;
    const ended = segmentEnd({ silenceMs: this.seg.silence, lengthMs: this.seg.length }, { endMs: endSilence(s.endSilenceMs) });
    if (ended) this.endSegment(ended);
  }

  // A pause or the length limit ended the segment, or the talk key cut it ('cut'): written down as a
  // piece (voiceinput.js decides whether it waits for its continuation); breath and noise go.
  endSegment(ended) {
    const seg = this.seg;
    this.seg = null;
    this.loud = 0;
    this.onsetVoiced = 0;
    if (!seg) return input.openStopped();
    const u = input.openEnd({ start: seg.start, voicedMs: seg.voiced, ended });
    if (!u) return setCaption(input.heldText);
    if (ended === 'limit') logEvent('info', 'long utterance split at the limit', { sec: Math.round(seg.length / 1000) });
    finishUtterance(() => toMono16k(concat(seg.chunks), this.rate), u, { pauseMs: ended === 'pause' ? seg.silence : 0 });
  }
}

export function createHandsFree(deps) {
  ({ input, finishUtterance } = deps);
  return new HandsFree();
}
