// Replies read aloud: the computer's voice (/api/speak), played here.
import { $, SPEAK_KEY, store, state } from './state.js';
import { icon, toast, AuthError } from './ui.js';
import { api } from './net.js';
import { refreshFace, voiceCtx, ensureAnalyser } from './face.js';

// ------------------------------------------------------------------ voice out
// `audio` feeds the face's analyser once that exists (see ensureAnalyser); `plainAudio` is never routed,
// so a reply is still heard if the browser has suspended the analyser's audio graph.
export const audio = new Audio();
const plainAudio = new Audio();
for (const a of [audio, plainAudio]) {
  a.addEventListener('ended', () => ((state.playing = false), refreshFace()));
  a.addEventListener('playing', () => ((state.playing = true), refreshFace()));
}

async function player() {
  if (!voiceCtx) return audio;
  if (voiceCtx.state !== 'running') await voiceCtx.resume().catch(() => {}); // refused without a gesture: the reply is still on screen
  return voiceCtx.state === 'running' ? audio : plainAudio;
}

function speakable(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*_~>|#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function say(md) {
  const text = speakable(md);
  if (!text) return;
  try {
    const res = await api('/api/speak', { method: 'POST', body: { text }, raw: true });
    const p = await player();
    for (const a of [audio, plainAudio]) a.pause();
    if (p.src) URL.revokeObjectURL(p.src);
    p.src = URL.createObjectURL(await res.blob());
    await p.play();
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message);
  }
}

export function setSpeak(on) {
  state.speak = on;
  store.set(SPEAK_KEY, on ? '1' : '0');
  $('#speakBtn').replaceChildren(icon(on ? 'speaker-on' : 'speaker-off'));
  $('#speakBtn').classList.toggle('on', on);
  $('#speakBtn').setAttribute('aria-pressed', String(on));
  if (!on) for (const a of [audio, plainAudio]) a.pause();
}
$('#speakBtn').addEventListener('click', () => {
  if (!state.voice && !state.speak) return toast('No voice is set up on the computer (Settings → Voice).');
  setSpeak(!state.speak);
  // A tap unlocks audio playback on mobile browsers, and is the moment to set up the face's analyser.
  if (state.speak) {
    ensureAnalyser();
    for (const a of [audio, plainAudio]) a.play().catch(() => {}); // autoplay refused: the reply is still on screen
  }
});
