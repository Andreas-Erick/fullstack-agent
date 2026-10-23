// What the app is running on, for the log's launch header and for bug reports: versions, code
// commit, hardware, GPU, monitors, and a secrets-free summary of the settings that change behaviour.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, screen } = require('electron');
const store = require('./store');
const log = require('./logger');

const ROOT = path.join(__dirname, '..');

function git(args) {
  return new Promise((resolve) => execFile('git', args, { cwd: ROOT, timeout: 4000, windowsHide: true }, (err, out) => resolve(err ? '' : String(out).trim())));
}

async function environment() {
  const s = await store.getSettings();
  const [commit, changed, gpu] = await Promise.all([git(['rev-parse', '--short', 'HEAD']), git(['status', '--porcelain']), app.getGPUInfo('basic').catch(() => null)]);
  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: `${os.cpus()[0]?.model || '?'} (${os.cpus().length} threads)`,
    ramGB: Math.round(os.totalmem() / 1e9),
    gpu: (gpu?.gpuDevice || []).map((d) => `${d.vendorId?.toString(16)}:${d.deviceId?.toString(16)}${d.active ? ' active' : ''}${d.driverVersion ? ` driver ${d.driverVersion}` : ''}`),
    monitors: screen.getAllDisplays().map((d) => `${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}@${d.scaleFactor}`),
    code: { commit: commit || '(no git)', uncommittedFiles: changed ? changed.split('\n').length : 0 },
    settings: {
      brain: s.llm.provider,
      model: s.llm.provider === 'claude-code' ? s.claudeCode.model : s.llm.provider === 'anthropic' ? s.anthropic.model : s.llm.model,
      fastForVoice: s.llm.voiceUsesFast,
      permissionMode: s.safety.permissionMode,
      stt: `${s.stt.enabled ? s.stt.engine : 'off'} ${s.stt.engine === 'local' ? s.stt.localModel : ''}`.trim(),
      mic: `${s.stt.micMode}${s.stt.headphones ? ' +headphones' : ''} vad=${s.stt.vadEngine}`,
      voice: s.voice.ttsEnabled ? `VoiceStudio ${s.voice.baseUrl}` : 'off',
      calendar: s.calendar.enabled,
      github: s.github?.enabled !== false,
      workspaceSet: Boolean(s.documents.workspace),
      vault: s.obsidian.enabled,
      selfModify: s.code.allowSelfModify,
    },
  };
}

// Settings without secrets or bulky images, for a bug report.
async function safeSettings() {
  const s = JSON.parse(JSON.stringify(await store.getSettings()));
  for (const [section, key] of store.SECRET_FIELDS) if (s[section]?.[key]) s[section][key] = '(set)';
  if (s.agent?.avatar) s.agent.avatar = '(image)';
  if (s.agent?.personality) s.agent.personality = `(${s.agent.personality.length} characters)`;
  return s;
}

/** Writes logs/bug-report-<time>.md: environment, health checks, recent problems, recent log, settings. */
async function bugReport(note = '') {
  const [env, diag, settings] = await Promise.all([
    environment(),
    require('./diagnostics')
      .run()
      .catch((e) => ({ error: e.message })),
    safeSettings(),
  ]);
  const problems = log.recentErrors(24 * 3600000);
  const fence = (lang, text) => `\`\`\`${lang}\n${text}\n\`\`\``;
  const md = [
    `# Nexus Agent bug report`,
    `Created ${new Date().toString()}`,
    note ? `\n**What happened (as described):** ${note}` : '',
    `\n## Environment\n${fence('json', JSON.stringify(env, null, 2))}`,
    `\n## Health checks\n${fence('json', JSON.stringify(diag, null, 2))}`,
    `\n## Errors and warnings, last 24 hours (${problems.length})\n${fence('', problems.slice(-200).join('\n') || '(none)')}`,
    `\n## Recent log (last 600 lines)\n${fence('', log.tail(600))}`,
    `\n## Settings (secrets removed)\n${fence('json', JSON.stringify(settings, null, 2))}`,
  ].join('\n');
  const file = path.join(log.dir(), `bug-report-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`);
  fs.writeFileSync(file, log.redact(md), 'utf8');
  log.info('bug report created', { file, problems: problems.length });
  return { file, problemsLast24h: problems.length, healthChecks: Array.isArray(diag) ? diag.map((c) => `${c.id}:${c.status}`).join(' ') : undefined };
}

module.exports = { environment, bugReport };
