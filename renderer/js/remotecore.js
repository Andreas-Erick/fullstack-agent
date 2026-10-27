// The pure part of the Remote pill (js/remote.js): the paired devices as tooltip lines, connected ones
// first, each with how long ago it was seen. Tested in test/remotecore.test.js.

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
