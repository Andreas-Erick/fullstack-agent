// The settings each persona keeps, in one place for both sides: main/personacore.js requires it (an .mjs
// file is an ES module everywhere, and Node 22.12+/Electron can require() one), and the window's
// settingsave.js imports it. The live values of these fields are always the active persona's.

// [settings section, settings key, persona field]
export const FIELDS = Object.freeze([
  ['agent', 'name', 'name'],
  ['agent', 'personality', 'personality'],
  ['agent', 'aesthetic', 'aesthetic'],
  ['agent', 'avatar', 'avatar'],
  ['agent', 'personaSummary', 'personaSummary'],
  ['appearance', 'theme', 'theme'],
  ['appearance', 'personaNotes', 'personaNotes'],
  ['appearance', 'greeting', 'greeting'],
  ['appearance', 'scene', 'scene'],
  ['ui', 'face', 'face'],
  ['voice', 'voice', 'voice'],
  ['voice', 'localVoice', 'localVoice'],
].map((f) => Object.freeze(f)));

/** The same as 'section.key' paths (the Settings view's field paths). */
export const PERSONA_PATHS = new Set(FIELDS.map(([section, key]) => `${section}.${key}`));
