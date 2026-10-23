// Google Calendar via OAuth2 "installed app" loopback flow with PKCE: reads events and, when the
// user allows it, creates, changes and deletes them.
// The user supplies their own OAuth client (Desktop app type) from Google Cloud Console.
const http = require('http');
const crypto = require('crypto');
const { shell } = require('electron');
const store = require('./store');

const READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_BLOB = 'google-tokens';

let cache = { key: '', at: 0, events: [] };
let pendingServer = null;

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function status() {
  const s = await store.getSettings();
  const tokens = await store.getSecretBlob(TOKEN_BLOB);
  const granted = grantedWrite(tokens);
  return {
    configured: Boolean(s.calendar.clientId),
    signedIn: Boolean(tokens?.refresh_token || tokens?.access_token),
    email: tokens?.email || null,
    enabled: s.calendar.enabled,
    canWrite: granted && s.calendar.allowWrite !== false,
    needsReconnect: !granted && s.calendar.allowWrite !== false && Boolean(tokens),
  };
}

// Sign-ins from before write support only granted read access; Google reports the granted scopes.
function grantedWrite(tokens) {
  return String(tokens?.scope || '').split(' ').includes(WRITE_SCOPE);
}

async function signIn() {
  const s = await store.getSettings();
  const { clientId, clientSecret } = s.calendar;
  if (!clientId) throw new Error('Add your Google OAuth Client ID in Settings → Google Calendar first.');
  if (pendingServer) pendingServer.close();

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  let redirectUri = '';
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<html><body style="background:#0a0a0f;color:#7df9ff;font-family:sans-serif;display:grid;place-items:center;height:100vh">
        <h2>${ok ? 'Signed in — you can close this tab and return to the app.' : 'Sign-in failed. Please try again.'}</h2></body></html>`,
      );
      server.close();
      pendingServer = null;
      if (ok) resolve(url.searchParams.get('code'));
      else reject(new Error(url.searchParams.get('error') || 'OAuth state mismatch'));
    });
    pendingServer = server;
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: [READ_SCOPE, s.calendar.allowWrite !== false && WRITE_SCOPE, 'openid', 'email'].filter(Boolean).join(' '),
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      });
      shell.openExternal(`${AUTH_URL}?${params}`);
    });
    setTimeout(() => {
      if (pendingServer === server) {
        server.close();
        pendingServer = null;
        reject(new Error('Sign-in timed out after 5 minutes.'));
      }
    }, 5 * 60 * 1000);
  });

  // The same redirect URI must be sent again with the token exchange.
  const tokens = await exchange({
    code,
    client_id: clientId,
    client_secret: clientSecret || undefined,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  tokens.email = decodeEmail(tokens.id_token);
  tokens.expires_at = Date.now() + (tokens.expires_in || 3600) * 1000;
  await store.setSecretBlob(TOKEN_BLOB, tokens);
  cache = { key: '', at: 0, events: [] };
  return status();
}

function decodeEmail(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
    return payload.email || null;
  } catch {
    return null;
  }
}

async function exchange(body) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) if (v != null) params.set(k, v);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google token error: ${json.error_description || json.error || res.status}`);
  return json;
}

async function signOut() {
  const tokens = await store.getSecretBlob(TOKEN_BLOB);
  if (tokens?.access_token) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refresh_token || tokens.access_token)}`, {
      method: 'POST',
    }).catch(() => {});
  }
  await store.setSecretBlob(TOKEN_BLOB, null);
  cache = { key: '', at: 0, events: [] };
  return status();
}

async function accessToken() {
  const tokens = await store.getSecretBlob(TOKEN_BLOB);
  if (!tokens) throw new Error('Google Calendar is not connected. Sign in from Settings.');
  if (tokens.access_token && tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error('Google session expired. Please sign in again.');
  const s = await store.getSettings();
  const fresh = await exchange({
    client_id: s.calendar.clientId,
    client_secret: s.calendar.clientSecret || undefined,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });
  const merged = { ...tokens, ...fresh, expires_at: Date.now() + (fresh.expires_in || 3600) * 1000 };
  await store.setSecretBlob(TOKEN_BLOB, merged);
  return merged.access_token;
}

async function api(pathname, params = {}, { method = 'GET', body } = {}) {
  const token = await accessToken();
  const url = `${API}${pathname}?${new URLSearchParams(params)}`;
  const headers = { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return {};
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Calendar error: ${json.error?.message || res.status}`);
  return json;
}

async function calendars() {
  const s = await store.getSettings();
  if (!s.calendar.allCalendars) return [{ id: 'primary', summary: 'Primary', backgroundColor: '#00e5ff' }];
  const res = await api('/users/me/calendarList', { minAccessRole: 'reader' });
  return (res.items || []).filter((c) => c.selected !== false);
}

function normalize(ev, cal) {
  const allDay = Boolean(ev.start?.date);
  return {
    id: ev.id,
    calendarId: cal.id,
    title: ev.summary || '(no title)',
    start: ev.start?.dateTime || ev.start?.date,
    end: ev.end?.dateTime || ev.end?.date,
    allDay,
    location: ev.location || '',
    description: (ev.description || '').slice(0, 500),
    link: ev.htmlLink,
    meet: ev.hangoutLink || '',
    calendar: cal.summaryOverride || cal.summary || cal.id,
    color: cal.backgroundColor || '#00e5ff',
  };
}

