// Findings of the security review of 2026-10-29, each kept fixed: the agent window's local-address
// block (trailing dots, missing ranges, names that resolve to a local address), faces://.. reading the
// data folder, web fetches following a redirect to a local address before checking it, and IPC calls
// from pages that aren't the app's own.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, tmpDir, quietLog } = require('./helpers');

const core = load('main/agentwindowcore.js');
const { isPrivateAddress } = load('main/netcore.js');

test('the agent window never opens this computer or the local network, however it is written', () => {
  for (const host of ['localhost.', 'localhost..', 'foo.localhost.', 'printer.local.', 'router.home', 'nas.lan.', 'box.internal']) assert.ok(core.isPrivateHost(host), host);
  // IPv6 the old check missed: the rest of fe80::/10, site-local, IPv4-compatible, NAT64, multicast.
  for (const host of ['[fe90::1]', '[febf::1]', '[fec0::1]', '[::7f00:1]', '[64:ff9b::7f00:1]', '[ff02::1]', '[::ffff:0:7f00:1]']) assert.ok(core.isPrivateHost(host), host);
  // IPv4: multicast, broadcast, benchmarking.
  for (const host of ['224.0.0.1', '239.255.255.250', '255.255.255.255', '198.18.0.1']) assert.ok(core.isPrivateHost(host), host);
  for (const host of ['example.com', 'example.com.', '93.184.216.34', '[2606:2800:220:1::1]']) assert.ok(!core.isPrivateHost(host), `${host} is public`);
  assert.strictEqual(core.checkUrl('http://localhost.:11434/').ok, false, 'a trailing dot is still localhost');
  assert.ok(core.isIpLiteral('[::1]') && core.isIpLiteral('10.0.0.1') && !core.isIpLiteral('127.0.0.1.nip.io'), 'names (looked up) vs addresses (checked directly)');
});

test('names are looked up, and a name that points to a local address is refused', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/agentwindow.js'), 'utf8');
  assert.match(src, /resolvesPrivate\(ses, u\.hostname\)/, 'every non-literal host is resolved in onBeforeRequest');
  assert.match(src, /ses\.resolveHost\(host\)/);
  // A pass is trusted only for a moment, so a name switched to a local address (DNS rebinding) is caught.
  assert.ok(Number(/const GOOD_FOR_MS = (\d+);/.exec(src)?.[1]) <= 5000, 'a passed lookup is reused for seconds, not a minute');
  assert.match(src, /function isGlobeRequest/, 'the globe exception only for the globe’s own pages');
});

test('IPv4 inside IPv6, both ways of writing it, is checked as IPv4', () => {
  assert.ok(isPrivateAddress('::ffff:127.0.0.1'));
  assert.ok(isPrivateAddress('::ffff:7f00:1'));
  assert.ok(isPrivateAddress('::ffff:0:7f00:1'), 'IPv4-translated (::ffff:0:0/96)');
  assert.ok(isPrivateAddress('::ffff:0:10.0.0.1'));
  assert.ok(!isPrivateAddress('::ffff:5db8:d822'), '93.184.216.34 is public');
});

test('faces:// serves only from inside a face’s own folder', () => {
  stub({ './store': { dataDir: () => tmpDir('siren-faces-') } });
  const faces = load('main/faces.js');
  const root = tmpDir('siren-faces-root-');
  assert.strictEqual(faces.servedFile(root, '..', 'settings.json'), null, 'faces://../settings.json');
  assert.strictEqual(faces.servedFile(root, '.', 'settings.json'), null);
  assert.strictEqual(faces.servedFile(root, 'siren', '../../settings.json'), null);
  assert.strictEqual(faces.servedFile(root, '.hidden', 'x'), null, 'a name starts with a letter, digit, _ or -');
  assert.strictEqual(faces.servedFile(root, 'siren', 'index.html'), path.join(root, 'siren', 'index.html'));
  assert.strictEqual(faces.servedFile(root, 'my-face.v2', 'img/a.png'), path.join(root, 'my-face.v2', 'img', 'a.png'));
  const main = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  assert.match(main, /faces\.servedFile\(await facesDir\(\), name, rel\)/, 'the protocol handler uses it');
});

test('a web fetch checks every redirect before it follows it', async () => {
  stub({ './store': { getSettings: async () => ({ web: { enabled: true } }) }, './logger': quietLog });
  const web = load('main/websearch.js');
  const asked = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    asked.push(url);
    return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:11434/api/tags' } });
  };
  try {
    await assert.rejects(web.fetchPage('http://93.184.216.34/'), /local or private/);
    assert.deepStrictEqual(asked, ['http://93.184.216.34/'], 'the local address was never requested');
  } finally {
    global.fetch = realFetch;
  }
});

