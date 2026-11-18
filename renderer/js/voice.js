// Voice I/O: VoiceStudio playback (sentence-chunked, in order, with the offline Kokoro voice or the
// OS voice as fallback), microphone capture (push-to-talk or hands-free with voice-activity
// detection), speech-to-text.
import { api, emit, on, speakable, toastError, logEvent } from './util.js';
import { state, setFlag, setCaption, ttsActive } from './state.js';
import { KOKORO_SAMPLE_RATE } from './kokorotext.js';
import { takeSentences, splitSentences, firstCut, cutWorth, paceAfter, warmStep, sayChunks, offlineVoiceSpeaks, createLineOrder, LONE_CHARS } from './speechplan.js';
import { voiceIdentity, madeByOf, launchGreeting } from './phrasecore.js';
import { getPhrase, keepPhrase, forgetPhrases } from './phrases.js';
import { env } from './faces/env.js';
import { createJobs } from './ttsjobs.js';
import { allFillers } from './chatcore.js';
import { practiceLanguage, pickVoice, languageName } from './practice.js';
import { BALANCED, profile, speechPlan, voiceOnGpu, preloadSpeech, effectsLevel } from './perfcore.js';
import { perfReady } from './perf.js';
import { onset, segmentEnd, endSilence, createJoiner, HOLD_MS, PTT_MAX_MS } from './utterance.js';

let audioCtx = null;
export function ctx() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    state.analyser = audioCtx.createAnalyser();
    state.analyser.fftSize = 512;
    state.analyser.smoothingTimeConstant = 0.75;
    state.analyser.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// ----------------------------------------------------------------- Offline voice
// Kokoro in tts-worker.js, used when VoiceStudio is unreachable (voice.fallback: local | system | off).
export const fallbackMode = () => state.settings.voice.fallback || 'local';

