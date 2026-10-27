// New versions, pure (updates.js asks GitHub): comparing versions and picking, from the latest release,
// the download for this computer and the APKs for the phone and the watch. Tested in test/updates.test.js.

/** "v2.1.0" → [2, 1, 0]; null for anything else (a pre-release "2.1.0-beta" never counts as newer). */
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? m.slice(1).map(Number) : null;
}

/** Is `latest` newer than `current`? */
function newer(latest, current) {
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

const OWN_HOSTS = /^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//;

/**
 * The parts of a GitHub release (api.github.com/repos/…/releases/latest) the app uses: version, page,
 * notes (cut short), and the download for each platform. Links only to GitHub itself.
 */
function fromRelease(rel, { platform = process.platform, arch = process.arch } = {}) {
  if (!rel || rel.draft || rel.prerelease) return null;
  const version = String(rel.tag_name || '').replace(/^v/, '');
  if (!parse(version)) return null;
  const assets = (Array.isArray(rel.assets) ? rel.assets : []).filter((a) => a && typeof a.name === 'string' && OWN_HOSTS.test(String(a.browser_download_url || '')));
  const find = (re) => assets.find((a) => re.test(a.name))?.browser_download_url || null;
  const desktop =
    platform === 'win32' ? find(/^Siren-Assistant-Setup-[\d.]+\.exe$/)
      : platform === 'darwin' ? find(new RegExp(`^Siren-Assistant-[\\d.]+-mac-${arch === 'arm64' ? 'arm64' : 'x64'}\\.dmg$`))
        : null;
  const page = OWN_HOSTS.test(String(rel.html_url || '')) ? rel.html_url : null;
  return {
    version,
    page,
    notes: String(rel.body || '').slice(0, 4000),
    publishedAt: Date.parse(rel.published_at) || null,
    desktop: desktop || page,
    android: find(/^Siren-Android-[\d.]+\.apk$/),
    wear: find(/^Siren-Wear-[\d.]+\.apk$/),
  };
}

/** What the window shows: an update, unless there is none or the user skipped this version. */
function state(latest, current, { skipped = '' } = {}) {
  if (!latest || !newer(latest.version, current)) return { available: false, current };
  return { available: true, current, skipped: skipped === latest.version, ...latest };
}

module.exports = { parse, newer, fromRelease, state };
