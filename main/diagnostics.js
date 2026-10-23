// Health checks for every part of the stack. Used by the Health panel and by the agent's `diagnose`
// tool, so it can find and fix problems with its own tools ("you are the mechanic").
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const store = require('./store');
const log = require('./logger');

const timeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms))]);

async function check(id, label, fn) {
  const started = Date.now();
  try {
    const r = (await timeout(fn(), 15000, label)) || {};
    return { id, label, status: r.status || 'ok', detail: r.detail || '', fix: r.fix || '', ms: Date.now() - started };
  } catch (err) {
    return { id, label, status: 'fail', detail: err.message, fix: '', ms: Date.now() - started };
  }
}

async function run() {
  const s = await store.getSettings();
  const llm = require('./llm');
  const claudecode = require('./claudecode');
  const voice = require('./voice');
  const obsidian = require('./obsidian');
  const calendar = require('./calendar');
  const selfchange = require('./selfchange');

  const checks = [
    check('brain', 'AI brain', async () => {
      if (s.llm.provider === 'claude-code') {
        const st = await claudecode.status();
        if (!st.installed) return { status: 'fail', detail: 'Claude Code CLI not found.', fix: `Install: ${claudecode.installHint()}, or set its path in Settings → AI brain.` };
        if (!st.loggedIn) return { status: 'fail', detail: `Claude Code ${st.version} is not signed in.`, fix: 'Settings → AI brain → Connect Claude account.' };
        return { detail: `Claude account ${st.email || ''} (${st.subscription || st.authMethod}), Claude Code ${st.version}` };
      }
      if (s.llm.provider === 'anthropic') {
        if (!s.anthropic.apiKey) return { status: 'fail', detail: 'No Anthropic API key.', fix: 'Add it in Settings → AI brain.' };
        return { detail: `API key set · model ${s.anthropic.model}` };
      }
      const models = await llm.listModels(s);
      if (s.llm.model && !models.some((m) => m.id === s.llm.model)) return { status: 'warn', detail: `Model "${s.llm.model}" is not offered by ${s.llm.baseUrl} (${models.length} models available).`, fix: 'Pick an available model in Settings → AI brain.' };
      return { detail: `${s.llm.baseUrl} · ${models.length} models · using ${s.llm.model || models[0]?.id}` };
    }),
    check('tts', 'Voice output (VoiceStudio)', async () => {
      if (!s.voice.ttsEnabled) return { status: 'off', detail: 'Disabled.' };
      const p = await voice.ping();
      if (!p.ok) return { status: s.voice.fallbackSystemVoice ? 'warn' : 'fail', detail: `VoiceStudio is unreachable at ${s.voice.baseUrl}.${s.voice.fallbackSystemVoice ? ' Using the system voice as fallback.' : ''}`, fix: 'Start VoiceStudio, or correct its URL in Settings → Voice output.' };
      const t0 = Date.now();
      try {
        await voice.speak('ok');
      } catch (err) {
        return { status: s.voice.fallbackSystemVoice ? 'warn' : 'fail', detail: `VoiceStudio answers but synthesis fails: ${err.message}${s.voice.fallbackSystemVoice ? ' (using the system voice meanwhile)' : ''}`, fix: 'Check the voice id and model in Settings → Voice output, or restart VoiceStudio.' };
      }
      return { detail: `${s.voice.baseUrl} · voice "${s.voice.voice || 'default'}" · synthesis ${Date.now() - t0} ms` };
    }),
    check('stt', 'Voice input', async () => {
      if (!s.stt.enabled) return { status: 'off', detail: 'Disabled.' };
      if (s.stt.engine === 'remote' && !(s.stt.remoteUrl || s.llm.baseUrl)) return { status: 'fail', detail: 'No transcription URL configured.', fix: 'Settings → Voice input.' };
      return { detail: `${s.stt.engine === 'local' ? `Local Whisper (${s.stt.localModel})` : `Remote ${s.stt.remoteUrl || s.llm.baseUrl}`} · ${s.stt.micMode === 'open' ? 'hands-free' : `push-to-talk (${s.stt.pttKey})`}${s.stt.micDevice ? ` · mic "${s.stt.micDevice}"` : ''}` };
    }),
    check('vault', 'Vault', async () => {
      if (!s.obsidian.enabled) return { status: 'off', detail: 'Disabled.' };
      const root = await obsidian.vaultPath();
      if (!root) return { status: 'fail', detail: 'Vault folder unavailable.', fix: 'Check the path in Settings → Vault.' };
      const probe = path.join(root, `.nexus-write-test-${Date.now()}`);
      await fsp.writeFile(probe, 'ok');
      await fsp.rm(probe, { force: true });
      const st = await obsidian.status();
      return { status: st.registered ? 'ok' : 'warn', detail: `${root} · ${st.count} notes · writable${fs.existsSync(path.join(root, '.git')) ? ' · versioned' : ''}${st.registered ? '' : ' · not registered in Obsidian'}`, fix: st.registered ? '' : 'Settings → Vault → Register in Obsidian (close Obsidian first).' };
    }),
    check('calendar', 'Google Calendar', async () => {
      if (!s.calendar.enabled) return { status: 'off', detail: 'Disabled.' };
      const st = await calendar.status();
      if (!st.configured) return { status: 'off', detail: 'Not set up.' };
      if (!st.signedIn) return { status: 'warn', detail: 'Not signed in.', fix: 'Settings → Google Calendar → Sign in.' };
      const ev = await calendar.events();
      return { detail: `${st.email || 'connected'} · ${ev.length} upcoming events` };
    }),
    check('web', 'Internet search', async () => {
      if (!s.web.enabled) return { status: 'off', detail: 'Disabled.' };
      if (s.llm.provider === 'claude-code') return { detail: 'Using Claude Code’s built-in web search.' };
      const r = await require('./websearch').search('weather', 2);
      return { status: r.results.length ? 'ok' : 'warn', detail: `${r.provider}: ${r.results.length} results` };
    }),
    check('self', 'Self-improvement', async () => {
      if (!s.code.allowSelfModify) return { status: 'off', detail: 'Disabled.' };
      const st = await selfchange.status();
      if (!st.available) return { status: 'fail', detail: st.reason };
      const chk = await selfchange.check();
      if (!chk.ok) return { status: 'fail', detail: `Code fails the syntax check:\n${chk.output.slice(0, 800)}`, fix: 'Open Evolution and revert the last change, or run: npm run recover -- undo' };
      return { status: st.dirty?.length ? 'warn' : 'ok', detail: `History at ${st.head}${st.dirty?.length ? ` · ${st.dirty.length} uncommitted file(s)` : ''} · syntax check passes`, fix: st.dirty?.length ? 'Evolution → Record or Discard the uncommitted changes.' : '' };
    }),
    check('log', 'Recent errors', async () => {
      const errs = log.recentErrors(3600000);
      if (!errs.length) return { detail: 'No errors or warnings in the last hour.' };
      return { status: 'warn', detail: `${errs.length} in the last hour. Latest:\n${errs.slice(-5).join('\n')}`, fix: 'Ask the agent to read its log and fix the cause.' };
    }),
  ];
  const results = await Promise.all(checks);
  log.info('diagnostics', results.map((r) => `${r.id}:${r.status}`).join(' '));
  return results;
}

module.exports = { run };