const localVoice = {
  worker: null,
  ready: null, // resolves when the model is loaded, rejects if it can't be
  loaded: false,
  device: '',
  msPerChar: 0, // the measured pace (speechplan.js paceAfter), for cutting a long first sentence
  seq: 0,
  pending: new Map(), // id → { done, fail, quiet, chars, postedAt, readyAt, begunAt }
  jobs: createJobs(), // ttsjobs.js: which sentences wait, run, ran too long
  timer: 0,
  lastWarn: 0,

  start() {
    if (this.ready) return this.ready;
    this.startedAt = performance.now();
    this.worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
    this.syncBusy();
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => this.onMessage(e.data, resolve, reject);
      this.worker.onerror = (e) => this.reset(e.message || 'the offline voice failed to load', reject);
    });
    this.ready.catch(() => {});
    // GPU or not is the profile's call, which on a first start is known only after the hardware check:
    // asked earlier, a lighter computer would load the 310 MB GPU model instead of the 88 MB one.
    const worker = this.worker;
    perfReady.then(() => this.worker === worker && worker.postMessage({ type: 'load', gpu: voiceOnGpu(state.settings) }));
    return this.ready;
  },

  onMessage(msg, resolve, reject) {
    if (msg.type === 'progress') emit('tts-progress', msg);
    else if (msg.type === 'ready') this.onReady(msg, resolve);
    else if (msg.id) this.onJob(msg);
    else if (msg.type === 'error') this.reset(msg.message, reject);
  },

  onReady(msg, resolve) {
    const now = performance.now();
    this.loaded = true;
    this.syncBusy();
    this.device = msg.device;
    for (const job of this.pending.values()) job.readyAt ||= now;
    // Where the load's time went (tts-worker.js load), to compare the app with the voice on its own.
    logEvent('info', 'offline voice ready', { device: msg.device, ...msg.timing, sinceStartMs: Math.round(now - this.startedAt) });
    emit('tts-progress', { status: 'ready', device: msg.device });
    this.keepFor(); // Balanced: the idle clock starts at load, not only after the first sentence
    resolve();
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
    clearTimeout(this.idle);
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.ready = null;
    this.device = '';
    this.dropJobs(reason);
  },

  // Every sentence still waiting fails with `reason`.
  dropJobs(reason) {
    this.loaded = false;
    this.msPerChar = 0; // the next load may run elsewhere (the GPU, the processor)
    for (const { fail } of this.pending.values()) fail(new Error(reason));
    this.pending.clear();
    this.jobs = createJobs();
    clearInterval(this.timer);
    this.timer = 0;
    this.syncBusy();
  },

  keepFor() {
    clearTimeout(this.idle);
    if (profile(state.settings) === 'balanced') this.idle = setTimeout(() => this.unload(), BALANCED.voiceIdleMin * 60000);
  },

  // A failed load is retried on the next sentence after a minute (e.g. it was offline on first use).
  reset(reason, reject) {
    this.worker?.terminate();
    this.worker = null;
    this.dropJobs(reason);
    emit('tts-progress', { status: 'error', message: reason });
    reject?.(new Error(reason));
    // Also after a crash once loaded: until the retry, sentences go straight to the system voice.
    this.ready = Promise.reject(new Error(reason));
    this.ready.catch(() => {});
    setTimeout(() => (this.ready = null), 60000);
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
    if (this.jobs.stalled(now)) {
      logEvent('warn', 'offline voice stopped responding; restarting it', { waiting: this.pending.size });
      this.unload('the offline voice stopped responding');
    }
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

/**
 * At launch: load the offline voice when it is the main voice, so the greeting needn't wait for it.
 * Once it is in, the filler lines are made in the first quiet moment (speaker.filler plays only those),
 * when replies are spoken: with auto-speak off no filler plays, and making them is CPU work for nothing.
 * The ones kept from earlier sessions (phrases.js) are ready at once, in any voice, without the model.
 */
export function preloadOfflineVoice() {
  const v = state.settings?.voice;
  if (ttsActive() && v.filler) speaker.loadKept(allFillers());
  if (!v?.ttsEnabled || v.engine !== 'local') return;
  const idle = () => !state.generating && !state.recording;
  localVoice.start().then(() => ttsActive() && state.settings.voice.filler && speaker.warmFillers(allFillers(), idle), () => {});
}

/** A paired phone's reply in the offline voice, as a WAV (remote.js). Never cancelled by a stop here. */
export async function offlineVoiceWav(text) {
  const buf = await localVoice.speak(speakable(text), { waitMs: 180000, keep: true });
  if (!buf) throw new Error('The offline voice is not ready');
  return encodeWav(buf.getChannelData(0), buf.sampleRate);
}

/** For the system monitor's memory section. */
export const offlineVoiceStatus = () => ({ loaded: Boolean(localVoice.worker), device: localVoice.device });
export const unloadOfflineVoice = () => localVoice.unload();

/** Settings → Voice output: the kept lines go (made again when next needed). True if there were any. */
export async function forgetVoiceLines() {
  speaker.fillers.clear();
  speaker.warmWant = null;
  return forgetPhrases();
}

// Settings → Voice output: download/load the offline voice ahead of time, then speak a sample.
export async function testLocalVoice(text) {
  await localVoice.start();
  speaker.say(text, { engine: 'local' });
  return localVoice.device;
}

// ----------------------------------------------------------------- Speaker
// The filler warm-up on the cloud voice: its per-minute limit is shared with the replies, so one line
// every few seconds instead of seventeen requests back to back.
const CLOUD_WARM_GAP_MS = 8000;

// Language practice speaks with a Windows voice for that language: the language, or '' when the usual
// voice speaks (synthesize; chunk doesn't cut a sentence that voice says at once).
const practiceVoiceFor = (override) => (override?.engine !== 'local' && !override?.voice && state.settings.learning?.practiceVoice !== 'assistant' && practiceLanguage(state.settings)) || '';

class Speaker {
  constructor() {
    this.queue = []; // [{ text, audio: Promise<AudioBuffer|'system'|null> }]
    this.gen = 0;
    this.source = null;
    this.buffer = '';
    this.batch = [];
    this.started = false;
    this.running = false;
    this.onFallback = false; // set after VoiceStudio fails; retried periodically
    this.lastSpokeAt = 0;
    this.fillers = new Map(); // fillerKey → AudioBuffer
    this.order = createLineOrder(); // kept lines are looked up first; the voice still makes lines in order
  }

  // remember: a fixed line (a greeting) whose audio is kept (phrases.js) and played from there next time.
  // Its chunks never depend on the measured pace (no first-sentence cut), or the keys would change.
  say(text, override, { remember = false } = {}) {
    this.stop();
    if (remember) {
      sayChunks(splitSentences(speakable(text), true)).forEach((c, i) => this.enqueue(c, override, { first: i === 0, remember: true }));
      return;
    }
    for (const s of splitSentences(speakable(text), true)) this.chunk(s, override);
    this.release();
    this.started = false;
  }

  // After what is being said, without stopping it: the launch greeting's "Last time we were on …" line
  // (skipIf: dropped if it comes too late), a new persona's hello after the reply (remember).
  follow(text, { remember = false, skipIf = null, firstAlone = false } = {}) {
    for (const c of sayChunks(splitSentences(speakable(text), true), { firstAlone })) this.enqueue(c, undefined, { remember, skipIf });
  }

  // A streamed reply: sentence by sentence, up to voice.speakLimit characters (a long result, such as
  // a report or a list of papers, is for the screen); then one line says so and the rest stays silent.
  feed(delta) {
    if (this.capped) return;
    this.buffer += delta;
    const { done, rest } = takeSentences(this.buffer);
    this.buffer = rest;
    for (const s of done) {
      if (this.overLimit(s)) return;
      this.chunk(speakable(s));
    }
  }

  overLimit(next) {
    const limit = Number(state.settings.voice.speakLimit);
    if (!(limit > 0)) return false;
    this.spoken = (this.spoken || 0) + next.length;
    if (this.spoken <= limit || !this.started) return false;
    this.capped = true;
    this.buffer = '';
    this.chunk('The rest is on the screen.');
    return true;
  }

  flush() {
    const s = this.capped ? '' : speakable(this.buffer);
    this.buffer = '';
    if (s && !this.overLimit(s)) this.chunk(s);
    this.release();
    this.started = false;
  }

  // The first sentence of a reply goes out alone so the voice starts fast (a long one in two parts
  // when the offline voice is slow, speechplan.js firstCut/cutWorth: the second is made while the first
  // plays; never for a practice language's Windows voice, which speaks at once: there a cut only adds a
  // pause); after that sentences go in pairs, because the voice gives fuller chunks livelier delivery
  // than single short sentences. A lone sentence never waits longer than a moment for its partner.
  chunk(text, override) {
    if (!text) return;
    if (!this.started) {
      this.started = true;
      const practice = practiceVoiceFor(override);
      const instant = practice && pickVoice(speechSynthesis.getVoices(), practice);
      const [head, tail] = instant || !this.cutsFirst(text, override) ? [text, ''] : firstCut(text);
      this.enqueue(head, override, { first: true });
      if (tail) this.enqueue(tail, override);
      return;
    }
    this.batch.push(text);
    this.batchOverride = override;
    clearTimeout(this.batchTimer);
    if (this.batch.length >= 2 || text.length >= LONE_CHARS) this.release();
    else this.batchTimer = setTimeout(() => this.release(), 450);
  }

  // Only the offline voice cuts (its pace is measured); VoiceStudio and the cloud voice keep it whole.
  cutsFirst(text, override) {
    const offline = (override?.engine || state.settings.voice.engine) === 'local' || (this.onFallback && fallbackMode() === 'local');
    return offline && cutWorth({ chars: text.length, msPerChar: localVoice.msPerChar, device: localVoice.device });
  }

  release() {
    clearTimeout(this.batchTimer);
    if (this.batch.length) this.enqueue(this.batch.join(' '), this.batchOverride);
    this.batch = [];
  }

  // Short line while a reply is on its way, so a pause never feels like a dead line. Skipped if already
  // talking. It plays from audio made ahead in a quiet moment (warmFillers): made on the spot it held up
  // the reply's first sentence (one voice engine, one sentence at a time). Not made yet: nothing.
  filler(text) {
    if (this.busy || Date.now() - this.lastSpokeAt < 4000 || practiceLanguage(state.settings)) return false;
    const buf = this.fillers.get(fillerKey(text));
    if (!buf) return false;
    this.queue.push({ text, audio: Promise.resolve(buf), gen: this.gen, queuedAt: performance.now() });
    this.pump();
    return true;
  }

  // Makes the filler lines' audio one at a time, only while `idle()` and nothing is being said. The
  // wish is kept: a speaker that is talking resumes it when it goes quiet (pump), a reply or a
  // recording when it is over (chat.js finish). Before, it gave up whenever the reply was still being
  // spoken, which after all but the shortest replies it was, so fillers were hardly ever made.
  // The launch greeting's chunks join them: read from the kept lines, or made and kept for next launch.
  warmFillers(lines, idle) {
    if (!this.warmWant) (this.warmMade = 0), (this.warmKept = 0), (this.warmFrom = performance.now());
    this.warmWant = { lines: [...new Set([...lines, ...this.greetingLines()])], idle };
    if (!this.warming) this.warmSoon(1500);
  }

  // Exactly what greetOnLaunch (app.js) says with say(…, { remember: true }), chunk by chunk.
  greetingLines() {
    const v = state.settings?.voice;
    if (!v?.ttsEnabled || !v.greetOnLaunch) return [];
    return sayChunks(splitSentences(speakable(launchGreeting(state.settings).greeting), true));
  }

  // At launch: the filler lines kept from earlier sessions, read without the model.
  async loadKept(lines) {
    for (const t of lines) {
      const key = fillerKey(t);
      const id = voiceIdentity(state.settings); // the voice asked for, even if the settings change meanwhile
      if (this.fillers.has(key)) continue;
      const buf = await getPhrase(id, t);
      if (buf && fillerKey(t) === key) this.fillers.set(key, buf);
    }
  }

  warmSoon(ms) {
    this.warming = true;
    clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => this.warmNext(), ms);
  }

  async warmNext() {
    const want = this.warmWant;
    if (!want) return void (this.warming = false);
    const todo = want.lines.filter((t) => !this.fillers.has(fillerKey(t)));
    // Not while local Whisper writes a recording down (one processor for both), and not while the main
    // voice is unreachable (a filler is made in the main voice or not at all: synthesize, quiet).
    const idle = want.idle() && !state.transcribing;
    const step = warmStep({ todo: todo.length, idle, busy: this.busy, away: this.mainVoiceAway() });
    if (step === 'done') {
      this.warmWant = null;
      this.warming = false;
      if (this.warmMade || this.warmKept) logEvent('info', 'offline voice fillers ready', { n: this.warmMade, kept: this.warmKept, ms: Math.round(performance.now() - this.warmFrom), engine: state.settings.voice?.engine });
      return;
    }
    if (step !== 'warm') return void (this.warming = false);
    const key = fillerKey(todo[0]); // the voice it is made in, even if the settings change meanwhile
    const id = voiceIdentity(state.settings);
    // Kept from an earlier session (phrases.js): no model run at all.
    const kept = await getPhrase(id, todo[0]);
    // The lookup took a moment: a message or a recording that started meanwhile goes first (made now,
    // the filler would hold the voice ahead of the reply's first sentence). It resumes like warmStep's
    // wait or stop: when the speaker goes quiet (pump) or the reply or recording is over (chat.js finish).
    if (!kept && (!want.idle() || state.transcribing || this.busy || this.mainVoiceAway())) return void (this.warming = false);
    const buf = kept || (await this.synthesize(todo[0], undefined, this.gen, { quiet: true }).catch(() => null));
    // The system voice ('system') is instant anyway; a failure or a stop waits for the next quiet moment.
    if (!buf || typeof buf !== 'object') return void (this.warming = false);
    if (this.fillers.size > 80) this.fillers.clear(); // a few voices' worth
    this.fillers.set(key, buf);
    if (kept) this.warmKept++;
    else {
      this.warmMade++;
      keepPhrase(id, todo[0], buf); // for the next session
    }
    this.warmSoon(kept ? 20 : state.settings.voice?.engine === 'cloud' ? CLOUD_WARM_GAP_MS : 600);
  }

  // VoiceStudio or the cloud voice failed and the fallback speaks, until a reply reaches it again.
  mainVoiceAway() {
    return this.onFallback && state.settings.voice?.engine !== 'local';
  }

  // remember: played from the kept lines when there (else made and kept); skipIf: checked when its turn
  // comes, true drops it. Lines are made in the order they are said (speechplan.js createLineOrder).
  enqueue(text, override, { first = false, remember = false, skipIf = null } = {}) {
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return;
    const gen = this.gen;
    const audio = remember ? this.remembered(text, override, gen) : this.order.after(() => this.synthesize(text, override, gen));
    this.queue.push({ text, audio, gen, first, skipIf, queuedAt: performance.now() });
    this.pump();
  }

  // A fixed line in the main voice: from memory (a filler made this session), from the kept lines, or
  // made now and kept. Never for an override or a practice language's voice.
  remembered(text, override, gen) {
    const id = override || practiceVoiceFor(override) ? null : voiceIdentity(state.settings);
    const key = id && fillerKey(text);
    const mem = key && this.fillers.get(key);
    if (mem) return Promise.resolve(Object.assign(mem, { timing: { cached: true } }));
    const make = () => this.synthesize(text, override, gen);
    if (!id) return this.order.after(make);
    return this.order.lookup(
      () => getPhrase(id, text),
      async () => {
        const buf = await make();
        if (buf && typeof buf === 'object') keepPhrase(id, text, buf);
        return buf;
      },
    );
  }

  // quiet: a filler made ahead, kept out of the sentence log and best effort in the main voice only.
  // Made by the fallback, it would be kept under the main voice's key and play in the wrong voice once
  // VoiceStudio is back; failing, it shows nothing (no toast, no red face, no switch to the fallback)
  // and the next quiet moment tries again. Never part of override, which goes to VoiceStudio as it is.
  async synthesize(text, override, gen, { quiet = false } = {}) {
    if (override?.engine === 'local') return localVoice.speak(text, { waitMs: 600000, quiet }).catch((err) => (this.reportError(err), null));
    // Language practice speaks with a Windows voice for that language (if one is installed).
    const practice = practiceVoiceFor(override);
    if (practice) {
      if (pickVoice(speechSynthesis.getVoices(), practice)) return 'system';
      if (!quiet && this.noPracticeVoice !== practice) {
        this.noPracticeVoice = practice;
        toastError(new Error(`No ${languageName(practice)} voice on this computer, so the usual voice speaks. Add one in Windows Settings → Time & language → Speech → Add voices.`));
      }
    }
    // The offline voice as the main voice: wait for it (its first download included) rather than
    // filling in with the system voice, so the user hears one voice from the very first sentence. If it
    // fails (too slow, crashed), the rest of the reply stays silent, on screen; the system voice only
    // fills in when the user chose it as the fallback.
    if (state.settings.voice.engine === 'local' && !override?.voice) {
      return localVoice.speak(text, { waitMs: 180000, quiet }).catch((err) => (quiet ? quietFail(err) : (localVoice.warn(err), gen === this.gen ? this.systemIfChosen() : null)));
    }
    const mode = fallbackMode();
    if (this.onFallback && mode !== 'off' && Date.now() - this.fallbackSince < 120000) return quiet ? null : this.fallback(text, gen);
    // The voice this request asks for, even if the settings change meanwhile (kept lines, phrases.js).
    const madeBy = override ? null : madeByOf(state.settings.voice?.engine === 'cloud' ? 'cloud' : 'voicestudio', state.settings);
    try {
      const { audio } = await api.tts.speak(text, override);
      const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
      const buf = await ctx().decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      buf.madeBy = madeBy;
      if (this.onFallback) logEvent('info', `${engineName()} back online`);
      this.onFallback = false;
      return buf;
    } catch (err) {
      if (gen !== this.gen) return null;
      if (quiet) return quietFail(err);
      logEvent('warn', `${engineName()} failed`, err.message);
      if (mode === 'off') {
        this.reportError(err);
        return null;
      }
      if (!this.onFallback && !state.setupMode) {
        toastError(new Error(`${engineName()} unavailable — using the ${mode === 'local' ? 'offline' : 'system'} voice. (${err.message})`));
        emit('voice-fallback', err.message);
      }
      this.onFallback = true;
      this.fallbackSince = Date.now();
      return this.fallback(text, gen);
    }
  }

  // VoiceStudio (or the cloud voice) is unreachable: the offline voice when it is the chosen fallback and works (silence,
  // on screen, while it still downloads or if it fails); the OS voice only when the user chose it.
  async fallback(text, gen) {
    if (fallbackMode() === 'local') {
      const buf = await localVoice.speak(text).catch((err) => (localVoice.warn(err), null));
      if (gen !== this.gen) return null;
      return buf || null;
    }
    return this.systemIfChosen();
  }

  systemIfChosen() {
    return fallbackMode() === 'system' && 'speechSynthesis' in window ? 'system' : null;
  }

  reportError(err) {
    const now = Date.now();
    if (now - (this.lastErr || 0) > 8000) toastError(new Error(`Voice: ${err.message}`));
    this.lastErr = now;
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const item = this.queue.shift();
      if (item.gen !== this.gen) continue;
      const buf = await item.audio;
      if (!buf || item.gen !== this.gen) continue;
      if (item.skipIf?.()) continue;
      setFlag('playing', true);
      setCaption(item.text, 'assistant');
      if (item.first) logFirstAudio(item, buf);
      if (buf === 'system') await this.playSystem(item.text);
      else {
        await new Promise((resolve) => {
          const src = ctx().createBufferSource();
          src.buffer = buf;
          src.connect(state.analyser);
          // onended never fires while the audio device is stalled (e.g. a headset being switched).
          const limit = setTimeout(resolve, (buf.duration + 3) * 1000);
          src.onended = () => (clearTimeout(limit), resolve());
          this.source = src;
          src.start();
        });
      }
      this.source = null;
      this.lastSpokeAt = Date.now();
    }
    this.running = false;
    setFlag('playing', false);
    emit('speech-idle');
    // A filler warm-up that waited for the speaker goes on now that it is quiet.
    if (this.warmWant && !this.warming) this.warmSoon(1500);
  }

  // OS speech synthesis fallback. The face gets a synthetic level so it still "speaks".
  playSystem(text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = Number(state.settings.voice.speed) || 1;
      // voice.voice is a VoiceStudio id, so pick by language: the Windows default may be another
      // language pack's voice (a German voice reading English).
      // During language practice: a voice for the practiced language.
      const voices = speechSynthesis.getVoices();
      const lang = practiceLanguage(state.settings) || (state.settings.stt?.language || 'en').toLowerCase();
      u.voice = pickVoice(voices, lang) || voices.find((v) => v.default) || null;
      if (u.voice) u.lang = u.voice.lang;
      let t = 0;
      const pulse = setInterval(() => (state.synthLevel = 0.35 + 0.35 * Math.abs(Math.sin((t += 0.6)))), 80);
      // Chromium sometimes never fires onend; never let that leave the speaker (and mic) stuck.
      const limit = setTimeout(() => done(), (text.length / 10 / (u.rate || 1) + 5) * 1000);
      const done = () => {
        clearTimeout(limit);
        clearInterval(pulse);
        state.synthLevel = 0;
        resolve();
      };
      u.onend = done;
      u.onerror = done;
      this.source = { stop: () => speechSynthesis.cancel() };
      speechSynthesis.speak(u);
    });
  }

  // Barge-in, a new message, say(), the spoken approval prompt: the old reply's sentences still waiting
  // to be made are dropped too, so the next words don't queue behind them.
  stop() {
    this.gen++;
    this.queue = [];
    this.order.reset(); // what comes next doesn't wait for a dropped line's lookup
    localVoice.cancelQueued();
    this.buffer = '';
    clearTimeout(this.batchTimer);
    this.batch = [];
    this.started = false;
    this.spoken = 0;
    this.capped = false;
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.source = null;
    setFlag('playing', false);
  }

  get busy() {
    return this.running || this.queue.length > 0;
  }
}

