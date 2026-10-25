// Which of the user's skills, connectors, plugins and extensions fit a task (tool capabilities_for), so the
// agent can pick one on its own and suggest the ones that need the user (sign in, turn on, add).
// `match` is pure (tested in test/capabilities.test.js); `inventory` gathers what this computer has.

// Well-known services and the words of a request they help with. Used to recognize the user's
// connectors and plugins by name, and to suggest one they could add (never one that doesn't exist).
const SERVICES = [
  { id: 'todoist', label: 'Todoist', words: ['task', 'tasks', 'todo', 'todos', 'to-do', 'checklist', 'project'] },
  { id: 'google calendar', label: 'Google Calendar', words: ['google calendar', 'meeting', 'meetings', 'invite', 'availability', 'free slot'], ownFirst: 'the schedule in the vault (calendar tools)' },
  { id: 'gmail', label: 'Gmail', words: ['email', 'emails', 'mail', 'inbox', 'gmail', 'reply to'] },
  { id: 'notion', label: 'Notion', words: ['notion', 'wiki', 'workspace page'] },
  { id: 'slack', label: 'Slack', words: ['slack', 'channel', 'dm', 'team message'] },
  { id: 'linear', label: 'Linear', words: ['linear', 'issue', 'issues', 'ticket', 'tickets', 'sprint'] },
  { id: 'atlassian', label: 'Jira / Confluence', words: ['jira', 'confluence', 'ticket', 'epic'] },
  { id: 'canva', label: 'Canva', words: ['canva', 'poster', 'flyer', 'social post', 'banner', 'invitation card', 'presentation design'] },
  { id: 'figma', label: 'Figma', words: ['figma', 'mockup', 'wireframe', 'prototype', 'ui design'] },
  { id: 'google slides', label: 'Google Slides', words: ['slides', 'slide deck', 'presentation'] },
  { id: 'deepl', label: 'DeepL', words: ['translate', 'translation', 'proofread'] },
  { id: 'wolfram', label: 'Wolfram', words: ['calculate', 'integral', 'derivative', 'equation', 'solve', 'plot', 'unit conversion'] },
  { id: 'consensus', label: 'Consensus', words: ['paper', 'papers', 'study', 'studies', 'research', 'evidence', 'scientific'] },
  { id: 'scispace', label: 'SciSpace', words: ['paper', 'papers', 'literature', 'citation'] },
  { id: 'accuweather', label: 'AccuWeather', words: ['weather', 'forecast', 'rain', 'temperature'] },
  { id: 'booking', label: 'Booking.com', words: ['hotel', 'hotels', 'accommodation', 'stay'] },
  { id: 'expedia', label: 'Expedia', words: ['flight', 'flights', 'hotel', 'trip'] },
  { id: 'kiwi', label: 'Kiwi.com', words: ['flight', 'flights', 'cheap flight'] },
  { id: 'tripadvisor', label: 'Tripadvisor', words: ['hotel', 'restaurant', 'things to do'] },
  { id: 'excalidraw', label: 'Excalidraw', words: ['whiteboard', 'sketch', 'diagram'] },
  { id: 'mindmap', label: 'MindMap AI', words: ['mind map', 'mindmap', 'brainstorm'] },
  { id: 'kahoot', label: 'Kahoot!', words: ['kahoot', 'quiz game', 'class quiz'] },
  { id: 'plaud', label: 'Plaud', words: ['recording', 'recordings', 'transcript', 'meeting notes'] },
  { id: 'hugging face', label: 'Hugging Face', words: ['hugging face', 'model card', 'dataset', 'open model'] },
  { id: 'github', label: 'GitHub', words: ['github', 'repo', 'repository', 'pull request'], ownFirst: 'the GitHub tools' },
];

// The extensions in extensions.js and what they are for.
const EXTENSION_WORDS = {
  rea: ['reverse engineer', 'how does this app work', 'how does this website work', 'binary', 'decompile', 'bundle', 'electron app', 'minified'],
  godseye: ['flight', 'flights', 'aircraft', 'plane', 'planes', 'flying', 'ship', 'ships', 'vessel', 'satellite', 'satellites', 'iss', 'earthquake', 'earthquakes', 'wildfire', 'fires', 'launch', 'globe', 'world map'],
};

const norm = (t) => ` ${String(t || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]+/gu, ' ').replace(/\s+/g, ' ').trim()} `;
const has = (text, phrase) => text.includes(` ${phrase} `);
const words = (t) => norm(t).trim().split(' ').filter((w) => w.length > 2);
const STOP = new Set('the and for with that this from your you are was can will what when how who into about please help make need want our out its just'.split(' '));
// Words in connector names that say nothing about what a request needs.
const GENERIC = new Set([...STOP, ...'have been docs search data viewer platform developer music claude academy plugin productivity engineering free'.split(' ')]);

function serviceOf(name) {
  const n = norm(name);
  return SERVICES.find((s) => has(n, s.id) || has(n, norm(s.label).trim())) || null;
}

// "flowcharts" and "flowchart", "diagrams" and "diagram" count as the same word.
const stem = (w) => (w.length > 4 ? w.replace(/ies$/, 'y').replace(/(?<=[^s])s$/, '') : w);
const stems = (t) => new Set(words(String(t).replace(/-/g, ' ')).filter((w) => !STOP.has(w)).map(stem));

