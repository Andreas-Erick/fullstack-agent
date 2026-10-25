// The feature guide behind "how can I use you?" (tool app_guide, the /tour skill). One entry per area of
// the app: what it does, things to say, where it lives in the app, and whether it is set up on this
// computer right now. Keep it current when a feature is added or changed (CLAUDE.md says so).
const store = require('./store');

const FEATURES = [
  {
    id: 'talk',
    title: 'Talking with me',
    what: 'Type or talk. Push-to-talk (hold the talk key) or hands-free; I answer in a voice and my face shows what I am doing (listening, thinking, working, speaking). Voice calibration teaches me how your names and words come through.',
    say: ['"Calibrate my voice"', '"Switch to hands-free"', '"Speak slower"'],
    where: 'Settings → Voice output and Voice input; the face (Ctrl+2); the chat layouts (Ctrl+Shift+1/2/3).',
    status: (s) => `${s.voice.ttsEnabled ? 'voice on' : 'voice off'}; ${s.stt.enabled ? (s.stt.micMode === 'open' ? 'hands-free' : `push-to-talk (${s.stt.pttKey})`) : 'voice input off'}`,
  },
  {
    id: 'personas',
    title: 'Personas, look and faces',
    what: 'Several personas, each with its own master prompt, image, theme, face, greeting and voice; switch in the title bar. Ready-made templates: Ada (STEM tutor), Mira (polyglot coach), Sol (life coach). Ask me to change my look and I restyle myself.',
    say: ['"Make yourself look like an 80s synthwave terminal"', '"Use the companion face"', '"Switch to Ada"'],
    where: 'Settings → Persona studio (🎓 Templates…); the switcher next to my name.',
    status: (s) => `${s.personas.list.length} persona${s.personas.list.length === 1 ? '' : 's'}; active: ${s.agent.name}`,
  },
  {
    id: 'memory',
    title: 'Memory and your vault',
    what: 'I remember what matters about you, and keep notes, a daily journal, your priorities and your profile in an Obsidian vault of plain Markdown files you own. When the app closes I note where we left off.',
    say: ['"Remember that I prefer mornings for deep work"', '"What are my priorities?"', '"Save this as a note"', '"What did we talk about last Tuesday?"'],
    where: 'Memory (Ctrl+3) and Knowledge (Ctrl+5); the vault in Obsidian.',
    status: (s, f) => (f.vault ? `vault at ${f.vault}` : 'no vault yet: choose one in Settings → Vault'),
  },
  {
    id: 'learning',
    title: 'Learning: understanding, math and proofs',
    what: 'Tutoring that aims at understanding: intuition first, then the rigorous version; proofs with the strategy, every step justified, and hints instead of answers while you work. Formulas render on screen and are read aloud in words. A learning tracker per topic keeps what you understood, what is shaky, misconceptions and open questions.',
    say: ['"Help me understand eigenvalues"', '"/proof-coach every bounded monotone sequence converges"', '"/teach-back the chain rule"', '"Let\'s study"'],
    where: 'The chat; Learning/ in the vault; skills /explain, /proof-coach, /teach-back, /study-session.',
    status: (_s, f) => (f.vault ? `${f.topics} topic${f.topics === 1 ? '' : 's'} tracked` : 'needs the vault'),
  },
  {
    id: 'languages',
    title: 'Languages (polyglots)',
    what: 'Vocabulary and phrase decks with spaced repetition, reviews by voice, and speaking practice: say "let\'s practice Spanish" and speech recognition and my voice switch to that language, with gentle corrections.',
    say: ['"/drill Icelandic"', '"/converse French, about my weekend"', '"Add these words to my deck"', '"Stop practice"'],
    where: 'Languages/ in the vault; Settings → Learning; the Practice pill in the title bar.',
    status: (s, f) => `${f.decks ? `${f.decks} deck${f.decks === 1 ? '' : 's'}` : 'no decks yet'}${s.learning?.practiceLanguage ? `; practicing ${s.learning.practiceLanguage}` : ''}`,
  },
  {
    id: 'coaching',
    title: 'Coaching, goals and habits',
    what: 'A life-coach side: I listen first, help turn intentions into small concrete steps with if-then plans, and follow up without nagging. A habit tracker with streaks and weekly targets; tick habits off in the Habits view or just tell me.',
    say: ['"/goal run a half marathon"', '"I meditated"', '"How are my habits?"', '"/reflect"', '"/weekly-review"'],
    where: 'Habits view (rail); Habits.md in the vault.',
    status: (_s, f) => (f.vault ? `${f.habits} habit${f.habits === 1 ? '' : 's'} tracked` : 'needs the vault'),
  },
  {
    id: 'skilltree',
    title: 'Skill tree',
    what: 'A constellation of what you are growing (subjects, languages, physical skills, ways of working) with prerequisites. Progress comes from your learning tracker, vocabulary decks and habits; skills unlock as what they build on grows.',
    say: ['"Map my goal of speaking Icelandic at B2 into my skill tree"', '"What should I work on next?"'],
    where: 'Tree view (rail); Skill Tree.md in the vault.',
    status: (_s, f) => (f.vault ? `${f.skills} skill${f.skills === 1 ? '' : 's'}` : 'needs the vault'),
  },
  {
    id: 'routines',
    title: 'Routines (things I do on a schedule)',
    what: 'I run instructions on a schedule while the app is open: a daily briefing, syncing Google Calendar or Todoist, summarizing new Plaud recordings, a daily language text. Each run is its own conversation and you get a notification.',
    say: ['"Every morning at 8, check my Plaud for new recordings"', '"Run my daily briefing now"', '"Which routines do I have?"'],
    where: 'Habits view → Routines.',
    status: (_s, f) => `${f.routines} routine${f.routines === 1 ? '' : 's'}${f.routinesOn !== f.routines ? ` (${f.routinesOn} on)` : ''}`,
  },
  {
    id: 'schedule',
    title: 'Your schedule and calendar',
    what: 'Tell me appointments and repeating things ("Linear Algebra every Monday at 10 in H1 until February") and I keep them in Schedule.md in your vault; a calendar view with month, week and agenda. A routine can sync your Google Calendar in.',
    say: ['"I have the dentist on the 28th at 2"', '"What\'s on tomorrow?"', '"Skip the lecture next Monday"'],
    where: 'Calendar (Ctrl+4).',
    status: (s) => (s.calendar.enabled ? 'on' : 'off'),
  },
  {
    id: 'connectors',
    title: 'Claude connectors and plugins',
    what: 'With the Claude account brain I can use the services connected to your claude.ai account (Google Calendar, Todoist, Plaud, Wolfram, DeepL, Canva, Figma…) and your Claude Code plugins. Each service is set to ask every time, allow reading, allow all but deleting, or allow everything. I suggest a connector when a task would go better with one.',
    say: ['"Which connectors do I have?"', '"Find papers on spaced repetition"', '"Add this to my Todoist"'],
    where: 'Settings → AI brain → connectors (Check connectors).',
    status: (s) => (s.claudeCode.connectors ? 'on' : 'off: turn on in Settings → AI brain (Claude account brain)'),
  },
  {
    id: 'documents',
    title: 'Documents, files, PDFs and your screen',
    what: 'I open and read your documents (PDF, Word, images…) in their own windows and move them between monitors, write PDFs, jot quick notes, and see your screen while you share it.',
    say: ['"Open the quarterly report on the right monitor"', '"Make a PDF of this"', '"Note that I need to call the bank"', '"What do you see on my screen?"'],
    where: 'Documents (Ctrl+6); Share screen in the chat.',
    status: (s) => (s.documents.workspace ? `workspace: ${s.documents.workspace}` : 'no workspace folder set'),
  },
  {
    id: 'folders',
    title: 'Which of your folders I can use',
    what: 'Only your workspace folder at first, plus my own vault. You add more folders yourself, and removing one from the list takes my access away again. Files you open in the app are always fine.',
    say: ['"Which folders can you see?"', '"Find my CV" (searched in the workspace first)'],
    where: 'Settings → Documents & folder access.',
    status: (s) => `${s.documents.workspace ? 'workspace set' : 'no workspace folder yet'}; ${(s.documents.allowedRoots || []).length} more folder(s)`,
  },
  {
    id: 'agent-window',
    title: 'My agent window: websites and the globe',
    what: "A browser window I control and you can watch (or use yourself): I open sites, read them, click, type and scroll in small steps, and take a look to check what is on screen. The God's Eye View globe shows there too and moves when I point it somewhere. I never type passwords or payment details, and I ask before buying, sending or deleting anything.",
    say: ['"Open the train timetable and find the next connection to Munich"', '"Show me the earthquakes on the globe, full screen on the left monitor"', '"What does this page say about pricing?"'],
    where: 'The 🌐 button in the title bar; Settings → Internet.',
    status: (s) => (s.agentWindow?.enabled === false ? 'off' : 'on'),
  },
  {
    id: 'system',
    title: 'Your computer at a glance',
    what: 'The title bar shows CPU, RAM and GPU load; click it for details: processor, memory in GB, each GPU with its VRAM and temperature, the system disk, connected Bluetooth devices, and your internet connection with a speed test you start with a click. Only you see it; I never get these numbers.',
    say: [],
    where: 'The CPU · RAM · GPU meter in the title bar; turn it off in Settings → Interface.',
    status: (s) => (s.ui?.showSystemStats === false ? 'hidden' : 'shown'),
  },
  {
    id: 'usage',
    title: 'How much of your Claude plan is left',
    what: "With the Claude account brain, the title bar shows how much of your plan's 5-hour and weekly limits is left, with the reset times in its tooltip.",
    say: ['"Where do I see my Claude usage?"'],
    where: 'The "Claude %" pill in the title bar; turn it off in Settings → AI brain (or Interface).',
    status: (s) => (s.ui?.showClaudeUsage === false ? 'hidden' : 'shown'),
  },
  {
    id: 'skills',
    title: 'Skills (your workflows)',
    what: 'Save a workflow once and run it again by name, a slash command or a trigger phrase. Learning and coaching skills come built in, and you can import Agent Skills from GitHub (for example mattpocock/skills: /grill-me, /tdd, /diagnosing-bugs, /teach), with their reference files.',
    say: ['"Make what you just did a skill"', '"Import the skills from mattpocock/skills"', '"/grill-me my plan for the semester"'],
    where: 'Skills (Ctrl+8) → ⬇ Import from GitHub.',
    status: (_s, f) => `${f.skillCount} skills`,
  },
  {
    id: 'diagrams',
    title: 'Diagrams',
    what: 'I draw diagrams as clean HTML + SVG pages (architecture, flowchart, sequence, timeline, quadrant, mind of a proof…) and open them in a window; they are kept in Diagrams/ in your vault. With the diagram-design skill imported, 45 editorial diagram types.',
    say: ['"Draw an architecture diagram of my app"', '"Make a timeline of the French Revolution"', '"Show this proof as a flowchart"'],
    where: 'Diagrams/ in the vault; import cathrynlavery/diagram-design in Skills for the full design system.',
    status: (_s, f) => (f.vault ? 'on' : 'needs the vault'),
  },
  {
    id: 'extensions',
    title: 'Extensions: reverse engineering and the live globe',
    what: 'With the Claude account brain: REA explains how apps, websites, Electron bundles and binaries work, with evidence (for software you may analyze). God\'s Eye View is a live 3D globe of public world data (flights, ships, satellites, weather, quakes, fires) that I can query and show you.',
    say: ['"How does this Electron app store its settings?"', '"What is flying over Reykjavik right now? Show me."', '"When does the ISS pass over me next?"'],
    where: 'Settings → Extensions.',
    status: (s) => `REA ${s.extensions?.rea ? 'on' : 'off'}; globe ${s.extensions?.godseye ? (s.extensions.godseyePath ? 'on' : 'on, no folder set') : 'off'}`,
  },
  {
    id: 'web-code',
    title: 'The web, GitHub, coding, and improving myself',
    what: 'I search and read the web with sources, work on your GitHub repositories on branches (pushing and pull requests always ask), and can change my own code when you ask for a feature, with checks, tests and a history you can undo.',
    say: ['"What\'s new in …? Cite sources"', '"Open an issue summary for my repo"', '"Add a feature that …"'],
    where: 'Evolution (Ctrl+7) shows my own changes.',
    status: (s) => `${s.web.enabled ? 'web on' : 'web off'}; self-improvement ${s.code.allowSelfModify ? 'on' : 'off'}`,
  },
  {
    id: 'remote',
    title: 'Your phone',
    what: 'Pair a phone (or the Android app) to talk to me away from the desk: chat, voice, your schedule, approvals, the same face. Over Wi-Fi or a secure address (Tailscale or Cloudflare).',
    say: ['"How do I use you from my phone?"'],
    where: 'Settings → Remote access.',
    status: (s) => (s.remote?.enabled ? 'on' : 'off'),
  },
  {
    id: 'safety',
    title: 'Safety, privacy and fixing problems',
    what: 'Consequential actions ask you first (click or say "yes"); I never widen my own access. Everything stays on this computer except what goes to the AI brain and the services you use. When something breaks I diagnose it from my log and fix the cause.',
    say: ['"Something is wrong with the voice"', '"Run a diagnosis"', '"Write a bug report"'],
    where: 'Settings → Safety and Health.',
    status: (s) => `permission mode: ${s.safety.permissionMode}`,
  },
];

