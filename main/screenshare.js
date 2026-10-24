// Screen sharing: the user picks a screen or a window in the app; while it is shared, each message
// can carry a fresh screenshot of it and the agent can look again (look_at_screen). Nothing is shared
// until the user starts it, it stops with one click (or when the window it shows closes), and
// screenshots are never written to disk or kept in the conversation.
const { desktopCapturer, systemPreferences } = require('electron');
const log = require('./logger');

let shared = null; // { id, name, kind: 'screen'|'window', startedAt }
let notify = () => {};

function setListener(fn) {
  notify = fn;
}

function state() {
  return shared ? { active: true, name: shared.name, kind: shared.kind, since: shared.startedAt } : { active: false };
}

// macOS needs the Screen Recording permission; without it every capture is blank.
function permission() {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen');
}

/** Screens and windows the user can choose from, with small previews. */
async function sources() {
  const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false });
  return list
    .filter((s) => !s.thumbnail.isEmpty())
    .map((s) => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen') ? 'screen' : 'window', thumb: s.thumbnail.toDataURL() }));
}

function start({ id, name }) {
  if (!id) throw new Error('Choose a screen or window to share.');
  shared = { id, name: name || 'screen', kind: String(id).startsWith('screen') ? 'screen' : 'window', startedAt: Date.now() };
  log.info('screen sharing started', { kind: shared.kind, name: shared.name.slice(0, 80) });
  notify(state());
  return state();
}

function stop(reason = '') {
  if (!shared) return state();
  log.info('screen sharing stopped', { minutes: Math.round((Date.now() - shared.startedAt) / 60000), reason });
  shared = null;
  notify({ ...state(), reason });
  return state();
}

/**
 * A screenshot of the shared screen/window as a JPEG data URL (long edge at most `size` px, which
 * keeps text readable for the model without huge requests).
 */
async function capture({ size = 1568 } = {}) {
  if (!shared) throw new Error('Screen sharing is off. Ask the user to click "Share screen" in the chat first.');
  const list = await desktopCapturer.getSources({ types: [shared.kind], thumbnailSize: { width: size, height: size }, fetchWindowIcons: false });
  const src = list.find((s) => s.id === shared.id) || (shared.kind === 'screen' && list.length === 1 ? list[0] : null);
  if (!src || src.thumbnail.isEmpty()) {
    const what = shared.name;
    stop('source gone');
    throw new Error(`The shared ${shared?.kind || 'window'} "${what}" is no longer available, so sharing stopped.`);
  }
  const { width, height } = src.thumbnail.getSize();
  const url = `data:image/jpeg;base64,${src.thumbnail.toJPEG(72).toString('base64')}`;
  log.info('screen captured', { width, height, kb: Math.round((url.length * 3) / 4 / 1024) });
  return { url, width, height, name: shared.name };
}

/** Small live preview for the UI. */
async function preview() {
  if (!shared) return null;
  const list = await desktopCapturer.getSources({ types: [shared.kind], thumbnailSize: { width: 240, height: 150 }, fetchWindowIcons: false });
  const src = list.find((s) => s.id === shared.id);
  return src && !src.thumbnail.isEmpty() ? src.thumbnail.toDataURL() : null;
}

module.exports = { setListener, state, permission, sources, start, stop, capture, preview };
