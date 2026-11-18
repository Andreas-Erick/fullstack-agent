// What the speaker says when: sentence chunks and when filler audio is made. Pure (voice.js speaks
// it), so test/speechplan.test.js covers it.
import { mathOpen } from './mathtext.js';

// Pull complete sentences out of a streaming buffer. Short fragments are merged to avoid choppy audio.
export function takeSentences(buf) {
  const done = [];
  let rest = buf;
  const re = /([\s\S]*?[.!?…:;](?=\s|$)|[\s\S]*?\s[—–]\s|[\s\S]*?\n\s*\n)/;
  let m;
  let acc = '';
  while ((m = rest.match(re)) && m[0].length < rest.length) {
    acc += m[0];
    rest = rest.slice(m[0].length);
    // Never split inside a formula: "$$a. b$$" would be spoken as raw LaTeX.
    if ((acc.trim().length >= 24 || /\n\s*\n/.test(m[0])) && !mathOpen(acc)) {
      done.push(acc.trim());
      acc = '';
    }
  }
  return { done, rest: acc + rest };
}

export function splitSentences(text, all = false) {
  const { done, rest } = takeSentences(text);
  if (all && rest.trim()) done.push(rest);
  return done;
}

// A reply's first sentence is made alone so the voice starts fast; a long one still took as long to
// make as it is long. Cut at its first comma between these characters: the head plays while the
// tail is made.
const CUT_FROM = 100;
const CUT_MIN = 30;
const CUT_MAX = 80;
const digit = (c) => c >= '0' && c <= '9';

/** [head, tail]: the first sentence in two parts when it is long, else [sentence, '']. */
export function firstCut(s) {
  const text = String(s || '');
  if (text.length <= CUT_FROM) return [text, ''];
  for (let i = text.indexOf(', ', CUT_MIN); i >= 0 && i <= CUT_MAX; i = text.indexOf(', ', i + 1)) {
    if (digit(text[i - 1]) && digit(text[i + 2])) continue; // "1, 2, 3" is one list
    if (mathOpen(text.slice(0, i))) continue;
    return [text.slice(0, i + 1), text.slice(i + 2).trim()];
  }
  return [text, ''];
}

// The cut has a price: on the offline voice the pause at the comma came out 0.2–0.4 s longer than in
// the whole sentence, and the head often ends on a falling, sentence-final tone. So a long first
// sentence is cut only where making it whole would keep the listener waiting: on the processor
// (seconds a sentence), or when the measured pace puts the whole sentence past CUT_WORTH_MS. A healthy
// GPU makes a 160-character sentence in about 1.6 s: there it stays whole.
export const CUT_WORTH_MS = 2500;

/** Whether the offline voice should cut this first sentence (firstCut). */
export function cutWorth({ chars, msPerChar = 0, device = '' }) {
  if (/^CPU/i.test(device)) return true;
  return msPerChar > 0 && chars * msPerChar > CUT_WORTH_MS;
}

/**
 * The offline voice's pace, ms of model time per character, leaning on recent sentences. A short line
 * is mostly fixed cost, so it doesn't count.
 */
export function paceAfter(prev, { chars, modelMs }) {
  if (!(chars >= 20) || !(modelMs > 0)) return prev;
  const now = modelMs / chars;
  return prev > 0 ? prev * 0.6 + now * 0.4 : now;
}

/**
 * The filler warm-up's next step: 'done' (all made), 'stop' (a reply or a recording is on, or the main
 * voice is `away` and the fallback speaks, whose audio would be kept as the main voice's: the next
 * quiet moment resumes it), 'wait' (the speaker is talking: it resumes when it goes quiet), 'warm'.
 */
export function warmStep({ todo, idle, busy, away = false }) {
  if (todo === 0) return 'done';
  if (!idle || away) return 'stop';
  if (busy) return 'wait';
  return 'warm';
}
