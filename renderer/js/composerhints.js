// The composer's quiet hints (pure; app.js draws them): the one-time "keep holding" after a short tap on
// the mic (push-to-talk records only while it is held), and the "Saved on this PC" chip with the notes
// folder in its tooltip.

/** A press shorter than this is a tap, not a hold. */
export const TAP_MS = 400;

const HOLD_HINT = 'Keep holding while you speak.';

/** The hint after a mic press of `heldMs`, or null: only for a tap, and only the first time. */
export function tapHint(heldMs, shownBefore) {
  if (shownBefore || !Number.isFinite(heldMs) || heldMs >= TAP_MS) return null;
  return HOLD_HINT;
}

/** The chip near the composer: fixed words, the tooltip naming where notes are kept (obsidian status). */
export function savedChip(status) {
  const where = status?.ok && typeof status.path === 'string' && status.path ? status.path : '';
  return {
    text: 'Saved on this PC',
    title: where
      ? `Your chats, memories and settings stay on this computer. Notes are saved in ${where}`
      : 'Your chats, memories and settings stay on this computer.',
  };
}
