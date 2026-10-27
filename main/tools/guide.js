// Agent tools: The feature guide and which skills, connectors and extensions fit a task.
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const store = require('../store');
const { obj, str, bool } = require('./common');

module.exports = [
  {
    name: 'app_guide',
    group: 'guide',
    description:
      'What you (the app) can do: every feature with what it does, things the user can say, where it is in the app, and whether it is set up on this computer. Call it when the user asks what you can do, how to use you, or about a feature ("how can I use you?", "what are routines?"); pass topic for one area. Never describe features from memory alone.',
    parameters: obj({ topic: str('Optional: one area, e.g. "routines", "languages", "habits"') }),
    run: async (a) => require('../guide').guide(a.topic || ''),
  },
  {
    name: 'capabilities_for',
    group: 'guide',
    description:
      "Which of the user's skills, connectors, plugins and extensions fit a task. Call it before a bigger or unfamiliar task (a document, a design, research, travel, data, anything that may involve another service) when you are not sure what you have for it. Returns `use` (ready now: use them without being asked) and `suggest` (would help but need the user: signing in, turning on, adding; mention the best one in one sentence, once per topic).",
    parameters: obj({ task: str('The task, in the user\'s words') }, ['task']),
    run: async (a) => {
      const caps = require('../capabilities');
      const r = caps.match(a.task, await caps.inventory(await store.getSettings()));
      return { ...r, ...(r.use.length || r.suggest.length ? {} : { note: 'Nothing specific: use your own tools.' }) };
    },
  },
  {
    name: 'connectors_list',
    group: 'connectors',
    description:
      'The user’s Claude connectors (services connected on claude.ai) and Claude Code plugins: which are connected, which need signing in, which fail, whether you may use them (the user turns that on) and which run without asking. Use it to suggest the right connector or plugin for a task, or to tell the user how to connect one. refresh checks every server again (takes up to half a minute); otherwise the last check is returned.',
    parameters: obj({ refresh: bool('Check every server now instead of using the last check') }),
    run: async (a) => {
      const claudecode = require('../claudecode');
      const connectors = require('../connectors');
      const s = await store.getSettings();
      let at = Date.now();
      let list;
      if (a.refresh) list = await claudecode.listConnectors();
      else {
        const c = await claudecode.cachedConnectors();
        list = c ? c.list : await claudecode.listConnectors();
        if (c) at = c.at;
      }
      const allowed = new Set(connectors.allowedKeys(s.claudeCode.connectorsAllowed));
      return {
        youCanUseThem: Boolean(s.claudeCode.connectors),
        checked: new Date(at).toISOString(),
        ...connectors.byStatus(list),
        alwaysAllowed: list.filter((c) => allowed.has(c.key)).map((c) => c.name),
        how: {
          turnOn: 'Settings → AI brain → "Use my Claude connectors and plugins" (only the user can; Claude account brain only).',
          signIn: 'Connect or sign in on claude.ai → Settings → Connectors, or run /mcp in Claude Code.',
          add: 'New connectors: claude.ai → Settings → Connectors → Browse. New plugins: /plugin in Claude Code. Then "Check connectors" in Settings.',
        },
      };
    },
  },
];
