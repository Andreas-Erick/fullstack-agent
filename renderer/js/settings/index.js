// Configuration dashboard. Every control auto-saves to settings.json (secrets are encrypted at rest).
// This module draws the view: the tabs and search, the card list (CARDS) and render; the cards live in
// the modules beside it, the shared saving state in core.js and the field builders in fields.js.
import { $, api, el, toast, on, logEvent } from '../util.js';
import { state, loadSettings } from '../state.js';
import { currentView } from '../nav.js';
import { setBeforeSwitch } from '../personas.js';
import { TABS, tabFor, validTab, stepTab, matches } from '../settingstabs.js';
import { advancedShown, advancedNote } from '../settingsmode.js';
import { renderedPersona, setRenderedPersona, setRenderer, flushSaves, save } from './core.js';
import { card } from './fields.js';
import { agentCard } from './persona.js';
import { extensionProgress, extensionsCard } from './connectors.js';
import { brainCard } from './brain.js';
import { sttProgressEl, ttsProgressEl, voiceCard, sttCard } from './voice.js';
import { learningCard, calendarCard, githubCard, obsidianCard, webCard, selfCard, docsCard, worldCard, dataCard } from './workspace.js';
import { refreshRemote, refreshRemoteStatus, remoteCard } from './remote.js';
import { safetyCard, refreshHelperApps, helperAppsCard, healthCard, uiCard } from './system.js';

// ------------------------------------------------------------------- render
setRenderer(render);

export function initSettings() {
  setBeforeSwitch(flushSaves); // a switch in the title bar saves what was just typed here first
  on('stt-progress', (p) => {
    if (!sttProgressEl) return;
    if (p.status === 'progress' && p.file) sttProgressEl.textContent = `Downloading ${p.file.split('/').pop()} — ${Math.round(p.progress || 0)}%`;
    else if (p.status === 'ready') sttProgressEl.textContent = '✓ Speech model loaded and ready.';
    else if (p.status === 'error') sttProgressEl.textContent = `✕ ${p.error}`;
  });
  on('tts-progress', (p) => {
    if (!ttsProgressEl) return;
    if (p.status === 'progress' && p.file) ttsProgressEl.textContent = `Downloading ${p.file.split('/').pop()} — ${Math.round(p.progress || 0)}%`;
    else if (p.status === 'ready') ttsProgressEl.textContent = `✓ Offline voice ready (${p.device}).`;
    else if (p.status === 'error') ttsProgressEl.textContent = `✕ ${p.message}`;
  });
  api.on('helperApps:event', (ev) => ev.type === 'status' && refreshHelperApps?.());
  api.on('extensions:progress', (p) => extensionProgress && (extensionProgress.textContent = `${p.step}${p.line ? `: ${p.line}` : ''}`));
  api.on('remote:event', (ev) => {
    if (ev.type === 'tunnel') return refreshRemoteStatus?.();
    if (ev.type === 'connected' || ev.type === 'disconnected') return refreshRemoteStatus?.();
    if (ev.type !== 'paired' && ev.type !== 'moved') return;
    toast(ev.type === 'moved' ? `${ev.name} now uses the secure address` : `Paired: ${ev.name}`);
    refreshRemote?.();
  });
  on('view', ({ name, section }) => {
    if (name !== 'settings') return;
    // A link to one card ("brain" from the title bar's pill) opens its tab at once, then scrolls to it
    // once the new cards are in (several of them load data first).
    if (section) (activeTab = tabFor(section)), (query = ''), drawTabsKeepingSearch(), showCards();
    scrollTarget = section || null;
    // Read again first: a persona switched on the phone, the watch or by a routine never reached this
    // window, and the studio would show (and save into) the one before.
    render({ reload: true }).catch((err) => logEvent('warn', 'settings render failed', { message: String(err?.message || err) }));
  });
  // The persona changed (the title bar, the agent, or found by a reload): the studio shows the new one.
  // Only a persona change redraws: the user's own saves keep the same active persona. Compared with the
  // latest render's persona, so a switch back while a redraw is under way redraws once more.
  on('settings', (s) => currentView === 'settings' && s?.personas?.active !== drawingFor && render());
}

// ------------------------------------------------------------------- tabs
// One group of cards at a time (settingstabs.js), and a search across all of them. The tab is
// remembered in this window only (a convenience: without storage it opens on the first tab).
function storedTab() {
  try {
    return localStorage.getItem('settings.tab');
  } catch {
    return null;
  }
}
let activeTab = validTab(storedTab());
let query = '';

function chooseTab(id, { focus = false } = {}) {
  activeTab = validTab(id);
  query = '';
  try {
    localStorage.setItem('settings.tab', activeTab);
  } catch {
    /* private window: not remembered */
  }
  drawTabs();
  showCards();
  const view = $('#settingsRoot').parentElement;
  view.scrollTop = 0;
  if (focus) $(`#settingsTabs [data-tab="${activeTab}"]`)?.focus();
}