async function events({ start, end } = {}) {
  const from = start ? new Date(start) : startOfDay(new Date());
  const s = await store.getSettings();
  const to = end ? new Date(end) : new Date(from.getTime() + (s.calendar.daysAhead || 7) * 86400000);
  const key = `${from.toISOString()}|${to.toISOString()}`;
  if (cache.key === key && Date.now() - cache.at < 5 * 60 * 1000) return cache.events;

  const cals = await calendars();
  const lists = await Promise.all(
    cals.map((cal) =>
      api(`/calendars/${encodeURIComponent(cal.id)}/events`, {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
      })
        .then((r) => (r.items || []).filter((e) => e.status !== 'cancelled').map((e) => normalize(e, cal)))
        .catch(() => []),
    ),
  );
  const all = lists.flat().sort((a, b) => new Date(a.start) - new Date(b.start));
  cache = { key, at: Date.now(), events: all };
  return all;
}

// ---------------------------------------------------------------- writing
async function requireWrite() {
  const st = await status();
  if (!st.signedIn) throw new Error('Google Calendar is not connected. Sign in from Settings.');
  const s = await store.getSettings();
  if (s.calendar.allowWrite === false) throw new Error('Calendar changes are turned off in Settings → Google Calendar.');
  if (!st.canWrite) throw new Error('This Google sign-in only allows reading. Ask the user to click "Reconnect" in Settings → Google Calendar to allow changes.');
}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const dateOnly = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Times without an offset ("2026-10-24T15:00") are read in the computer's time zone.
function when(value, allDay) {
  if (allDay) return { date: String(value).slice(0, 10) };
  if (isNaN(new Date(value))) throw new Error(`Invalid date/time: ${value}`);
  value = String(value).replace(/T(\d{2}:\d{2})(?=$|[zZ+-])/, 'T$1:00'); // Google wants seconds
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? { dateTime: value } : { dateTime: value, timeZone: localZone() };
}

function later(start, ms = 3600000) {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(start)) return new Date(new Date(start).getTime() + ms).toISOString();
  const d = new Date(new Date(start).getTime() + ms); // no offset: parsed and formatted as local time
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

function eventBody(e, { partial = false } = {}) {
  const body = {};
  if (e.title != null) body.summary = e.title;
  if (e.description != null) body.description = e.description;
  if (e.location != null) body.location = e.location;
  if (e.attendees) body.attendees = e.attendees.map((email) => ({ email }));
  if (e.recurrence) body.recurrence = [].concat(e.recurrence);
  if (e.start) {
    const allDay = e.all_day ?? dateOnly(e.start);
    body.start = when(e.start, allDay);
    body.end = when(e.end || (allDay ? addDays(String(e.start).slice(0, 10), 1) : later(e.start)), allDay);
  } else if (e.end && partial) throw new Error('Changing the end also needs the start.');
  return body;
}

const sendUpdates = (notify) => ({ sendUpdates: notify ? 'all' : 'none' });

async function getEvent(id, calendarId = 'primary') {
  return api(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`);
}

async function createEvent(e) {
  await requireWrite();
  if (!e.title || !e.start) throw new Error('A new event needs a title and a start.');
  const cal = e.calendar_id || 'primary';
  const ev = await api(`/calendars/${encodeURIComponent(cal)}/events`, sendUpdates(e.notify_attendees), { method: 'POST', body: eventBody(e) });
  cache = { key: '', at: 0, events: [] };
  return normalize(ev, { id: cal });
}

async function updateEvent(id, e) {
  await requireWrite();
  const cal = e.calendar_id || 'primary';
  // Moving an event without a new end keeps its length.
  if (e.start && !e.end && !dateOnly(e.start)) {
    const old = await getEvent(id, cal);
    if (old.start?.dateTime && old.end?.dateTime) e = { ...e, end: later(e.start, new Date(old.end.dateTime) - new Date(old.start.dateTime)) };
  }
  const ev = await api(`/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(id)}`, sendUpdates(e.notify_attendees), { method: 'PATCH', body: eventBody(e, { partial: true }) });
  cache = { key: '', at: 0, events: [] };
  return normalize(ev, { id: cal });
}

async function deleteEvent(id, { calendar_id: cal = 'primary', notify_attendees } = {}) {
  await requireWrite();
  await api(`/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(id)}`, sendUpdates(notify_attendees), { method: 'DELETE' });
  cache = { key: '', at: 0, events: [] };
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function fmtEvent(e) {
  const start = new Date(e.start);
  const when = e.allDay
    ? `${start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} (all day)`
    : `${start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}–${new Date(e.end).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  return `- ${when}: ${e.title}${e.location ? ` @ ${e.location}` : ''}${e.calendar ? ` [${e.calendar}]` : ''}`;
}

// Text block for the system prompt: today's events + upcoming.
async function promptBlock() {
  const st = await status();
  if (!st.enabled || !st.signedIn) return '';
  try {
    const list = await events();
    const todayEnd = startOfDay(new Date()).getTime() + 86400000;
    const today = list.filter((e) => new Date(e.start).getTime() < todayEnd);
    const upcoming = list.filter((e) => new Date(e.start).getTime() >= todayEnd).slice(0, 40);
    return [
      `## Calendar (Google Calendar${st.canWrite ? '' : ', read-only'})`,
      "Today's events:",
      today.length ? today.map(fmtEvent).join('\n') : '- Nothing scheduled today.',
      'Upcoming:',
      upcoming.length ? upcoming.map(fmtEvent).join('\n') : '- Nothing upcoming in the next days.',
    ].join('\n');
  } catch (err) {
    return `## Calendar\n(Calendar unavailable: ${err.message})`;
  }
}

module.exports = { status, signIn, signOut, events, promptBlock, fmtEvent, getEvent, createEvent, updateEvent, deleteEvent };
