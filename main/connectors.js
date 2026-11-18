// The user's Claude connectors (claude.ai) and plugin MCP servers, reached through the Claude account
// brain (claudecode.js) when claudeCode.connectors is on. Pure: parsing `claude mcp list`, server keys
// as Claude Code names them in tool names (mcp__<key>__<tool>), and labels for the UI.

const OWN_SERVER = 'nexus'; // the app's own tool server (mcp-server.js)
// Both of the app's servers: nexus (everyday tools, always loaded) and nexus_more (the rest, on request).
const OWN_SERVERS = [OWN_SERVER, 'nexus_more'];
const isOwnServer = (server) => OWN_SERVERS.includes(server);

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
  return Boolean(server) && !isOwnServer(server);
}

/** "mcp__claude_ai_Todoist__find-tasks" → { service: "Todoist", action: "find tasks" }. */
function describeTool(toolName) {
  const server = toolServer(toolName);
  const action = String(toolName).slice(`mcp__${server}__`.length).replace(/[-_]+/g, ' ').trim();
  const service = server.replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '').replace(/_/g, ' ').trim();
  return { service: service || server, action };
}

// The state by its words, not its symbol: the CLI prints "✔ Connected" / "✘ Failed" in a terminal but
// "√ Connected" / "× Failed" when it runs without one (as from this app started from the Start menu),
// and reading the symbols lost every connected and failing server there.
const STATUS_WORDS = [
  [/^Connected\b/i, 'connected'],
  [/^Failed\b/i, 'failed'],
  [/^Needs authentication\b/i, 'needs-auth'],
  [/^Not configured\b/i, 'not-configured'],
];

/**
 * `claude mcp list` output → [{ name, key, source, status, detail }]. Lines look like
 * "claude.ai Todoist: https://ai.todoist.net/mcp - ✔ Connected" or
 * "plugin:productivity:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication".
 */
function parseMcpList(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    // "name: target - <symbol> <state …>": the symbol is any short non-letter mark (or none).
    const m = /^(.+?): (.*?) - (?:[^\sA-Za-z]{1,3} )?([A-Za-z].*)$/.exec(line.trim());
    if (!m) continue;
    const status = STATUS_WORDS.find(([re]) => re.test(m[3]))?.[1];
    if (!status) continue;
    const name = m[1].trim();
    if (isOwnServer(serverKey(name))) continue;
    out.push({
      name,
      key: serverKey(name),
      source: name.startsWith('claude.ai ') ? 'connector' : name.startsWith('plugin:') ? 'plugin' : 'local',
      status,
      detail: m[3].trim().slice(0, 200),
    });
  }
  return out;
}

/**
 * A tool's action in words: "mcp__x__send-message", "send_message" and "sendMessage" are all "send message".
 * stripService drops leading words that repeat the service's name (Slack's slack_send_message, Gmail's
 * gmail_…), so the verb comes first as with other services.
 */
function actionWords(toolName, { stripService = false } = {}) {
  const server = toolServer(toolName);
  const words = String(toolName).slice(`mcp__${server}__`.length).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[-_\s]+/).filter(Boolean);
  if (stripService) {
    const service = new Set(describeTool(toolName).service.toLowerCase().split(/[^a-z0-9]+/));
    while (words.length > 1 && service.has(words[0])) words.shift();
  }
  return words.join(' ');
}

// Tool names that only read: list_events, get-file, search_designs, suggest_time, whoami…
const READ_VERBS = /^(list|get|search|read|find|fetch|query|lookup|view|describe|whoami|suggest|check|count|status)(?![a-z])/;

/**
 * True when the tool's own name says it only reads (used for connectors set to "allow reading"): it starts
 * with a reading verb, after the service's own name, and names no deleting (check_and_remove_duplicates).
 */
function isReadOnly(toolName) {
  return READ_VERBS.test(actionWords(toolName, { stripService: true })) && !isDestructive(toolName);
}

// Tool names that remove or undo things: delete-object, remove_member, archive_project, cancel_order…
// Anywhere in the name (slack_delete_message, bulkDeleteTasks): only ever asks more.
const DESTRUCTIVE_VERBS = /(^| )(delete|remove|archive|purge|destroy|drop|cancel|revoke|clear|reset|wipe|uninstall|unsubscribe|empty|trash)(?![a-z])/;

