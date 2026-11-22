// Agent tools: The user's vault (obsidian.js): notes, daily notes, priorities, history.
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const path = require('path');
const memory = require('../memory');
const obsidian = require('../obsidian');
const store = require('../store');
const vaultgit = require('../vaultgit');
const attachcore = require('../attachcore');
const { arr, obj, str, int, requireApproval, guardWrite } = require('./common');

const DAY_MS = 86400000;
// Can a conversation (an index entry) hold messages from this local day (YYYY-MM-DD)? Its messages fall
// between its createdAt and updatedAt; a day's margin each side, and a missing time never rules it out.
function mayHoldDay(c, date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return true;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  if (!Number.isFinite(start)) return true;
  const created = Number(c?.createdAt);
  const updated = Number(c?.updatedAt);
  if (updated > 0 && updated < start - DAY_MS) return false; // last touched well before that day
  if (created > 0 && created >= start + 2 * DAY_MS) return false; // started well after it
  return true;
}

// Notes that go into every later prompt, or that the agent is told to follow (the operating manual, a
// Job's steps). After outside content a write to one asks first, in auto mode too (taintAsks): otherwise
// a web page could leave instructions that a later, clean turn reads as the user's own. (vault_write_note
// always writes a .md note, so it can't leave a package.json or .npmrc for a command to run.)
const STEERING_NOTES = new Set(['profile.md', 'active priorities.md', 'vault-index.md']);
const STEERING_FOLDERS = ['memory/', 'jobs/'];
function steersLater(ref) {
  // As obsidian.normalizeRef reads it ([[link]], |alias, #heading, .md added), then folded.
  let p = String(ref || '').replace(/^\[\[|\]\]$/g, '').split('|')[0].split('#')[0].trim().replace(/\\/g, '/');
  if (!p.toLowerCase().endsWith('.md')) p += '.md';
  p = path.posix.normalize(p).replace(/^(\.\/|\/)+/, '').toLowerCase();
  return STEERING_NOTES.has(p) || STEERING_FOLDERS.some((f) => p.startsWith(f));
}
const askIfOutside = (ctx, title, detail) => guardWrite(ctx, title, String(detail || '').slice(0, 600));

