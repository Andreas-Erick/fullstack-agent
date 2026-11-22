// Attachments in the composer: paste (Ctrl+V), drop anywhere on the window, or 📎. Each file becomes a chip
// in the tray above the box you type in and goes with the next message, typed or spoken (chat.js send).
// The window reads the file itself and hands main its bytes (chat:attach), never a path: main checks them
// again, reads a PDF's or Word file's text and holds the result under a one-time token
// (main/attachments.js). Pictures are redrawn here first (≤ 1568 px, PNG or JPEG, plus a small thumbnail).
// The rules (limits, names, chips) are the pure attachcore.mjs, shared with main.
import { $, api, el, toast, toastError, on, emit, dialogOpen } from './util.js';
import { state } from './state.js';
import { currentView, switchView } from './nav.js';
import * as core from './attachcore.mjs';

const { LIMITS } = core;
const ICONS = { image: '🖼', pdf: '📄', docx: '📘', text: '📝', unknown: '📎' };
const AT_ONCE = 2; // files read at the same time

let chips = []; // { id, status: 'reading'|'ready', kind, name, size, token, meta, url, done }
let nextId = 1;
let reading = 0;
const queue = [];

export function initAttach() {
  const picker = $('#attachInput');
  $('#attachBtn').onclick = () => (blocked() ? toast('Attachments work once setup is finished.') : picker.click());
  picker.addEventListener('change', () => {
    addFiles([...picker.files], 'pick');
    picker.value = '';
  });
  // In the box you type in, or anywhere in the chat that isn't another text field.
  document.addEventListener('paste', (e) => {
    if (e.target !== $('#input') && (currentView !== 'chat' || editable(e.target))) return;
    if (!blocked()) onPaste(e);
  });
  // A file dragged over the window never opens as a page (the window would navigate to file://).
  window.addEventListener('dragenter', onDragOver);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragend', endDrag);
  window.addEventListener('drop', onDrop);
  // The image chips warn when the brain can't see pictures; the 📎 button rests during setup.
  on('settings', () => (render(), syncButton()));
  on('view', syncButton);
  on('setup-complete', syncButton);
  $('#input').addEventListener('focus', syncButton);
  syncButton();
}

// The setup conversation, a dialog or the setup wizard: nothing is attached.
const blocked = () => Boolean(state.setupMode) || dialogOpen() || !$('#onboarding').classList.contains('hidden');
const editable = (t) => Boolean(t?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));

function syncButton() {
  const b = $('#attachBtn');
  const setup = Boolean(state.setupMode);
  b.disabled = setup;
  b.title = setup ? 'Attachments work once setup is finished' : 'Attach images or files (you can also paste or drop them on the chat)';
}

// ------------------------------------------------------------------ paste, drop, pick
function onPaste(e) {
  const data = e.clipboardData;
  const files = [...(data?.files || [])];
  // Text wins: Word and Excel also put a picture of the copied text on the clipboard.
  if (!files.length || data.getData('text/plain').trim()) return;
  e.preventDefault();
  addFiles(files.map(named), 'paste');
  // Pasted elsewhere in the chat (a message, History's drawer, which the files close): on to the box, as a drop.
  if (document.activeElement !== $('#input')) $('#input').focus();
}

// A pasted screenshot is called "image.png": it gets a name of its own ("Pasted image 14-32-05.png").
function named(f) {
  if (!f.type.startsWith('image/') || (f.name && !/^image\.\w+$/i.test(f.name))) return f;
  return new File([f], core.pastedName(f.type), { type: f.type, lastModified: f.lastModified });
}

let dragTimer = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

function onDragOver(e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  document.body.classList.add('dragging-files'); // a custom face's frame lets the drag through
  const no = blocked();
  e.dataTransfer.dropEffect = no ? 'none' : 'copy';
  $('#dropOverlay').classList.toggle('hidden', no);
  // dragover repeats while the file hovers; when it stops, the drag left the window.
  clearTimeout(dragTimer);
  dragTimer = setTimeout(endDrag, 150);
}

function endDrag() {
  clearTimeout(dragTimer);
  document.body.classList.remove('dragging-files');
  $('#dropOverlay').classList.add('hidden');
}

