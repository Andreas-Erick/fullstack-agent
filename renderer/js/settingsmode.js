// Settings in Simple and Advanced mode (pure, test/settingstabs.test.js). Simple (ui.settingsAdvanced off,
// the default) hides the fields a builder marks advanced (addresses, tokens, sampling, effort, CLI paths,
// audio formats); they stay in the page, so the search still finds them and shows them with a note.
// Also the voice shortcut recorder's rules (key press → Electron accelerator) and its readable label.

export const ADVANCED_NOTE = 'Advanced setting';

/** Whether an advanced field shows: always in Advanced mode; in Simple mode only when a search matches it. */
export const advancedShown = ({ advancedMode, searching, matched }) => Boolean(advancedMode || (searching && matched));

/** The note an advanced field carries while a search reveals it in Simple mode, else ''. */
export const advancedNote = (s) => (!s.advancedMode && advancedShown(s) ? ADVANCED_NOTE : '');

/** VoiceStudio's address, key, voice id and model matter only when it is the voice. */
export const voiceStudioShown = (engine) => engine === 'voicestudio';

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;
const NAMED = { Space: 'Space', Enter: 'Enter', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`' };

function keyName(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
  if ((m = /^Numpad([0-9])$/.exec(code))) return `num${m[1]}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED[code] || '';
}

/**
 * One key press while the shortcut field records (a KeyboardEvent's code and modifiers):
 * { accel } done ('' = off, by Backspace/Delete), { cancel } (Esc), or { waiting, why? } (only modifiers
 * so far, or a key that would fire while typing). Ctrl is CommandOrControl; on a Mac so is ⌘.
 */
export function accelerator(e, { mac = false } = {}) {
  const code = String(e?.code || '');
  if (code === 'Escape') return { cancel: true };
  if (code === 'Backspace' || code === 'Delete') return { accel: '' };
  if (MODIFIER_CODES.test(code)) return { waiting: true };
  const key = keyName(code);
  if (!key) return { waiting: true };
  const command = e.ctrlKey || (mac && e.metaKey);
  const mods = [command ? 'CommandOrControl' : '', !mac && e.metaKey ? 'Super' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(Boolean);
  const fn = /^F\d+$/.test(key);
  if (!fn && !mods.some((x) => x !== 'Shift')) return { waiting: true, why: 'Add Ctrl or Alt' };
  return { accel: [...mods, key].join('+') };
}

/** "CommandOrControl+Alt+Space" as the keys read: "Ctrl + Alt + Space" (⌘ on a Mac); '' is "Off". */
export function acceleratorLabel(accel, { mac = false } = {}) {
  if (!accel) return 'Off';
  const names = { CommandOrControl: mac ? '⌘' : 'Ctrl', CmdOrCtrl: mac ? '⌘' : 'Ctrl', Control: 'Ctrl', Ctrl: 'Ctrl', Super: mac ? '⌘' : 'Win', Meta: mac ? '⌘' : 'Win', Option: 'Alt' };
  return String(accel).split('+').map((p) => names[p] || p).join(' + ');
}