function drawTabs() {
  const bar = $('#settingsTabs');
  if (!bar) return;
  const searching = Boolean(query.trim());
  const tabs = TABS.map((t) => {
    const on = !searching && t.id === activeTab;
    return el('button', { class: `settings-tab${on ? ' active' : ''}`, role: 'tab', type: 'button', 'data-tab': t.id, id: `settings-tab-${t.id}`, 'aria-selected': String(on), 'aria-controls': 'settingsRoot', tabindex: on || (searching && t === TABS[0]) ? '0' : '-1', onclick: () => chooseTab(t.id) }, t.label);
  });
  const list = el('div', { class: 'settings-tablist', role: 'tablist', 'aria-label': 'Settings sections' }, ...tabs);
  // ← / → between tabs, Home / End to the first and last (docs/KEYBOARD.md).
  list.addEventListener('keydown', (e) => {
    const current = e.target.closest?.('[data-tab]')?.dataset.tab;
    if (!current) return;
    const to = e.key === 'ArrowRight' ? stepTab(current, 1) : e.key === 'ArrowLeft' ? stepTab(current, -1) : e.key === 'Home' ? TABS[0].id : e.key === 'End' ? TABS[TABS.length - 1].id : null;
    if (!to) return;
    e.preventDefault();
    chooseTab(to, { focus: true });
  });
  const search = el('input', { type: 'search', class: 'settings-search', placeholder: 'Search settings', 'aria-label': 'Search all settings', value: query });
  search.addEventListener('input', () => {
    query = search.value;
    drawTabsKeepingSearch();
    showCards();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) (e.preventDefault(), (search.value = ''), (query = ''), drawTabsKeepingSearch(), showCards());
  });
  const saved = $('#saveState') || el('span', { class: 'save-state', id: 'saveState' }, '✓ Saved');
  bar.replaceChildren(list, saved, advancedSwitch(), search);
}

// Simple / Advanced (settingsmode.js): the switch at the top of Settings, remembered in ui.settingsAdvanced.
// Changing it only shows or hides the marked fields; nothing is drawn again.
function advancedSwitch() {
  const input = el('input', { type: 'checkbox', 'data-setting': 'ui.settingsAdvanced' });
  input.checked = advancedMode();
  input.addEventListener('change', async () => {
    if (!(await save('ui.settingsAdvanced', input.checked))) input.checked = advancedMode();
    showCards();
  });
  return el('label', { class: 'toggle settings-mode', title: 'Server addresses, keys, models, sampling and paths' }, input, el('span', { class: 'sw' }), el('span', {}, 'Show advanced'));
}
const advancedMode = () => Boolean(state.settings?.ui?.settingsAdvanced);

// Redraws the tabs' state while the search field keeps its focus and caret.
function drawTabsKeepingSearch() {
  const searching = Boolean(query.trim());
  const search = document.querySelector('#settingsTabs .settings-search');
  if (search && document.activeElement !== search && search.value !== query) search.value = query; // a link cleared it
  for (const b of document.querySelectorAll('#settingsTabs .settings-tab')) {
    const on = !searching && b.dataset.tab === activeTab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on || (searching && b.dataset.tab === TABS[0].id) ? 0 : -1;
  }
}

// What a card says and what is set in it ("localhost" finds the VoiceStudio address): labels and
// descriptions, typed values and chosen options. Never a password field's value.
function cardText(card) {
  const values = [...card.querySelectorAll('input, textarea, select')].map((f) => {
    if (f.type === 'password' || f.type === 'hidden' || f.type === 'checkbox' || f.type === 'range') return '';
    return f.tagName === 'SELECT' ? f.selectedOptions[0]?.textContent || '' : f.value || '';
  });
  return `${card.textContent} ${values.join(' ')}`;
}

function showCards() {
  const root = $('#settingsRoot');
  if (!root) return;
  const searching = Boolean(query.trim());
  let shown = 0;
  for (const note of root.querySelectorAll('.adv-note')) note.remove(); // not part of what the search reads
  for (const card of root.querySelectorAll(':scope > .card')) {
    const show = searching ? matches(cardText(card), query) : tabFor(card.id.replace(/^set-/, '')) === activeTab;
    card.classList.toggle('tab-hidden', !show);
    if (show) shown++;
  }
  showAdvanced(root, searching);
  // A folded block whose fields the search finds opens (Remote access's "Use it away from home").
  if (searching) for (const d of root.querySelectorAll(':scope > .card:not(.tab-hidden) details')) if (!d.open && matches(cardText(d), query)) d.open = true;
  if (searching) root.removeAttribute('aria-labelledby');
  else root.setAttribute('aria-labelledby', `settings-tab-${activeTab}`);
  let empty = root.querySelector(':scope > .settings-empty');
  if (searching && !shown) {
    if (!empty) root.append((empty = el('p', { class: 'settings-empty muted' })));
    empty.textContent = `No setting matches “${query.trim()}”.`;
  } else empty?.remove();
}

