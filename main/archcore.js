// The architecture map's pure part (no files, no Electron): what the app is made of and how the parts
// talk, as a C4-style model (context → containers → components → code) for the Architecture view
// (renderer/js/archmap.js). archmap.js reads the code and hands each file's facts to build() here.
// The knowledge below is curated (names, groupings, lessons), the rest is found in the code: a file no
// rule claims becomes a component of its own (marked `auto`), and connections come from imports, IPC
// calls, pushed events and the detection patterns in EXTERNALS, so a rebuild follows the code.

// ------------------------------------------------------------ containers (C4 level 2)
// row: top-to-bottom band; anchor: the row's centerpiece; tone: a theme token (renderer maps it to a color).
const CONTAINERS = [
  { id: 'user', kind: 'actor', row: 0, anchor: true, tone: 'text', name: 'You', tech: 'Person', about: 'The person using Nexus: in the desktop app, on the phone, or watching the agent window.' },
  { id: 'windows', row: 1, tone: 'c2', name: 'Pop-out windows', tech: 'Electron windows', match: ['renderer/viewer.html', 'renderer/js/viewer.js', 'renderer/agentwindow.html', 'renderer/js/agentwindow.js', 'virtual/'], about: 'Second windows: the document viewer and the agent window, whose web page runs in a sandboxed view with no access to the app.' },
  { id: 'desktop', row: 1, anchor: true, tone: 'c1', name: 'Desktop UI', tech: 'Electron renderer · ES modules', match: ['renderer/'], about: 'The main window: chat, voice, the face and every view. A web page without Node access; it reaches the rest of the app only through the preload bridge.', lesson: 'The UI is treated as untrusted: it can render anything (Markdown from the model, web content) so it gets no powers of its own. Everything it can do is a named request to the main process.' },
  { id: 'phone', row: 1, tone: 'c2', name: 'Phone client', tech: 'Plain web app (PWA)', match: ['renderer/remote/'], about: 'The remote client served by the companion server: chat, approvals and push-to-talk from a paired phone.', lesson: 'A second client reuses the same core through a narrow HTTP API instead of a copy of the app. Devices get trimmed data (tool names, never inputs or results).' },
  { id: 'android', row: 1, tone: 'c2', name: 'Android app', tech: 'Java · WebView', match: ['android/'], about: 'A thin native shell around the phone client, with notifications, a quick-settings talk tile and a background connection.' },
  { id: 'preload', row: 2, anchor: true, tone: 'c2', name: 'Preload bridge', tech: 'contextBridge', match: ['preload.js'], about: 'The only door between the UI and the main process: a fixed list of IPC channels exposed as api.ns.method().', lesson: 'One small, explicit surface is easy to audit. Adding a capability means adding it here on purpose; nothing leaks by accident.' },
  { id: 'quality', row: 3, tone: 'ok', name: 'Build & quality', tech: 'Node scripts · node:test', match: ['scripts/', 'test/'], about: 'Syntax and integrity checks (scripts/verify.js) and the offline test suite. Self-changes are recorded only when both pass.', lesson: 'Rules that live only in documentation get broken. Turning cross-file contracts (IPC handler ↔ preload channel ↔ renderer call) into automatic checks keeps a fast-changing codebase honest.' },
  { id: 'main', row: 3, anchor: true, tone: 'c1', name: 'Main process', tech: 'Electron main · Node (CommonJS)', match: ['main/'], about: 'The core: windows, IPC handlers, the agent loop and its tools, storage, permissions and every integration.', lesson: 'Privileged work happens in one process with clear modules around it. Each module owns one concern and talks to the others through plain function calls.' },
  { id: 'mcp', row: 3, tone: 'c3', name: 'MCP tool server', tech: 'Node child process · JSON-RPC', match: ['main/mcp-server.js'], about: 'Launched by the Claude Code CLI; offers the app’s tools to Claude by forwarding each call to the app’s local tool bridge.', lesson: 'A tiny process with no logic of its own: it translates one protocol (MCP over stdio) into another (HTTP to the app), so the tools and their permission checks stay in one place.' },
  { id: 'ext-web', kind: 'external', row: 4, tone: 'c3', name: 'Websites & web APIs', tech: 'HTTPS', about: 'Web search, pages the agent reads, GitHub downloads for skills, the speed test.' },
  { id: 'ext-git', kind: 'external', row: 4, tone: 'c3', name: 'git & GitHub CLI', tech: 'Child processes', about: 'The code history behind self-changes, vault versions, and GitHub work through the user’s gh CLI.' },
  { id: 'ext-os', kind: 'external', row: 4, tone: 'c3', name: 'Operating system', tech: 'PowerShell · nvidia-smi · OS APIs', about: 'Hardware readings, notifications, screen capture and processes.' },
  { id: 'ext-llm', kind: 'external', row: 4, anchor: true, tone: 'c3', name: 'AI model APIs', tech: 'HTTPS · SSE', about: 'Anthropic, and OpenAI-compatible providers (FreeLLMAPI, Gemini, DeepSeek, Groq, Perplexity).' },
  { id: 'ext-claude', kind: 'external', row: 4, tone: 'c3', name: 'Claude Code CLI', tech: 'Child process · stream-json', about: 'The user’s own Claude Code, run headless as the “Claude account” brain.' },
  { id: 'ext-voice', kind: 'external', row: 4, tone: 'c3', name: 'VoiceStudio', tech: 'Local HTTP server', about: 'The natural voice: text to speech and voice creation, on this computer.' },
  { id: 'ext-tunnel', kind: 'external', row: 4, tone: 'c3', name: 'Tunnels', tech: 'cloudflared · Tailscale', about: 'HTTPS from anywhere for the phone client, through the user’s own tunnel.' },
  { id: 'ext-vault', kind: 'external', row: 5, anchor: true, tone: 'ok', name: 'Obsidian vault', tech: 'Markdown files', about: 'Memory, notes, schedule, habits, learning trackers and decks: plain Markdown the user owns and can edit in Obsidian.', lesson: 'Plain files as the database: human-readable, editable by hand, versioned with git, and still there if the app is gone.' },
  { id: 'ext-data', kind: 'external', row: 5, tone: 'ok', name: 'App data folder', tech: 'JSON files', about: 'Settings (secrets encrypted), conversations, routines, caches and the log, in the app’s userData folder.' },
];

