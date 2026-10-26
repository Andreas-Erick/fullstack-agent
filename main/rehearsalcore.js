// Rehearsal: a scene the user is preparing for (a negotiation, an interview, a hard conversation),
// played out by independent characters before the real thing. Each character is its own model call
// that sees only the conversation and its own private goal (the persona simulations of Microsoft's
// TinyTroupe), a stand-in plays the user's role with the approach they chose, and a debrief at the end
// reveals what everyone was after and what to take into the real conversation.
// Pure (no Electron, no I/O): rehearsal.js runs it and saves it in the vault.

const MAX_CHARACTERS = 4;
const MAX_CALLS = 24; // turns per rehearsal, all characters and the stand-in together
const DONE = '[DONE]';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** A rehearsal spec from untrusted input (tool arguments). Throws with what is missing. */
function validate(a) {
  const scenario = clip(a?.scenario, 2000);
  if (!scenario) throw new Error('Describe the scene: who is there, what is at stake, where it happens.');
  const userRole = clip(a?.user_role, 200) || 'the user';
  const seen = new Set(['you']);
  const characters = (Array.isArray(a?.characters) ? a.characters : [])
    .map((c) => ({ name: clip(c?.name, 40), role: clip(c?.role, 200), goal: clip(c?.goal, 400), style: clip(c?.style, 300) }))
    .filter((c) => c.name && !seen.has(c.name.toLowerCase()) && seen.add(c.name.toLowerCase()))
    .slice(0, MAX_CHARACTERS);
  if (!characters.length) throw new Error('Give at least one character (name, role, what they privately want).');
  const perRound = characters.length + 1;
  const rounds = Math.max(1, Math.min(Number.isInteger(a?.rounds) ? a.rounds : 4, 6, Math.floor(MAX_CALLS / perRound)));
  return {
    title: clip(a?.title, 80) || clip(scenario, 60),
    scenario,
    userRole,
    approach: clip(a?.user_approach, 600) || 'Do what a thoughtful, reasonably skilled person would do.',
    characters,
    rounds,
    opener: a?.opener === 'user' ? 'user' : characters[0].name, // 'character' or nothing: the first character opens
  };
}

/** Who speaks when: rounds of (opener first, then everyone else in order). */
function order(spec) {
  const all = ['You', ...spec.characters.map((c) => c.name)];
  const first = spec.opener === 'user' ? 'You' : spec.opener;
  const round = [first, ...all.filter((n) => n !== first)];
  return Array.from({ length: spec.rounds }, () => round).flat();
}

const transcriptText = (lines) => (lines.length ? lines.map((l) => `${l.who}: ${l.text}`).join('\n') : '(nobody has spoken yet)');

