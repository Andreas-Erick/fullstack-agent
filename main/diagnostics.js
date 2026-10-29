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
      if (s.llm.provider === 'auto') {
        const list = (await require('./router').status(s)).filter((p) => p.enabled);
        const ready = list.filter((p) => p.configured && !p.resting);
        const resting = list.filter((p) => p.resting);
        const line = list.map((p) => `${p.name}: ${!p.configured ? 'not set up' : p.resting ? `skipped ${p.resting.minutes} min (${p.resting.reason})` : 'ready'}`).join(' · ');
        if (!ready.length) return { status: 'fail', detail: `Multi-provider mode, but no provider is ready. ${line}`, fix: resting.length ? 'Wait for the limits to reset, or add another provider in Settings → AI brain.' : 'Connect your Claude account or add an API key in Settings → AI brain.' };
        return { status: ready.length === 1 ? 'warn' : 'ok', detail: `Multi-provider: ${line}`, fix: ready.length === 1 ? 'Only one provider is ready, so there is nothing to fall back to. Add another key in Settings → AI brain.' : '' };
      }
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
    check('tts', 'Voice output', async () => {
      if (!s.voice.ttsEnabled) return { status: 'off', detail: 'Disabled.' };
      if (s.voice.engine === 'local') return { detail: 'The offline voice (Kokoro, runs in the app; downloaded once on first use).' };
      if (s.voice.engine === 'cloud') {
        const openai = s.cloudVoice?.provider === 'openai';
        if (!(openai ? s.cloudVoice?.apiKey : s.groq?.apiKey)) return { status: 'fail', detail: `The cloud voice (${openai ? 'OpenAI' : 'Groq'}) has no API key.`, fix: 'Add it in Settings → Voice output.' };
        return { detail: `The cloud voice: ${openai ? 'OpenAI' : 'Groq (Orpheus)'}, voice ${s.cloudVoice?.voice || 'default'}.` };
      }
      const p = await voice.ping();
      const fallback = { local: 'the offline voice', system: 'the system voice' }[s.voice.fallback];
      if (!p.ok) return { status: fallback ? 'warn' : 'fail', detail: `VoiceStudio is unreachable at ${s.voice.baseUrl}.${fallback ? ` Using ${fallback} as fallback.` : ''}`, fix: require('./helperapps').installedPath('voicestudio', s) ? 'Start it from Settings → Helper apps (or ask me to); Siren starts it by itself when "Start with Siren" is on.' : 'Start VoiceStudio, or correct its URL in Settings → Voice output.' };
      const t0 = Date.now();
      try {
        await voice.speak('ok');
      } catch (err) {
        return { status: fallback ? 'warn' : 'fail', detail: `VoiceStudio answers but synthesis fails: ${err.message}${fallback ? ` (using ${fallback} meanwhile)` : ''}`, fix: 'Check the voice id and model in Settings → Voice output, or restart VoiceStudio.' };
      }
      return { detail: `${s.voice.baseUrl} · voice "${s.voice.voice || 'default'}" · synthesis ${Date.now() - t0} ms` };
    }),
    check('stt', 'Voice input', async () => {
      if (!s.stt.enabled) return { status: 'off', detail: 'Disabled.' };
      if (s.stt.engine === 'remote' && !(s.stt.remoteUrl || s.llm.baseUrl)) return { status: 'fail', detail: 'No transcription URL configured.', fix: 'Settings → Voice input.' };
      if ((s.stt.engine === 'groq' || s.stt.cloudFallback) && !s.groq?.apiKey) return { status: s.stt.engine === 'groq' ? 'fail' : 'warn', detail: 'Cloud speech-to-text (Groq) has no API key.', fix: 'Settings → Voice input → Get a free key.' };
      return { detail: `${s.stt.engine === 'local' ? `Local Whisper (${s.stt.localModel})${s.stt.cloudFallback ? ', Groq as fallback' : ''}` : s.stt.engine === 'groq' ? `Groq Whisper (${s.stt.groqModel || 'whisper-large-v3-turbo'})` : `Remote ${s.stt.remoteUrl || s.llm.baseUrl}`} · ${s.stt.micMode === 'open' ? 'hands-free' : `push-to-talk (${s.stt.pttKey})`}${s.stt.micDevice ? ` · mic "${s.stt.micDevice}"` : ''}` };
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
    check('calendar', 'Schedule', async () => {
      if (!s.calendar.enabled) return { status: 'off', detail: 'Disabled.' };
      const st = await calendar.status();
      if (!st.vault) return { status: 'warn', detail: 'The schedule lives in the vault, which is off.', fix: 'Settings → Vault → turn it on.' };
      const ev = await calendar.events();
      const detail = `${calendar.FILE} · ${st.recurring} repeating, ${st.events} single · ${ev.length} in the next days`;
      if (st.problems) return { status: 'warn', detail: `${detail} · ${st.problems} unreadable line(s)`, fix: 'Ask the agent to fix them (calendar_list_entries shows which), or correct them in Obsidian.' };
      return { detail };
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
      if (!chk.ok) return { status: 'fail', detail: `Code fails its checks (syntax or integrity):\n${chk.output.slice(0, 800)}`, fix: 'Open Evolution and revert the last change, or run: npm run recover -- undo' };
      return { status: st.dirty?.length ? 'warn' : 'ok', detail: `History at ${st.head}${st.dirty?.length ? ` · ${st.dirty.length} uncommitted file(s)` : ''} · syntax and integrity checks pass`, fix: st.dirty?.length ? 'Evolution → Record or Discard the uncommitted changes.' : '' };
    }),
    check('lastchange', 'Last self-change', async () => {
      if (!s.code.allowSelfModify) return { status: 'off', detail: 'Disabled.' };
      const v = await selfchange.lastVerification();
      if (!v) return { status: 'off', detail: 'No self-change recorded yet.' };
      const when = new Date(v.at).toLocaleString();
      if (v.state === 'pending') return { status: 'warn', detail: `“${v.subject}” (${v.short}, ${when}) is not live yet.`, fix: v.restart ? 'Restart the app to load it.' : 'Reload the window to load it.' };
      if (v.state === 'problems') return { status: 'fail', detail: `“${v.subject}” (${v.short}) logged problems after it went live:\n${v.problems.map((p) => `${p.count}× ${p.event}: ${p.message.slice(0, 160)}${p.locations.length ? ` (${p.locations.join(', ')})` : ''}`).join('\n')}`, fix: 'Ask the assistant to fix it, or revert it in Evolution.' };
      return { detail: `“${v.subject}” (${v.short}) started cleanly.` };
    }),
    check('log', 'Recent problems', async () => {
      const groups = require('./errorinsight').fromLog({ sinceMs: 3600000, limit: 5 });
      if (!groups.length) return { detail: 'No errors or warnings in the last hour.' };
      const total = groups.reduce((n, g) => n + g.count, 0);
      const errors = groups.some((g) => g.level === 'error');
      return { status: errors ? 'fail' : 'warn', detail: `${total} in the last hour, ${groups.length} distinct:\n${groups.map((g) => `${g.count}× ${g.level} ${g.event}${g.where ? ` (${g.where})` : ''}: ${g.message.slice(0, 140)}${g.locations.length ? ` @ ${g.locations[0]}` : ''}`).join('\n')}`, fix: 'Ask the assistant to analyze its errors and fix the cause.' };
    }),
    check('disk', 'Disk space', async () => {
      const st = await fsp.statfs(store.dataDir());
      const freeGb = (st.bavail * st.bsize) / 1e9;
      const detail = `${freeGb.toFixed(1)} GB free where the app keeps its data`;
      if (freeGb < 0.3) return { status: 'fail', detail, fix: 'Free some disk space: settings, conversations and the log can no longer be saved reliably.' };
      if (freeGb < 2) return { status: 'warn', detail, fix: 'Free some disk space soon (speech models alone need up to 1.6 GB).' };
      return { detail };
    }),
    check('helperapps', 'Helper apps', async () => {
      const apps = (await require('./helperapps').status(s)).filter((a) => a.needed);
      if (!apps.length) return { status: 'off', detail: 'Neither VoiceStudio nor FreeLLMAPI is used with the current settings.' };
      const line = (a) => `${a.name}: ${a.status === 'running' ? 'running' : a.status === 'starting' ? 'starting…' : a.status === 'remote' ? `on another computer (${a.url})` : a.status === 'failed' ? `failed to start (${a.error})` : a.installedAt ? 'installed, not running' : 'not found on this computer'}`;
      const down = apps.filter((a) => a.local && !['running', 'starting'].includes(a.status));
      const auto = s.helperApps?.autoStart !== false;
      return {
        status: down.length ? 'warn' : 'ok',
        detail: `${apps.map(line).join(' · ')}${auto ? ' · started with Siren' : ''}`,
        fix: down.length ? (down.some((a) => a.installedAt) ? 'Settings → Helper apps → Start now (or ask me to start it).' : 'Install it, or set where it is in Settings → Helper apps.') : '',
      };
    }),
    check('remote', 'Remote access', async () => {
      if (!s.remote?.enabled) return { status: 'off', detail: 'Off. Nothing is reachable from other devices.' };
      const st = await require('./companion').status();
      const t = st.tunnel || {};
      const parts = [`${st.devices.length} paired device(s)`, st.lan ? 'local network (unencrypted)' : 'this computer only'];
      if (t.mode && t.mode !== 'off') parts.push(`${t.mode} tunnel ${t.connected ? 'connected' : 'not connected'}`);
      if (t.mode === 'quick') return { status: 'warn', detail: parts.join(' · '), fix: 'The temporary address is public and has no sign-in in front of it: turn it off when you are done testing, or use a Cloudflare tunnel with Access or Tailscale.' };
      if (t.mode === 'cloudflare' && !st.access) return { status: 'warn', detail: parts.join(' · '), fix: 'Put a Cloudflare Access application in front of the address and enter its team and AUD tag in Settings → Remote access.' };
      if (st.error) return { status: 'fail', detail: st.error };
      return { detail: parts.join(' · ') };
    }),
  ];
  const results = await Promise.all(checks);
  log.info('diagnostics', results.map((r) => `${r.id}:${r.status}`).join(' '));
  return results;
}

module.exports = { run };
