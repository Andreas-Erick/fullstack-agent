// The desktop approval dialog (renderer/js/approval.js show()): its parts in order on its own layer
// (#approvalModal), nothing from the request rendered as HTML (the phone card likewise), and content ids that
// can never take that layer (DOMPurify prefixes them; the smoke check tries them).
const test = require('node:test');
const assert = require('node:assert');
const { read } = require('./appfixture');

test('show() builds the approval card in order on its own layer: kind, title, outside-content warning, detail as text, voice hint, actions', () => {
  const src = read('renderer/js/approval.js');
  const start = src.indexOf('function show(req) {');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /const wrap = document\.getElementById\('approvalModal'\);/);
  const order = [
    "el('h3', {}, `⚠ ${KIND_LABEL[req.kind] || 'Permission'} — approval needed`)",
    'wants to: `, el(\'b\', {}, req.title)',
    "req.tainted ? el('div', { class: 'evo-banner' }",
    "req.detail ? el('pre', { class: 'diff',",
    'approvalHint(req, { pttKey: state.settings?.stt?.pttKey, handsFree: state.settings?.stt?.micMode === \'open\' }), countdown)',
    'req.remember?.length',
    "el('div', { class: 'modal-actions' }",
    "wrap.classList.remove('hidden');",
    "current.release = holdFocus(wrap, card, { role: 'alertdialog', initial: card });",
    'current.shownAt = performance.now();',
    'if (ttsActive()) speaker.say(approvalPrompt(req));',
    "logEvent('info', 'approval requested', { kind: req.kind, title: req.title });",
  ];
  let at = -1;
  for (const s of order) {
    const i = body.indexOf(s, at + 1);
    assert.ok(i > at, `show() lacks, or has out of order: ${s}`);
    at = i;
  }
  assert.doesNotMatch(body, /html:|renderMarkdown|innerHTML = req/, 'nothing from the request is HTML');
  assert.match(body, /req\.detail \? el\('pre', \{[^}]*\{[^}]*\} \}, req\.detail\)/, 'the detail is a text child');
  assert.match(read('renderer/remote/app.js'), /a\.detail \? el\('pre', \{ class: 'detail' \}, String\(a\.detail\)\.slice\(0, 1500\)\)/, 'the phone too');
});

test('content ids can’t take the approval layer: ids are prefixed, and the smoke payload covers the layer', () => {
  const util = read('renderer/js/util.js');
  const configs = [...util.matchAll(/SANITIZE_NAMED_PROPS: true/g)];
  assert.ok(configs.length >= 2, 'renderMarkdown’s and the documents’ configs both prefix ids');
  assert.doesNotMatch(util, /SANITIZE_NAMED_PROPS: false/);
  const ids = /const ids = \[([^\]]*)\];/.exec(read('main/smoke.js'));
  assert.ok(ids, 'smoke.js MARKDOWN_JS has its id payloads');
  const listed = new Set([...ids[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]));
  for (const id of ['modal', 'modalCard', 'toasts', 'approvalModal']) assert.ok(listed.has(id), `MARKDOWN_JS doesn’t try #${id}`);
  assert.match(read('renderer/index.html'), /<div class="modal approval-layer hidden" id="approvalModal">/);
});
