// The Speaker: a reply's sentences in order (VoiceStudio, the cloud voice, the offline voice, or the
// OS voice as fallback), the fillers made ahead, kept lines (phrases.js), and the first-audio log line.
import { api, emit, speakable, toastError, logEvent } from './util.js';
import { state, setFlag, setCaption, ttsActive } from './state.js';
import { takeSentences, splitSentences, firstCut, cutWorth, warmStep, sayChunks, createLineOrder, createReplySpeech, LONE_CHARS } from './speechplan.js';
import { voiceIdentity, madeByOf, launchGreeting } from './phrasecore.js';
import { getPhrase, keepPhrase } from './phrases.js';
import { allFillers } from './chatcore.js';
import { practiceLanguage, pickVoice, languageName } from './practice.js';
import { ctx } from './voicecommon.js';
import { fallbackMode, localVoice } from './offlinevoice.js';

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
    this.playing = false; // a sentence is playing (or the next one is on its way): the open mic ignores the room
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
      this.setPlaying(true);
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
    this.setPlaying(false);
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
    this.setPlaying(false);
  }

  setPlaying(on) {
    this.playing = on;
    setFlag('playing', on);
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

// What chat.js speaks a reply through (speechplan.js createReplySpeech): spoken or not, fillers, the end.
export const replySpeech = createReplySpeech({ speaker, active: ttsActive, fillersOn: () => state.settings.voice.filler, fillerLines: allFillers });

const engineName = () => (state.settings?.voice?.engine === 'cloud' ? 'The cloud voice' : 'VoiceStudio');

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

// The end of the user's speech (finishUtterance in voice.js), for the first audio's sinceSpeechEndMs.
export function noteSpeechEnd(at) {
  utteranceEndedAt = at;
}