// A filler's audio belongs to the voice that made it (engine, voice, speed…; phrasecore.js, no keys).
const fillerKey = (text) => `${JSON.stringify(voiceIdentity(state.settings))}|${text}`;

// A filler made ahead that failed (a cloud limit, a timeout): a line in the log, nothing on screen.
function quietFail(err) {
  logEvent('info', 'filler not made', { engine: state.settings.voice?.engine, error: err?.message });
  return null;
}

export const speaker = new Speaker();

// On any profile, an unloaded offline voice (Balanced frees it after a quiet while; the system
// monitor's Unload frees it anywhere) loads again as soon as a reply is coming (a message went out),
// or at a push-to-talk press when speech-to-text runs in the cloud (with local Whisper the press
// already loads that model on the same processor). Never on a hands-free onset (breath and room noise
// start one) or the face demo. With the voice loaded, start() returns at once and keepFor() restarts
// Balanced's idle clock (elsewhere it does nothing).
on('agent-state', (s) => {
  if (state.demo || state.transcribing || !offlineVoiceSpeaks(state.settings?.voice, { onFallback: speaker.onFallback })) return;
  const sent = s === 'thinking' && state.generating;
  const talking = s === 'listening' && recorder.active && state.settings.stt?.engine !== 'local';
  if (!sent && !talking) return;
  localVoice.start();
  if (sent && localVoice.worker) localVoice.keepFor();
});

