// The user's Claude connectors (claude.ai) and plugin MCP servers, reached through the Claude account
// brain (claudecode.js) when claudeCode.connectors is on. Pure: parsing `claude mcp list`, server keys
// as Claude Code names them in tool names (mcp__<key>__<tool>), and labels for the UI.

const OWN_SERVER = 'nexus'; // the app's own tool server (mcp-server.js)

/** "claude.ai AccuWeather®" → "claude_ai_AccuWeather", "plugin:productivity:slack" → "plugin_productivity_slack". */
function serverKey(name) {
  return String(name || '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

/** The server key of an MCP tool name, or '' for built-in tools. */
function toolServer(toolName) {
  const m = /^mcp__(.+?)__/.exec(String(toolName || ''));
  return m ? m[1] : '';
}

/** A tool from a connector or plugin (not the app's own server). */
function isConnectorTool(toolName) {
  const server = toolServer(toolName);
  return Boolean(server) && server !== OWN_SERVER;
}

/** "mcp__claude_ai_Todoist__find-tasks" → { service: "Todoist", action: "find tasks" }. */
function describeTool(toolName) {
  const server = toolServer(toolName);
  const action = String(toolName).slice(`mcp__${server}__`.length).replace(/[-_]+/g, ' ').trim();
  const service = server.replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '').replace(/_/g, ' ').trim();
  return { service: service || server, action };
}

const STATUS = { '✔': 'connected', '✘': 'failed', '!': 'needs-auth', '-': 'not-configured' };

/**
 * `claude mcp list` output → [{ name, key, source, status, detail }]. Lines look like
 * "claude.ai Todoist: https://ai.todoist.net/mcp - ✔ Connected" or
 * "plugin:productivity:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication".
 */
function parseMcpList(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(.+?): (.*) - ([✔✘!-]) (.+)$/.exec(line.trim());
    if (!m) continue;
    const name = m[1].trim();
    if (serverKey(name) === OWN_SERVER) continue;
    out.push({
      name,
      key: serverKey(name),
      source: name.startsWith('claude.ai ') ? 'connector' : name.startsWith('plugin:') ? 'plugin' : 'local',
      status: STATUS[m[3]],
      detail: m[3] === '✘' ? m[4].slice(0, 200) : m[4].trim(),
    });
  }
  return out;
}

// Tool names that only read: list_events, get-file, search_designs, suggest_time, whoami…
const READ_VERBS = /^(list|get|search|read|find|fetch|query|lookup|view|describe|whoami|suggest|check|count|status)(?![a-z])/;

/** True when the tool's own name says it only reads (used for connectors set to "allow reading"). */
function isReadOnly(toolName) {
  const server = toolServer(toolName);
  const action = String(toolName).slice(`mcp__${server}__`.length).toLowerCase().replace(/[-_]+/g, ' ');
  return READ_VERBS.test(action);
}

// Tool names that remove or undo things: delete-object, remove_member, archive_project, cancel_order…
const DESTRUCTIVE_VERBS = /^(delete|remove|archive|purge|destroy|drop|cancel|revoke|clear|reset|wipe|uninstall|unsubscribe|empty|trash)(?![a-z])/;

/** True when the tool's name says it deletes or undoes something (asks even at "allow all but deleting"). */
function isDestructive(toolName) {
  const server = toolServer(toolName);
  const action = String(toolName).slice(`mcp__${server}__`.length).toLowerCase().replace(/[-_]+/g, ' ');
  // Multipurpose admin tools (Todoist's project-management archives projects) can do either: they ask.
  return DESTRUCTIVE_VERBS.test(action) || /(^| )(manage|management|admin)( |$)/.test(action);
}

/** A short view by state: { connected, needSignIn, failing, notSetUp } of display names. */
function byStatus(list) {
  const pick = (st) => [...new Set((list || []).filter((c) => c.status === st).map((c) => c.name.replace(/^claude\.ai /, '').replace(/^plugin:[^:]+:/, '')))];
  return { connected: pick('connected'), needSignIn: pick('needs-auth'), failing: pick('failed'), notSetUp: pick('not-configured') };
}

/** Server keys from the setting, cleaned (the user picks them in Settings; never the app's own server). */
function allowedKeys(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(serverKey).filter((k) => k && k !== OWN_SERVER))];
}

// Permission levels per server (Settings → AI brain, the approval dialog's "Always…" buttons, and the
// tool connector_permission, which asks the user first): ask < read < write < all.
const LEVELS = ['ask', 'read', 'write', 'all'];
const LEVEL_LISTS = { all: 'connectorsAllowed', write: 'connectorsWrite', read: 'connectorsReadOnly' };
const LEVEL_LABEL = { ask: 'ask every time', read: 'allow reading', write: 'allow all but deleting', all: 'allow everything' };

/** The level the user set for a server, from the claudeCode settings. */
function levelOf(cc, server) {
  for (const level of ['all', 'write', 'read']) if (allowedKeys(cc?.[LEVEL_LISTS[level]]).includes(server)) return level;
  return 'ask';
}

/** Whether a level lets this tool run without asking. */
function permits(level, toolName) {
  if (level === 'all') return true;
  if (level === 'write') return !isDestructive(toolName);
  if (level === 'read') return isReadOnly(toolName);
  return false;
}

/** The settings patch that puts a server at a level (and takes it out of the other lists). */
function levelPatch(cc, server, level) {
  const patch = {};
  for (const [lv, field] of Object.entries(LEVEL_LISTS)) {
    const keys = allowedKeys(cc?.[field]).filter((k) => k !== server);
    if (lv === level) keys.push(server);
    patch[field] = keys;
  }
  return patch;
}

/** The "from now on" choices the approval dialog offers for this tool (never "everything"). */
function rememberChoices(toolName) {
  const { service } = describeTool(toolName);
  const out = [];
  if (isReadOnly(toolName)) out.push({ level: 'read', label: `Always allow reading ${service}` });
  if (!isDestructive(toolName)) out.push({ level: 'write', label: `Always allow ${service} (except deleting)` });
  return out;
}

/** A service name the user said ("google calendar") → the matching servers from the last check, best first. */
function findServers(list, name) {
  const want = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!want) return [];
  const clean = (c) => c.name.replace(/^claude\.ai /, '').replace(/^plugin:[^:]+:/, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const rank = (c) => (clean(c) === want ? 0 : 2) + (c.status === 'connected' ? 0 : 4) + (c.source === 'connector' ? 0 : 1);
  return (list || []).filter((c) => clean(c).includes(want) || c.key.toLowerCase() === want.replace(/ /g, '_')).sort((a, b) => rank(a) - rank(b));
}

module.exports = { OWN_SERVER, LEVELS, LEVEL_LABEL, serverKey, toolServer, isConnectorTool, isReadOnly, isDestructive, describeTool, parseMcpList, byStatus, allowedKeys, levelOf, permits, levelPatch, rememberChoices, findServers };
