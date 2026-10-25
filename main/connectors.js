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

/** A short view by state: { connected, needSignIn, failing, notSetUp } of display names. */
function byStatus(list) {
  const pick = (st) => [...new Set((list || []).filter((c) => c.status === st).map((c) => c.name.replace(/^claude\.ai /, '').replace(/^plugin:[^:]+:/, '')))];
  return { connected: pick('connected'), needSignIn: pick('needs-auth'), failing: pick('failed'), notSetUp: pick('not-configured') };
}

/** Server keys from the setting, cleaned (the user picks them in Settings; never the app's own server). */
function allowedKeys(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(serverKey).filter((k) => k && k !== OWN_SERVER))];
}

module.exports = { OWN_SERVER, serverKey, toolServer, isConnectorTool, describeTool, parseMcpList, byStatus, allowedKeys };
