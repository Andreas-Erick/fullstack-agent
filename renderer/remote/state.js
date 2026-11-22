// The phone client's shared state: the open conversation (turnstate), the device token and settings in
// this browser's storage, and the Android app's bridge. Imported by every other module of the client.
import { createChat } from './js/turnstate.js';

export const $ = (s) => document.querySelector(s);
// The message box, taken once before any message is drawn: whatever a reply renders can never be what
// Send reads (PHONE_PURIFY also prefixes ids; this holds even if it didn't).
export const inputEl = document.getElementById('input');
export const TOKEN_KEY = 'nexus.token';
export const CONV_KEY = 'nexus.conv';
export const SPEAK_KEY = 'nexus.speak';
export const NAME_KEY = 'nexus.deviceName';
// Present inside the Android app (android/): background notifications, the Talk tile, the share sheet.
export const android = window.NexusAndroid || null;
// The Android app's bridge: what changes something takes the key the app hands this page once per load
// (hello); a custom face's frame never gets it. Older apps have no hello and take no key.
const keyed = typeof android?.hello === 'function';
const bridgeKey = keyed ? String(android.hello() || '') : '';
export function bridge(name, ...args) {
  if (typeof android?.[name] !== 'function') return undefined;
  if (!keyed) return android[name](...args);
  return bridgeKey ? android[name](bridgeKey, ...args) : undefined; // no key this load: skipped, never thrown
}

export const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {
      /* private mode: works until the page closes */
    }
  },
};

// The open conversation and its replies: this phone's own (chat.own, requestId null while its send is in
// flight, events held meanwhile) and those started elsewhere in it (chat.others). A turn's nodes are its view.
export const chat = createChat();
chat.setConv(store.get(CONV_KEY));
export const replying = () => Boolean(chat.own || chat.others.length);

export const state = {
  token: store.get(TOKEN_KEY),
  get convId() {
    return chat.convId;
  },
  set convId(id) {
    chat.setConv(id);
  },
  shownConv: undefined, // the conversation whose messages are drawn (null: a new one; undefined: none yet)
  face: 'idle', // what the face shows now (refreshFace): faceState, 'speaking-text' for a reply written without a voice
  recording: false,
  transcribing: false,
  playing: false,
  name: 'Siren',
  view: 'chat', // chat | sched | a screen from screens.js (today, learn, memory, notes, world, arch, skills, more)
  info: null, // the computer's /api/info
  client: '', // the phone client's version this page was loaded as (/api/info client)
  calendar: false,
  convTitle: '',
  secureUrl: '', // the computer's https address, when it has one
  speak: store.get(SPEAK_KEY) === '1',
  voice: false,
  stream: null,
};
