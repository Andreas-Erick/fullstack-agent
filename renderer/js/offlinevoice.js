// The offline voice: Kokoro in tts-worker.js on the model host (modelhost.js), the main voice when
// voice.engine is 'local', else the fallback when VoiceStudio or the cloud voice is unreachable.
import { emit, toastError, logEvent } from './util.js';
import { state } from './state.js';
import { KOKORO_SAMPLE_RATE } from './kokorotext.js';
import { paceAfter } from './speechplan.js';
import { madeByOf } from './phrasecore.js';
import { env } from './faces/env.js';
import { createJobs } from './ttsjobs.js';
import { BALANCED, profile, voiceOnGpu, effectsLevel } from './perfcore.js';
import { perfReady } from './perf.js';
import { createModelHost } from './modelhost.js';
import { ctx, timers, byProfile } from './voicecommon.js';

// ----------------------------------------------------------------- Offline voice
// Kokoro in tts-worker.js, used when VoiceStudio is unreachable (voice.fallback: local | system | off).
export const fallbackMode = () => state.settings.voice.fallback || 'local';

export const localVoice = {
  // modelhost.js: load once (after the hardware check), Balanced's idle unload, the hang restart, and a
  // failed load retried on the next sentence after a minute (e.g. it was offline on first use; also after
  // a crash once loaded: until the retry, sentences go straight to the system voice).
  host: createModelHost({
    name: 'offline voice',
    create: () => new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' }),
    // GPU or not is the profile's call, which on a first start is known only after the hardware check:
    // asked earlier, a lighter computer would load the 310 MB GPU model instead of the 88 MB one.
    gate: () => perfReady,
    configure: (w) => w.postMessage({ type: 'load', gpu: voiceOnGpu(state.settings) }),
    onStart: () => localVoice.onStart(),
    onMessage: (msg) => localVoice.onMessage(msg),
    onStop: (reason, kind) => localVoice.onStop(reason, kind),
    failText: 'the offline voice failed to load',
    idleMs: (p) => (p === 'balanced' ? BALANCED.voiceIdleMin * 60000 : 0),
    profile: byProfile,
    idleReason: 'the offline voice was unloaded',
    retryAfterMs: 60000,
    clock: timers,
    log: logEvent,
  }),
  device: '',
  msPerChar: 0, // the measured pace (speechplan.js paceAfter), for cutting a long first sentence
  seq: 0,
  pending: new Map(), // id → { done, fail, quiet, chars, postedAt, readyAt, begunAt }
  jobs: createJobs(), // ttsjobs.js: which sentences wait, run, ran too long
  timer: 0,
  lastWarn: 0,

  get worker() {
    return this.host.worker;
  },
  get loaded() {
    return this.host.loaded;
  },

  // Resolves when the model is loaded, rejects if it can't be.
  start() {
    return this.host.load();
  },

  onStart() {
    this.startedAt = performance.now();
    this.syncBusy();
  },

  onMessage(msg) {
    if (msg.type === 'progress') emit('tts-progress', msg);
    else if (msg.type === 'ready') this.onReady(msg);
    else if (msg.id) this.onJob(msg);
    else if (msg.type === 'error') this.host.fail(msg.message);
  },

  // The worker went (modelhost.js): unloaded, restarted after a hang, or failed (then the face says so).
  onStop(reason, kind) {
    if (kind !== 'failed') this.device = '';
    this.dropJobs(reason);
    if (kind === 'failed') emit('tts-progress', { status: 'error', message: reason });
  },

  onReady(msg) {
    const now = performance.now();
    this.host.ready();
    this.syncBusy();
    this.device = msg.device;
    for (const job of this.pending.values()) job.readyAt ||= now;
    // Where the load's time went (tts-worker.js load), to compare the app with the voice on its own.
    logEvent('info', 'offline voice ready', { device: msg.device, ...msg.timing, sinceStartMs: Math.round(now - this.startedAt) });
    emit('tts-progress', { status: 'ready', device: msg.device });
    this.keepFor(); // Balanced: the idle clock starts at load, not only after the first sentence
  },

  // A sentence's messages: begin (its run limit starts), then audio, error or skipped (cancelled).
  onJob(msg) {
    this.jobs.heard(); // alive, even about a sentence given up on (checkJobs)
    const job = this.pending.get(msg.id);
    if (!job) return; // given up on already (a stop, a time limit)
    if (msg.type === 'begin') {
      job.begunAt = performance.now();
      job.faceFps = env.maxFps(); // the cap the faces get while this sentence is made (faces/host.js)
      return this.jobs.begin(msg.id, job.begunAt);
    }
    this.pending.delete(msg.id);
    this.syncBusy();
    this.jobs.done(msg.id);
    if (msg.type === 'audio') {
      this.msPerChar = paceAfter(this.msPerChar, { chars: job.chars, modelMs: msg.timing?.modelMs });
      this.logSentence(job, msg.timing);
      job.done({ samples: msg.samples, timing: msg.timing });
    } else if (msg.type === 'skipped') job.done(null);
    else job.fail(new Error(msg.message));
  },

  // The first sentences after a load, to see what a sentence costs and what the window was doing
  // meanwhile (the voice is slower in the app than on its own). Filler warm-ups don't count.
  logSentence(job, timing) {
    if (!timing || job.quiet || (this.timed = (this.timed || 0) + 1) > 40) return;
    const s = state.settings;
    const view = document.querySelector('.view.active')?.id.replace(/^view-/, '');
    logEvent('info', 'offline voice sentence', { ...timing, device: this.device, view, layout: s.ui?.chatLayout, fx: effectsLevel(s), lite: profile(s) === 'balanced', faceFps: job.faceFps, focused: document.hasFocus(), visible: document.visibilityState });
  },

  // Loading, or a sentence out (the phone's WAVs and the fillers made ahead too): the faces draw fewer
  // frames meanwhile (perfcore.js faceFpsCap), so the voice gets the graphics card.
  syncBusy() {
    state.voiceWorking = Boolean(this.worker) && (!this.loaded || this.pending.size > 0);
  },

  // Frees the model (the memory section's button, or Balanced performance after a while unused).
  unload(reason = 'the offline voice was unloaded') {
    this.host.unload(reason);
  },

  // Every sentence still waiting fails with `reason`.
  dropJobs(reason) {
    this.msPerChar = 0; // the next load may run elsewhere (the GPU, the processor)
    for (const { fail } of this.pending.values()) fail(new Error(reason));
    this.pending.clear();
    this.jobs = createJobs();
    clearInterval(this.timer);
    this.timer = 0;
    this.syncBusy();
  },

  // Balanced: the idle clock (re)starts; elsewhere it does nothing.
  keepFor() {
    this.host.idle();
  },

  // Posted at once, also while the model still loads (the worker waits for it). Resolves null if it
  // never began because the model is still downloading after waitMs (the system voice may fill in), or
  // if a stop cancelled it (cancelQueued; never a `keep` one). quiet: a filler made ahead, not logged.
  async speak(text, { waitMs = 8000, keep = false, quiet = false } = {}) {
    const ready = this.start();
    if (!this.worker) return ready.then(() => null); // a failed load: its reason, until the retry
    const v = state.settings.voice;
    const id = ++this.seq;
    const postedAt = performance.now();
    const job = { quiet, chars: text.length, postedAt, readyAt: this.loaded ? postedAt : 0, begunAt: 0 };
    const out = await new Promise((done, fail) => {
      Object.assign(job, { done, fail });
      this.pending.set(id, job);
      this.syncBusy();
      this.jobs.post(id, { now: postedAt, keep, waitMs });
      this.worker.postMessage({ type: 'speak', id, keep, text, voice: v.localVoice, speed: Number(v.speed) || 1 });
      this.timer ||= setInterval(() => this.checkJobs(), 1000);
    });
    if (!out) return null;
    this.keepFor();
    const buf = ctx().createBuffer(1, out.samples.length, KOKORO_SAMPLE_RATE);
    buf.copyToChannel(out.samples, 0);
    const ms = (n) => Math.max(0, Math.round(n));
    buf.timing = { loadWaitMs: ms(job.readyAt - postedAt), queueMs: ms(job.begunAt - Math.max(postedAt, job.readyAt)), modelMs: out.timing?.modelMs };
    buf.madeBy = madeByOf('local', { voice: v }); // the voice as posted, for kept lines (phrases.js)
    return buf;
  },

  // Every second while sentences are out. The run limit is generous: a sentence pair takes well under
  // a second on the GPU, a few seconds on the CPU, counted from its begin. A worker that then stays
  // silent hangs (what waits behind it would never begin): it is restarted, the model loads again.
  checkJobs() {
    const now = performance.now();
    for (const id of this.jobs.expired(now, { loaded: this.loaded })) {
      const job = this.pending.get(id);
      this.jobs.done(id);
      this.pending.delete(id);
      if (job?.begunAt) job.fail(new Error('the offline voice took too long'));
      else if (job) {
        this.worker?.postMessage({ type: 'cancel', ids: [id] }); // not to be made once the model is in
        job.done(null);
      }
    }
    if (this.jobs.stalled(now)) this.host.restart('the offline voice stopped responding', { warn: 'offline voice stopped responding; restarting it', data: { waiting: this.pending.size } });
    if (!this.jobs.size) {
      clearInterval(this.timer);
      this.timer = 0;
    }
    this.syncBusy();
  },

  // A stop: the sentences not begun yet are dropped, so the next reply doesn't wait behind them (the
  // one being made finishes: an ONNX run can't be interrupted). The phone's WAVs (`keep`) stay.
  cancelQueued() {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'cancel', upTo: this.seq });
    for (const id of this.jobs.cancel(this.seq)) {
      const job = this.pending.get(id);
      this.pending.delete(id);
      job?.done(null);
    }
    this.syncBusy();
  },

  warn(err) {
    logEvent('warn', 'offline voice failed', err.message);
    if (Date.now() - this.lastWarn > 60000) toastError(new Error(`Offline voice: ${err.message} — ${fallbackMode() === 'system' ? 'using the system voice' : 'the reply stays on screen'}.`));
    this.lastWarn = Date.now();
  },
};
