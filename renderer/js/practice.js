// Language practice (learning.practiceLanguage): speech recognition listens for the target language and
// replies are spoken by a voice for it. Notes in the user's own language go in a Markdown blockquote
// ("> …"): shown on screen, not spoken, so the target-language voice never reads English.
// Pure (no DOM, no app state): tested in test/practice.test.js.

export const LANGUAGE_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', sv: 'Swedish',
  no: 'Norwegian', da: 'Danish', fi: 'Finnish', pl: 'Polish', cs: 'Czech', sk: 'Slovak', hu: 'Hungarian', ro: 'Romanian',
  el: 'Greek', tr: 'Turkish', ru: 'Russian', uk: 'Ukrainian', ar: 'Arabic', he: 'Hebrew', hi: 'Hindi', bn: 'Bengali',
  ja: 'Japanese', zh: 'Chinese', ko: 'Korean', vi: 'Vietnamese', th: 'Thai', id: 'Indonesian', ms: 'Malay', sw: 'Swahili',
  ca: 'Catalan', hr: 'Croatian', sr: 'Serbian', bg: 'Bulgarian', fa: 'Persian', ur: 'Urdu', ta: 'Tamil', la: 'Latin',
};

export const languageName = (code) => LANGUAGE_NAMES[String(code || '').slice(0, 2).toLowerCase()] || String(code || '').toUpperCase();

/** The language being practiced, or '' when practice is off. */
export const practiceLanguage = (settings) => String(settings?.learning?.practiceLanguage || '').trim().toLowerCase();

/** A voice from `voices` (speechSynthesis.getVoices()) that speaks `lang`, preferring natural/online ones. */
export function pickVoice(voices, lang) {
  const want = String(lang || '').toLowerCase();
  const fits = (voices || []).filter((v) => String(v.lang || '').toLowerCase().replace('_', '-').startsWith(want));
  return fits.find((v) => /natural|online|neural/i.test(v.name)) || fits.find((v) => v.default) || fits[0] || null;
}

/**
 * Streams reply text and lets through only what should be spoken: lines starting with ">" (blockquotes)
 * are dropped. Returns feed(delta) → the speakable part of that delta.
 */
export function quoteFilter() {
  let lineStart = true;
  let inQuote = false;
  let pendingSpaces = ''; // leading spaces of a line, held until we know whether it is a quote
  return (delta) => {
    let out = '';
    for (const ch of String(delta)) {
      if (ch === '\n') {
        if (!inQuote) out += pendingSpaces + ch;
        pendingSpaces = '';
        lineStart = true;
        inQuote = false;
        continue;
      }
      if (lineStart) {
        if (ch === ' ' || ch === '\t') {
          pendingSpaces += ch;
          continue;
        }
        lineStart = false;
        inQuote = ch === '>';
        if (!inQuote) out += pendingSpaces;
        pendingSpaces = '';
      }
      if (!inQuote) out += ch;
    }
    return out;
  };
}
