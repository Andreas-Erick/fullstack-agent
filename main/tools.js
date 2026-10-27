// Agent tools: definitions (JSON Schema) + executors. Provider adapters convert the definitions
// into OpenAI "functions", Anthropic "tools", or MCP tools (for the Claude account provider).
// The tools themselves live in main/tools/<group>.js; this file puts them into one list, adds the
// agent's own settings tools and the setup conversation's tools, and decides which are active.
const obsidian = require('./obsidian');
const approvals = require('./approvals');
const store = require('./store');
const log = require('./logger');
const github = require('./github');
const { FACES, obj, str, UNTRUSTED_NOTICE, requireApproval } = require('./tools/common');

// Settings the agent may change itself (to fix its own tools). Never safety, permissions, code
// access, document roots or secrets — the agent must not expand its own access.
const SETTABLE = {
  llm: ['baseUrl', 'model', 'temperature', 'maxTokens', 'historyLimit', 'modelMode', 'fastModel', 'deepModel', 'maxToolRounds', 'engineeringToolRounds'],
  claudeCode: ['model', 'effort', 'fastModel', 'deepModel', 'cliPath', 'idleMinutes'],
  anthropic: ['model', 'effort', 'fastModel', 'deepModel'],
  voice: ['ttsEnabled', 'autoSpeak', 'baseUrl', 'model', 'voice', 'speed', 'format', 'greetOnLaunch', 'thinkingSound', 'thinkingVolume', 'filler', 'fallback', 'localVoice'],
  stt: ['enabled', 'engine', 'localModel', 'remoteUrl', 'remoteModel', 'language', 'pttKey', 'autoSend', 'micMode', 'micDevice', 'headphones', 'vadSensitivity'],
  calendar: ['daysAhead'],
  routing: ['smart', 'cooldownMin'],
  gemini: ['model', 'fastModel', 'deepModel'],
  deepseek: ['model', 'fastModel', 'deepModel'],
  groq: ['model', 'fastModel', 'deepModel'],
  perplexity: ['model', 'fastModel', 'deepModel'],
  obsidian: ['injectIndex', 'maxIndexEntries'],
  journal: ['enabled', 'idleMinutes', 'handoffOnClose'],
  ui: ['showVisualizerInChat', 'captions', 'face', 'zoom', 'chatLayout', 'sleepAfterMin', 'fx'],
};
const SETTABLE_DESCRIPTION = () => Object.fromEntries(Object.entries(SETTABLE).map(([s, keys]) => [s, keys.join(',')]));
const SECRET_KEYS = /key|secret|token|password/i;

function redact(settings) {
  const out = JSON.parse(JSON.stringify(settings));
  for (const section of Object.values(out)) {
    if (!section || typeof section !== 'object') continue;
    for (const k of Object.keys(section)) if (SECRET_KEYS.test(k) && section[k]) section[k] = '(set, hidden)';
  }
  if (out.agent?.avatar) out.agent.avatar = '(image)';
  if (out.appearance?.theme) out.appearance.theme = `(theme "${out.appearance.theme.name}")`;
  if (out.personas) out.personas = require('./personacore').summary(settings.personas);
  return out;
}

// The agent's own settings: here, next to SETTABLE, which decides what settings_update may change.
const SETTINGS_TOOLS = [
  {
    name: 'settings_read',
    group: 'mechanic',
    description: 'Read your current configuration (secrets are hidden).',
    parameters: obj({}),
    run: async () => redact(await store.getSettings()),
  },
  {
    name: 'settings_update',
    group: 'mechanic',
    description: `Change one of your own settings to fix a problem (e.g. a wrong VoiceStudio URL or an unavailable model). Allowed: ${Object.entries(SETTABLE_DESCRIPTION()).map(([s, k]) => `${s}.{${k}}`).join(', ')}. You can never change safety, permissions, code access or secrets.`,
    parameters: obj({ section: str('Settings section, e.g. voice'), key: str('Key, e.g. baseUrl'), value: { type: ['string', 'number', 'boolean'], description: 'New value' } }, ['section', 'key', 'value']),
    run: async (a, ctx) => {
      if (!SETTABLE[a.section]?.includes(a.key)) throw new Error(`"${a.section}.${a.key}" cannot be changed by the agent.`);
      const s = await store.getSettings();
      const old = s[a.section][a.key];
      if (typeof old === 'number') a.value = Number(a.value);
      if (typeof old === 'boolean') a.value = a.value === true || a.value === 'true';
      await requireApproval(ctx, 'settings', `Change setting ${a.section}.${a.key}`, `${JSON.stringify(old)} → ${JSON.stringify(a.value)}`);
      await store.setSettings({ [a.section]: { [a.key]: a.value } });
      ctx.emit({ type: 'settings_changed' });
      return { changed: `${a.section}.${a.key}`, from: old, to: a.value };
    },
  },
];

