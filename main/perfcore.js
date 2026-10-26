// Performance profiles, the main process's side (pure). Settings → Interface → Performance: Full keeps
// everything; Balanced is for lighter computers (fewer live Claude sessions, shorter idle times, helper
// apps stopped on quit). Auto follows the hardware check the window runs (renderer/js/perfcore.js, which
// has the same profile() rule and the renderer-side limits).

const BALANCED = {
  sessionCap: 2, // live Claude Code processes at once (each is a Node process plus its MCP server)
  sessionIdleMin: 5, // a session closes after this long without a turn
};

/** 'balanced' or 'full' for these settings (perf.mode: auto | balanced | full). */
function profile(settings) {
  const p = settings?.perf || {};
  if (p.mode === 'balanced' || p.mode === 'full') return p.mode;
  return p.detected === 'low' ? 'balanced' : 'full';
}

/**
 * Which idle sessions to close so that at most `cap` stay alive once a new one starts: the least
 * recently used first, never one in the middle of a turn, never `keep` (the one about to run).
 * sessions: [{ id, alive, busy, lastUsed }]
 */
function sessionsToClose(sessions, cap, keep) {
  const alive = sessions.filter((s) => s.alive && s.id !== keep);
  const excess = alive.length + 1 - cap;
  if (excess <= 0) return [];
  return alive
    .filter((s) => !s.busy)
    .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0))
    .slice(0, excess)
    .map((s) => s.id);
}

module.exports = { BALANCED, profile, sessionsToClose };