// The fields marked advanced (fields.js markAdvanced): shown in Advanced mode; in Simple mode only those a
// search matches, with the note "Advanced setting" by their label. Inside a revealed advanced block everything
// shows, with one note on the block. A row of two hidden fields hides too (no empty gap).
function showAdvanced(root, searching) {
  const on = advancedMode();
  for (const node of root.querySelectorAll('[data-advanced]')) {
    const inShown = node.parentElement?.closest('[data-advanced]')?.classList.contains('adv-shown');
    const s = { advancedMode: on, searching, matched: Boolean(inShown) || (searching && matches(cardText(node), query)) };
    node.classList.toggle('adv-shown', advancedShown(s));
    const note = inShown ? '' : advancedNote(s);
    if (note) (node.matches('label') ? node : node.querySelector(':scope > label, :scope > .toggle') || node).append(el('span', { class: 'adv-note' }, note));
  }
  for (const row of root.querySelectorAll('.grid2, .row')) {
    const kids = [...row.children];
    row.classList.toggle('adv-empty', kids.length > 0 && kids.every((k) => k.matches('[data-advanced]:not(.adv-shown)')));
  }
}

// Every card, in order: [id as passed to card() (settingstabs.js tabs), title for its error card, builder].
// A builder that keeps a module-level reference (sttProgressEl, refreshRemote…) sets it before its first
// await, so the latest render's cards are the ones it points to.
const CARDS = [
  ['agent', 'Persona studio', agentCard], ['brain', 'AI brain', brainCard], ['extensions', 'Extensions', extensionsCard],
  ['voice', 'Voice output', voiceCard], ['stt', 'Voice input', sttCard], ['learning', 'Learning', learningCard],
  ['helperapps', 'Helper apps', helperAppsCard], ['safety', 'Safety & permissions', safetyCard], ['remote', 'Remote access', remoteCard],
  ['obsidian', 'Obsidian vault', obsidianCard], ['web', 'Internet', webCard], ['code', 'Self-improvement', selfCard],
  ['health', 'Health & the mechanic', healthCard], ['calendar', 'Calendar', calendarCard], ['github', 'GitHub', githubCard],
  ['documents', 'Documents & folder access', docsCard], ['data', 'Memory & history', dataCard], ['world', 'Inner World', worldCard], ['ui', 'Interface', uiCard],
];
let renderGen = 0;
let drawingFor = null; // the persona the latest render draws for
let scrollTarget = null; // the card a link opened (a status light), brought into view when the latest render lands
let refocus = null; // { path, persona }: the field that had the keyboard focus when a redraw began
// Builds every card at once (the slow ones in parallel) and swaps them in together: the old cards stay
// until the new ones exist, and only the latest render lands (two renders used to show every card twice).
// Meanwhile the old cards can't be changed (inert): a value typed into them would show older in the new
// cards and be saved over. What still waits to be saved goes in first, so the new cards show it.
async function render({ reload = false } = {}) {
  const mine = ++renderGen;
  const root = $('#settingsRoot');
  const focused = document.activeElement?.closest?.('#settingsRoot [data-setting]');
  if (focused) refocus = { path: focused.dataset.setting, persona: renderedPersona };
  root.inert = true;
  root.setAttribute('aria-busy', 'true');
  try {
    if (!root.childElementCount) root.replaceChildren(el('p', { class: 'muted' }, 'Loading settings…'));
    await flushSaves();
    if (reload) await loadSettings().catch(() => {}); // a changed persona redraws once more (the settings listener)
    if (mine !== renderGen) return false;
    const persona = (drawingFor = state.settings.personas?.active); // the cards below are drawn for this persona
    const cards = await Promise.all(CARDS.map(([id, title, build]) => safeCard(id, title, build)));
    if (mine !== renderGen) return false;
    const scroll = root.parentElement.scrollTop;
    root.replaceChildren(...cards);
    root.inert = false;
    root.removeAttribute('aria-busy');
    root.setAttribute('role', 'tabpanel');
    setRenderedPersona(persona);
    if (!document.querySelector('#settingsTabs .settings-tablist')) drawTabs();
    else drawTabsKeepingSearch();
    showCards();
    root.parentElement.scrollTop = scroll;
    // A switch toggled with Space (or a select) keeps the keyboard focus, unless the cards are another persona's.
    const back = refocus?.persona === persona && root.querySelector(`[data-setting="${CSS.escape(refocus.path)}"]`);
    if (back && (!document.activeElement || document.activeElement === document.body)) back.focus({ preventScroll: true });
    refocus = null;
    if (scrollTarget) $(`#set-${scrollTarget}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    scrollTarget = null;
    return true;
  } finally {
    if (mine === renderGen) (root.inert = false), root.removeAttribute('aria-busy');
  }
}

// A card whose builder throws shows its own error with Try again; the others still render.
async function safeCard(id, title, build) {
  try {
    return await build();
  } catch (err) {
    logEvent('warn', 'settings card failed', { id, message: String(err?.message || err).slice(0, 200) });
    return card(id, title, '', el('div', { class: 'test-result err', role: 'alert' }, `This section couldn’t load: ${err?.message || err}`), el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => render() }, '⟳ Try again')));
  }
}
