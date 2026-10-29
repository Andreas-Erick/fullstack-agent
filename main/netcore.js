// Is an IP address on this computer, the local network, or otherwise not a public internet address?
// Pure (only Node's net). Used by web fetching (websearch.js, which also resolves names first) and by
// the agent window (agentwindowcore.js / agentwindow.js), so both block the same addresses.
const net = require('net');

/** True for loopback, private, link-local, CGNAT, multicast, reserved and the IPv6 forms of those. */
function isPrivateAddress(addr) {
  let a = String(addr || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  // IPv4 inside IPv6: mapped (::ffff:a.b.c.d / ::ffff:hhhh:hhhh) and translated (::ffff:0:a.b.c.d).
  const mapped = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(?:0{1,4}:)?(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(a);
  if (mapped) a = mapped[1] || [parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255, parseInt(mapped[3], 16) >> 8, parseInt(mapped[3], 16) & 255].join('.');
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    return p === 0 || p === 10 || p === 127 || p >= 224 || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 192 && q === 0) || (p === 198 && (q === 18 || q === 19));
  }
  if (net.isIPv6(a)) return a === '::' || a === '::1' || /^(f[cd]|fe[89ab]|fe[c-f]|ff)/.test(a) || /^::(\d|[a-f]|$)/.test(a) || /^64:ff9b:/.test(a);
  return true;
}

module.exports = { isPrivateAddress };
