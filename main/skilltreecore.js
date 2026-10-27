// The skill tree (Skill Tree.md in the vault): the skills the user is growing, their prerequisites, and
// where progress comes from. One line per skill, readable in Obsidian, with the data in a JSON comment:
//   - **Real Analysis** — rigorous calculus <!-- skill {"area":"Math","needs":["Calculus"],"from":[{"type":"learning","name":"Real Analysis"}]} -->
// Progress is computed, never stored: from the learning tracker (concepts understood), vocabulary decks
// (mature cards), habits (consistency over four weeks), or a manual estimate. Pure: no I/O.

const SKILL = /^\s*[-*]\s+\*\*(.+?)\*\*(?:\s*[—–-]\s*(.*?))?\s*(?:<!--\s*skill\s+(\{.*\})\s*-->)?\s*$/;
const SOURCE_TYPES = ['learning', 'deck', 'habit'];
const DEFAULT_TARGET = { learning: 12, deck: 300, habit: 1 }; // concepts understood, mature cards, (rate)
const UNLOCK_AT = 0.6; // a prerequisite this far along unlocks what builds on it
const MASTERED_AT = 0.9;
const MAX_SKILLS = 120;

const keyOf = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
const clean = (s, n = 80) => String(s ?? '').replace(/\s*\n\s*/g, ' ').replace(/\*\*|<!--|-->/g, '').trim().slice(0, n);
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

function parse(text) {
  const lines = String(text || '').split(/\r?\n/);
  const skills = [];
  const before = [];
  const after = [];
  let seen = false;
  for (const line of lines) {
    const m = SKILL.exec(line);
    if (m) {
      seen = true;
      let data = {};
      try {
        data = m[3] ? JSON.parse(m[3]) : {};
      } catch {
        data = {}; // a hand-edited comment that broke: keep the skill, drop the data
      }
      skills.push(normalizeSkill({ name: m[1], description: m[2] || '', ...data }));
    } else (seen ? after : before).push(line);
  }
  return { skills, before: before.join('\n').trimEnd(), after: after.join('\n').trim() };
}

function normalizeSkill(s) {
  const out = {
    name: clean(s.name, 60),
    description: clean(s.description, 160),
    area: clean(s.area, 30),
    needs: [...new Set((Array.isArray(s.needs) ? s.needs : []).map((n) => clean(n, 60)).filter(Boolean))],
    from: (Array.isArray(s.from) ? s.from : []).filter((x) => x && SOURCE_TYPES.includes(x.type) && clean(x.name)).map((x) => ({ type: x.type, name: clean(x.name, 80), ...(Number(x.target) > 0 ? { target: Math.round(Number(x.target)) } : {}) })),
  };
  if (s.manual !== undefined && s.manual !== null && s.manual !== '') out.manual = clamp01(s.manual);
  return out;
}

function serialize(tree) {
  const line = (s) => {
    const { name, description, ...data } = s;
    if (!data.needs.length) delete data.needs;
    if (!data.from.length) delete data.from;
    if (!data.area) delete data.area;
    return `- **${name}**${description ? ` — ${description}` : ''} <!-- skill ${JSON.stringify(data)} -->`;
  };
  const head = tree.before || '---\ntype: skill-tree\n---\n# Skill Tree\n\nThe skills you are growing and what each builds on. Progress comes from your learning tracker, vocabulary decks and habits; the Skill tree view shows it. Edit freely; keep the `<!-- skill … -->` comments.\n\n## Skills';
  return `${[head, tree.skills.map(line).join('\n'), tree.after].filter((x) => x && x.trim()).join('\n\n')}\n`;
}

const find = (tree, name) => tree.skills.find((s) => keyOf(s.name) === keyOf(name));

// Would `name` needing `needs` close a loop (A needs B needs … A)?
function createsCycle(tree, name, needs) {
  const graph = new Map(tree.skills.map((s) => [keyOf(s.name), s.needs.map(keyOf)]));
  graph.set(keyOf(name), needs.map(keyOf));
  const seen = new Set();
  const visit = (k, path) => {
    if (path.has(k)) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    path.add(k);
    const loop = (graph.get(k) || []).some((n) => visit(n, path));
    path.delete(k);
    return loop;
  };
  return visit(keyOf(name), new Set());
}

/** Adds or updates skills (merging fields given); prerequisites that don't exist yet are created bare. */
function upsert(tree, items) {
  const out = { ...tree, skills: tree.skills.map((s) => ({ ...s, needs: [...s.needs], from: s.from.map((f) => ({ ...f })) })) };
  const changed = [];
  for (const raw of items || []) {
    const name = clean(raw.name, 60);
    if (!name) throw new Error('Every skill needs a name.');
    const old = find(out, name);
    const next = normalizeSkill({ ...(old || {}), ...raw, name: old?.name || name, needs: raw.needs ?? old?.needs, from: raw.from ?? old?.from });
    if (raw.manual === null) delete next.manual;
    next.needs = next.needs.filter((n) => keyOf(n) !== keyOf(name));
    if (createsCycle(out, name, next.needs)) throw new Error(`"${name}" can't need ${next.needs.join(', ')}: that would make a loop.`);
    for (const n of next.needs) if (!find(out, n)) out.skills.push(normalizeSkill({ name: n, area: next.area }));
    if (old) Object.assign(old, next);
    else out.skills.push(next);
    changed.push(next.name);
  }
  if (out.skills.length > MAX_SKILLS) throw new Error(`A tree of more than ${MAX_SKILLS} skills is hard to use; merge some.`);
  return { tree: out, changed };
}

