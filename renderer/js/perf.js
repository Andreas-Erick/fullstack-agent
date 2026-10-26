// Performance (rules in perfcore.js): checks this computer once and every 30 days, then says what it
// chose. Balanced on a lighter computer: a smaller speech model loaded only when used, effects without
// motion or blur, calmer faces, fewer live Claude sessions (main/perfcore.js).
import { api, emit, toast, logEvent } from './util.js';
import { state, saveSettings } from './state.js';
import { profile, classify } from './perfcore.js';

const RECHECK_MS = 30 * 86400000;
let ready;
export const perfReady = new Promise((r) => (ready = r));
export const isBalanced = () => profile(state.settings) === 'balanced';

export async function initPerf() {
  const p = state.settings.perf || {};
  if (p.detectedAt && Date.now() - p.detectedAt < RECHECK_MS) return ready();
  try {
    await detect({ first: !p.detectedAt });
  } catch (err) {
    logEvent('warn', 'performance check failed', { error: err.message });
  } finally {
    ready();
  }
}

/** Checks the hardware (also Settings → Interface → "Check this computer again"). */
export async function detect({ first = false } = {}) {
  const webgpu = 'gpu' in navigator ? Boolean(await navigator.gpu.requestAdapter().catch(() => null)) : false;
  const { hardware, recommendations } = await api.hardware.scan({ webgpu });
  const { detected, hw } = classify(hardware, recommendations);
  const patch = { perf: { detected, hw, detectedAt: Date.now() } };
  // A lighter computer starts with the chat-only layout: no second face running beside the chat.
  if (first && detected === 'low' && state.settings.ui.chatLayout === 'split') patch.ui = { chatLayout: 'chat' };
  await saveSettings(patch);
  if (patch.ui) emit('layout');
  logEvent('info', 'performance check', { detected, ramGB: hw.ramGB, vramGB: hw.vramGB, profile: profile(state.settings) });
  if (first && detected === 'low' && (state.settings.perf.mode || 'auto') === 'auto') {
    toast(`Siren runs in Balanced mode on this computer (${hw.reason}): a lighter speech model, effects without motion, calmer faces. Settings → Interface → Performance.`, 'info', 14000);
  }
  return state.settings.perf;
}