// The groups, in the order the agent sees them.
const TOOLS = [
  ...require('./tools/memory'),
  ...require('./tools/stream'),
  ...require('./tools/calendar'),
  ...require('./tools/voice'),
  ...require('./tools/github'),
  ...require('./tools/vault'),
  ...require('./tools/web'),
  ...require('./tools/code'),
  ...require('./tools/mechanic'),
  ...require('./tools/guide'),
  ...require('./tools/browser'),
  ...require('./tools/learning'),
  ...require('./tools/world'),
  ...require('./tools/habits'),
  ...require('./tools/skilltree'),
  ...require('./tools/routines'),
  ...require('./tools/appearance'),
  ...require('./tools/documents'),
  ...require('./tools/skills'),
  ...require('./tools/screen'),
  ...SETTINGS_TOOLS,
];

// Claude Code brings its own file, edit and web tools, so those groups are not exposed to it.
// ------------------------------------------------------- first-run setup
// During the setup conversation the user is answering the agent's questions directly, so the agent
// may apply these settings without a separate approval. Secrets are never set through chat.
const SETUP_SETTABLE = [
  'agent.name', 'agent.personality', 'agent.aesthetic',
  'llm.baseUrl', 'voice.ttsEnabled', 'voice.autoSpeak', 'voice.baseUrl', 'voice.voice', 'voice.speed', 'voice.greetOnLaunch', 'voice.thinkingSound', 'voice.filler',
  'stt.enabled', 'stt.engine', 'stt.localModel', 'stt.micMode', 'stt.pttKey', 'stt.headphones', 'stt.language',
  'obsidian.enabled', 'obsidian.vaultPath', 'ui.face', 'ui.showVisualizerInChat',
  'safety.permissionMode', 'code.allowSelfModify', 'web.enabled', 'journal.enabled', 'llm.modelMode', 'llm.voiceUsesFast', 'calendar.enabled', 'documents.workspace',
];
const secretHint = (service) => (service === 'freellmapi' ? 'You find it in FreeLLMAPI’s configuration.' : 'You find it in VoiceStudio’s settings.');