module.exports = [
  {
    name: 'vault_search',
    group: 'vault',
    description: 'Full-text search your Obsidian vault (your knowledge base). Returns matching note paths with snippets.',
    parameters: obj({ query: str('Search keywords'), limit: int('Max results (default 10)') }, ['query']),
    run: async (a) => obsidian.search(a.query, Math.min(25, a.limit || 10)),
  },
  {
    name: 'vault_links',
    group: 'vault',
    description: 'The [[wikilinks]] around one note: which notes link to it (backlinks) and which it links to. Use it to find related notes, or before renaming or merging one.',
    parameters: obj({ path: str('Vault-relative path or note name') }, ['path']),
    run: async (a) => {
      const n = await obsidian.readNote(a.path, 200);
      return require('../linkindex').forNote(await obsidian.vaultPath(), n.path);
    },
  },
  {
    name: 'vault_read_note',
    group: 'vault',
    description: 'Read a note from your vault by its vault-relative path (e.g. "Notes/Plan.md") or note name / [[wikilink]].',
    parameters: obj({ path: str('Vault-relative path or note name') }, ['path']),
    run: async (a) => {
      const n = await obsidian.readNote(a.path);
      delete n.fullPath;
      return n;
    },
  },
  {
    name: 'vault_list_notes',
    group: 'vault',
    description: 'List notes in your vault, optionally inside one folder.',
    parameters: obj({ folder: str('Vault-relative folder (optional)') }),
    run: async (a) => (await obsidian.listNotes(a.folder || '')).slice(0, 300).map((n) => n.path),
  },
  {
    name: 'vault_write_note',
    group: 'vault',
    description:
      'Create or update a Markdown note in your vault. Use folders (Notes/, Research/, Journal/YYYY-MM-DD.md, …), [[wikilinks]] and #tags. mode: "create" (new note only), "overwrite" (replace), "append" (add to the end, e.g. journal entries), "prepend".',
    parameters: obj({ path: str('Vault-relative path, e.g. "Research/Solar panels.md"'), content: str('Markdown content'), mode: { type: 'string', enum: ['create', 'overwrite', 'append', 'prepend'], description: 'Write mode (default overwrite)' } }, ['path', 'content']),
    run: async (a, ctx) => {
      if (steersLater(a.path)) await askIfOutside(ctx, `Write ${String(a.path).slice(0, 120)}`, a.content);
      const r = await obsidian.writeNote(a.path, a.content, a.mode || 'overwrite');
      ctx.emit({ type: 'vault_changed', path: r.path });
      return r;
    },
  },
  {
    name: 'vault_delete_note',
    group: 'vault',
    description: "Delete a note from your vault (moved to the vault's .trash, recoverable).",
    parameters: obj({ path: str('Vault-relative path or note name') }, ['path']),
    run: async (a, ctx) => {
      await requireApproval(ctx, 'delete', `Delete the note "${a.path}" from its vault`, 'It moves to the vault trash and stays in the vault history.');
      const r = await obsidian.deleteNote(a.path);
      ctx.emit({ type: 'vault_changed', path: r.deleted });
      return r;
    },
  },
  {
    name: 'memory_get',
    group: 'memory',
    description: 'Load the full text of memories by id (the system prompt may only list titles when there are many).',
    parameters: obj({ ids: arr('Memory ids') }, ['ids']),
    run: async (a) => Promise.all((a.ids || []).slice(0, 30).map(async (id) => (await memory.get(id)) || { id, error: 'not found' })),
  },
  {
    name: 'daily_note_log',
    group: 'vault',
    description:
      "Append a session entry to today's daily note (append-only; never overwrites). Use at natural wrap-up points, after finishing something notable, or to reconstruct a missing day (pass date). Keep items short and factual.",
    parameters: obj(
      {
        topic: str('3-6 word topic'),
        outcome: str('One past-tense sentence'),
        done: arr('What got done'),
        in_progress: arr('What is still in progress'),
        decisions: arr('Decisions made'),
        notes_touched: arr('Vault notes created/edited/used'),
        date: str('YYYY-MM-DD (optional, default today — check the real date first)'),
      },
      ['topic', 'outcome'],
    ),
    run: async (a, ctx) => {
      const r = await obsidian.logSession({ date: a.date, topic: a.topic, outcome: a.outcome, done: a.done, inProgress: a.in_progress, decisions: a.decisions, notesTouched: a.notes_touched });
      ctx.emit({ type: 'vault_changed', path: r.path });
      return r;
    },
  },
  {
    name: 'priorities_update',
    group: 'vault',
    description:
      'Rewrite Active Priorities.md — the single list of open work (sections: Now, Next, Waiting on, Done recently; Markdown checkboxes). Its current content is in your context; keep everything still relevant and only change what the user asked or what verifiably changed.',
    parameters: obj({ content: str('Full new Markdown content of the note') }, ['content']),
    run: async (a, ctx) => {
      await askIfOutside(ctx, 'Rewrite your Active Priorities', a.content);
      const r = await obsidian.writePriorities(a.content);
      ctx.emit({ type: 'vault_changed', path: r.path });
      return r;
    },
  },
  {
    name: 'profile_update',
    group: 'vault',
    description: `Update the user's living profile (Profile.md) with something you learned. You may only change these sections: ${obsidian.PROFILE_AGENT_SECTIONS.join(', ')}. Few, high-quality updates; replace contradicted facts. Every change is logged.`,
    parameters: obj({ section: { type: 'string', enum: obsidian.PROFILE_AGENT_SECTIONS }, content: str('Text to add (or the full new section text when mode is replace)'), mode: { type: 'string', enum: ['append', 'replace'] } }, ['section', 'content']),
    run: async (a, ctx) => {
      await askIfOutside(ctx, `Update your profile (${String(a.section).slice(0, 60)})`, a.content);
      const r = await obsidian.updateProfile(a.section, a.content, a.mode || 'append');
      ctx.emit({ type: 'vault_changed', path: 'Profile.md' });
      return r;
    },
  },
  {
    name: 'job_save',
    group: 'vault',
    description:
      'Create or replace a Job note (Jobs/<name>.md): the reusable procedure for a recurring task — purpose, numbered steps, quality bar, notes to read first, lessons learned. Save one whenever you work out how to do a recurring task well.',
    parameters: obj({ name: str('Job name, e.g. "Weekly review"'), purpose: str('One sentence'), procedure: arr('Steps in order'), quality_bar: arr('What "good" looks like'), read_first: arr('Vault notes to read before doing it'), lessons: arr('Lessons learned / dead ends to avoid') }, ['name', 'purpose', 'procedure']),
    run: async (a, ctx) => {
      await askIfOutside(ctx, `Save the job "${String(a.name).slice(0, 80)}"`, [a.purpose, ...(a.procedure || [])].join('\n'));
      const r = await obsidian.saveJob({ name: a.name, purpose: a.purpose, procedure: a.procedure, qualityBar: a.quality_bar, related: a.read_first, lessons: a.lessons });
      ctx.emit({ type: 'vault_changed', path: r.path });
      return r;
    },
  },
  {
    name: 'job_add_lesson',
    group: 'vault',
    description: 'Add a lesson learned to an existing Job note after doing the job (what worked, what to avoid next time).',
    parameters: obj({ name: str('Job name'), lesson: str('The lesson') }, ['name', 'lesson']),
    run: async (a, ctx) => {
      await askIfOutside(ctx, `Add a lesson to the job "${String(a.name).slice(0, 80)}"`, a.lesson);
      return obsidian.addJobLesson(a.name, a.lesson);
    },
  },
  {
    name: 'vault_note_history',
    group: 'vault',
    description: 'List earlier versions of a vault note (every change is versioned).',
    parameters: obj({ path: str('Vault-relative note path') }, ['path']),
    run: async (a) => {
      const { root, full } = await obsidian.resolveNote(a.path);
      return vaultgit.history(root, require('path').relative(root, full).split(require('path').sep).join('/'));
    },
  },
  {
    name: 'vault_restore_note',
    group: 'vault',
    description: 'Restore a vault note to an earlier version (from vault_note_history). The restore itself is versioned too.',
    parameters: obj({ path: str('Vault-relative note path'), version: str('Version id') }, ['path', 'version']),
    run: async (a, ctx) => {
      const root = await obsidian.vaultPath();
      const rel = a.path.endsWith('.md') ? a.path : `${a.path}.md`;
      const r = await vaultgit.restore(root, rel, a.version);
      ctx.emit({ type: 'vault_changed', path: rel });
      return r;
    },
  },
  {
    name: 'history_search',
    group: 'memory',
    description: 'Search past conversations with the user (by keywords and/or a date YYYY-MM-DD). Use to recall earlier discussions or to reconstruct a missing daily note.',
    parameters: obj({ query: str('Keywords (optional)'), date: str('YYYY-MM-DD (optional)') }),
    run: async (a) => {
      const terms = String(a.query || '').toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      const out = [];
      let read = 0;
      for (const c of await store.listConversations()) {
        // With a date, only conversations whose [createdAt, updatedAt] can hold that day are opened.
        if (a.date && !mayHoldDay(c, a.date)) continue;
        // Each file is read and unsealed on the main thread: let the window breathe between a few.
        if (++read % 8 === 0) await new Promise((r) => setImmediate(r));
        const conv = await store.getConversation(c.id);
        for (const m of conv?.messages || []) {
          const day = new Date(m.createdAt || conv.updatedAt);
          const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
          if (a.date && ymd !== a.date) continue;
          // Attached files' old text never comes back here untainted: their names and saved copies do.
          const text = m.attachments?.length ? attachcore.summaryLine(m) : String(m.content || '');
          const lower = text.toLowerCase();
          if (terms.length && !terms.every((t) => lower.includes(t))) continue;
          const at = terms.length ? Math.max(0, lower.indexOf(terms[0]) - 80) : 0;
          out.push({ conversation: conv.title, date: ymd, time: day.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), role: m.role, text: text.slice(at, at + 400) });
          if (out.length >= 40) return out;
        }
      }
      return out.length ? out : 'No matching messages.';
    },
  },
];
