// Agent tools: Voices (VoiceStudio) and voice calibration.
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const documents = require('../documents');
const approvals = require('../approvals');
const store = require('../store');
const log = require('../logger');
const voicestudio = require('../voicestudio');
const calibration = require('../calibration');
const { arr, obj, str, bool, requireApproval } = require('./common');

// Read aloud by the user to clone their voice: varied sounds, natural rhythm, about 20 seconds.
const CLONE_SCRIPT =
  'The quick brown fox jumps over the lazy dog, and that is just the start. On a bright Tuesday morning I check my calendar, make a cup of coffee, and plan the week ahead. Some days are busy, others are quiet, but every one of them is mine.';

// After a voice is created: let the user hear it, and switch to it when asked (with approval).
async function finishNewVoice(v, a, ctx, extra = {}) {
  let using = false;
  if (a.use_now) {
    await requireApproval(ctx, 'settings', `Speak with the new voice "${v.name}"`, `voice.voice → ${v.id}`);
    await store.setSettings({ voice: { voice: v.id } });
    ctx.emit({ type: 'settings_changed' });
    using = true;
  }
  ctx.emit({ type: 'voice_preview', voice: v.id, text: a.sample_text || `Hi, this is ${v.name}. How do I sound?` });
  return { created: true, voice_id: v.id, name: v.name, using, ...extra, note: 'A sample is playing for the user. The first sample can take a while if VoiceStudio still has to load its model.' };
}

// After calibration: is the speech model good enough for this voice?
function speechRecommendation(stt, accuracy) {
  if (accuracy >= 0.9) return 'None: recognition is accurate.';
  if (stt.engine === 'local' && !/large/.test(stt.localModel)) {
    return 'Switch stt.localModel to onnx-community/whisper-large-v3-turbo (about 1.6 GB, once; much better with accents, and on a GPU also faster). Ask the user first.';
  }
  if (stt.engine === 'local') return 'The largest local model is already in use. A remote Whisper (stt.engine "remote", e.g. through FreeLLMAPI) is usually more accurate; suggest it.';
  return 'Speak a little slower and closer to the microphone; check the input device in Settings → Voice input.';
}