const SETUP_TOOLS = [
  {
    name: 'setup_get_state',
    group: 'setup',
    description: 'Get the current configuration and what was detected (voices, existing Obsidian vaults, faces, brain, mic). Call this first, and again whenever you need to check something.',
    parameters: obj({}),
    run: async () => {
      const s = await store.getSettings();
      const voice = require('./voice');
      const [ping, voices, vaults, vaultNow, faces] = await Promise.all([
        voice.ping().catch(() => ({ ok: false })),
        voice.voices().catch(() => []),
        obsidian.knownVaults().catch(() => []),
        obsidian.vaultPath().catch(() => null),
        require('./faces').list().catch(() => []),
      ]);
      return {
        agent: { name: s.agent.name, usingDefaultPersona: s.agent.personality === store.DEFAULTS.agent.personality, personaPreview: s.agent.personality.slice(0, 300), aesthetic: s.agent.aesthetic, hasImage: Boolean(s.agent.avatar) },
        brain: { provider: s.llm.provider, modelMode: s.llm.modelMode },
        voiceOutput: { enabled: s.voice.ttsEnabled, url: s.voice.baseUrl, voiceStudioReachable: ping.ok, currentVoice: s.voice.voice || '(default)', availableVoices: voices.slice(0, 60).map((v) => v.id), note: ping.ok ? '' : `VoiceStudio is not reachable; ${{ local: 'the offline voice', system: 'the system voice', off: 'nothing' }[s.voice.fallback] || 'the offline voice'} is used meanwhile.` },
        voiceInput: { enabled: s.stt.enabled, engine: s.stt.engine, micMode: s.stt.micMode, pushToTalkKey: s.stt.pttKey, headphones: s.stt.headphones },
        vault: { current: vaultNow, isDefault: !s.obsidian.vaultPath, defaultPath: obsidian.defaultVaultPath(), existingObsidianVaults: vaults.filter((v) => v.exists).map((v) => v.path) },
        faces: [...FACES, ...faces.map((f) => f.id)],
        currentFace: s.ui.face,
        permissions: { mode: s.safety.permissionMode, selfModification: s.code.allowSelfModify },
        internet: s.web.enabled,
        calendar: { enabled: s.calendar.enabled, howItWorks: 'Nothing to connect: the user tells you their schedule (appointments, and repeating things like weekly lectures) and you keep it in Schedule.md in the vault. Mention that they can do this any time.' },
        journaling: s.journal.enabled,
        settableDuringSetup: SETUP_SETTABLE,
      };
    },
  },
  {
    name: 'setup_configure',
    group: 'setup',
    description: 'Apply one of the user\'s answers to your configuration. setting is "section.key" from settableDuringSetup (e.g. "agent.name", "stt.micMode" = ptt|open, "ui.face", "safety.permissionMode" = ask|auto, "obsidian.vaultPath" = "default" for your own vault). Confirm briefly after applying.',
    parameters: obj({ setting: str('section.key'), value: { type: ['string', 'number', 'boolean'], description: 'New value' } }, ['setting', 'value']),
    run: async (a, ctx) => {
      if (!SETUP_SETTABLE.includes(a.setting)) throw new Error(`"${a.setting}" can't be set during setup. Settable: ${SETUP_SETTABLE.join(', ')}`);
      const [section, key] = a.setting.split('.');
      const s = await store.getSettings();
      let value = a.value;
      const old = s[section][key];
      if (typeof old === 'number') value = Number(value);
      if (typeof old === 'boolean') value = value === true || value === 'true' || value === 'yes';
      if (a.setting === 'obsidian.vaultPath' && /^(default|own|)$/i.test(String(value ?? '').trim())) value = '';
      if (a.setting === 'documents.workspace' && value) {
        value = require('path').resolve(String(value).replace(/^~(?=$|[/\\])/, require('os').homedir()));
        const st = await require('fs').promises.stat(value).catch(() => null);
        if (!st?.isDirectory()) throw new Error(`There is no folder at ${value}. Ask the user for the exact path, or to pick it in Settings → Documents.`);
      }
      if (a.setting === 'ui.face' && !FACES.includes(value) && !String(value).startsWith('custom:')) throw new Error(`Unknown face. Use one of: ${FACES.join(', ')}`);
      if (a.setting === 'stt.micMode' && !['ptt', 'open'].includes(value)) throw new Error('micMode must be "ptt" or "open"');
      if (a.setting === 'safety.permissionMode' && !['ask', 'auto'].includes(value)) throw new Error('permissionMode must be "ask" or "auto"');
      await store.setSettings({ [section]: { [key]: value } });
      log.info('setup configured', { setting: a.setting, value: typeof value === 'string' ? value.slice(0, 80) : value });
      ctx.emit({ type: 'settings_changed' });
      return { set: a.setting, value: typeof value === 'string' && value.length > 120 ? `${value.slice(0, 120)}…` : value };
    },
  },
  {
    name: 'setup_profile',
    group: 'setup',
    description: `Write what the user tells you about themselves into their Profile (sections: ${obsidian.PROFILE_SECTIONS.join(', ')}). Use their words; keep it short.`,
    parameters: obj({ section: { type: 'string', enum: obsidian.PROFILE_SECTIONS }, content: str('What to add') }, ['section', 'content']),
    run: async (a, ctx) => {
      const r = await obsidian.updateProfile(a.section, a.content, 'append', { anySection: true });
      ctx.emit({ type: 'vault_changed', path: 'Profile.md' });
      return r;
    },
  },
  {
    name: 'setup_generate_look',
    group: 'setup',
    description: 'Redesign the whole app (colors, fonts, background, face, greeting, voice) to match the persona and aesthetic currently configured. Takes up to a minute. Use after setting agent.aesthetic (and optionally an image).',
    parameters: obj({}),
    run: async (_a, ctx) => {
      const s = await store.getSettings();
      const voices = (await require('./voice').voices().catch(() => [])).map((v) => v.id);
      const persona = require('./persona');
      const res = await persona.generate({ masterPrompt: s.agent.personality, aesthetic: s.agent.aesthetic, palette: [], voices, image: s.agent.avatar, options: persona.DEFAULT_OPTIONS });
      await store.setSettings({ appearance: { theme: res.theme, personaNotes: res.personaNotes, greeting: res.greeting } });
      if (res.voice && s.appearance.applyVoice) await store.setSettings({ voice: { voice: res.voice } });
      ctx.emit({ type: 'settings_changed' });
      return { applied: res.theme?.name, greeting: res.greeting, voice: res.voice || 'unchanged' };
    },
  },
  {
    name: 'setup_add_persona',
    group: 'setup',
    description: 'Add a ready-made persona the user can switch to later from the title bar (it does not change who you are now): "stem-tutor" (Ada: understanding, math, proofs), "polyglot-coach" (Mira: languages), "life-coach" (Sol: goals and habits). Offer the ones that fit what the user wants to use you for.',
    parameters: obj({ template: { type: 'string', enum: ['stem-tutor', 'polyglot-coach', 'life-coach'], description: 'Which template' } }, ['template']),
    run: async (a, ctx) => {
      const s = await require('./persona').create({ template: a.template, activate: false });
      ctx.emit({ type: 'settings_changed' });
      return { added: s.personas.list[s.personas.list.length - 1]?.name, personas: s.personas.list.map((x) => x.name), active: s.agent.name };
    },
  },
  {
    name: 'setup_pick_image',
    group: 'setup',
    description: "Open a file picker on the user's screen so they can choose an image (avatar) for you. Only after they said they want to.",
    parameters: obj({}),
    run: async (_a, ctx) => {
      ctx.emit({ type: 'setup_pick_image' });
      return { opened: true, note: 'A file picker is open on the user’s screen. Ask them to choose an image (or cancel).' };
    },
  },
  {
    name: 'setup_check_service',
    group: 'setup',
    description:
      'Check whether FreeLLMAPI or VoiceStudio is connected, and get a diagnosis plus step-by-step help (about, steps, laterIn). Pass url to try a different address — if it works there, it is saved. Use the steps to guide the user one step per message.',
    parameters: obj({ service: { type: 'string', enum: ['freellmapi', 'voicestudio'] }, url: str('Address to try (optional), e.g. http://localhost:3001/v1') }, ['service']),
    run: async (a, ctx) => {
      const r = await require('./services').check(a.service, { url: a.url });
      // Save the address whenever the service answers there (even if it still needs a key or a model).
      const reachable = !['unreachable', 'timeout', 'not_found'].includes(r.status);
      if (reachable && a.url) {
        await store.setSettings(a.service === 'freellmapi' ? { llm: { baseUrl: r.url } } : { voice: { baseUrl: r.url, ttsEnabled: true } });
        ctx.emit({ type: 'settings_changed' });
        r.saved = true;
      }
      log.info('setup service check', { service: a.service, url: r.url, status: r.status });
      return r;
    },
  },
  {
    name: 'setup_request_secret',
    group: 'setup',
    description:
      'Open a secure, masked input in the app for a FreeLLMAPI token or VoiceStudio API key. The user types it there (never in chat); it is stored encrypted and you never see it. Afterwards, call setup_check_service again.',
    parameters: obj({ service: { type: 'string', enum: ['freellmapi', 'voicestudio'] } }, ['service']),
    run: async (a, ctx) => {
      const label = a.service === 'freellmapi' ? 'FreeLLMAPI bearer token' : 'VoiceStudio API key';
      const value = await approvals.askSecret({ label, hint: `Stored encrypted on this computer. ${secretHint(a.service)}` });
      if (value == null) return { saved: false, note: 'The user cancelled or did not enter anything.' };
      await store.setSettings(a.service === 'freellmapi' ? { llm: { apiKey: value } } : { voice: { apiKey: value } });
      ctx.emit({ type: 'settings_changed' });
      return { saved: true };
    },
  },
  {
    name: 'setup_register_vault',
    group: 'setup',
    description: "Add your vault to Obsidian's vault list so it opens directly in the Obsidian app. Ask the user first; Obsidian must be closed.",
    parameters: obj({}),
    run: async () => obsidian.registerVault(),
  },
  {
    name: 'setup_scan_hardware',
    group: 'setup',
    description: "Optional hardware check (only if the user agrees): processor, memory and graphics card, with recommendations for the speech model and whether a local or a cloud brain fits this computer. Apply a recommendation only after the user says yes (stt.localModel via setup_configure).",
    parameters: obj({}),
    run: async () => require('./hardware').scan(),
  },
  {
    name: 'setup_complete',
    group: 'setup',
    description: 'Finish the first-run setup once the interview is done (after running diagnose). Give a short summary of what was configured.',
    parameters: obj({ summary: str('What was configured, in a few lines') }, ['summary']),
    run: async (a, ctx) => {
      await store.setSettings({ onboarded: true });
      log.info('setup complete', a.summary);
      ctx.emit({ type: 'setup_complete', summary: a.summary });
      return { done: true };
    },
  },
];
TOOLS.push(...SETUP_TOOLS);

