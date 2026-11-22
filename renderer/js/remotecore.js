// The pure part of the Remote pill (js/remote.js): what the pill says (running, reachable) and the paired
// devices as tooltip lines, connected ones first, each with how long ago it was seen. Tested in
// test/remotecore.test.js.

/**
 * The Remote pill: { label, cls, reach } from settings.remote's `lan`, companion.status()'s `error` and
 * its `tunnel`. `listening` is left out on purpose: the server starts after the window, so it is false
 * for a moment at every launch; `error` is set only when it really failed (a port in use). The tunnel's
 * `check` is the secure address opened from this computer (tunnel.js verify; Tailscale in practice).
 */
export function pillState({ lan = false, error = '', tunnel = null } = {}) {
  if (error) return { label: 'Remote: not running', cls: 'err', reach: error };
  if (tunnel?.connected && tunnel.check === 'fail') return { label: 'Remote: unreachable', cls: 'warn', reach: tunnel.warning || `${tunnel.url} didn’t answer from this computer` };
  if (tunnel?.connected && tunnel.url) return { label: 'Remote: online', cls: 'online', reach: `Reachable ${tunnel.mode === 'tailscale' ? 'from your tailnet' : 'from the internet'} at ${tunnel.url}` };
  return lan ? { label: 'Remote: network', cls: '', reach: 'Reachable from your local network' } : { label: 'Remote', cls: '', reach: 'Reachable from this computer only' };
}

/**
 * "Connect my phone" (Settings → Remote access): the settings patch that makes the server reachable for
 * pairing a phone, from settings.remote, or null when nothing needs to change. Today's defaults: the port
 * stays as it is; the home network is opened only when no secure address (a tunnel) is set up.
 */
export function connectPatch(remote = {}) {
  const r = remote || {};
  const patch = {};
  if (!r.enabled) patch.enabled = true;
  if (!r.lan && (!r.tunnel || r.tunnel === 'off')) patch.lan = true;
  return Object.keys(patch).length ? { remote: patch } : null;
}

/** A text as the tooltip's first sentence: a full stop only when it doesn't end with one, ? or ! already. */
export function sentence(text) {
  const s = String(text ?? '').trimEnd();
  return !s || /[.?!…]["'”’)]*$/.test(s) ? s : `${s}.`;
}

export function ago(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** { connected, headline, lines } for a list from companion.status().devices. */
export function deviceSummary(devices, now) {
  const list = [...(devices || [])].sort((a, b) => Number(b.connected) - Number(a.connected) || (b.lastSeen || 0) - (a.lastSeen || 0));
  const connected = list.filter((d) => d.connected).length;
  if (!list.length) return { connected: 0, headline: 'no paired devices', lines: ['No paired devices.'] };
  const lines = list.map((d) => {
    const when = d.connected ? 'connected now' : d.lastSeen ? `last seen ${ago(d.lastSeen, now)}` : 'never used';
    const watch = d.watch && d.faceAt ? ` · watch face from ${ago(d.faceAt, now)}` : '';
    return `${d.connected ? '●' : '○'} ${d.name}: ${when}${watch}`;
  });
  const headline = connected ? `${connected} of ${list.length} device${list.length === 1 ? '' : 's'} connected` : `${list.length} paired, none connected`;
  return { connected, headline, lines };
}