/** Removes a skill; skills that needed it lose that prerequisite. */
function remove(tree, name) {
  const s = find(tree, name);
  if (!s) throw new Error(`No skill called "${name}".`);
  return { ...tree, skills: tree.skills.filter((x) => x !== s).map((x) => ({ ...x, needs: x.needs.filter((n) => keyOf(n) !== keyOf(s.name)) })) };
}

/**
 * Progress and state per skill. evidence: { learning: [{ topic, understood, shakyCount, questionCount }],
 * decks: [{ language, mature, total }], habits: [{ name, rate28, streak, streakUnit, paused }] }.
 */
function compute(tree, evidence = {}) {
  const by = (list, field) => new Map((list || []).map((x) => [keyOf(x[field]), x]));
  const learning = by(evidence.learning, 'topic');
  const decks = by(evidence.decks, 'language');
  const habits = by(evidence.habits, 'name');
  const own = new Map();
  for (const s of tree.skills) {
    const parts = s.from.map((f) => {
      const target = f.target || DEFAULT_TARGET[f.type];
      if (f.type === 'learning') {
        const t = learning.get(keyOf(f.name));
        if (!t) return { ...f, progress: 0, detail: 'no tracker yet' };
        // Shaky concepts and open questions count as known unknowns: they raise the bar.
        const bar = Math.max(target, t.understood + (t.shakyCount || 0) + (t.questionCount || 0));
        return { ...f, progress: clamp01(t.understood / bar), detail: `${t.understood} understood${t.shakyCount ? `, ${t.shakyCount} shaky` : ''}${t.questionCount ? `, ${t.questionCount} open` : ''}` };
      }
      if (f.type === 'deck') {
        const d = decks.get(keyOf(f.name));
        if (!d) return { ...f, progress: 0, detail: 'no deck yet' };
        // A flashcard or vocabulary deck: mature cards (21+ days, Anki's "known") of the whole deck,
        // up to 300; a target set on the link wins.
        const goal = f.target || Math.min(DEFAULT_TARGET.deck, Math.max(10, d.total));
        return { ...f, progress: clamp01(d.mature / goal), detail: `${d.mature} of ${goal} cards mature (${d.total} in the deck)` };
      }
      const h = habits.get(keyOf(f.name));
      if (!h) return { ...f, progress: 0, detail: 'not tracked yet' };
      return { ...f, progress: clamp01(h.rate28), detail: `${Math.round(h.rate28 * 100)}% of the target over four weeks${h.streak ? `, streak ${h.streak} ${h.streakUnit}` : ''}${h.paused ? ' (paused)' : ''}` };
    });
    const measured = parts.length ? parts.reduce((a, p) => a + p.progress, 0) / parts.length : 0;
    own.set(keyOf(s.name), { parts, progress: s.manual !== undefined ? Math.max(s.manual, measured) : measured });
  }
  return tree.skills.map((s) => {
    const o = own.get(keyOf(s.name));
    const blockers = s.needs.filter((n) => (own.get(keyOf(n))?.progress ?? 0) < UNLOCK_AT);
    const state = o.progress >= MASTERED_AT ? 'mastered' : blockers.length && o.progress === 0 ? 'locked' : o.progress > 0 ? 'growing' : 'ready';
    return { ...s, progress: Math.round(o.progress * 100) / 100, state, blockers, sources: o.parts };
  });
}

/**
 * Constellation layout: columns by depth (how many prerequisites deep), rows grouped by area.
 * Returns { x, y } in 0..1 per skill name, plus the edges.
 */
function layout(skills) {
  const byKey = new Map(skills.map((s) => [keyOf(s.name), s]));
  const depth = new Map();
  const depthOf = (k, guard = 0) => {
    if (depth.has(k)) return depth.get(k);
    const s = byKey.get(k);
    const d = !s || guard > 50 ? 0 : s.needs.length ? 1 + Math.max(...s.needs.map((n) => depthOf(keyOf(n), guard + 1))) : 0;
    depth.set(k, d);
    return d;
  };
  skills.forEach((s) => depthOf(keyOf(s.name)));
  const maxDepth = Math.max(0, ...depth.values());
  const areas = [...new Set(skills.map((s) => s.area || ''))];
  const columns = new Map();
  for (const s of skills) {
    const d = depth.get(keyOf(s.name));
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(s);
  }
  const pos = {};
  for (const [d, list] of columns) {
    list.sort((a, b) => areas.indexOf(a.area || '') - areas.indexOf(b.area || '') || a.name.localeCompare(b.name));
    list.forEach((s, i) => (pos[s.name] = { x: maxDepth ? d / maxDepth : 0.5, y: list.length > 1 ? i / (list.length - 1) : 0.5, depth: d }));
  }
  const edges = skills.flatMap((s) => s.needs.filter((n) => byKey.has(keyOf(n))).map((n) => ({ from: byKey.get(keyOf(n)).name, to: s.name })));
  return { pos, edges, depth: maxDepth, areas };
}

module.exports = { SOURCE_TYPES, UNLOCK_AT, MASTERED_AT, parse, serialize, upsert, remove, compute, layout, keyOf };