// ----------------------------------------------------------- microphone
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

async function openMic() {
  await api.mic.request().catch(() => true);
  return navigator.mediaDevices.getUserMedia({ audio: await micConstraints() });
}

async function toMono16k(float32, sampleRate) {
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
class Recorder {
  constructor() {
    this.keepTimer = 0;
    this.module = null; // the worklet, loaded once
    this.starting = null; // a start in progress, so a release that comes first still stops it
  }

  /** The mic stream and the worklet, ready; reopened when the chosen microphone changed. */
  async warm() {
    const ac = ctx();
    this.module ||= ac.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url)).catch(() => {});
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
    if (this.starting) await this.starting.catch(() => {});
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

// A voice sample for cloning, kept at the mic's own rate (cloning wants more than the 16 kHz used
// for speech-to-text). Hands-free listening ignores the mic meanwhile, so reading the script aloud
// doesn't start a turn. Returns { seconds(), stop() → { samples, rate, wav() }, cancel() }.
let clipActive = false;

export async function recordClip() {
  speaker.stop();
  const rec = new Recorder();
  await rec.start();
  clipActive = true;
  const end = () => {
    clipActive = false;
    rec.cancel();
  };
  return {
    seconds: () => (performance.now() - rec.startedAt) / 1000,
    stop: () => {
      const samples = concat(rec.chunks);
      end();
      return { samples, rate: ctx().sampleRate, wav: () => encodeWav(samples, ctx().sampleRate) };
    },
    cancel: end,
  };
}

// Worklets must be connected through to the destination to be processed; a muted gain does that.
function silentSink(ac) {
  const g = ac.createGain();
  g.gain.value = 0;
  g.connect(ac.destination);
  return g;
}

function concat(chunks) {
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

const engineName = () => (state.settings?.voice?.engine === 'cloud' ? 'The cloud voice' : 'VoiceStudio');

// Neural voice detector (Silero VAD in a worker). Scores arrive about one frame behind the audio,
// which the pre-roll absorbs. Until it is ready, or if it fails to load, the energy detector is used.
const neural = {
  worker: null,
  ready: false,
  prob: 0,
  start() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./vad-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'prob') this.prob = msg.prob;
      else if (msg.type === 'ready') {
        this.ready = true;
        logEvent('info', 'neural voice detection ready');
      } else if (msg.type === 'error') this.fail(msg.error);
    };
    this.worker.onerror = (e) => this.fail(e.message || 'worker failed');
    this.worker.postMessage({ type: 'load' });
  },
  fail(message) {
    logEvent('warn', 'neural voice detection unavailable, using the energy detector', message);
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  },
  feed(samples, rate) {
    const copy = new Float32Array(samples);
    this.worker.postMessage({ type: 'frame', samples: copy, rate }, [copy.buffer]);
  },
  reset() {
    this.prob = 0;
    this.worker?.postMessage({ type: 'reset' });
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
    if (state.recording) setFlag('recording', false);
    state.micLevel = 0;
    emit('handsfree', false);
  }

  async restart() {
    this.stop();
    await this.start();
  }

  onFrame(samples, rms, voiced) {
    const s = state.settings.stt;
    const sens = Math.min(1, Math.max(0, Number(s.vadSensitivity ?? 0.5)));
    const agentTalking = state.playing;
    if (!this.seg) this.noise = this.noise * 0.995 + Math.min(rms, 0.05) * 0.005; // learn the room
    state.micLevel = this.seg ? Math.min(1, rms * 5) : 0;

    if (busy || clipActive || state.transcribing || (agentTalking && !s.headphones)) {
      if (agentTalking) this.seg = null;
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
        // Interrupting the agent needs clearly voiced speech, so breathing or a cough doesn't cut it off.
        if (onset({ agentTalking, loudMs: this.loud, voicedMs: this.onsetVoiced || 0 })) {
          heldPiece.wait(); // a piece waiting for its continuation: this is it
          if (agentTalking) {
            speaker.stop();
            emit('barge-in');
          }
          this.seg = { chunks: [...this.pre], silence: 0, length: 0, voiced: this.onsetVoiced || 0 };
          setFlag('recording', true);
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
    if (ended) {
      const seg = this.seg;
      this.seg = null;
      this.loud = 0;
      this.onsetVoiced = 0;
      setFlag('recording', false);
      // A short "yes" has ~150 ms of vowel; segments with none are breath or noise.
      if (seg.voiced < 80) return (setCaption(heldPiece.pending), heldPiece.pending && heldPiece.later());
      if (ended === 'limit') logEvent('info', 'long utterance split at the limit', { sec: Math.round(seg.length / 1000) });
      finishUtterance(() => toMono16k(concat(seg.chunks), this.rate), { join: true, limit: ended === 'limit', pauseMs: ended === 'limit' ? 0 : seg.silence });
    }
  }
}

export const handsFree = new HandsFree();

// Rebuild the mic after a headset is plugged in or removed (the old stream goes silent otherwise).
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  logEvent('info', 'audio devices changed');
  if (handsFree.running) handsFree.restart().catch((e) => logEvent('warn', 'mic restart failed', e.message));
});