/** Score a skill: a trigger phrase wins; else the request's words in its name (3) and description (2). */
function skillScore(text, skill) {
  if ((skill.triggers || []).some((t) => t && norm(t).trim() && text.includes(norm(t).trim()))) return 10;
  const req = stems(text);
  const name = stems(`${skill.name} ${skill.slug}`);
  let score = 0;
  for (const w of name) if (req.has(w)) score += 3;
  for (const w of stems(skill.description)) if (!name.has(w) && req.has(w)) score += 2;
  return score;
}

/**
 * @param {string} task the user's request
 * @param {object} inv { skills: [{slug,name,description,triggers}], connectors: [{name,status,source}] | null,
 *   connectorsOn: bool, claudeBrain: bool, extensions: [{id,name,on,ready}] }
 * @returns {{ use: object[], suggest: object[] }}
 */
function match(task, inv) {
  const text = norm(task);
  const use = [];
  const suggest = [];
  for (const s of inv.skills || []) {
    const score = skillScore(text, s);
    if (score >= 4) use.push({ kind: 'skill', name: s.name, how: `skill_run "${s.slug}"`, score });
  }
  // Connectors and plugins the user has, recognized by name; then well-known ones they could add.
  const relevant = SERVICES.filter((svc) => svc.words.some((w) => has(text, w)) || has(text, svc.id));
  const seen = new Set();
  for (const c of inv.connectors || []) {
    const svc = serviceOf(c.name);
    const short = c.name.replace(/^claude\.ai /, '').replace(/^plugin:[^:]+:/, '');
    const hit = svc ? relevant.includes(svc) : words(short).some((w) => w.length >= 4 && !GENERIC.has(w) && has(text, w));
    if (!hit) continue;
    if (svc) seen.add(svc.id);
    const note = svc?.ownFirst ? ` Prefer ${svc.ownFirst} unless the user means this service.` : '';
    const kind = c.source === 'plugin' ? 'plugin' : 'connector';
    if (c.status === 'connected' && inv.connectorsOn && inv.claudeBrain) use.push({ kind, name: short, how: `ToolSearch for ${short}, then its tools (each call asks the user unless always-allowed).${note}` });
    else if (c.status === 'connected') suggest.push({ kind, name: short, why: 'connected to the account but not usable here', action: inv.claudeBrain ? 'The user turns on "Use my Claude connectors and plugins" (Settings → AI brain).' : 'Needs the Claude account brain with connectors on (Settings → AI brain).' });
    else if (c.status === 'needs-auth') suggest.push({ kind, name: short, why: 'installed, needs signing in', action: kind === 'plugin' ? `Sign in: run /mcp in Claude Code and pick ${short}.` : `Sign in on claude.ai → Settings → Connectors → ${short}.` });
    else if (c.status === 'not-configured') suggest.push({ kind, name: short, why: 'installed, not set up', action: `Set it up with /mcp in Claude Code (${short}).` });
  }
  for (const svc of relevant) {
    if (seen.has(svc.id) || svc.ownFirst) continue;
    suggest.push({ kind: 'connector', name: svc.label, why: 'a connector the user could add for this', action: 'claude.ai → Settings → Connectors → Browse (then "Check connectors" in Settings → AI brain).', optional: true });
  }
  for (const e of inv.extensions || []) {
    if (!(EXTENSION_WORDS[e.id] || []).some((w) => has(text, w))) continue;
    if (e.on && e.ready && inv.claudeBrain) use.push({ kind: 'extension', name: e.name, how: e.id === 'godseye' ? 'the gods-eye-view tools (ToolSearch), then globe_open to show it' : 'the rea tools (ToolSearch)' });
    else suggest.push({ kind: 'extension', name: e.name, why: e.on ? (e.ready ? 'on, but only the Claude account brain can use it' : 'on, but not ready') : 'off', action: 'Settings → Extensions (only the user turns extensions on).' });
  }
  use.sort((a, b) => (b.score || 0) - (a.score || 0));
  return { use: use.map(({ score, ...u }) => u).slice(0, 6), suggest: suggest.slice(0, 5) };
}

/** What this computer has: saved skills, the last connector check, the extensions. */
async function inventory(settings) {
  const [skills, cc, ext] = await Promise.all([
    require('./skills').list().catch(() => []),
    require('./claudecode').cachedConnectors().catch(() => null),
    require('./extensions').status(settings).catch(() => []),
  ]);
  const p = settings.llm?.provider;
  const claudeBrain = p === 'claude-code' || (p === 'auto' && (settings.routing?.order || []).includes('claude-code') && !(settings.routing?.disabled || []).includes('claude-code'));
  return {
    skills: skills.map((s) => ({ slug: s.slug, name: s.name, description: s.description || '', triggers: s.triggers || [] })),
    connectors: cc?.list || null,
    connectorsOn: Boolean(settings.claudeCode?.connectors),
    claudeBrain,
    extensions: ext.map((e) => ({ id: e.id, name: e.name, on: e.on, ready: e.ready })),
  };
}

module.exports = { SERVICES, match, inventory };
