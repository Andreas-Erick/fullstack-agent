// Conversations sealed at rest (main/store.js, privacy.encryptConversations): files and the index are
// encrypted with the OS keychain, older plain files still open and get converted, turning it off unseals.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog } = require('./helpers');

const dir = tmpDir('nexus-convseal-');
// A stand-in keychain: reversible, and visibly not the plain text.
const KEY = 0x5a;
const flip = (buf) => Buffer.from(buf.map((b) => b ^ KEY));
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => flip(Buffer.from(s, 'utf8')),
  decryptString: (b) => flip(b).toString('utf8'),
};
stub({ electron: { app: { getPath: () => dir }, safeStorage }, './logger': quietLog });
const store = load('main/store.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const convDir = path.join(dir, 'conversations');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rawOf = (id) => fs.readFileSync(path.join(convDir, `${id}.json`), 'utf8');

test('new conversations and the index are sealed; nothing readable on disk', async () => {
  await store.getSettings(); // default: on
  const c = await store.createConversation('Doctor appointment');
  c.messages.push({ role: 'user', content: 'my blood test results' });
  await store.saveConversation(c);
  const raw = rawOf(c.id);
  assert.match(raw, /"sealed":"v1"/);
  assert.ok(!raw.includes('blood test') && !raw.includes('Doctor'), 'no plain text on disk');
  assert.strictEqual((await store.getConversation(c.id)).messages[0].content, 'my blood test results');
  await wait(700);
  const index = fs.readFileSync(path.join(convDir, 'index.json'), 'utf8');
  assert.ok(!index.includes('Doctor'), 'titles in the index are sealed too');
  assert.ok((await store.listConversations()).some((x) => x.title === 'Doctor appointment'));
});

test('an older plain file still opens and is sealed in the background', async () => {
  fs.writeFileSync(path.join(convDir, 'cold1.json'), JSON.stringify({ id: 'cold1', title: 'Old chat', createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: 'plain words' }] }));
  assert.strictEqual((await store.getConversation('cold1')).title, 'Old chat');
  assert.ok((await store.resealConversations()) >= 1);
  assert.ok(!rawOf('cold1').includes('plain words'));
  assert.strictEqual((await store.getConversation('cold1')).messages[0].content, 'plain words');
});

test('turning it off writes them back as plain JSON; a file that cannot be decrypted is left alone', async () => {
  await store.setSettings({ privacy: { encryptConversations: false } });
  await store.resealConversations();
  assert.match(rawOf('cold1'), /plain words/);
  fs.writeFileSync(path.join(convDir, 'alien.json'), JSON.stringify({ sealed: 'v1', data: 'not-for-this-key' }));
  safeStorage.decryptString = () => {
    throw new Error('wrong key');
  };
  assert.strictEqual(await store.getConversation('alien'), null);
  await store.resealConversations();
  assert.match(rawOf('alien'), /not-for-this-key/, 'never overwritten');
  safeStorage.decryptString = (b) => flip(b).toString('utf8');
  await store.setSettings({ privacy: { encryptConversations: true } });
});

// Store problems go to the log (store.js holds the logger object, so swapping its warn records them),
// by the file's name only and without the file's words.
async function warningsWhile(fn) {
  const seen = [];
  const warn = quietLog.warn;
  quietLog.warn = (event, data) => seen.push({ event, data });
  try {
    await fn();
  } finally {
    quietLog.warn = warn;
  }
  return seen;
}

test('a conversation that can’t be decrypted is logged by its file name, never the folder', async () => {
  fs.writeFileSync(path.join(convDir, 'calien2.json'), JSON.stringify({ sealed: 'v1', data: 'not-for-this-key' }));
  const decrypt = safeStorage.decryptString;
  safeStorage.decryptString = () => {
    throw new Error('wrong key');
  };
  let got;
  const seen = await warningsWhile(async () => (got = await store.getConversation('calien2'))).finally(() => (safeStorage.decryptString = decrypt));
  assert.strictEqual(got, null);
  const rec = seen.find((r) => r.event === 'conversation unreadable');
  assert.ok(rec, JSON.stringify(seen));
  assert.strictEqual(rec.data.file, 'calien2.json');
  assert.ok(!JSON.stringify(rec).includes(path.basename(dir)), 'no folder in the log');
});

test('a conversation file that isn’t JSON is logged without its words', async () => {
  fs.writeFileSync(path.join(convDir, 'cplain2.json'), 'my blood test results');
  let got;
  const seen = await warningsWhile(async () => (got = await store.getConversation('cplain2')));
  assert.strictEqual(got, null);
  const rec = seen.find((r) => r.event === 'unreadable JSON');
  assert.ok(rec, JSON.stringify(seen));
  assert.strictEqual(rec.data.file, 'cplain2.json');
  assert.ok(!/blood/.test(JSON.stringify(rec)), JSON.stringify(rec));
  assert.ok(!JSON.stringify(rec).includes(path.basename(dir)));
});