// ------------------------------------------------------------ Transcriber
let worker = null;
let workerKey = ''; // the plan the worker loaded (perfcore.js speechPlan: model, fallback, gpu)
let loaded = null; // { model, device } once the worker reports ready
let unloadTimer = null;
let reqId = 0;
const pending = new Map();

let workerReady = false;

// Stops the worker and fails whatever it was transcribing, so the mic never waits on it forever.
function resetWorker(reason) {
  worker?.terminate();
  worker = null;
  workerKey = '';
  workerReady = false;
  loaded = null;
  clearTimeout(unloadTimer);
  for (const { reject } of pending.values()) reject(new Error(reason));
  pending.clear();
}

// The model for this computer and the language being spoken (practice mode switches it).
const currentPlan = () => speechPlan(state.settings, practiceLanguage(state.settings) || state.settings.stt.language || 'en');

function getWorker(plan) {
  const key = JSON.stringify(plan);
  if (worker && workerKey === key) return worker;
  resetWorker('The speech model was switched');
  worker = new Worker(new URL('./stt-worker.js', import.meta.url), { type: 'module' });
  workerKey = key;
  const model = plan.model;
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'progress') emit('stt-progress', msg);
    else if (msg.type === 'ready') {
      workerReady = true;
      loaded = { model: msg.model || model, device: msg.device };
      logEvent('info', 'speech-to-text ready', { model: msg.model || model, device: msg.device });
      emit('stt-progress', { status: 'ready' });
    } else if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (!msg.error) return resolve(msg.text);
      reject(new Error(msg.error));
      // A failed run can leave the model unusable (e.g. the GPU was reset after sleep or a driver
      // update); reload it for the next sentence instead of failing every time from now on.
      logEvent('warn', 'speech-to-text failed; reloading the model', msg.error);
      resetWorker('Speech-to-text was restarted');
    }
  };
  worker.onerror = (e) => resetWorker(e.message || 'Speech model failed to load');
  worker.postMessage({ type: 'load', ...plan });
  return worker;
}

