// Values typed in Settings wait a moment and are saved once (the last value), remembering the persona whose
// cards they were typed into: the live persona fields are always the active persona (main/personacore.js
// sync), so a value saved after a switch elsewhere would land in another persona. Main decides that inside
// its save queue (settings:set { persona } answers { saved, dropped }); the checks here only spare a model
// call made for a persona no longer active. Pure: test/settingsview.test.js.

// The settings each persona keeps: the one list main/personacore.js uses too.
import { PERSONA_PATHS } from './personafields.mjs';
export { PERSONA_PATHS };

/** A value for `path` from cards drawn for `persona` would now land in another persona. */
export const stale = (path, persona, active) => Boolean(persona) && PERSONA_PATHS.has(path) && persona !== active;

/**
 * The same, judged by main's settings too. This window's copy of the active persona (`active`) can lag: a
 * switch on the phone, the watch or by a routine reaches the window only when it reads the settings again.
 * So a persona field this window still counts as current asks main (`readActive()`, only then; a failed read
 * rejects, and the caller says so instead of saving).
 */
export async function staleNow(path, persona, active, readActive) {
  if (stale(path, persona, active)) return true;
  if (!persona || !PERSONA_PATHS.has(path)) return false;
  return stale(path, persona, await readActive());
}

/**
 * A number field's text → its number, or null when there is nothing to save (empty, half typed, not a
 * number): the field then keeps the stored value instead of saving 0 (Number('') is 0). Counts accept
 * "1,000", "1 000", "1_000" and "1'000"; `decimal` fields (temperature) read one comma as the decimal point
 * ("0,7") and refuse nothing else that is a plain decimal.
 */
export function parseNumber(raw, { decimal = false } = {}) {
  let t = String(raw ?? '').normalize('NFKC').trim();
  if (!t) return null;
  if (decimal) {
    t = t.replace(/[\s_]/g, '');
    t = !t.includes('.') && t.split(',').length === 2 ? t.replace(',', '.') : t.replace(/,/g, '');
  } else t = t.replace(/[\s,_'’]/g, '');
  if (!(decimal ? /^-?(\d+\.?\d*|\.\d+)$/ : /^-?\d+$/).test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A folder or program path as pasted: trimmed, without the quotes Explorer's "Copy as path" adds. */
export function cleanPath(raw) {
  const t = String(raw ?? '').trim();
  const m = /^(["'])(.*)\1$/s.exec(t);
  return m ? m[2].trim() : t;
}

/**
 * One waiting save per path: queue(path, value, persona) calls save(path, value, persona) after `delay` ms;
 * flushAll() saves what waits now and also waits for the saves already on their way (each one waits for
 * main's answer), so a persona switch after it never lands before one of them. It resolves to what each waiting
 * save said.
 */
export function createSaves({ save, delay = 400, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) } }) {
  const pending = new Map(); // path → { value, persona, timer }
  const running = new Set(); // saves whose time came, not finished yet
  const flush = (path) => {
    const x = pending.get(path);
    if (!x) return Promise.resolve(true);
    pending.delete(path);
    timers.clear(x.timer);
    const job = Promise.resolve(save(path, x.value, x.persona)).finally(() => running.delete(job));
    running.add(job);
    return job;
  };
  return {
    queue(path, value, persona) {
      timers.clear(pending.get(path)?.timer);
      pending.set(path, { value, persona, timer: timers.set(() => flush(path), delay) });
    },
    flushAll: async () => {
      const onTheirWay = [...running];
      const results = await Promise.all([...pending.keys()].map(flush));
      await Promise.allSettled(onTheirWay);
      return results;
    },
    size: () => pending.size,
  };
}
