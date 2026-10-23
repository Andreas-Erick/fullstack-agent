// Diagnostic log (<userData>/logs/nexus.log): what was heard and said, tool calls, fallbacks, session
// spawns, errors. The agent reads it through the read_app_log tool to diagnose itself ("the mechanic").
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_BYTES = 5 * 1024 * 1024;

function file() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'nexus.log');
}

function write(level, event, data) {
  try {
    const f = file();
    const st = fs.existsSync(f) ? fs.statSync(f) : null;
    if (st && st.size > MAX_BYTES) fs.renameSync(f, f.replace(/\.log$/, '.1.log'));
    let detail = '';
    if (data !== undefined) detail = typeof data === 'string' ? data : JSON.stringify(data);
    if (detail.length > 2000) detail = `${detail.slice(0, 2000)}…`;
    fs.appendFileSync(f, `${new Date().toISOString()} ${level.padEnd(5)} ${event}${detail ? ` ${detail}` : ''}\n`);
  } catch {
    /* logging must never break the app */
  }
}

function tail(lines = 150, filter = '') {
  try {
    const text = fs.readFileSync(file(), 'utf8');
    let rows = text.trimEnd().split('\n');
    if (filter) {
      const f = filter.toLowerCase();
      rows = rows.filter((r) => r.toLowerCase().includes(f));
    }
    return rows.slice(-Math.min(1000, lines)).join('\n');
  } catch {
    return '(log is empty)';
  }
}

function recentErrors(sinceMs = 3600000) {
  const cutoff = Date.now() - sinceMs;
  return tail(1000)
    .split('\n')
    .filter((r) => / (ERROR|WARN) /.test(r) && Date.parse(r.slice(0, 24)) >= cutoff);
}

module.exports = {
  info: (e, d) => write('INFO', e, d),
  warn: (e, d) => write('WARN', e, d),
  error: (e, d) => write('ERROR', e, d),
  tail,
  recentErrors,
  file,
};
