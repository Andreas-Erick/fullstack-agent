// What Nexus itself holds right now, for the "Nexus" section of the system monitor's panel
// (renderer/js/sysmon.js): its own processes by kind (Electron's app metrics), live Claude sessions,
// the agent window and the globe server; and freeing those on the user's click. The speech model and
// the offline voice live in the window (their workers count under "Windows") and are freed there.
// Like sysmon.js: for the user only, never for tools, the prompt or paired devices.
const { app } = require('electron');

// Electron's process types, in words.
const KIND = { Browser: 'App core', Tab: 'Windows (incl. speech models)', GPU: 'Graphics' };

function usage() {
  const kinds = {};
  for (const m of app.getAppMetrics()) {
    const kb = m.memory?.privateBytes || m.memory?.workingSetSize || 0;
    const name = KIND[m.type] || 'Helpers';
    kinds[name] = (kinds[name] || 0) + kb / 1024;
  }
  const processes = Object.entries(kinds)
    .map(([name, mb]) => ({ name, mb: Math.round(mb) }))
    .sort((a, b) => b.mb - a.mb);
  const sessions = require('./claudecode').liveSessions();
  return {
    processes,
    totalMb: processes.reduce((s, p) => s + p.mb, 0),
    claude: { live: sessions.length, busy: sessions.filter((s) => s.busy).length },
    agentWindow: Boolean(require('./agentwindow').window()),
    globe: require('./extensions').globeStartedByNexus(),
  };
}

/** Frees one part: 'claude' (idle sessions), 'agentWindow' or 'globe' (only the server Nexus started). */
function free(what) {
  if (what === 'claude') return require('./claudecode').closeIdleSessions();
  if (what === 'agentWindow') return require('./agentwindow').close();
  if (what === 'globe') return require('./extensions').stopGodsEye(), true;
  throw new Error('Nothing to free by that name.');
}

module.exports = { usage, free };