// Detected connections to the outside: a main-process file whose code (comments removed) matches
// `test` gets an edge of `kind` to the external container (`except`: files that only name it, like a
// default setting).
const EXTERNALS = [
  { id: 'ext-llm', kind: 'http', test: /@anthropic-ai\/sdk|chat\/completions/ },
  { id: 'ext-claude', kind: 'process', test: /stream-json/ },
  { id: 'ext-voice', kind: 'http', test: /audio\/(?:speech|voices)/ },
  { id: 'ext-web', kind: 'http', test: /duckduckgo|api\.github\.com|raw\.githubusercontent|speed\.cloudflare|searx/i, except: ['main/store.js', 'main/agentwindowcore.js'] },
  { id: 'ext-git', kind: 'process', test: /(?:execFile|spawn)\(\s*'git'|run\('(?:git|gh)'|\bgit\(\[|\bgh\(\[|'gh',\s*\[/ },
  { id: 'ext-os', kind: 'process', test: /powershell\.exe|nvidia-smi|desktopCapturer|new Notification\(|tasklist|os\.cpus\(\)/ },
  { id: 'ext-tunnel', kind: 'process', test: /cloudflared|tailscale serve|'tailscale'/i, except: ['main/store.js'] },
  { id: 'ext-vault', kind: 'fs', test: /\bvaultPath\(|\bvaultDir\(/ },
  { id: 'ext-data', kind: 'fs', test: /getPath\('userData'\)|dataDir\(\)/ },
];

// Connections no static scan can see (a process launch, a URL in an environment variable…).
const LINKS = [
  { from: 'c:user', to: 'renderer/index.html', kind: 'user', label: 'chats, talks, clicks' },
  { from: 'c:user', to: 'renderer/remote/index.html', kind: 'user', label: 'uses on the phone' },
  { from: 'c:user', to: 'renderer/agentwindow.html', kind: 'user', label: 'watches or browses' },
  { from: 'main/main.js', to: 'renderer/index.html', kind: 'process', label: 'creates the window' },
  { from: 'main/docwindows.js', to: 'renderer/viewer.html', kind: 'process', label: 'opens document windows' },
  { from: 'main/agentwindow.js', to: 'renderer/agentwindow.html', kind: 'process', label: 'opens the agent window' },
  { from: 'main/agentwindow.js', to: 'virtual/webpage', kind: 'process', label: 'shows the site in a sandboxed view, reads it with injected scripts' },
  { from: 'c:ext-claude', to: 'main/mcp-server.js', kind: 'process', label: 'launches it, speaks MCP (JSON-RPC over stdio)' },
  { from: 'main/mcp-server.js', to: 'main/bridge.js', kind: 'http', label: 'tool calls on a loopback port with a secret token' },
  { from: 'renderer/remote/app.js', to: 'main/companion.js', kind: 'http', label: 'HTTPS + server-sent events, with a device token' },
  { from: 'android/app/src/main/java/com/nexusagent/android/MainActivity.java', to: 'renderer/remote/index.html', kind: 'process', label: 'hosts the phone client in a WebView' },
  { from: 'main/companion.js', to: 'c:ext-tunnel', kind: 'http', label: 'reached from anywhere through the tunnel' },
];

// Descriptions for files whose own first comment doesn't describe them (pages, the main stylesheet).
const FILE_ABOUT = {
  'renderer/index.html': 'The main window’s static layout: title bar, navigation rail and one <section> per view. Its Content Security Policy allows no outside scripts.',
  'renderer/styles.css': 'All styles. Colors, fonts and radius are theme tokens (CSS variables) that the theme engine sets from the persona.',
  'renderer/viewer.html': 'The pop-out document window.',
  'renderer/agentwindow.html': 'The agent window’s toolbar and the frame around the web page.',
  'renderer/remote/index.html': 'The phone client’s page, served by the companion server.',
};

// Files that aren't code on disk but belong on the map.
const VIRTUAL = [{ path: 'virtual/webpage', about: 'Any website, in its own sandboxed view: no preload, its own session, no camera, microphone, downloads or local-network access.', lines: 0, symbols: [] }];

// ------------------------------------------------------------ components (C4 level 3)
const m = (...n) => n.map((x) => `main/${x}.js`);
const r = (...n) => n.map((x) => (x.endsWith('/') ? `renderer/js/${x}` : `renderer/js/${x}.js`));

const COMPONENTS = [
  // Main process
  { id: 'shell', container: 'main', name: 'App shell & IPC', files: m('main', 'logger', 'envinfo', 'diagnostics', 'errorinsight', 'services'), about: 'The composition root: creates the windows, registers every IPC handler and wires the modules together; plus the log and health checks.', lesson: 'Composition root: one place knows how everything is assembled, so the modules themselves stay unaware of each other’s setup and are easy to test alone.' },
  { id: 'brain', container: 'main', name: 'Agent brain', files: m('llm', 'router', 'prompt', 'engineering'), about: 'The agent loop: builds the prompt, calls a model provider, runs the tools it asks for and streams the answer. The router picks and falls back between providers.', lesson: 'Adapters (ports & adapters): every provider is wrapped to look the same to the loop, so adding one or falling back after a rate limit changes nothing upstream.' },
  { id: 'tools', container: 'main', name: 'Tools & permissions', files: m('tools', 'approvals', 'capabilities', 'guide'), about: 'Everything the agent can do, as tools with a JSON Schema, and the permission gate every consequential action passes through.', lesson: 'One choke point for risk: tools call requireApproval() instead of each deciding alone, and anything from outside (web pages, screenshots) taints the turn.' },
  { id: 'claude', container: 'main', name: 'Claude Code bridge', files: m('claudecode', 'bridge', 'connectors', 'extensions', 'claudeusage'), about: 'Runs the Claude Code CLI as a brain, gives it the app’s tools through the MCP server and a loopback bridge, and adds connectors and extensions.', lesson: 'Anti-corruption layer: an external tool with its own protocol is wrapped so the rest of the app sees ordinary turns, tools and approvals.' },
  { id: 'knowledge', container: 'main', name: 'Memory & vault', files: m('memory', 'obsidian', 'vaultgit', 'notelock', 'journal', 'handoff'), about: 'Long-term memory and the Obsidian vault: notes, daily journal, profile and priorities, versioned with git, one write at a time per note.', lesson: 'Serialize writers: a per-note lock (notelock) turns racing read-modify-write updates into a queue, which is simpler than merging.' },
  { id: 'documents', container: 'main', name: 'Documents & output', files: m('documents', 'files', 'diagrams', 'pdf', 'docwindows'), about: 'Opening and reading documents with path checks, saving diagrams, PDF export, document windows.' },
  { id: 'web', container: 'main', name: 'Web access', files: m('websearch'), about: 'Search and page fetching for the agent, with private-network addresses blocked.' },
  { id: 'schedule', container: 'main', name: 'Schedule & routines', files: m('calendar', 'schedulecore', 'routines', 'routinecore'), about: 'The schedule as Schedule.md in the vault, and routines: agent runs on a timer, each in its own conversation.' },
  { id: 'growth', container: 'main', name: 'Learning & growth', files: m('learning', 'learningcore', 'srs', 'habits', 'habitcore', 'skilltree', 'skilltreecore'), about: 'Understanding trackers, vocabulary decks with spaced repetition, habits and the skill tree, all in the vault.', lesson: 'Functional core, imperative shell: the rules (streaks, SM-2 scheduling, prerequisites) live in pure *core.js modules that are trivial to test; thin wrappers do the file I/O.' },
  { id: 'innerworld', container: 'main', name: 'Memory stream & Inner World', files: m('stream', 'streamcore', 'innerworld', 'worldcore', 'rehearsal', 'rehearsalcore'), about: 'The memory stream (observations and reflections, recalled by recency + importance + relevance), the personas’ village whose buildings grow with real progress, and rehearsals of real conversations with independent characters.', lesson: 'Borrow the idea, not the runtime: the Generative Agents memory architecture, Concordia’s narrator and TinyTroupe’s persona simulations are rebuilt as small pure modules on top of what the app already has (the vault, the model call, the stream), instead of running three Python projects beside it.' },
  { id: 'personas', container: 'main', name: 'Personas & look', files: m('persona', 'personacore', 'personatemplates', 'faces'), about: 'Saved personas (prompt, theme, face, voice) and switching between them; custom faces.' },
  { id: 'voice', container: 'main', name: 'Voice', files: m('voice', 'voicestudio', 'calibration'), about: 'Text to speech through VoiceStudio, voice creation, and calibration of how the user’s words come through.' },
  { id: 'selfevo', container: 'main', name: 'Self-evolution', files: m('selfchange', 'codebase', 'codemap', 'archcore', 'archmap', 'github'), about: 'The agent reading and changing its own code: every change checked, tested and recorded in git; the code map and this architecture map.', lesson: 'Make every change reversible: with each change committed and checked first, trying things is cheap and a bad change is one revert away.' },
  { id: 'windows', container: 'main', name: 'Windows & screen', files: m('agentwindow', 'agentwindowcore', 'screenshare'), about: 'The agent window (a browser the agent drives) and screen sharing started by the user.' },
  { id: 'remote', container: 'main', name: 'Remote access', files: m('companion', 'tunnel'), about: 'The companion server for paired phones (HTTP + SSE, pairing, tokens) and secure tunnels.', lesson: 'Defense in depth at the edge: Host/Origin checks, a token on every route, a narrow route list and trimmed data. Each layer assumes the one before it might fail.' },
  { id: 'system', container: 'main', name: 'System & performance', files: m('sysmon', 'netspeed', 'hardware', 'helperapps', 'resources', 'perfcore'), about: 'The title-bar system monitor and what Nexus itself uses, the speed test, the hardware scan, the performance profile (fewer Claude sessions on lighter computers) and starting the helper apps.', lesson: 'Adapt to the machine instead of assuming yours: measure what is expensive, then let a profile scale the costly parts (model size, effects, processes) while the features stay the same.' },
  { id: 'skills', container: 'main', name: 'Skills', files: m('skills', 'skillimport'), about: 'Reusable workflows (Agent Skills folders) and importing them from GitHub.' },
  { id: 'storage', container: 'main', name: 'Settings & conversations', files: m('store'), about: 'Settings with defaults and encrypted secrets, and conversation history, behind a per-file write queue with backups.', lesson: 'Defaults in one place (DEFAULTS) and an allowlist (SETTABLE) of what the agent may change: the safe set is explicit.' },
  // Desktop UI
  { id: 'ui-shell', container: 'desktop', name: 'App shell', files: [...r('app', 'nav', 'state', 'util', 'layout', 'hud'), 'renderer/index.html', 'renderer/styles.css', 'renderer/hud.css'], about: 'Boot and wiring, navigation between views, shared state, helpers, layouts and the HUD layer.', lesson: 'An event bus (on/emit) lets views react to each other without importing each other.' },
  { id: 'ui-chat', container: 'desktop', name: 'Chat', files: r('chat', 'approval', 'commands', 'handoff', 'mathtext'), about: 'The conversation: streaming replies, tool chips, approvals, voice commands and formulas.' },
  { id: 'ui-voice', container: 'desktop', name: 'Voice I/O', files: r('voice', 'bargein', 'pcm-worklet', 'vad-worker', 'stt-worker', 'tts-worker', 'kokorotext', 'sounds', 'practice'), about: 'Microphone capture, voice detection, local speech recognition and the offline voice, in workers off the UI thread.', lesson: 'Heavy work (speech models) runs in Web Workers so the UI never stutters; the main thread only passes messages.' },
  { id: 'ui-face', container: 'desktop', name: 'Face & theme', files: [...r('visualizer', 'theme', 'themecore', 'faces/'), 'renderer/faces/'], about: 'The animated faces and the theme engine that turns a persona’s aesthetic into CSS variables.', lesson: 'Faces read the app only through a small env interface, so the same modules run on the phone too.' },
  { id: 'ui-views', container: 'desktop', name: 'Views', files: r('memory', 'calendar', 'knowledge', 'docs', 'docview', 'skills', 'habits', 'skilltree', 'innerworld', 'evolution', 'archmap', 'personas'), about: 'One module per view: memory, calendar, vault, documents, skills, habits, skill tree, evolution, architecture.' },
  { id: 'ui-settings', container: 'desktop', name: 'Settings & setup', files: r('settings', 'onboarding', 'setup', 'hwscan', 'perf', 'perfcore'), about: 'Configuration, the first-run wizard and the setup conversation.' },
  { id: 'ui-titlebar', container: 'desktop', name: 'Title bar', files: r('sysmon', 'usage', 'remote', 'qr'), about: 'The pills in the title bar: system monitor, Claude usage, remote access and pairing QR code.' },
  // Other containers
  { id: 'viewer', container: 'windows', name: 'Document viewer', files: ['renderer/viewer.html', 'renderer/js/viewer.js'], about: 'A pop-out window that shows one document.' },
  { id: 'awbar', container: 'windows', name: 'Agent window toolbar', files: ['renderer/agentwindow.html', 'renderer/js/agentwindow.js'], about: 'The address bar and frame Nexus draws around the page.' },
  { id: 'webpage', container: 'windows', name: 'Web page (sandboxed)', files: ['virtual/webpage'], about: 'The site itself, isolated from the app.', lesson: 'Least privilege: the page gets no preload, its own session and no device permissions, so a hostile site can’t reach the app or the network behind it.' },
  { id: 'remote-app', container: 'phone', name: 'Phone web app', files: ['renderer/remote/'], about: 'Plain files, no build step, its own Content Security Policy.' },
  { id: 'android-shell', container: 'android', name: 'Native shell', files: ['android/'], about: 'Activity, background service, notifications and the talk tile.' },
  { id: 'bridge', container: 'preload', name: 'IPC channels', files: ['preload.js'], about: 'The channel list and the api object the UI calls.' },
  { id: 'mcp-server', container: 'mcp', name: 'Protocol translator', files: ['main/mcp-server.js'], about: 'MCP over stdio in, HTTP to the tool bridge out.' },
  { id: 'tests', container: 'quality', name: 'Tests', files: ['test/'], about: 'node:test suites, offline, with Electron stand-ins (test/helpers.js).' },
  { id: 'scripts', container: 'quality', name: 'Checks & scripts', files: ['scripts/'], about: 'Syntax check, cross-file integrity (verify.js), the test runner and recovery.' },
];

// ------------------------------------------------------------ design principles (the Learn panel)
const PRINCIPLES = [
  { id: 'isolation', title: 'Isolate by privilege, connect through one door', idea: 'Code that renders untrusted content (the UI, web pages) runs in sandboxed processes with no powers. A single bridge with a fixed list of channels connects it to the privileged core.', why: 'If the UI is compromised (a malicious Markdown reply, a hostile site), the damage stops at the door.', apply: 'Draw your trust boundaries first. For each one, define the smallest explicit interface across it and refuse everything else.', where: ['c:desktop', 'c:preload', 'k:windows/webpage'] },
  { id: 'root', title: 'Composition root', idea: 'One module (main.js) creates the windows and wires every other module together; the modules themselves don’t set each other up.', why: 'Modules stay small and testable alone, and the whole assembly can be read in one place.', apply: 'Keep construction and wiring at the entry point. Pass dependencies in (init({ … })) instead of reaching for globals.', where: ['k:main/shell'] },
  { id: 'core', title: 'Functional core, imperative shell', idea: 'Rules live in pure modules (the *core.js files) that take data and return data; thin wrappers read and write files.', why: 'Pure code is deterministic: tests need no files, clocks or mocks, and bugs are easy to reproduce.', apply: 'When a module mixes rules and I/O, split it: compute in a pure function, then do the side effects in a few lines around it.', where: ['k:main/growth', 'k:main/schedule', 'k:main/personas', 'k:main/windows'], evidence: 'pure' },
  { id: 'gate', title: 'One gate for risky actions', idea: 'Every consequential tool asks the permission gate (approvals.js) instead of deciding alone; content from outside taints the turn.', why: 'Security rules in one place are consistent and auditable; a new tool can’t forget them.', apply: 'Route every dangerous operation through a single policy function. Make the safe path the easy path.', where: ['k:main/tools', 'k:main/claude'] },
  { id: 'allow', title: 'Allowlists, not denylists', idea: 'What may happen is listed: IPC channels (preload), served folders (SERVED), settings the agent may change (SETTABLE), phone routes (STATIC).', why: 'A denylist fails open when something new appears; an allowlist fails closed.', apply: 'When in doubt, enumerate what is allowed. New capabilities then need a deliberate change.', where: ['c:preload', 'k:main/storage', 'k:main/remote'] },
  { id: 'adapters', title: 'Adapters around the outside world', idea: 'Model providers, the Claude CLI and helper apps each sit behind a module that makes them look like the app’s own concepts.', why: 'Swapping or adding a provider, or surviving its outage, doesn’t ripple through the codebase.', apply: 'Wrap every third-party service in your own interface, named in your domain’s words. Keep its quirks inside the wrapper.', where: ['k:main/brain', 'k:main/claude', 'k:main/voice'] },
  { id: 'files', title: 'Plain files as the database', idea: 'Memory, schedule, habits and notes are Markdown in a vault; settings and conversations are JSON files.', why: 'The user owns readable data, can fix it by hand, and versioning is just git. No database server to run.', apply: 'Pick the simplest storage that meets the need. Files plus a write queue or lock go a long way for single-user apps.', where: ['c:ext-vault', 'c:ext-data', 'k:main/knowledge'] },
  { id: 'soft', title: 'Fail soft', idea: 'Fallbacks everywhere: the next provider after a rate limit, the offline voice when VoiceStudio is down, timeouts on speech and tools, crash recovery for windows and child processes.', why: 'Integrations fail; users should get a slightly worse answer, not a broken app.', apply: 'For each dependency ask: what happens when it is slow, down or wrong? Add a timeout and a fallback.', where: ['k:main/brain', 'k:main/voice', 'k:desktop/ui-voice'] },
  { id: 'observe', title: 'Make it observable', idea: 'A structured log with turn ids, health checks for every service, and error grouping that points at code locations.', why: 'You can’t fix what you can’t see; context on every line turns a bug report into a stack trace.', apply: 'Log events with structured data and a correlation id from the start. Build a health check for each dependency.', where: ['k:main/shell'] },
  { id: 'verify', title: 'Verify contracts automatically', idea: 'scripts/verify.js reads the code statically and checks the cross-file rules: every IPC handler has a channel and every renderer call a handler; imports exist; settings have defaults.', why: 'The bugs a syntax check misses are the ones between files. Machines are better at remembering them.', apply: 'Whenever a rule says “if you change X, also change Y”, write a check for it.', where: ['c:quality', 'k:main/selfevo'] },
  { id: 'reversible', title: 'Every change is reversible', idea: 'Self-changes are committed to git only after checks and tests pass, verified after the next start, and can be reverted from Evolution. The vault is versioned too.', why: 'Cheap undo makes bold changes safe.', apply: 'Put everything under version control, automate the checks before a change lands, keep a one-step rollback.', where: ['k:main/selfevo', 'k:main/knowledge'] },
  { id: 'depth', title: 'Defense in depth at the edges', idea: 'Remote access stacks Host/Origin checks, device tokens, a narrow route list, trimmed data and optional Cloudflare Access; the agent window blocks private addresses twice (navigation and requests).', why: 'Any single check can have a bug. Several independent ones rarely fail together.', apply: 'At every entry point from outside, layer independent checks, and give outside callers only what they need.', where: ['k:main/remote', 'c:phone', 'k:windows/webpage'] },
];

// ------------------------------------------------------------ facts from one file
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w\\])\/\/.*$/gm, '$1');

/** What one file's code says about its connections (pure: text in, facts out). */
function facts(rel, text) {
  const code = stripComments(text);
  const out = { apiCalls: [], subscribes: [], pushes: false, externals: [] };
  if (rel.startsWith('renderer/')) {
    out.apiCalls = [...new Set([...code.matchAll(/\bapi\.(\w+)\.(\w+)\(/g)].filter((x) => x[1] !== 'on').map((x) => `${x[1]}:${x[2]}`))].sort();
    out.subscribes = [...new Set([...code.matchAll(/\bapi\.on\('([\w:-]+)'/g)].map((x) => x[1]))].sort();
  }
  // archcore.js itself is skipped: the patterns above would match their own source.
  if (rel.startsWith('main/') && rel !== 'main/archcore.js') {
    out.pushes = /webContents\.send\(/.test(code);
    out.externals = EXTERNALS.filter((e) => !e.except?.includes(rel) && e.test.test(code)).map((e) => e.id);
  }
  return out;
}

/** The file's own description: its leading comment, up to the first sentence or so. */
function aboutOf(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let i = 0;
  if (/^#!/.test(lines[0] || '')) i++;
  if (/^\s*<!doctype/i.test(lines[i] || '')) {
    const t = /<title>([^<]*)<\/title>/i.exec(text);
    return t ? `The page “${t[1].trim()}”.` : '';
  }
  let block = false;
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (block || l.startsWith('/*')) {
      out.push(l.replace(/^\/\*+|\*\/$/g, '').replace(/^\*(?!\/)/, '').trim());
      block = !l.includes('*/');
      if (!block) break;
    } else if (l.startsWith('//')) out.push(l.replace(/^\/\/\s?/, ''));
    else if (l === '' && !out.length) continue;
    else break;
  }
  return clip(out.join(' ').replace(/\s+/g, ' ').trim());
}

function clip(s, max = 260) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(': '));
  return end > 80 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}

// ------------------------------------------------------------ classification
const matches = (rel, pattern) => (pattern.endsWith('/') ? rel.startsWith(pattern) : rel === pattern);
// The most specific pattern wins (main/mcp-server.js belongs to the MCP container, not to main/).
function bestMatch(rel, entries, patternsOf) {
  let best = null;
  let len = -1;
  for (const e of entries) for (const p of patternsOf(e)) if (matches(rel, p) && p.length > len) (best = e), (len = p.length);
  return best;
}

const stemOf = (rel) => rel.split('/').pop().replace(/\.[^.]+$/, '').replace(/(core|-worker|\.test)$/, '');
const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The model: nodes (containers, components, files) with parents, and raw edges between nodes.
 * files: [{ path, lines, about, symbols, imports: [path], apiCalls, subscribes, pushes, externals }]
 * handlers: { 'ns:method': 'main/main.js' } (who handles each IPC channel).
 */
function model(files, { handlers = {} } = {}) {
  const all = [...files, ...VIRTUAL.map((v) => ({ ...v, imports: [], apiCalls: [], subscribes: [], pushes: false, externals: [] }))];
  const nodes = [];
  const byId = new Map();
  const add = (n) => (nodes.push(n), byId.set(n.id, n), n);
  for (const c of CONTAINERS) add({ id: `c:${c.id}`, level: 'container', kind: c.kind || 'system', name: c.name, tech: c.tech, about: c.about, lesson: c.lesson, tone: c.tone, row: c.row, anchor: Boolean(c.anchor), parent: null });

  const fileOf = new Map();
  for (const f of all) {
    const container = bestMatch(f.path, CONTAINERS.filter((c) => c.match), (c) => c.match);
    if (!container) continue;
    let comp = bestMatch(f.path, COMPONENTS.filter((k) => k.container === container.id), (k) => k.files);
    let compId = comp ? `k:${container.id}/${comp.id}` : `k:${container.id}/auto-${stemOf(f.path)}`;
    if (!byId.has(compId)) {
      if (!comp) comp = { name: titleCase(stemOf(f.path)), about: f.about || '', auto: true };
      add({ id: compId, level: 'component', kind: 'component', name: comp.name, about: comp.about, lesson: comp.lesson, auto: Boolean(comp.auto), tone: container.tone, parent: `c:${container.id}` });
    }
    const node = add({ id: `f:${f.path}`, level: 'file', kind: f.path.startsWith('virtual/') ? 'virtual' : 'file', name: f.path.split('/').pop(), path: f.path, about: FILE_ABOUT[f.path] || f.about || '', lines: f.lines || 0, symbols: f.symbols || [], tone: container.tone, parent: compId });
    fileOf.set(f.path, node);
  }

  // Raw edges, file to file (or to an external/actor container), merged by (from, to, kind).
  const edges = new Map();
  const edge = (from, to, kind, label, count = 1) => {
    if (!from || !to || from === to) return;
    const key = `${from}|${to}|${kind}`;
    const e = edges.get(key);
    if (e) {
      e.count += count;
      if (label && !e.labels.includes(label)) e.labels.push(label);
    } else edges.set(key, { from, to, kind, count, labels: label ? [label] : [] });
  };
  const id = (p) => (p.startsWith('c:') ? (byId.has(p) ? p : null) : p.endsWith('/') ? [...fileOf.keys()].filter((k) => k.startsWith(p)).map((k) => `f:${k}`)[0] || null : fileOf.has(p) ? `f:${p}` : null);
  const preload = fileOf.has('preload.js') ? 'f:preload.js' : null;

  for (const f of all) {
    const me = fileOf.get(f.path);
    if (!me) continue;
    for (const t of f.imports || []) if (fileOf.has(t)) edge(me.id, `f:${t}`, f.path.startsWith('test/') ? 'test' : 'call');
    if (preload && f.apiCalls?.length) {
      edge(me.id, preload, 'ipc', null, f.apiCalls.length);
      const namespaces = [...new Set(f.apiCalls.map((c) => c.split(':')[0]))];
      edges.get(`${me.id}|${preload}|ipc`).labels = namespaces;
      const perHandler = {};
      for (const c of f.apiCalls) if (handlers[c] && fileOf.has(handlers[c])) perHandler[handlers[c]] = (perHandler[handlers[c]] || 0) + 1;
      for (const [h, n] of Object.entries(perHandler)) edge(preload, `f:${h}`, 'ipc', null, n);
    }
    if (preload && f.subscribes?.length) edge(preload, me.id, 'event', f.subscribes.slice(0, 6).join(', '), f.subscribes.length);
    if (preload && f.pushes) edge(me.id, preload, 'event', 'pushes events to the window');
    for (const x of f.externals || []) edge(me.id, `c:${x}`, EXTERNALS.find((e) => e.id === x).kind);
  }
  for (const l of LINKS) edge(id(l.from), id(l.to), l.kind, l.label);

  // Drop empty containers (e.g. no Android folder in this checkout), but keep actors and externals.
  const used = new Set(nodes.filter((n) => n.parent).map((n) => n.parent));
  const keep = nodes.filter((n) => n.level !== 'container' || n.kind === 'actor' || n.kind === 'external' || used.has(n.id));
  const kept = new Set(keep.map((n) => n.id));
  return { nodes: keep, edges: [...edges.values()].filter((e) => kept.has(e.from) && kept.has(e.to)) };
}

// ------------------------------------------------------------ layout
// World units. Headers and padding grow with a box's width, so each box's title reads at about the same
// size on screen at the zoom where its inside appears (the renderer's semantic zoom thresholds).
const FILE_W = 300;
const FILE_HEAD = 84;
const SYM_ROW = 19;
const MAX_ROWS = 16;
const MIN_CONTAINER = { w: 1800, h: 1000 };

function fileSize(n) {
  const rows = Math.min(n.symbols.length, MAX_ROWS) + (n.symbols.length > MAX_ROWS ? 1 : 0);
  return { w: FILE_W, h: FILE_HEAD + (rows ? rows * SYM_ROW + 14 : 0) };
}

// Shelf packing in the given order: rows up to a width that makes the block roughly 4:3.
function pack(children, gap) {
  if (!children.length) return { w: 0, h: 0 };
  const area = children.reduce((a, c) => a + (c.w + gap) * (c.h + gap), 0);
  const maxW = Math.max(...children.map((c) => c.w));
  const target = Math.max(maxW, Math.sqrt(area * 1.33));
  let x = 0;
  let y = 0;
  let rowH = 0;
  let w = 0;
  for (const c of children) {
    if (x > 0 && x + c.w > target) (y += rowH + gap), (x = 0), (rowH = 0);
    c.x = x;
    c.y = y;
    x += c.w + gap;
    rowH = Math.max(rowH, c.h);
    w = Math.max(w, x - gap);
  }
  return { w, h: y + rowH };
}

function boxAround(content, { headK, headMin, padK, padMin, min = { w: 0, h: 0 } }) {
  const w0 = content.w + 2 * Math.max(padMin, content.w * padK);
  const w = Math.max(min.w, w0);
  const pad = Math.max(padMin, w * padK);
  const head = Math.round(Math.max(headMin, w * headK));
  const h = Math.max(min.h, head + content.h + 2 * pad);
  // Content centered horizontally, below the header.
  return { w: Math.round(w), h: Math.round(h), head, ox: Math.round((w - content.w) / 2), oy: Math.round(head + pad) };
}

/** Positions every node (x, y, w, h in world units; children absolute) and returns the world bounds. */
function layout({ nodes }) {
  const kids = new Map();
  for (const n of nodes) if (n.parent) (kids.get(n.parent) || kids.set(n.parent, []).get(n.parent)).push(n);
  const bySize = (a, b) => b.h - a.h || a.name.localeCompare(b.name);

  const sizeOf = (n) => {
    if (n.level === 'file') return Object.assign(n, fileSize(n));
    const children = (kids.get(n.id) || []).map(sizeOf).sort(bySize);
    if (n.level === 'component') {
      const content = pack(children, 26);
      return Object.assign(n, boxAround(content, { headK: 0.075, headMin: 30, padK: 0.035, padMin: 20 }), { content });
    }
    if (!children.length) return Object.assign(n, { w: MIN_CONTAINER.w, h: n.kind === 'actor' ? 800 : 900, head: 0 });
    const content = pack(children, 80);
    return Object.assign(n, boxAround(content, { headK: 0.045, headMin: 90, padK: 0.025, padMin: 50, min: MIN_CONTAINER }), { content });
  };
  const place = (n, x, y) => {
    n.x = x;
    n.y = y;
    for (const c of kids.get(n.id) || []) place(c, x + n.ox + c.x, y + n.oy + c.y);
  };

  const containers = nodes.filter((n) => n.level === 'container');
  containers.forEach(sizeOf);
  const rows = [...new Set(containers.map((c) => c.row))].sort((a, b) => a - b);
  const GAP = 420;
  let y = 0;
  for (const row of rows) {
    const items = containers.filter((c) => c.row === row);
    const a = Math.max(0, items.findIndex((c) => c.anchor));
    const xs = [];
    const anchorX = items.some((c) => c.anchor) ? -items[a].w / 2 : -(items.reduce((s, c) => s + c.w, 0) + GAP * (items.length - 1)) / 2;
    if (items.some((c) => c.anchor)) {
      xs[a] = anchorX;
      for (let i = a + 1; i < items.length; i++) xs[i] = xs[i - 1] + items[i - 1].w + GAP;
      for (let i = a - 1; i >= 0; i--) xs[i] = xs[i + 1] - GAP - items[i].w;
    } else {
      let x = anchorX;
      items.forEach((c, i) => ((xs[i] = x), (x += c.w + GAP)));
    }
    items.forEach((c, i) => place(c, Math.round(xs[i]), y));
    y += Math.max(...items.map((c) => c.h)) + 700;
  }
  for (const n of nodes) delete n.content;
  const xs = containers.map((c) => [c.x, c.x + c.w]).flat();
  const ys = containers.map((c) => [c.y, c.y + c.h]).flat();
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// ------------------------------------------------------------ the whole map, and what changed
function build(files, options = {}) {
  const mdl = model(files, options);
  const bounds = layout(mdl);
  const pure = mdl.nodes.filter((n) => n.level === 'file' && /core\.js$/.test(n.path)).map((n) => n.path);
  const principles = PRINCIPLES.map((p) => ({ ...p, where: p.where.filter((id) => mdl.nodes.some((n) => n.id === id)), ...(p.evidence === 'pure' ? { evidence: pure } : {}) }));
  const stats = {
    containers: mdl.nodes.filter((n) => n.level === 'container').length,
    components: mdl.nodes.filter((n) => n.level === 'component').length,
    files: mdl.nodes.filter((n) => n.kind === 'file').length,
    lines: mdl.nodes.reduce((s, n) => s + (n.lines || 0), 0),
    connections: mdl.edges.length,
    undescribed: mdl.nodes.filter((n) => n.auto).map((n) => n.name),
  };
  return { version: 1, nodes: mdl.nodes, edges: mdl.edges, bounds, principles, stats, sizes: { fileHead: FILE_HEAD, symRow: SYM_ROW, maxRows: MAX_ROWS } };
}

/** What a rebuild changed: ids added (marked new on the map) and names removed. */
function diff(prev, next) {
  if (!prev?.nodes) return { added: [], removed: [], first: true };
  const tracked = (map) => new Map(map.nodes.filter((n) => n.level !== 'container' || n.kind !== 'external').map((n) => [n.id, n]));
  const a = tracked(prev);
  const b = tracked(next);
  return {
    added: [...b.keys()].filter((id) => !a.has(id)),
    removed: [...a.keys()].filter((id) => !b.has(id)).map((id) => a.get(id).path || a.get(id).name),
  };
}

module.exports = { CONTAINERS, COMPONENTS, EXTERNALS, LINKS, PRINCIPLES, facts, aboutOf, model, layout, build, diff, stripComments };