module.exports = [
  {
    name: 'voice_list',
    group: 'voice',
    description: 'List the voices in VoiceStudio (ids and names) and which one you currently speak with.',
    parameters: obj({}),
    run: async () => {
      const s = await store.getSettings();
      return { current: s.voice.voice || '(default)', voices: await voicestudio.list() };
    },
  },
  {
    name: 'voice_design',
    group: 'voice',
    description:
      'Create a new voice in VoiceStudio from a description, e.g. "warm, low-pitched British man, calm". VoiceStudio understands gender, age, pitch, speaking style and accent; it reports which words it ignored. The user hears a sample afterwards. Set use_now to switch to it (asks the user).',
    parameters: obj(
      {
        name: str('Name for the voice'),
        description: str('What it should sound like'),
        sample_text: str('A sentence to hear it with (optional)'),
        use_now: bool('Switch your own voice to it afterwards'),
      },
      ['name', 'description'],
    ),
    run: async (a, ctx) => {
      await requireApproval(ctx, 'voice', `Create the voice "${a.name}" in VoiceStudio`, `Description: ${a.description}`);
      const v = await voicestudio.design({ name: a.name, description: a.description, sampleText: a.sample_text });
      return finishNewVoice(v, a, ctx, { understood: v.understood, ignored: v.ignored });
    },
  },
  {
    name: 'voice_clone',
    group: 'voice',
    description:
      "Clone a voice into VoiceStudio. source 'record': the app asks the user to read a short script aloud (their own voice). source 'file': an existing recording (10–30 s of one clear speaker; wav, mp3, m4a, flac, ogg or webm). Only clone a voice that belongs to the user or whose owner agreed: ask the user which applies before cloning from a file, and pass it as consent. Set use_now to switch to it (asks the user).",
    parameters: obj(
      {
        name: str('Name for the voice'),
        source: { type: 'string', enum: ['record', 'file'] },
        path: str("For source 'file': the recording's path"),
        transcript: str("For source 'file': what is said in it (optional; VoiceStudio transcribes it otherwise)"),
        consent: { type: 'string', enum: ['own_voice', 'speaker_agreed'], description: "For source 'file': the user's own voice, or the speaker agreed to it being cloned" },
        use_now: bool('Switch your own voice to it afterwards'),
      },
      ['name', 'source'],
    ),
    run: async (a, ctx) => {
      let audio, filename, transcript;
      if (a.source === 'record') {
        const script = CLONE_SCRIPT;
        const b64 = await approvals.askRecording({ script, seconds: 30 });
        if (!b64) return { created: false, note: 'The user cancelled the recording.' };
        audio = Buffer.from(b64, 'base64');
        filename = 'recording.wav';
        transcript = script;
      } else {
        if (!a.path) throw new Error("source 'file' needs a path.");
        if (!a.consent) throw new Error("Ask the user whether this is their own voice or the speaker agreed to the cloning, then pass consent.");
        const full = await documents.resolveAllowed(a.path);
        const ext = require('path').extname(full).toLowerCase();
        if (!voicestudio.AUDIO_TYPES[ext]) throw new Error(`Not an audio file VoiceStudio takes: ${ext || '(no extension)'}`);
        const who = a.consent === 'own_voice' ? "the user's own voice" : 'someone who agreed to have their voice cloned';
        await requireApproval(ctx, 'voice_clone', `Clone the voice in ${require('path').basename(full)} as "${a.name}"`, `Recording: ${full}\nWhose voice: ${who}`);
        audio = await require('fs/promises').readFile(full);
        filename = full;
        transcript = a.transcript || '';
      }
      const v = await voicestudio.clone({ name: a.name, audio, filename, transcript });
      log.info('voice cloned', { id: v.id, source: a.source, consent: a.consent || 'recorded by the user' });
      return finishNewVoice(v, a, ctx);
    },
  },
  {
    name: 'voice_delete',
    group: 'voice',
    description: 'Delete a voice from VoiceStudio (get its id from voice_list). You cannot delete the voice you are using.',
    parameters: obj({ voice_id: str('Voice id') }, ['voice_id']),
    run: async (a, ctx) => {
      const s = await store.getSettings();
      if (s.voice.voice === a.voice_id) throw new Error('That is the voice you are using; switch to another one first.');
      const v = (await voicestudio.list()).find((x) => x.id === a.voice_id);
      if (!v) throw new Error(`No VoiceStudio voice with id ${a.voice_id}.`);
      await requireApproval(ctx, 'delete', `Delete the voice "${v.name}" from VoiceStudio`, `Voice id: ${v.id}`);
      await voicestudio.remove(a.voice_id);
      return { deleted: v.name };
    },
  },
  {
    name: 'voice_calibrate',
    group: 'listening',
    description:
      "Optional voice calibration (about a minute): the user reads a short script aloud in the app. It measures how accurately you understand their voice, learns how names and special words get misheard (fixed automatically from then on) and sets the hands-free sensitivity to their voice and room. It does not retrain speech recognition. Pass the user's name and the names and words they will often say (people, projects, places, jargon). Report the result in plain words and act on the recommendation (ask before switching the speech model).",
    parameters: obj({ user_name: str("What the user wants to be called"), words: arr('Names and special words they will often say, up to 6') }),
    run: async (a, ctx) => {
      const s = await store.getSettings();
      const { script, vocabulary } = calibration.buildScript({ userName: a.user_name || '', agentName: s.agent.name || 'Siren', words: a.words || [] });
      const json = await approvals.askRecording({
        script,
        seconds: 60,
        mode: 'calibrate',
        title: 'Voice calibration',
        intro: 'Read this aloud the way you normally talk to me. I compare it with what I heard, so I learn how your names and words come through. The recording itself is not kept.',
      });
      if (!json) return { calibrated: false, note: 'The user cancelled; nothing changed. They can ask for it again any time.' };
      const heard = JSON.parse(json);
      const result = calibration.analyze({ script, transcript: heard.transcript, vocabulary });
      const level = calibration.sensitivityFor(heard);
      const patch = { vocabulary: [...new Set([...(s.stt.vocabulary || []), ...vocabulary])].slice(-30), corrections: calibration.merge(s.stt.corrections, result.corrections), calibratedAt: Date.now() };
      // The level-based sensitivity is for the basic loudness detector; the neural one judges speech itself.
      const tuneLevel = level && s.stt.vadEngine === 'energy';
      if (tuneLevel) patch.vadSensitivity = level.sensitivity;
      await store.setSettings({ stt: patch });
      ctx.emit({ type: 'settings_changed' });
      log.info('voice calibration', { accuracy: result.accuracy.toFixed(2), corrections: result.corrections.length, ratio: level?.ratio?.toFixed(1) });
      return {
        calibrated: true,
        accuracy: `${Math.round(result.accuracy * 100)}% of the words came through right`,
        heard: heard.transcript,
        words: result.words.map((w) => `${w.word}: ${w.heardAs === null ? 'unclear' : w.heardAs === w.word.toLowerCase() ? 'understood' : `heard as "${w.heardAs}"`}`),
        learnedCorrections: result.corrections.map((c) => `"${c.heard}" → ${c.meant}`),
        microphone: !level ? 'could not measure' : heard.speechLevel < 0.01 ? 'very quiet: move closer or raise the input volume' : level.ratio < 3 ? 'noisy: background noise is close to your speaking level' : 'good',
        handsFreeSensitivity: tuneLevel ? `set to ${level.sensitivity}` : 'unchanged (the neural voice detector adapts by itself)',
        recommendation: speechRecommendation(s.stt, result.accuracy),
      };
    },
  },
];