// Tools available in the setup conversation.
const SETUP_EXTRA = ['memory_save', 'priorities_update', 'diagnose', 'voice_calibrate', 'app_guide', 'habit_add', 'routine_save', 'skilltree_update', 'setup_add_persona'];

const NATIVE_IN_CLAUDE_CODE = ['code', 'selfmod', 'web'];

async function activeTools(settings, { setup = false } = {}) {
  if (setup) return TOOLS.filter((t) => t.group === 'setup' || SETUP_EXTRA.includes(t.name));
  const gh = settings.github?.enabled !== false ? await github.status().catch(() => ({})) : {};
  const vault = await obsidian.vaultPath().catch(() => null);
  const viaClaudeCode = settings.llm.provider === 'claude-code';
  return TOOLS.filter((t) => {
    if (t.group === 'setup') return false;
    // Claude Code edits with its own tools, but still states its plan for approval first.
    if (viaClaudeCode && NATIVE_IN_CLAUDE_CODE.includes(t.group) && t.name !== 'self_change_plan') return false;
    if (t.group === 'calendar') return settings.calendar.enabled && Boolean(vault);
    if (t.group === 'voice') return settings.voice.ttsEnabled;
    if (t.group === 'listening') return settings.stt.enabled;
    if (t.group === 'github') return settings.github?.enabled !== false && gh.connected;
    if (t.group === 'vault' || t.group === 'learning' || t.group === 'habits' || t.group === 'skilltree' || t.group === 'rehearsal') return Boolean(vault);
    if (t.group === 'stream') return Boolean(vault) && settings.memory?.stream !== false;
    if (t.group === 'world') return Boolean(vault) && Boolean(settings.innerWorld?.enabled);
    if (t.group === 'practice') return settings.stt.enabled || settings.voice.ttsEnabled;
    if (t.group === 'code' || t.group === 'engineering') return settings.code.enabled;
    if (t.group === 'selfmod' || t.group === 'engineering_run') return settings.code.enabled && settings.code.allowSelfModify;
    if (t.group === 'web') return settings.web.enabled;
    if (t.group === 'connectors') return viaClaudeCode || settings.llm.provider === 'auto';
    if (t.group === 'globe') return Boolean(settings.extensions?.godseye);
    if (t.group === 'browser') return settings.agentWindow?.enabled !== false;
    return true;
  });
}

