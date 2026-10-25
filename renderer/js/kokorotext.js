// Text side of the offline Kokoro voice (tts-worker.js): normalization before phonemization, the
// phoneme fixes the model expects, and the voice list. Pure: no imports, so tests can load it.
// Ported from kokoro-js 1.2.1 (Apache-2.0, github.com/hexgrad/kokoro).

export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_SAMPLE_RATE = 24000;
export const voiceUrl = (id) => `https://huggingface.co/${KOKORO_MODEL}/resolve/main/voices/${id}.bin`;

// The voices worth offering (grade from the model card). The first letter is the accent: a = US, b = UK.
export const KOKORO_VOICES = [
  ['af_heart', 'Heart · US female (A)'],
  ['af_bella', 'Bella · US female (A-)'],
  ['af_nicole', 'Nicole · US female, soft (B-)'],
  ['af_sarah', 'Sarah · US female (C+)'],
  ['af_kore', 'Kore · US female (C+)'],
  ['am_fenrir', 'Fenrir · US male (C+)'],
  ['am_michael', 'Michael · US male (C+)'],
  ['am_puck', 'Puck · US male (C+)'],
  ['bf_emma', 'Emma · UK female (B-)'],
  ['bf_isabella', 'Isabella · UK female (C)'],
  ['bm_george', 'George · UK male (C)'],
  ['bm_fable', 'Fable · UK male (C)'],
];
export const DEFAULT_KOKORO_VOICE = 'af_heart';
export const kokoroVoice = (id) => (KOKORO_VOICES.some(([v]) => v === id) ? id : DEFAULT_KOKORO_VOICE);

function splitNum(m) {
  if (m.includes('.')) return m;
  if (m.includes(':')) {
    const [h, min] = m.split(':').map(Number);
    if (min === 0) return `${h} o'clock`;
    return min < 10 ? `${h} oh ${min}` : `${h} ${min}`;
  }
  const year = parseInt(m.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return m;
  const left = m.slice(0, 2);
  const right = parseInt(m.slice(2, 4), 10);
  const s = m.endsWith('s') ? 's' : '';
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${s}`;
    if (right < 10) return `${left} oh ${right}${s}`;
  }
  return `${left} ${right}${s}`;
}

function money(m) {
  const unit = m[0] === '$' ? 'dollar' : 'pound';
  const amount = m.slice(1);
  if (isNaN(Number(amount))) return `${amount} ${unit}s`;
  if (!amount.includes('.')) return `${amount} ${unit}${amount === '1' ? '' : 's'}`;
  const [whole, frac] = amount.split('.');
  const cents = parseInt(frac.padEnd(2, '0'), 10);
  const small = m[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : cents === 1 ? 'penny' : 'pence';
  return `${whole} ${unit}${whole === '1' ? '' : 's'} and ${cents} ${small}`;
}

function decimal(m) {
  const [a, b] = m.split('.');
  return `${a} point ${b.split('').join(' ')}`;
}

export function normalizeText(text) {
  return String(text)
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '“')
    .replace(/»/g, '”')
    .replace(/[“”]/g, '"')
    .replace(/\(/g, '«')
    .replace(/\)/g, '»')
    .replace(/[^\S \n]/g, ' ')
    .replace(/  +/, ' ')
    .replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, money)
    .replace(/\d*\.\d+/g, decimal)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

// Punctuation stays as it is (the model reads it as prosody); only the words between go to eSpeak.
const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_RUN = new RegExp(`(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

export function splitPunctuation(text) {
  const parts = [];
  let at = 0;
  for (const m of text.matchAll(PUNCT_RUN)) {
    if (at < m.index) parts.push({ punct: false, text: text.slice(at, m.index) });
    if (m[0].length) parts.push({ punct: true, text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ punct: false, text: text.slice(at) });
  return parts;
}

export function fixPhonemes(ipa, accent = 'a') {
  let out = ipa
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (accent === 'a') out = out.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return out.trim();
}

// phonemize(text, lang) → string[] (phonemizer's eSpeak NG); injected so this module stays pure.
export async function toPhonemes(text, voice, phonemize) {
  const accent = voice[0];
  const lang = accent === 'a' ? 'en-us' : 'en';
  const parts = splitPunctuation(normalizeText(text));
  const ipa = await Promise.all(parts.map(async (p) => (p.punct ? p.text : (await phonemize(p.text, lang)).join(' '))));
  return fixPhonemes(ipa.join(''), accent);
}

// Each voice file holds one 256-value style per input length; pick the one for this many tokens.
export function styleOffset(tokenCount) {
  return 256 * Math.min(Math.max(tokenCount - 2, 0), 509);
}