/** The prompt for one character's next turn: it knows the scene, its own goal and what was said. */
function characterPrompt(spec, name, lines) {
  const c = spec.characters.find((x) => x.name === name);
  const others = spec.characters.filter((x) => x.name !== name).map((x) => `${x.name} (${x.role || 'present'})`);
  return `You are ${c.name}${c.role ? `, ${c.role}` : ''}, in a realistic rehearsal of a real conversation. Stay in character.
THE SCENE: ${spec.scenario}
Also present: "You" (${spec.userRole})${others.length ? `, ${others.join(', ')}` : ''}.
${c.goal ? `YOUR PRIVATE GOAL (the others don't know it; pursue it the way a real person would, without announcing it): ${c.goal}\n` : ''}${c.style ? `HOW YOU COME ACROSS: ${c.style}\n` : ''}
Be realistic: neither a pushover nor a caricature. Push back where a real person would, concede when it serves you, ask what you would ask.

CONVERSATION SO FAR
${transcriptText(lines)}

Write only your next turn: what you say, 1-4 sentences (a brief action in *asterisks* is fine). If the conversation has clearly come to its end, write only ${DONE}.`;
}

/** The prompt for the stand-in who plays the user's role with the user's chosen approach. */
function standInPrompt(spec, lines) {
  return `You are playing "You" (${spec.userRole}) in a rehearsal the real person is using to prepare for this conversation.
THE SCENE: ${spec.scenario}
Present: ${spec.characters.map((c) => `${c.name} (${c.role || 'present'})`).join(', ')}.
THE APPROACH TO TRY: ${spec.approach}
Play it as a capable but human person would: follow the approach, adapt to what you hear, don't be perfect.

CONVERSATION SO FAR
${transcriptText(lines)}

Write only your next turn, 1-4 sentences. If the conversation has clearly come to its end, write only ${DONE}.`;
}

/** One spoken turn from a model reply: no speaker prefix, no quotes around it; null when it ended. */
function parseTurn(text, name) {
  let t = String(text || '').trim();
  if (!t || t.includes(DONE)) return null;
  t = t.replace(new RegExp(`^\\**\\s*(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|You)\\s*\\**\\s*:\\s*\\**\\s*`, 'i'), '');
  t = t.replace(/^"(.*)"$/s, '$1');
  return clip(t, 700) || null;
}

/** The prompt for the debrief: the whole transcript, and what each character was really after. */
function debriefPrompt(spec, lines) {
  return `You are a sharp, kind coach. The user rehearsed a conversation they are about to have; "You" was a stand-in trying their approach. Debrief it so they walk in better prepared.
THE SCENE: ${spec.scenario}
THE USER'S ROLE: ${spec.userRole}
THE APPROACH TRIED: ${spec.approach}
WHAT EACH CHARACTER PRIVATELY WANTED:
${spec.characters.map((c) => `- ${c.name}${c.role ? ` (${c.role})` : ''}: ${c.goal || 'nothing hidden'}`).join('\n')}

TRANSCRIPT
${transcriptText(lines)}

Respond with ONLY a JSON object:
{"outcome": "one sentence: how it ended",
 "summary": "2-3 sentences: what happened and why",
 "worked": ["moves that helped"],
 "risks": ["where it went or could go wrong"],
 "objections": ["what to expect from them in the real conversation"],
 "lines": ["concrete sentences the user could say"],
 "next": "one suggestion: what to change in the approach, or what to rehearse next"}
2-4 items per list. Be specific to this transcript; don't invent what wasn't said.`;
}

function parseDebrief(json) {
  const list = (v) => (Array.isArray(v) ? v.map((x) => clip(x, 300)).filter(Boolean).slice(0, 5) : []);
  if (!json?.summary && !json?.outcome) throw new Error('No debrief in the reply.');
  return { outcome: clip(json.outcome, 240), summary: clip(json.summary, 700), worked: list(json.worked), risks: list(json.risks), objections: list(json.objections), lines: list(json.lines), next: clip(json.next, 300) };
}

/** The rehearsal as a vault note. */
function markdown(spec, lines, debrief, at = Date.now()) {
  const items = (title, list) => (list?.length ? ['', `### ${title}`, ...list.map((x) => `- ${x}`)] : []);
  return [
    `# Rehearsal: ${spec.title}`,
    '',
    `_${new Date(at).toLocaleString()} · played on the Stage in the Inner World_`,
    '',
    `**The scene:** ${spec.scenario}`,
    '',
    `**You:** ${spec.userRole}. Approach: ${spec.approach}`,
    ...spec.characters.map((c) => `**${c.name}:** ${c.role || ''}`),
    '',
    '## The conversation',
    '',
    ...lines.map((l) => `> **${l.who}:** ${l.text}`),
    '',
    '## Debrief',
    '',
    debrief ? `**Outcome:** ${debrief.outcome}\n\n${debrief.summary}` : '_No debrief (the coach did not answer)._',
    ...items('What worked', debrief?.worked),
    ...items('Risks', debrief?.risks),
    ...items('Expect from them', debrief?.objections),
    ...items('Lines to use', debrief?.lines),
    ...(debrief?.next ? ['', `**Next:** ${debrief.next}`] : []),
    '',
    '### What each of them wanted',
    ...spec.characters.map((c) => `- **${c.name}:** ${c.goal || 'nothing hidden'}`),
    '',
  ].join('\n');
}

module.exports = { MAX_CHARACTERS, MAX_CALLS, DONE, validate, order, characterPrompt, standInPrompt, parseTurn, debriefPrompt, parseDebrief, markdown };
