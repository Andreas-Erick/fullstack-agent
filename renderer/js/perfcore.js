// Performance profiles, the window's side (pure: no DOM, no app state; tests load it). Settings →
// Interface → Performance: Full keeps everything; Balanced is for lighter computers. Auto picks from a
// hardware check (perf.js runs it; main/hardware.js scans). The same profile() rule is in
// main/perfcore.js, which applies the main process's limits (Claude sessions, helper apps).

export const BALANCED = {
  speechIdleMin: 10, // the speech model is unloaded after this long without voice input
  voiceIdleMin: 10, // the offline voice likewise
  faceFps: 30, // faces draw at most this many frames a second, at 1× pixel density, without glow
};

/** 'balanced' or 'full' for these settings (perf.mode: auto | balanced | full). */
export function profile(settings) {
  const p = settings?.perf || {};
  if (p.mode === 'balanced' || p.mode === 'full') return p.mode;
  return p.detected === 'low' ? 'balanced' : 'full';
}

/**
 * A lighter computer: little memory, or no graphics card with its own memory for the large speech
 * model (integrated graphics share the system's memory). hw and rec come from main/hardware.js scan().
 */
export function classify(hw, rec) {
  const vram = rec?.vramGB || 0;
  const gpu = (hw?.gpus || []).find((g) => g.vendor === 'NVIDIA' || g.vendor === 'AMD' || g.unified)?.name || (hw?.gpus || [])[0]?.name || '';
  const reasons = [];
  if ((hw?.ramGB || 0) < 12) reasons.push(`${hw?.ramGB || '?'} GB of memory`);
  if (vram < 4) reasons.push(vram ? `${Math.round(vram)} GB of graphics memory` : 'no graphics card with its own memory');
  return { detected: reasons.length ? 'low' : 'high', hw: { ramGB: hw?.ramGB || null, vramGB: vram || null, gpu, reason: reasons.join(' and ') } };
}

const SMALL = { en: 'Xenova/whisper-small.en', multi: 'Xenova/whisper-small' };
const BASE = { en: 'Xenova/whisper-base.en', multi: 'Xenova/whisper-base' };

/**
 * Which speech model to load for this computer and language: { model, fallback, gpu }.
 * - The large model only where it fits: Full profile and (once checked) a graphics card with 4 GB+.
 *   Otherwise Whisper small (16 GB+ of memory) or base. About 1.5 GB → 370 / 73 MB.
 * - English-only (.en) models only for English; other languages get the multilingual model.
 * - fallback: what the worker runs on the processor when the GPU can't (fast enough there).
 * - gpu: false keeps everything on the processor (Balanced: no model copy in shared graphics memory).
 */
export function speechPlan(settings, language = 'en') {
  const english = /^en\b/i.test(language || 'en');
  const pick = (m) => (english ? m.en : m.multi);
  const hw = settings?.perf?.hw;
  const balanced = profile(settings) === 'balanced';
  let model = settings?.stt?.localModel || pick(BASE);
  if (/large/i.test(model) && (balanced || (hw && !(hw.vramGB >= 4)))) model = pick((hw?.ramGB || 0) >= 16 ? SMALL : BASE);
  else if (!english) model = model.replace(/^(Xenova\/whisper-(?:tiny|base|small|medium))\.en$/, '$1');
  return { model, fallback: pick(BASE), gpu: !balanced };
}

/** The effects level actually used: Balanced keeps the HUD's look but without motion (Subtle). */
export function effectsLevel(settings) {
  const fx = ['hud', 'subtle', 'off'].includes(settings?.ui?.fx) ? settings.ui.fx : 'hud';
  return fx === 'hud' && profile(settings) === 'balanced' ? 'subtle' : fx;
}
