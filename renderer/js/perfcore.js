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
 * model (integrated graphics share the system's memory). Macs with Apple silicon have unified memory:
 * the GPU is fast but shares one pool with macOS and the apps, so they count as lighter below 16 GB.
 * hw and rec come from main/hardware.js scan().
 */
export function classify(hw, rec) {
  const vram = rec?.vramGB || 0;
  const gpus = hw?.gpus || [];
  const unified = gpus.some((g) => g.unified);
  const gpu = gpus.find((g) => g.vendor === 'NVIDIA' || g.vendor === 'AMD' || g.unified)?.name || gpus[0]?.name || '';
  const ram = hw?.ramGB || 0;
  const reasons = [];
  if (unified) {
    if (ram < 16) reasons.push(`${ram || '?'} GB of unified memory, shared by the processor and the graphics`);
  } else {
    if (ram < 12) reasons.push(`${ram || '?'} GB of memory`);
    if (vram < 4) reasons.push(vram ? `${Math.round(vram)} GB of graphics memory` : 'no graphics card with its own memory');
  }
  return { detected: reasons.length ? 'low' : 'high', hw: { ramGB: ram || null, vramGB: vram || null, unified, gpu, reason: reasons.join(' and ') } };
}

export const LARGE = 'onnx-community/whisper-large-v3-turbo';
const SMALL = { en: 'Xenova/whisper-small.en', multi: 'Xenova/whisper-small' };
const BASE = { en: 'Xenova/whisper-base.en', multi: 'Xenova/whisper-base' };

// The heavy models, measured in the window and graphics processes together (NEXUS_SMOKE_MEM=1):
// large Whisper on the GPU about 4.5–7 GB, the offline voice at full precision on the GPU about
// 1.9 GB; Whisper small/base and the 8-bit voice on the processor a few hundred MB.
export const HEAVY = { ramGB: 32, vramGB: 8 };

/**
 * The heavy models (large Whisper, the offline voice on the GPU) for these settings. Balanced: never.
 * Full chosen by the user: as before, wherever they run (a 4 GB graphics card, a Mac with 16 GB).
 * Auto: only on a computer with room for them besides everything else (HEAVY), so a 16 GB laptop with
 * a small graphics card gets the full look without giving half its memory to speech.
 */
export function heavyModels(settings) {
  if (profile(settings) === 'balanced') return false;
  const hw = settings?.perf?.hw;
  if (settings?.perf?.mode === 'full') return !hw || (hw.unified ? hw.ramGB >= 16 : hw.vramGB >= 4);
  return Boolean(hw) && hw.ramGB >= HEAVY.ramGB && (hw.unified || hw.vramGB >= HEAVY.vramGB);
}

/**
 * Which speech model to load for this computer and language: { model, fallback, gpu }.
 * - stt.localModel '' (the default) or 'auto': chosen here. The large model only with heavyModels(),
 *   otherwise Whisper small (16 GB+ of memory) or base. About 1.5 GB → 370 / 73 MB to download.
 * - A large model the user picked is also replaced by small/base where heavy models don't fit.
 * - English-only (.en) models only for English; other languages get the multilingual model.
 * - fallback: what the worker runs on the processor when the GPU can't (fast enough there).
 * - gpu: false keeps everything on the processor (Balanced: no model copy in shared graphics memory).
 */
export function speechPlan(settings, language = 'en') {
  const english = /^en\b/i.test(language || 'en');
  const pick = (m) => (english ? m.en : m.multi);
  const hw = settings?.perf?.hw;
  const heavy = heavyModels(settings);
  const light = pick((hw?.ramGB || 0) >= 16 ? SMALL : BASE);
  const chosen = settings?.stt?.localModel;
  let model = !chosen || chosen === 'auto' ? (heavy ? LARGE : light) : chosen;
  if (/large/i.test(model) && !heavy) model = light;
  else if (!english) model = model.replace(/^(Xenova\/whisper-(?:tiny|base|small|medium))\.en$/, '$1');
  return { model, fallback: pick(BASE), gpu: profile(settings) !== 'balanced' };
}

/** The offline voice on the GPU (full precision, ~1.9 GB) or the 8-bit model on the processor. */
export const voiceOnGpu = (settings) => heavyModels(settings);

export const RECENT_VOICE_MS = 7 * 86400000;

/**
 * Load the local speech model at launch? Only for someone who talks to the assistant: voice input used
 * in the last week (lastUsedAt, ms). Everyone else loads it with the first press of the talk key.
 * Balanced never preloads.
 */
export function preloadSpeech(settings, lastUsedAt, now = Date.now()) {
  const s = settings?.stt;
  if (!s?.enabled || s.engine !== 'local' || profile(settings) === 'balanced') return false;
  return Number(lastUsedAt) > 0 && now - lastUsedAt < RECENT_VOICE_MS;
}

/** The effects level actually used: Balanced keeps the HUD's look but without motion (Subtle). */
export function effectsLevel(settings) {
  const fx = ['hud', 'subtle', 'off'].includes(settings?.ui?.fx) ? settings.ui.fx : 'hud';
  return fx === 'hud' && profile(settings) === 'balanced' ? 'subtle' : fx;
}
