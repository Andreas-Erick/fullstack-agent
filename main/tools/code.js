// Agent tools: Reading and changing the app’s own code (codebase.js, selfchange.js).
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const codebase = require('../codebase');
const selfchange = require('../selfchange');
const { arr, obj, str, int, bool, requireApproval } = require('./common');

module.exports = [
  {
    name: 'code_list_files',
    group: 'code',
    description: "List the files of your own source code (this assistant app's codebase).",
    parameters: obj({ dir: str('Sub-directory relative to the code root (optional)') }),
    run: async (a) => codebase.listFiles(a.dir || ''),
  },
  {
    name: 'code_read_file',
    group: 'code',
    description: 'Read one of your own source files, with line numbers. Use to answer questions about how you work, and always before editing a file.',
    parameters: obj({ path: str('File path relative to the code root'), start_line: int('First line (optional)'), end_line: int('Last line (optional)') }, ['path']),
    run: async (a) => codebase.readFile(a.path, a.start_line, a.end_line),
  },
  {
    name: 'code_search',
    group: 'code',
    description: 'Search your own source code for keywords; returns the best-matching files with a snippet. For exact matches (every caller of a function, every use of a setting) use code_grep.',
    parameters: obj({ query: str('Keywords or identifier') }, ['query']),
    run: async (a) => codebase.search(a.query),
  },
  {
    name: 'code_grep',
    group: 'code',
    description: 'Exact search of your own source code with a regular expression: every matching line with its line number and surrounding lines. Use it to find all callers, definitions and uses before changing something (e.g. pattern "handoff\\.write\\(" or "\\bstartTurn\\b").',
    parameters: obj({ pattern: str('JavaScript regular expression'), path: str('Limit to files matching this glob or text, e.g. "main/*.js", "renderer/**/*.css", "settings" (optional)'), ignore_case: bool('Case-insensitive'), context: int('Lines of context around each match (default 2)') }, ['pattern']),
    run: async (a) => codebase.grep(a.pattern, { glob: a.path || '', ignoreCase: a.ignore_case, context: a.context ?? 2 }),
  },
  {
    name: 'code_outline',
    group: 'code',
    description: 'The structure of one of your source files: functions (with parameters), classes, exports, IPC handlers and tools, with line numbers. Read this before reading a large file, then read only the parts you need.',
    parameters: obj({ path: str('File path relative to the code root') }, ['path']),
    run: async (a) => codebase.outline(a.path),
  },
  {
    name: 'code_map',
    group: 'engineering',
    description: 'Architecture overview of your own codebase: every module with its purpose, exports and size, the IPC surface, your tools by group, the settings sections and the design docs. Start here when planning a feature or a refactor, together with CLAUDE.md and docs/ENGINEERING.md.',
    parameters: obj({}),
    run: async () => codebase.map(),
  },
  {
    name: 'code_edit_file',
    group: 'selfmod',
    description:
      'Edit one of your own source files by exact string replacement. old_string must match the file exactly (copy it from code_read_file output without the line-number prefix) and be unique unless replace_all is true.',
    parameters: obj({ path: str('File path relative to the code root'), old_string: str('Exact text to replace'), new_string: str('Replacement text'), replace_all: bool('Replace every occurrence') }, ['path', 'old_string', 'new_string']),
    run: async (a, ctx) => {
      await requireApproval(ctx, 'self_modify', `Change its own code (${a.path})`, `Edit ${a.path}\n\n- ${String(a.old_string).slice(0, 300)}\n+ ${String(a.new_string).slice(0, 300)}`);
      return codebase.editFile(a.path, a.old_string, a.new_string, a.replace_all);
    },
  },
  {
    name: 'code_write_file',
    group: 'selfmod',
    description: 'Create a new source file (or completely replace a small one) in your own codebase.',
    parameters: obj({ path: str('File path relative to the code root'), content: str('Full file content') }, ['path', 'content']),
    run: async (a, ctx) => {
      await requireApproval(ctx, 'self_modify', `Change its own code (${a.path})`, `Write ${a.path}\n\n${String(a.content).slice(0, 600)}`);
      return codebase.writeFile(a.path, a.content);
    },
  },
  {
    name: 'code_check',
    group: 'selfmod',
    description: 'Check your whole codebase after editing it: syntax of every file, then integrity across files (IPC handler ↔ preload ↔ renderer calls, imports and the names they import, settings keys, tool names). Fix everything it reports before finishing.',
    parameters: obj({}),
    run: async () => selfchange.check(),
  },
  {
    name: 'code_diff',
    group: 'selfmod',
    description: 'Your uncommitted changes as a diff (and the list of new files). Review it before self_change_commit like a senior reviewer would: unintended edits, leftovers, missing pieces (preload channel, setting default, tool label, docs, tests), error handling, security.',
    parameters: obj({ path: str('Only this file (optional)') }),
    run: async (a) => selfchange.diff(a.path || ''),
  },
  {
    name: 'run_tests',
    group: 'engineering_run',
    description: 'Run your automated tests (test/*.test.js, Node\'s built-in test runner). Returns the summary, and the failures in full. self_change_commit also runs them and refuses a change that breaks one. Pass a filter to run only matching test files, e.g. "companion".',
    parameters: obj({ filter: str('Only test files whose name contains this (optional)') }),
    run: async (a) => selfchange.runTests(a.filter || ''),
  },
  {
    name: 'self_change_commit',
    group: 'selfmod',
    description:
      'Finish a change to yourself: runs code_check and the tests, and records the change in your change history (so the user can review or revert it). Refuses the change while either fails. Call once when the feature/fix is complete and reviewed (code_diff), with a one-line summary of what changed and why. After the next reload/restart the app checks that the change started cleanly.',
    parameters: obj({ summary: str('One-line summary, e.g. "Add a weather widget to the chat header"') }, ['summary']),
    run: async (a, ctx) => {
      const r = await selfchange.commit(a.summary, { source: 'agent' });
      if (r.ok && !r.nothing) ctx.emit({ type: 'self_changed', change: r });
      if (!r.ok) return { committed: false, error: 'Checks failed (syntax, integrity or tests) — fix the cause, not the check, and call self_change_commit again.', output: r.check.output };
      return r.nothing ? { committed: false, note: 'No changes to record.' } : { committed: true, id: r.short, files: r.files, needs: r.restart ? 'app restart' : r.reload ? 'window reload' : 'nothing' };
    },
  },
  {
    name: 'self_change_plan',
    group: 'selfmod',
    description:
      'Before changing your own code, state the plan: what you will change and why, and which files. The user approves it once (by click or voice); then edits in this turn proceed without further prompts. Required before code_edit_file / code_write_file. For anything beyond a small fix, also give the design (approach, and the alternative you rejected and why), the risks (what could break, security, data) and how you will verify it (tests you add or run, what to check after reload/restart): see docs/ENGINEERING.md.',
    parameters: obj(
      {
        summary: str('One line: what the change does'),
        steps: arr('Concrete steps'),
        files: arr('Files to create or modify'),
        design: str('Approach and why; the alternative you considered and rejected (optional for small fixes)'),
        risks: arr('What could break or go wrong, and how the change guards against it (optional for small fixes)'),
        verification: arr('How you will verify it: tests added/run, checks, what to look at after reload or restart'),
      },
      ['summary', 'steps', 'files'],
    ),
    run: async (a, ctx) => {
      const section = (title, list) => (list?.length ? `\n\n${title}:\n${list.map((x) => `- ${x}`).join('\n')}` : '');
      const detail = `${(a.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}${a.design ? `\n\nDesign: ${a.design}` : ''}${section('Risks', a.risks)}${section('Verification', a.verification)}\n\nFiles: ${(a.files || []).join(', ')}`;
      await requireApproval(ctx, 'self_modify', a.summary, detail);
      if (ctx.turn) ctx.turn.plan = a;
      return { approved: true, next: 'Read before you edit (code_outline, code_grep for every caller). Make the edits; add or update tests for new logic; run code_check and run_tests; review code_diff; then self_change_commit.' };
    },
  },
];