// Balanced performance: the model leaves memory after a while without voice input (it loads again,
// from the cache, with the next sentence).
function scheduleUnload() {
  clearTimeout(unloadTimer);
  if (profile(state.settings) !== 'balanced') return;
  unloadTimer = setTimeout(() => worker && (logEvent('info', 'speech model unloaded after idle'), resetWorker('The speech model was unloaded')), BALANCED.speechIdleMin * 60000);
}

/** For the system monitor's memory section. */
export function speechStatus() {
  const s = state.settings?.stt;
  return { on: Boolean(s?.enabled && s.engine === 'local'), loaded: Boolean(worker), ready: workerReady, model: loaded?.model || (worker ? currentPlan().model : ''), device: loaded?.device || '' };
}

export function unloadSpeech() {
  if (worker) resetWorker('The speech model was unloaded to free memory');
}

export function preloadLocalModel() {
  const s = state.settings?.stt;
  if (s?.enabled && s.engine === 'local') getWorker(currentPlan());
}

// When voice input was last used, on this computer only (a convenience: lost storage means one
// launch without the preload). Decides whether the model loads at launch (perfcore.js preloadSpeech).
const VOICE_USED_KEY = 'siren.voiceInputAt';
function noteVoiceInput() {
  try {
    localStorage.setItem(VOICE_USED_KEY, String(Date.now()));
  } catch {}
}
function voiceInputAt() {
  try {
    return Number(localStorage.getItem(VOICE_USED_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** At launch: load the speech model only for someone who used voice input lately. */
export function preloadSpeechIfUsed() {
  if (preloadSpeech(state.settings, voiceInputAt())) preloadLocalModel();
}

function encodeWav(samples, rate = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Uint8Array(buf);
}

// raw: skip the vocabulary hint and the learned corrections (voice calibration measures without them).
export async function transcribe(samples, { raw = false } = {}) {
  const s = state.settings.stt;
  // Cloud: Groq's Whisper Large v3 Turbo ("groq") or a custom endpoint ("remote"), sent by main/voice.js.
  if (s.engine === 'remote' || s.engine === 'groq') return cleanTranscript(await api.stt.transcribe(encodeWav(samples), { raw }), { raw });
  noteVoiceInput();
  // Local, with Groq as the fallback (stt.cloudFallback): while the model is still loading (the first
  // minutes after a start or after it was unloaded), or if it fails, the cloud answers instead; the
  // local model keeps loading for next time.
  if (s.cloudFallback && !raw) {
    if (!workerReady) {
      getWorker(currentPlan());
      return cleanTranscript(await api.stt.transcribe(encodeWav(samples), { provider: 'groq' }));
    }
    try {
      return await transcribeLocal(samples, { raw });
    } catch (err) {
      logEvent('warn', 'local speech-to-text failed; using Groq', { error: err.message });
      return cleanTranscript(await api.stt.transcribe(encodeWav(samples), { provider: 'groq' }));
    }
  }
  return transcribeLocal(samples, { raw });
}

async function transcribeLocal(samples, { raw = false } = {}) {
  const s = state.settings.stt;
  const w = getWorker(currentPlan());
  const id = ++reqId;
  const copy = new Float32Array(samples);
  // A loaded model answers in seconds; if it hangs, restart it rather than leave the mic waiting.
  // (No limit while the model is still downloading or loading.)
  const limitMs = workerReady ? 20000 + (samples.length / 16000) * 3000 : 0;
  const text = await new Promise((resolve, reject) => {
    const timer = limitMs && setTimeout(() => (logEvent('warn', 'speech-to-text timed out; restarting it'), resetWorker('Speech-to-text took too long and was restarted')), limitMs);
    const done = (fn) => (v) => (clearTimeout(timer), fn(v));
    pending.set(id, { resolve: done(resolve), reject: done(reject) });
    w.postMessage({ type: 'transcribe', id, audio: copy, language: practiceLanguage(state.settings) || s.language || 'en' }, [copy.buffer]);
  });
  scheduleUnload();
  return cleanTranscript(text, { raw });
}

function cleanTranscript(t, { raw = false } = {}) {
  // Whisper marks non-speech in brackets: [BLANK_AUDIO], [SIGHS], (coughs), (breathing)…
  const x = String(t || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, '').replace(/\s+/g, ' ').trim();
  if (/^(you|thank you\.?|\.)$/i.test(x)) return '';
  return raw ? x : applyCorrections(x);
}

// Names and words the user's voice calibration found misheard ("lexus" → "Nexus"), whole words only.
function applyCorrections(text) {
  let out = text;
  for (const { heard, meant } of state.settings.stt.corrections || []) {
    const words = String(heard).split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${words.join('[\\s,.-]+')}(?![\\p{L}\\p{N}])`, 'giu'), meant);
  }
  return out;
}

// Voice calibration: what the user's reading of the script sounded like to speech-to-text, plus
// their speaking level against the room (loudness percentiles over 20 ms frames).
export async function analyzeClip(samples, rate) {
  const frame = Math.round(rate * 0.02);
  const levels = [];
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += samples[j] * samples[j];
    levels.push(Math.sqrt(sum / frame));
  }
  levels.sort((a, b) => a - b);
  const pct = (p) => levels[Math.min(levels.length - 1, Math.floor(levels.length * p))] || 0;
  const transcript = await transcribe(await toMono16k(samples, rate), { raw: true });
  return { transcript, speechLevel: pct(0.9), noiseFloor: pct(0.1), seconds: samples.length / rate };
}

// ----------------------------------------------------- utterance handling
let busy = false;

// End-to-end latency: from the end of the user's speech (before the pause that closed the utterance,
// which the log didn't count) to the reply's first audio.
let utteranceEndedAt = 0;

// synthMs is the whole wait; for the offline voice, its parts: the model loading, sentences ahead of
// it in the worker, and the run itself (localVoice.speak). cached: a kept line (phrases.js), no run.
function logFirstAudio(item, buf) {
  const now = performance.now();
  const sinceSpeechEndMs = utteranceEndedAt && now - utteranceEndedAt < 120000 ? Math.round(now - utteranceEndedAt) : undefined;
  utteranceEndedAt = 0;
  const t = buf?.timing || {};
  logEvent('info', 'first audio', { synthMs: Math.round(now - item.queuedAt), loadWaitMs: t.loadWaitMs, queueMs: t.queueMs, modelMs: t.modelMs, cached: t.cached || undefined, sinceSpeechEndMs, chars: item.text.length });
}

// Hands-free pieces of one message (utterance.js): a recording that hit the length limit, or a
// transcript that trails off, waits a moment for its continuation and goes out joined with it.
const joiner = createJoiner();
const heldPiece = {
  timer: 0,
  get pending() {
    return joiner.pending;
  },
  // Speech started again: wait for it instead of sending the held piece.
  wait() {
    clearTimeout(this.timer);
    joiner.hold(performance.now());
  },
  later() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const text = joiner.due(performance.now());
      // A piece that trailed off waited this long for more: part of the wait before a reply.
      if (text) logEvent('info', 'voice piece sent after a hold', { heldMs: HOLD_MS + 50 });
      if (text) emit('voice-input', text);
    }, HOLD_MS + 50);
  },
};

async function finishUtterance(getSamples, { join = false, limit = false, pauseMs = 0 } = {}) {
  utteranceEndedAt = performance.now() - pauseMs;
  busy = true;
  try {
    const samples = await getSamples();
    if (!samples?.length) {
      setCaption(heldPiece.pending);
      if (join && heldPiece.pending) return heldPiece.later();
      emit('barge-in-over'); // nothing was said: an interrupted reply speaks again
      return;
    }
    setFlag('transcribing', true);
    setCaption('Transcribing…', 'user');
    const started = performance.now();
    const text = await transcribe(samples);
    setCaption(text || '(didn’t catch that)', 'user');
    if (text) logEvent('info', 'heard', { chars: text.length, sttMs: Math.round(performance.now() - started), audioSec: +(samples.length / 16000).toFixed(1), pauseMs: pauseMs || undefined });
    if (text && state.settings?.logging?.debug) logEvent('debug', 'heard text', { text: text.slice(0, 200) });
    if (join) {
      const whole = joiner.add(text, { limit, now: performance.now() });
      if (whole) emit('voice-input', whole);
      else if (joiner.pending) (setCaption(`${joiner.pending} …`, 'user'), heldPiece.later());
      else emit('barge-in-over');
    } else if (text) emit('voice-input', text);
    else emit('barge-in-over');
  } catch (err) {
    emit('barge-in-over');
    logEvent('error', 'speech-to-text failed', err.message);
    toastError(new Error(`Speech-to-text: ${err.message}`));
    setCaption('');
    if (join && joiner.pending) heldPiece.later(); // what was heard before still goes out
  } finally {
    setFlag('transcribing', false);
    busy = false;
  }
}

// A press while the last utterance is still being transcribed waits for it (a moment) instead of
// being dropped; a release meanwhile cancels the wait. `press` tells a start which press it belongs to.
let press = 0;
const untilIdle = (ms) => new Promise((resolve) => {
  const t0 = performance.now();
  const poll = () => (!busy || performance.now() - t0 > ms ? resolve() : setTimeout(poll, 40));
  poll();
});

/** Opens the microphone ahead of the first press (at launch, when the window gets focus). */
export function warmMic() {
  const s = state.settings?.stt;
  if (s?.enabled && s.micMode !== 'open') recorder.warm().catch(() => {});
}

export async function startListening() {
  if (!state.settings?.stt?.enabled) {
    toastError(new Error('Voice input is disabled in Settings.'));
    return;
  }
  if (recorder.active || recorder.starting) return;
  const mine = ++press;
  speaker.stop(); // barge-in: pressing the talk key interrupts the agent
  emit('barge-in');
  if (busy) {
    setCaption('One moment…', 'user');
    await untilIdle(4000);
    if (mine !== press) return; // released meanwhile
  }
  // Not preloaded at launch (perfcore.js preloadSpeech): it loads while you speak, not after.
  preloadLocalModel();
  try {
    await recorder.start();
    setFlag('recording', true);
    setCaption('Listening…', 'user');
    emit('listening', true);
    // A stuck talk key must not record forever: what was said so far is sent.
    clearTimeout(pttLimit);
    pttLimit = setTimeout(() => mine === press && recorder.active && (logEvent('warn', 'push-to-talk held at the limit; stopped', { min: PTT_MAX_MS / 60000 }), stopListening()), PTT_MAX_MS);
  } catch (err) {
    logEvent('error', 'microphone failed', err.message);
    toastError(new Error(`Microphone: ${err.message}`));
  }
}

let pttLimit = 0;
export async function stopListening() {
  clearTimeout(pttLimit);
  press++; // a press still waiting to start is over
  if (recorder.starting) await recorder.starting.catch(() => {});
  if (!recorder.active) return;
  setFlag('recording', false);
  emit('listening', false);
  await finishUtterance(() => recorder.stop());
}

export function toggleListening() {
  return recorder.active ? stopListening() : startListening();
}

export async function setMicMode(mode) {
  if (mode === 'open') {
    perfReady.then(preloadLocalModel); // always listening: the model is needed soon
    try {
      await handsFree.start();
    } catch (err) {
      toastError(new Error(`Hands-free: ${err.message}`));
    }
  } else handsFree.stop();
}