async function facts() {
  const out = { vault: '', topics: 0, decks: 0, habits: 0, skills: 0, routines: 0, routinesOn: 0, skillCount: 0 };
  const safe = (p) => p.catch(() => null);
  out.vault = (await safe(require('./obsidian').vaultPath())) || '';
  const [topics, decks, habits, tree, routines, skills] = await Promise.all([
    out.vault ? safe(require('./learning').topics()) : null,
    out.vault ? safe(require('./learning').deckSummaries()) : null,
    out.vault ? safe(require('./habits').status()) : null,
    out.vault ? safe(require('./skilltree').view()) : null,
    safe(require('./routines').list()),
    safe(require('./skills').list()),
  ]);
  out.topics = topics?.length || 0;
  out.decks = decks?.length || 0;
  out.habits = habits?.habits.filter((h) => !h.paused).length || 0;
  out.skills = tree?.skills.length || 0;
  out.routines = routines?.length || 0;
  out.routinesOn = routines?.filter((r) => r.enabled).length || 0;
  out.skillCount = skills?.length || 0;
  return out;
}

// Matching a question to an area: the area's name counts most; filler words don't count at all.
const FILLER = new Set(['how', 'can', 'you', 'use', 'what', 'the', 'does', 'work', 'works', 'about', 'are', 'my', 'me', 'with', 'for', 'and', 'tell', 'explain', 'your', 'this', 'that', 'there', 'way', 'ways']);
const score = (f, q) => {
  const words = String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !FILLER.has(w)).map((w) => w.replace(/(ies|es|s)$/, ''));
  const name = `${f.id} ${f.title}`.toLowerCase();
  const text = `${f.what} ${f.say.join(' ')}`.toLowerCase();
  return words.reduce((n, w) => n + (name.includes(w) ? 3 : 0) + (text.includes(w) ? 1 : 0), 0);
};

/** Everything (one line each, with status), or one area in full when `topic` names it. */
async function guide(topic = '') {
  const s = await store.getSettings();
  const f = await facts();
  const status = (x) => {
    try {
      return x.status(s, f);
    } catch {
      return 'unknown';
    }
  };
  if (topic) {
    const best = FEATURES.map((x) => [x, score(x, topic)]).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] > 0) {
      const x = best[0];
      return { topic: x.title, what: x.what, try: x.say, where: x.where, status: status(x), others: FEATURES.filter((y) => y !== x).map((y) => y.title) };
    }
  }
  return {
    features: FEATURES.map((x) => ({ id: x.id, title: x.title, what: x.what, try: x.say.slice(0, 2), status: status(x) })),
    tip: 'Explain what fits this user first (their profile, goals and what is already set up), offer one or two things to try now, and offer to set something up.',
  };
}

module.exports = { FEATURES, guide };
