// Turns the raw log into a short list of distinct problems: warnings and errors grouped by what they
// are (numbers, ids, paths and quoted values normalized), with counts, first and last time, example
// turn ids and the app's own code locations from the stack traces. Used by analyze_errors, the Health
// check and the check after a self-change. analyze() is pure (log text in, groups out).
const LINE = /^(\S+)\s+(ERROR|WARN)\s+(?:\[([^\]]*)\]\s+)?(.*)$/;
const LOCATION = /\b((?:main|renderer|preload|scripts)\/[\w./-]+\.js):(\d+)(?::\d+)?/g;
const APP_URL = /app:\/\/bundle\/((?:renderer|main)\/[\w./-]+\.js):(\d+)(?::\d+)?/g;

function normalize(s) {
  return String(s)
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/"[^"]{24,}"/g, '"…"')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b(?:[A-Za-z]:)?[\\/][\w\\/.-]+/g, '<path>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseLine(row) {
  const m = LINE.exec(row);
  if (!m) return null;
  const [, time, level, tags = '', rest] = m;
  const brace = rest.indexOf(' {');
  const event = (brace === -1 ? rest : rest.slice(0, brace)).trim();
  let data = null;
  if (brace !== -1) {
    try {
      data = JSON.parse(rest.slice(brace + 1));
    } catch {
      /* cut off or not JSON */
    }
  }
  const err = data?.error && typeof data.error === 'object' ? data.error : null;
  const message = err?.message || (typeof data?.error === 'string' ? data.error : '') || (brace === -1 ? '' : rest.slice(brace + 1, brace + 300));
  const where = data?.name || data?.channel || '';
  const stack = err?.stack || '';
  const locations = new Set();
  for (const re of [LOCATION, APP_URL]) for (const x of `${stack} ${rest}`.matchAll(re)) locations.add(`${x[1]}:${x[2]}`);
  const turn = /turn=(\w+)/.exec(tags)?.[1];
  return { time, level, event, where, message: String(message).slice(0, 400), locations: [...locations], turn };
}

/** groups: [{ level, event, where, message, count, first, last, turns[], locations[] }] */
function analyze(logText, { sinceMs = 24 * 3600000, now = Date.now(), limit = 15 } = {}) {
  const cutoff = now - sinceMs;
  const groups = new Map();
  for (const row of String(logText || '').split('\n')) {
    const p = parseLine(row);
    if (!p || !(Date.parse(p.time) >= cutoff)) continue;
    const key = `${p.level}|${p.event}|${p.where}|${normalize(p.message)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { level: p.level.toLowerCase(), event: p.event, where: p.where || undefined, message: p.message, count: 0, first: p.time, last: p.time, turns: [], locations: [] }));
    g.count++;
    g.last = p.time;
    if (p.turn && g.turns.length < 3 && !g.turns.includes(p.turn)) g.turns.push(p.turn);
    for (const l of p.locations) if (g.locations.length < 4 && !g.locations.includes(l)) g.locations.push(l);
  }
  // Errors first, then by how often and how recently.
  return [...groups.values()].sort((a, b) => (a.level === b.level ? b.count - a.count || b.last.localeCompare(a.last) : a.level === 'error' ? -1 : 1)).slice(0, limit);
}

/** From the app's own log (main process only). */
function fromLog({ sinceMs, limit } = {}) {
  const log = require('./logger');
  const minutes = Math.ceil((sinceMs || 24 * 3600000) / 60000);
  const text = log.tail(2000, '', { level: 'warn', sinceMin: minutes });
  return analyze(text, { sinceMs, limit });
}

module.exports = { analyze, fromLog, normalize, parseLine };
