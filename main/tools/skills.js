// Agent tools: Agent Skills folders (skills.js) and importing them (skillimport.js).
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const github = require('../github');
const skills = require('../skills');
const { arr, obj, str, requireApproval } = require('./common');

module.exports = [
  {
    name: 'skill_list',
    group: 'skills',
    description: "List the user's saved skills (reusable workflows): name, slash command, purpose, trigger phrases.",
    parameters: obj({}),
    run: async () => {
      const all = await skills.list();
      return all.length ? all.map((s) => ({ command: `/${s.slug}`, name: s.name, description: s.description, triggers: s.triggers, input: s.input || undefined })) : 'No skills saved yet.';
    },
  },
  {
    name: 'skill_run',
    group: 'skills',
    description: 'Load a saved skill (by name or slash command) to run it: returns its steps, which you then carry out in order with your tools. Use it when the user asks for a skill by name or says one of its trigger phrases.',
    parameters: obj({ name: str('Skill name or /command'), input: str('What the user gave it to work on (optional)') }, ['name']),
    run: async (a) => {
      const s = await skills.get(a.name);
      if (!s) throw new Error(`No skill called "${a.name}". Saved skills: ${(await skills.list()).map((x) => x.name).join(', ') || 'none'}.`);
      return { skill: s.name, purpose: s.description, input: a.input || '(none given)', steps: s.steps, ...(s.folder ? { files: s.files.slice(0, 120), howToUseFiles: `When a step names a file (e.g. "references/…"), load it with skill_file (skill "${s.slug}"). Scripts are reference only; you can't run them here.` } : {}), next: 'Carry out these steps now, in order, then report briefly what you did.' };
    },
  },
  {
    name: 'skill_file',
    group: 'skills',
    description: 'Load a companion file of a folder skill (references, templates, examples), when its steps point to one, e.g. "references/style-guide.md". Long files come in parts (offset).',
    parameters: obj({ skill: str('The skill (slug or name)'), path: str('The file inside the skill, e.g. references/type-flowchart.md'), offset: { type: 'number', description: 'Where to continue a long file (from the previous result)' } }, ['skill', 'path']),
    run: async (a) => skills.readFile(a.skill, a.path, a.offset),
  },
  {
    name: 'skill_import',
    group: 'skills',
    description:
      'Add Agent Skills (folders with a SKILL.md, the format Claude Code and Codex use) from a public GitHub repository, when the user asks. Without skills: lists what the repository offers (name, description, size). With skills (their paths or names): installs them, after the user approves. Only text is copied; nothing in a skill is run, and the repository’s license is kept with each one.',
    parameters: obj({ repo: str('owner/repo or a github.com link'), skills: arr('Paths or names from the list to install (leave out to list them)') }, ['repo']),
    run: async (a, ctx) => {
      const imp = require('../skillimport');
      if (!a.skills?.length) {
        const s = await imp.scan(a.repo);
        return { repo: s.repo, license: s.license, description: s.description, skills: s.skills.map(({ path: p, slug, name, description, files, bytes }) => ({ path: p, slug, name, description, files, kb: Math.round(bytes / 1024) })) };
      }
      await requireApproval(ctx, 'settings', `Add ${a.skills.length} skill${a.skills.length === 1 ? '' : 's'} from ${a.repo}`, a.skills.join(', '));
      const r = await imp.install(a.repo, a.skills);
      ctx.emit({ type: 'skills_changed' });
      return r;
    },
  },
  {
    name: 'skill_save',
    group: 'skills',
    description:
      'Save a reusable skill (a workflow the user wants to run again): a clear name, a one-line purpose, trigger phrases the user might say, what input it needs, and numbered steps written so you can follow them later without this conversation (name the tools to use). Use when the user asks to "make this a skill", "remember how to do this", or describes a routine. Replacing an existing skill asks the user first.',
    parameters: obj({ name: str('Skill name, e.g. "Morning briefing"'), description: str('One-line purpose'), steps: str('Numbered steps (Markdown)'), triggers: arr('Phrases that should start it, e.g. "start my day"'), input: str('What input it expects, if any') }, ['name', 'steps']),
    run: async (a, ctx) => {
      const existing = await skills.get(a.name);
      const replace = Boolean(existing && existing.slug === skills.slugify(a.name));
      if (replace) await requireApproval(ctx, 'settings', `Replace the skill "${existing.name}"`, String(a.steps).slice(0, 600));
      const s = await skills.save(a, { replace });
      ctx.emit({ type: 'skills_changed' });
      return { saved: s.name, command: `/${s.slug}`, replaced: s.replaced };
    },
  },
  {
    name: 'skill_delete',
    group: 'skills',
    description: 'Delete a saved skill when the user asks.',
    parameters: obj({ name: str('Skill name or /command') }, ['name']),
    run: async (a, ctx) => {
      const s = await skills.get(a.name);
      if (!s) throw new Error(`No skill called "${a.name}".`);
      await requireApproval(ctx, 'delete', `Delete the skill "${s.name}"`, s.description || s.steps.slice(0, 300));
      const r = await skills.remove(s.slug);
      ctx.emit({ type: 'skills_changed' });
      return r;
    },
  },
];
