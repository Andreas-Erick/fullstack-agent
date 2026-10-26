// Custom faces on paired devices (the phone and tablet client): a custom face is a web page from the
// user's faces folder, so it is never served at a fixed public address. A paired device asks
// (/api/face, with its token) and gets a short-lived link, /f/<key>/index.html, that serves only the
// active persona's face folder for ten minutes. The device shows it in a sandboxed frame (scripts only:
// no access to the app, its token or storage), and every face file carries a policy that blocks all
// network access, as on the desktop. Pure bookkeeping here; companion.js serves the files.
const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;
const MAX = 32; // links alive at once (a few per device)
const links = new Map(); // key -> { folder, deviceId, expiresAt }

/** A new link to `folder` for `deviceId`; older links of that device for the same face are replaced. */
function issue(folder, deviceId, now = Date.now()) {
  prune(now);
  for (const [k, l] of links) if (l.deviceId === deviceId && l.folder === folder) links.delete(k);
  if (links.size >= MAX) links.delete(links.keys().next().value);
  const key = crypto.randomBytes(24).toString('base64url');
  links.set(key, { folder, deviceId, expiresAt: now + TTL_MS });
  return { key, expiresAt: now + TTL_MS };
}

/** The face folder a link opens, or null (unknown, expired, or not a link's shape). */
function resolve(key, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(String(key || ''))) return null;
  const l = links.get(key);
  if (!l) return null;
  if (l.expiresAt < now) {
    links.delete(key);
    return null;
  }
  return l.folder;
}

/** Drops a device's links (it was unpaired) or all of them (remote access turned off). */
function revoke(deviceId = null) {
  for (const [k, l] of links) if (deviceId === null || l.deviceId === deviceId) links.delete(k);
}

function prune(now = Date.now()) {
  for (const [k, l] of links) if (l.expiresAt < now) links.delete(k);
}

/** A file path inside a face folder that may be served: plain names, no traversal, no hidden files. */
function safeRel(rel) {
  const r = String(rel || '').replace(/^\/+/, '') || 'index.html';
  if (r.length > 200 || !/^[\w./-]+$/.test(r) || r.split('/').some((p) => p === '..' || p === '.' || p.startsWith('.'))) return null;
  return r;
}

// What a face file is allowed to do on a device: run its own scripts and styles, draw images; never
// connect anywhere, embed frames or submit forms, or be framed by another site.
const FACE_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts";

module.exports = { issue, resolve, revoke, safeRel, FACE_CSP, TTL_MS };