test('IPC answers only the app’s own pages', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  assert.match(main, /const fromApp = \(e\) => \/\^app:\\\/\\\/bundle\\\/renderer\\\/\/\.test/);
  assert.match(main, /if \(!fromApp\(e\)\) \{/);
  assert.match(main, /handle\('docs:showInFolder', async \(p\) => shell\.showItemInFolder\(await documents\.resolveAllowed\(p\)\)\)/);
});

test('folder names are compared as Windows compares them: .GIT is .git', () => {
  const files = load('main/files.js');
  for (const p of ['.GIT/hooks/pre-commit', 'Node_Modules/x.js', '.git./config', 'src/.Git /HEAD', String.raw`a\.GIT\config`]) assert.ok(files.hasReservedPart(p, ['.git', 'node_modules']), p);
  for (const p of ['src/gitlab.js', 'main/node_modules_notes.md', '.github/workflows/x.yml']) assert.ok(!files.hasReservedPart(p, ['.git', 'node_modules']), `${p} is fine`);
  for (const f of ['main/codebase.js', 'main/obsidian.js', 'main/claudecode.js', 'main/github.js']) assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /hasReservedPart\(/, `${f} uses it`);
});

test('a link or junction inside an allowed folder can’t reach outside it', () => {
  const files = load('main/files.js');
  const dir = tmpDir('siren-link-');
  const vault = path.join(dir, 'vault');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(vault);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
  fs.symlinkSync(outside, path.join(vault, 'link'), 'junction');
  assert.throws(() => files.resolveInside(vault, 'link/secret.txt'), /outside the allowed folder/, 'reading through it');
  assert.throws(() => files.resolveInside(vault, 'link/new/planted.md'), /outside the allowed folder/, 'writing a new file through it');
  assert.ok(!files.isInside(vault, path.join(vault, 'link', 'secret.txt')));
  assert.throws(() => files.resolveInside(vault, 'note.md:hidden'), /outside the allowed folder/, 'an alternate data stream');
  assert.strictEqual(files.resolveInside(vault, 'Notes/a.md'), path.join(vault, 'Notes', 'a.md'), 'ordinary notes still work');
});

test('diagrams: cleaned until nothing changes, and every saved page carries a CSP that stops what is left', async () => {
  const dir = tmpDir('siren-diag-');
  stub({ './obsidian': { vaultPath: async () => dir, ymd: () => '2026-10-29' } });
  const diagrams = load('main/diagrams.js');
  assert.doesNotMatch(diagrams.sanitize('<div><scr<script>ipt>x()</scr</script>ipt></div>'), /<script/i, 'a split script tag can’t rebuild itself');
  assert.doesNotMatch(diagrams.sanitize('<svg/onload="x()"><rect/></svg><img src="x"onerror="y()">'), /on(load|error)/i, 'handlers without a space before them');
  assert.doesNotMatch(diagrams.sanitize('<svg><a><animate attributeName="href" values="javascript:x()"/></a></svg>'), /animate/i);
  const r = await diagrams.save('Test', '<div>hi</div>');
  assert.match(fs.readFileSync(r.path, 'utf8'), /<head><meta http-equiv="Content-Security-Policy" content="default-src 'none';/, 'the CSP comes first');
  await assert.rejects(diagrams.save('Huge', `<div>${'<a '.repeat(1100000)}`), /over 2 MB/, 'the size is checked before cleaning');
});

test('Anki media can’t unpack past its limit, whatever size the archive declares', () => {
  const core = load('main/flashimportcore.js');
  const zlib = require('zlib');
  const big = zlib.deflateRawSync(Buffer.alloc(5 * 1024 * 1024)); // 5 MB of zeros, a few KB packed
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  const buf = Buffer.concat([local, big]);
  const entry = { name: '0', method: 8, csize: big.length, size: 1, local: 0 }; // claims 1 byte
  assert.throws(() => core.zipRead(buf, entry, { max: 1024 * 1024 }), /too large/, 'stopped at 1 MB while unpacking');
  assert.strictEqual(core.zipRead(buf, entry, { max: 6 * 1024 * 1024 }).length, 5 * 1024 * 1024, 'within the limit it unpacks');
  assert.throws(() => core.zipRead(buf, { ...entry, csize: buf.length * 2 }), /Damaged/, 'data past the end of the file');
});

test('during setup, moving the vault asks in the app like the workspace does', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/tools.js'), 'utf8');
  assert.match(src, /\['documents\.workspace', 'obsidian\.vaultPath'\]\.includes\(a\.setting\)/);
});

test('the phone can’t read deleted notes or the vault’s settings', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/companiondata.js'), 'utf8');
  assert.ok(src.includes(String.raw`/(^|\/)\.(obsidian|trash|git)\b/i.test(p)`), 'the note filter refuses .trash, .obsidian and .git anywhere in the path');
});

test('Access: a token with an unknown key fetches the certificates at most once a minute', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/tunnel.js'), 'utf8');
  assert.match(src, /if \(c && fresh && Date\.now\(\) - c\.at < 60 \* 1000\) return c\.keys;/);
});