function execute(name, args, ctx) {
  return log.withContext(ctx.logTags || {}, () => executeTool(name, args, ctx));
}

async function executeTool(name, args, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    log.warn('tool unknown', { name });
    return { ok: false, result: { error: `Unknown tool "${name}"` } };
  }
  ctx.turn ||= approvals.newTurn();
  const started = Date.now();
  try {
    let result = await tool.run(args || {}, ctx);
    // Images (look_at_screen) travel next to the result, never inside its text.
    const image = result?.__image;
    if (image) delete result.__image;
    if (tool.untrusted) {
      approvals.markTainted(ctx.turn, `${name} ${args?.url || args?.path || args?.query || ''}`);
      result = { notice: UNTRUSTED_NOTICE, content: result };
    }
    log.info('tool', { name, ok: true, ms: Date.now() - started, args: JSON.stringify(args || {}).slice(0, 300) });
    return { ok: true, result, ...(image ? { image } : {}) };
  } catch (err) {
    // Declined approvals are normal outcomes; everything else is logged with its stack.
    const declined = /^Not approved by the user/.test(err.message);
    log[declined ? 'info' : 'warn'](declined ? 'tool declined' : 'tool failed', { name, ms: Date.now() - started, args: JSON.stringify(args || {}).slice(0, 300), error: declined ? err.message : err });
    return { ok: false, result: { error: err.message } };
  }
}

function stringifyResult(result) {
  const s = typeof result === 'string' ? result : JSON.stringify(result, null, 1);
  return s.length > 60000 ? `${s.slice(0, 60000)}\n…[truncated]` : s;
}

module.exports = { TOOLS, activeTools, execute, stringifyResult };
