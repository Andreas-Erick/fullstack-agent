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

module.exports = { OWN_SERVER, serverKey, toolServer, isConnectorTool, isReadOnly, isDestructive, describeTool, parseMcpList, byStatus, allowedKeys };
