// The feature guide behind "how can I use you?" (tool app_guide, the /tour skill). One entry per area of
// the app: what it does, things to say, where it lives in the app, and whether it is set up on this
// computer right now. Keep it current when a feature is added or changed (CLAUDE.md says so).
const store = require('./store');

const FEATURES = [
  {
    id: 'talk',
    title: 'Talking with me',
    what: 'Type or talk. Push-to-talk (hold the talk key) or hands-free; I answer in a voice (the offline voice runs right in the app; VoiceStudio is an optional app with more natural, cloneable voices) and my face shows what I am doing (listening, thinking, working, speaking). Speech is recognized on this computer with Whisper by default; Groq in the cloud can stand in while it loads or replace it (Settings → Voice input, free key). Voice calibration teaches me how your names and words come through.',
    say: ['"Calibrate my voice"', '"Switch to hands-free"', '"Speak slower"'],
    where: 'Settings → Voice output and Voice input; the face (Ctrl+2); the chat layouts (Ctrl+Shift+1/2/3).',
    status: (s) => `${s.voice.ttsEnabled ? `voice on (${s.voice.engine === 'local' ? 'offline voice' : 'VoiceStudio'})` : 'voice off'}; ${s.stt.enabled ? (s.stt.micMode === 'open' ? 'hands-free' : `push-to-talk (${s.stt.pttKey})`) : 'voice input off'}`,
  },
  {
    id: 'personas',
    title: 'Personas, look and faces',
    what: 'Several personas, each with its own master prompt, image, theme, face, greeting and voice; switch in the title bar. Ready-made templates: Ada (STEM tutor), Mira (polyglot coach), Sol (life coach). Ask me to change my look and I restyle myself. Six built-in faces (Siren is the default); make your own with any AI app using the prompt in the note "Make Your Own Face" in your vault.',
    say: ['"Make yourself look like an 80s synthwave terminal"', '"Use the companion face"', '"Switch to Ada"'],
    where: 'Settings → Persona studio (🎓 Templates…); the switcher next to my name; Face view → ＋ Custom faces.',
    status: (s) => `${s.personas.list.length} persona${s.personas.list.length === 1 ? '' : 's'}; active: ${s.agent.name}`,
  },
  {
    id: 'memory',
    title: 'Memory and your vault',
    what: 'I remember what matters about you, and keep notes, a daily journal, your priorities and your profile in an Obsidian vault of plain Markdown files you own. Besides facts, I keep a memory stream of small observations (how things went, what helped) and now and then reflect on it to draw a few insights; the most relevant ones come back to me with each message. When the app closes I note where we left off. The vault keeps a version history, and 🌱 Growth in the Vault view plays it: every note appearing in its folder, from the first day to today, with lines between the notes that link to each other. Under every note the Vault view lists which notes link to it and which it links to.',
    say: ['"Remember that I prefer mornings for deep work"', '"What have you learned about how I work?"', '"What are my priorities?"', '"What did we talk about last Tuesday?"'],
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
    id: 'flashcards',
    title: 'Flashcards',
    what: 'Decks of flashcards scheduled the way Anki does it: learning steps, then intervals that grow with Again, Hard, Good and Easy (Anki’s SM-2), or FSRS, Anki’s newer scheduler, as a deck option. Study them in the Cards view (Space shows the answer, 1–4 grade it), on your phone and tablet (More → Flashcards), or with me in the chat. I make cards for you (cloze cards too) and import them: put a CSV, TSV, Anki text export or an Anki deck (.apkg) in your workspace folder and ask me, or use Import in the view. Images, sounds and the schedule Anki had come along. Your vocabulary decks are here too. Mixed learning studies every deck at once, each card from another deck than the last: Mixed review (today’s due cards, scheduled as usual) or Shuffle everything (every card in random order, as practice that changes no schedule). Link a deck to a skill in your skill tree and the skill grows as its cards mature.',
    say: ['"Import the Anki deck in my workspace."', '"Make me flashcards about the Krebs cycle."', '"Quiz me on my Biology deck."', '"Let’s do a mixed review."', '"Shuffle all my cards."', '"Switch my Spanish deck to FSRS."'],
    where: 'Cards in the rail; Flashcards/ in your vault (one note per deck); More → Flashcards on the phone.',
    status: (_s, f) => (!f.vault ? 'needs the vault' : 'on'),
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
    id: 'innerworld',
    title: 'The Inner World and rehearsals',
    what: 'A small fantasy village where your personas (and two villagers) live a fictional day: every morning a narrator writes their plans, meetings and conversations, and each of them remembers it. It mirrors you: the Library grows with what you understand, the Café with your vocabulary, the Training Grounds fly a banner per habit (raised when kept today), the Garden blooms for each habit kept, and at night your skill tree shines as constellations. Whatever I am doing right now you can watch: at the forge when I write code, up the Lookout when I search the web. You choose its frame rate (automatic, 15, 30, 60 or 120 a second) in the view. When a building gains a level it lights up and sparks for a moment, and ⏳ Timelapse replays how the village grew, day by day, with the seasons turning. On its Stage I can rehearse a conversation you are preparing for, with characters who have their own hidden goals, and debrief it.',
    say: ['"What did you do today in the Inner World?"', '"Help me rehearse asking for a raise"', '"Rehearse my thesis defense with a skeptical examiner"'],
    where: 'World view (rail; ⚙ there or Settings → Inner World for season, art and villagers); Inner World/ in the vault (Chronicle, residents’ memories, Rehearsals).',
    status: (s, f) => (!f.vault ? 'needs the vault' : s.innerWorld?.enabled ? 'awake' : 'asleep: wake it in the World view (rehearsals work anyway)'),
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
    what: 'Tell me appointments and repeating things ("Linear Algebra every Monday at 10 in H1 until February") and I keep them in Schedule.md in your vault; a calendar view with month, week and agenda. A routine can sync your Google Calendar in. With the Todoist or TickTick connector, your dated tasks appear in the calendar too: press Sync in the calendar (or I save them whenever I look them up), then open one to reschedule it or mark it done.',
    say: ['"I have the dentist on the 28th at 2"', '"What\'s on tomorrow?"', '"Skip the lecture next Monday"'],
    where: 'Calendar (Ctrl+4).',
    status: (s) => (s.calendar.enabled ? 'on' : 'off'),
  },
  {
    id: 'connectors',
    title: 'Claude connectors and plugins',
    what: 'With the Claude account brain I can use the services connected to your claude.ai account (Google Calendar, Todoist, Plaud, Wolfram, DeepL, Canva, Figma…) and your Claude Code plugins. Each service is set to ask every time, allow reading, allow all but deleting, or allow everything: tell me ("stop asking about Google Calendar"), press "Always allow…" when I ask, or set it in Settings. I suggest a connector when a task would go better with one.',
    say: ['"Which connectors do I have?"', '"What\'s on my Google Calendar tomorrow?"', '"Stop asking me before reading my calendar"', '"Add this to my Todoist"'],
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
    id: 'architecture',
    title: 'How I am built (and how to design software like it)',
    what: 'The Arch view is a living map of my own code, drawn in the C4 style: zoom from the big picture (you, my processes, the outside services I use) into each part, then its components, its files and the functions inside them. Lines show how the parts talk: calls, IPC through the preload bridge, events, HTTP, processes and files. Click any part for what it does, what it talks to and the design idea behind it; 🎓 Learn explains the map and the principles you can reuse in your own projects. After I change my own code, Rebuild redraws it and marks the new parts. ▶ Replay plays my whole history on the map: files appear and grow commit by commit, the ones a commit touched glow, and my own self-changes are marked (Evolution → Watch the history opens it too). The map is on your phone and tablet as well.',
    say: ['"Explain how your Claude Code bridge works"', '"Quiz me on your architecture"', '"Help me design the architecture of my project"'],
    where: 'Arch view (rail) → 🎓 Learn, ▶ Replay, ⟳ Rebuild.',
    status: () => 'always on',
  },
  {
    id: 'performance',
    title: 'Running well on lighter computers',
    what: 'I check your computer once (and every 30 days) and pick a profile. Full keeps everything. Balanced, for lighter computers, runs speech recognition on the processor with a smaller model that loads only when you talk and leaves memory after 10 quiet minutes (in-app recognition needs over 1 GB while loaded; cloud recognition avoids that), keeps the effects without motion or blur (and pauses them while the window is in the background), draws faces at 30 frames a second without glow, and keeps at most two Claude sessions alive. The system monitor panel shows what I use right now, with buttons to free each part.',
    say: ['"Why is the speech model smaller?"', '"How much memory are you using?"'],
    where: 'Settings → Interface → Performance; click the CPU · RAM meter in the title bar → Siren.',
    status: (s) => `${(s.perf?.mode || 'auto') === 'auto' ? 'auto: ' : ''}${require('./perfcore').profile(s) === 'balanced' ? 'Balanced' : 'Full'}`,
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
    title: 'Diagrams, charts and study material',
    what: 'I draw diagrams as clean HTML + SVG pages (architecture, flowchart, sequence, timeline, quadrant, mind of a proof…) and open them in a window; they are kept in Diagrams/ in your vault. Charts are computed exactly (function plots like sin(x) or a parabola, data lines, scatter and bar charts). For studying I make complete packs: a vault note in a learning order with worked examples and practice questions, the diagrams and charts, a printable PDF with them inside and formulas typeset, and flashcards. With the diagram-design skill imported, 45 editorial diagram types.',
    say: ['"Make me a study pack for logistic regression"', '"Plot sin(x) and its derivative"', '"Make a one-page cheat sheet PDF for my exam"', '"Make a timeline of the French Revolution"'],
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
    title: 'Your phone, tablet and Galaxy Watch',
    what: 'Pair a phone or tablet (the Android app, or any browser, Safari on an iPhone or iPad included) to talk to me away from the desk: chat, voice, the same face, approvals, and your day: Today, habits to check off, learning, memories, notes, the skill tree, the Inner World and the map of my own architecture (More → Architecture: pinch to zoom from containers to files, tap a part and ask me to explain it). On a tablet or in Samsung DeX the chat and those screens sit side by side. Your custom face and formulas show there as on the desktop, and the face has a full-screen mode. When you switch my persona or change my look here, paired devices and the watch follow at once. Settings → Remote access shows which device is connected now and when each was last seen (and which face the watch has); the Remote pill’s tooltip says the same, and a toast tells you when a device connects or has been gone a few minutes. A device can be made view only, and the Android app can lock with your fingerprint, face or screen lock. On a Galaxy Watch (4 or newer), tap me and ask (I listen on my own screen); I answer on your wrist in my voice and with my face, through the phone app. Over Wi-Fi or a secure address (Tailscale or Cloudflare).',
    say: ['"How do I use you from my phone?"'],
    where: 'Settings → Remote access.',
    status: (s) => (s.remote?.enabled ? 'on' : 'off'),
  },
  {
    id: 'watch',
    title: 'Installing me on your Galaxy Watch',
    what: 'The watch app (Galaxy Watch 4 or newer) is installed from this computer over Wi-Fi, once: pair the Siren phone app first; get the phone and watch apps from the same release; on the watch turn on developer options (tap Software version five times), ADB debugging and Wireless debugging, then "Pair new device"; on the computer run adb pair, adb connect and adb install Siren-Wear-x.y.z.apk. I can run those commands for you if adb is installed: you read me the pairing code. The first start brings my face over from this computer (keep the watch screen on for a moment). The full walkthrough is the vault note "Install on your Galaxy Watch".',
    say: ['"How do I put you on my watch?"', '"Install yourself on my watch."'],
    where: 'Settings → Remote access → Install Siren on a Galaxy Watch, and the note "Install on your Galaxy Watch" in the vault.',
    status: (s) => (s.remote?.enabled ? 'phone link on' : 'turn on remote access first'),
  },
  {
    id: 'updates',
    title: 'New versions',
    what: 'Once a day I ask GitHub whether a newer Siren is out. When one is, an “Update” pill appears in the title bar: click it for what’s new and the download for this computer (it opens in your browser; install it over this one and everything stays). On the Android app, More shows the newer phone app too, and the watch app is on the same release page. Nothing is downloaded or installed on its own, and you can turn the check off.',
    say: ['"Is there a new version of you?"'],
    where: 'The Update pill in the title bar; Settings → Memory & history → Check for updates now.',
    status: (s) => (s.updates?.check === false ? 'off' : 'on'),
  },
  {
    id: 'keyboard',
    title: 'Keyboard and screen readers',
    what: 'Everything works from the keyboard: Ctrl+1 to Ctrl+8 open the views, Tab moves through the window with a visible focus ring, the arrow keys move along the rail, and each view has its own keys (the calendar’s arrows, the village’s WASD and zoom, Space to play a replay, Esc to go back a step). Screen readers hear each finished reply once, in full, instead of every streamed word, and the drawn views (the village, the architecture map, the skill tree) list their content in their side panels.',
    say: ['"Which keyboard shortcuts do you have?"', '"Can I use you with a screen reader?"'],
    where: 'docs/KEYBOARD.md lists every key per view.',
    status: () => 'always on',
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
