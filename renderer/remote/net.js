// Calls to the computer (main/companion.js): a deadline for the answer, a tunnel that answers for a
// computer that is off, and the token on every call.
import { plainStatus, networkFailure } from './sync.js';
import { state } from './state.js';
import { AuthError, NetError } from './ui.js';
import { unpair } from './pairing.js';

// fetch with a deadline for the answer's headers (a body being read, /api/speak's audio, is never cut
// off): past `ms` a NetError, as if the computer were off. 0 = no deadline.
export async function fetchWithin(url, init, ms) {
  const ctl = new AbortController();
  const timer = ms ? setTimeout(() => ctl.abort(), ms) : 0;
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (err) {
    if (ctl.signal.aborted) throw new NetError('Your computer isn’t answering right now.');
    if (networkFailure(err)) throw new NetError('Can’t reach your computer right now.'); // not the browser's "Failed to fetch"
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// A tunnel or proxy answering for a computer that is off (Cloudflare's or Tailscale Serve's error page);
// the computer's own errors (voice 502/503 among them) are JSON.
export const tunnelDown = (res) => [502, 503, 504, 530].includes(res.status) && !/json/i.test(res.headers.get('content-type') || '');

// An answer that isn't ok, as an Error with the server's own words, else its status in plain words.
// `fromServer`: the text is meant for the user (screens.js shows it as it is).
export async function answerError(res, opts) {
  const data = await res.json().catch(() => ({}));
  const err = new Error(typeof data.error === 'string' && data.error ? data.error : plainStatus(res.status, opts));
  err.fromServer = true;
  return err;
}

export async function api(path, { method = 'GET', body, raw = false, timeoutMs = 0 } = {}) {
  let res;
  try {
    res = await fetchWithin(path, {
      method,
      headers: { Authorization: `Bearer ${state.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, timeoutMs);
  } catch (err) {
    if (err instanceof NetError || err?.name === 'AbortError') throw err;
    throw new NetError('Can’t reach your computer right now.');
  }
  if (tunnelDown(res)) throw new NetError('Your computer isn’t answering right now.');
  if (res.status === 401) {
    unpair('This device was disconnected from the assistant. Pair it again.');
    throw new AuthError('Not paired');
  }
  if (!res.ok) throw await answerError(res);
  return raw ? res : res.json();
}