/** True when the tool's name says it deletes or undoes something (asks even at "allow all but deleting"). */
function isDestructive(toolName) {
  const action = actionWords(toolName);
  // Multipurpose admin tools (Todoist's project-management archives projects) can do either: they ask.
  return DESTRUCTIVE_VERBS.test(action) || /(^| )(manage|management|admin)( |$)/.test(action);
}

// Fields that name other people (an invitation, a message, an assignment), with the prefixes and suffixes
// services use: attendees, attendeeEmails, addedAttendees (Google Calendar), assignee_username (TickTick),
// shareWith… removedAttendeeEmails too: Google Calendar e-mails them a cancellation. The address-like
// ones count only with an "@" in them ("to" is also a date in some tools).
const PEOPLE_KEY = /^(added|new|extra|removed)?(attendee|invitee|guest|recipient|assignee|responsible|member|participant|collaborator|sharewith|sharedwith|shareto)s?(email|emails|user|users|username|usernames|uid|id|ids|name|names)?$/;
const ADDRESS_KEYS = new Set(['to', 'cc', 'bcc', 'email', 'emails']);
// Anywhere in the name (slack_send_message, outlook_send_email); a message goes to someone (Slack's
// schedule_message sends it later).
const PEOPLE_VERBS = /(^| )(send|share|invite|assign|respond|reply|forward|publish|post|notify|mention|email|message|messages)(?![a-z])/;
// Shallow on purpose: a nested value is walked by namesPeople, with a depth and width limit.
const filled = (v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null && v !== false);
const hasAt = (v) => {
  try {
    return JSON.stringify(v).includes('@');
  } catch {
    return true; // too deep to look at: counted as naming someone
  }
};

/** Whether an input names people: a people field anywhere in it (batch tools nest them), or an address field with an "@". */
function namesPeople(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return false;
  if (Array.isArray(value)) return value.slice(0, 50).some((v) => namesPeople(v, depth + 1));
  return Object.keys(value).slice(0, 100).some((k) => {
    const key = k.toLowerCase().replace(/[-_\s]/g, '');
    if (PEOPLE_KEY.test(key)) return filled(value[k]);
    if (ADDRESS_KEYS.has(key)) return filled(value[k]) && hasAt(value[k]);
    return namesPeople(value[k], depth + 1);
  });
}

/** True when the call reaches people besides the user: its action sends or shares, or its input names them. */
function reachesPeople(toolName, input) {
  return PEOPLE_VERBS.test(actionWords(toolName)) || namesPeople(input);
}

/**
 * In a turn that read outside content: why this call needs a yes given after it ('delete' | 'people'), or
 * null. Neither the service's level nor a yes from before the taint covers such a call. Reads never do.
 */
function taintedAsk(toolName, input) {
  if (isReadOnly(toolName)) return null;
  if (isDestructive(toolName)) return 'delete';
  if (reachesPeople(toolName, input)) return 'people';
  return null;
}

/** A short view by state: { connected, needSignIn, failing, notSetUp } of display names. */
function byStatus(list) {
  const pick = (st) => [...new Set((list || []).filter((c) => c.status === st).map((c) => c.name.replace(/^claude\.ai /, '').replace(/^plugin:[^:]+:/, '')))];
  return { connected: pick('connected'), needSignIn: pick('needs-auth'), failing: pick('failed'), notSetUp: pick('not-configured') };
}

/** Server keys from the setting, cleaned (the user picks them in Settings; never the app's own server). */
function allowedKeys(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(serverKey).filter((k) => k && !isOwnServer(k)))];
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

module.exports = { OWN_SERVER, LEVELS, LEVEL_LABEL, serverKey, toolServer, isConnectorTool, isReadOnly, isDestructive, reachesPeople, taintedAsk, describeTool, parseMcpList, byStatus, allowedKeys, levelOf, permits, levelPatch, rememberChoices, findServers, OWN_SERVERS, isOwnServer };