function onDrop(e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  endDrag();
  if (blocked() || (editable(e.target) && !e.target.closest('.composer'))) return;
  const items = [...(e.dataTransfer.items || [])].filter((it) => it.kind === 'file');
  const folder = (it) => Boolean(it.webkitGetAsEntry?.()?.isDirectory);
  if (items.some(folder)) toast('Folders can’t be attached. Drop the files inside it, or add the folder in Settings → Documents so Siren can use it.');
  const files = items.length ? items.filter((it) => !folder(it)).map((it) => it.getAsFile()).filter(Boolean) : [...e.dataTransfer.files];
  if (!files.length) return;
  if (currentView !== 'chat') switchView('chat');
  addFiles(files, 'drop');
  $('#input').focus();
}

// ------------------------------------------------------------------ the tray
function addFiles(files, via) {
  if (blocked()) return;
  let added = 0;
  for (const file of files) {
    if (chips.length >= LIMITS.files) {
      toast(`Siren takes up to ${LIMITS.files} attachments per message.`);
      break;
    }
    const c = core.classify({ name: file.name, type: file.type, size: file.size });
    if (c.error) {
      toast(c.error, 'error');
      continue;
    }
    if (c.kind === 'image' && chips.filter((x) => x.kind === 'image').length >= LIMITS.images) {
      toast(`Up to ${LIMITS.images} images per message.`);
      continue;
    }
    if (core.isDuplicate(chips, { name: file.name, size: file.size })) {
      toast(`Already attached: ${file.name}`);
      continue;
    }
    const chip = { id: nextId++, status: 'reading', kind: c.kind, name: file.name, size: file.size, url: c.kind === 'image' ? URL.createObjectURL(file) : '' };
    chips.push(chip);
    chip.done = schedule(() => read(chip, file));
    added++;
  }
  render();
  if (added) emit('files-added', { count: added, via });
}

// At most AT_ONCE files are read at a time; `done` resolves when this one is (it never rejects).
function schedule(job) {
  return new Promise((resolve) => {
    queue.push(() =>
      job().finally(() => {
        reading--;
        resolve();
        pump();
      }),
    );
    pump();
  });
}
function pump() {
  while (reading < AT_ONCE && queue.length) {
    reading++;
    queue.shift()();
  }
}

async function read(chip, file) {
  try {
    const r = chip.kind === 'image' ? await prepareImage(file) : await api.chat.attach({ name: file.name, type: file.type || '', bytes: new Uint8Array(await file.arrayBuffer()) });
    if (!chips.includes(chip)) return; // removed meanwhile: its token expires in main
    if (r.error) {
      remove(chip);
      toast(r.error, 'error');
      return;
    }
    const { token, ...meta } = r;
    Object.assign(chip, { status: 'ready', token, meta, kind: meta.kind });
  } catch (err) {
    if (chips.includes(chip)) remove(chip);
    toastError(err);
  }
  render();
}

// A picture is redrawn on a canvas: its long edge ≤ 1568 px, PNG (a JPEG when that is still big), plus a
// 160 px JPEG thumbnail that stays with the message. An animated GIF gives its first frame.
async function prepareImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { error: `“${file.name}” couldn’t be opened here. Save it as JPEG or PNG and try again.` };
  }
  try {
    const { width, height } = core.fitImage(bitmap.width, bitmap.height, LIMITS.imageEdge);
    let blob = await draw(bitmap, width, height, 'image/png');
    if (blob.size > LIMITS.imageKeepBytes) blob = await draw(bitmap, width, height, 'image/jpeg', 0.88);
    const t = core.fitImage(bitmap.width, bitmap.height, LIMITS.thumbEdge);
    const thumb = await dataUrl(await draw(bitmap, t.width, t.height, 'image/jpeg', 0.7));
    const r = await api.chat.attach({ name: file.name, type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()), width, height, thumb });
    return r.error ? r : { ...r, ...(core.isThumb(thumb) ? { thumb } : {}) };
  } finally {
    bitmap.close();
  }
}

async function draw(bitmap, w, h, type, quality) {
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d');
  // A JPEG has no transparency: a white matte behind it is part of the picture, not a UI colour.
  if (type === 'image/jpeg') (g.fillStyle = '#fff'), g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, w, h);
  return canvas.convertToBlob({ type, quality });
}

const dataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

function remove(chip) {
  const tray = $('#attachTray');
  const i = chips.indexOf(chip);
  if (i < 0) return;
  const hadFocus = tray.contains(document.activeElement);
  if (chip.url) URL.revokeObjectURL(chip.url);
  chips.splice(i, 1);
  render();
  // The keyboard stays in the tray (the next chip), or goes back to the box you type in.
  if (hadFocus) (tray.children[Math.min(i, tray.children.length - 1)] || $('#input')).focus();
}

function render() {
  const tray = $('#attachTray');
  tray.replaceChildren(...chips.map(chipNode));
  tray.classList.toggle('hidden', !chips.length);
}

function chipNode(c) {
  const info = c.meta ? core.chipFor(c.meta) : { icon: ICONS[c.kind] || '📎', name: c.name, detail: '', thumb: '' };
  const hint = c.kind === 'image' ? core.visionHint(state.settings?.llm?.provider) : '';
  const busy = c.status === 'reading';
  const pic = c.url || info.thumb;
  return el(
    'div',
    {
      class: `attach-chip${busy ? ' busy' : ''}${hint ? ' warn' : ''}`,
      role: 'listitem',
      tabindex: '0',
      title: [info.name, busy ? 'Reading…' : info.detail, hint].filter(Boolean).join('\n'),
      'aria-busy': busy ? 'true' : null,
      onkeydown: (e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
        e.preventDefault();
        remove(c);
      },
    },
    pic ? el('img', { src: pic, alt: '' }) : el('span', { class: 'i', 'aria-hidden': 'true' }, info.icon),
    el('span', { class: 'n' }, info.name),
    busy ? el('span', { class: 'r' }, 'Reading…') : null,
    el('button', { class: 'x', type: 'button', 'aria-label': `Remove ${info.name}`, title: 'Remove', onclick: () => remove(c) }, '✕'),
  );
}

// ------------------------------------------------------------------ for chat.js
export const attachmentsSummary = (meta) => core.summary(meta);

/** Resolves once nothing is being read any more: true when at least one attachment is ready to send. */
async function attachmentsReady() {
  while (chips.some((c) => c.status === 'reading')) await Promise.all(chips.filter((c) => c.status === 'reading').map((c) => c.done));
  return chips.some((c) => c.status === 'ready');
}

/** The ready attachments for the message being sent ({ tokens, meta }); the tray lets them go. */
function takeAttachments() {
  const ready = chips.filter((c) => c.status === 'ready');
  chips = chips.filter((c) => c.status !== 'ready');
  for (const c of ready) if (c.url) URL.revokeObjectURL(c.url);
  render();
  return { tokens: ready.map((c) => c.token), meta: ready.map((c) => c.meta) };
}

/** The message couldn't be sent: its attachments come back to the tray (main kept their tokens). */
function restoreAttachments(taken) {
  const tokens = taken?.tokens || [];
  if (!tokens.length) return;
  const back = tokens.map((token, i) => {
    const meta = taken.meta?.[i] || {};
    return { id: nextId++, status: 'ready', token, meta, kind: meta.kind, name: meta.name, size: meta.size, url: '', done: Promise.resolve() };
  });
  chips = [...back, ...chips];
  render();
}

/** The send button while a message waits for its files: "Reading 2 files…". */
function setSendBusy(busy, n = 0) {
  const b = $('#sendBtn');
  const count = chips.filter((c) => c.status === 'reading').length || n;
  const label = busy ? `Reading ${count} file${count === 1 ? '' : 's'}…` : 'Send';
  b.disabled = busy;
  b.classList.toggle('busy', busy);
  b.title = label;
  if (busy) b.setAttribute('aria-label', label);
  else b.removeAttribute('aria-label');
}

/** The tray as the outbox (outbox.js) sees it: what it holds, the wait for files being read, the hand-off. */
export const tray = {
  count: () => chips.length,
  reading: () => chips.some((c) => c.status === 'reading'),
  ready: attachmentsReady,
  take: takeAttachments,
  restore: restoreAttachments,
  setBusy: setSendBusy,
};
