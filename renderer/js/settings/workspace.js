// The cards for the user's things: learning, calendar, GitHub, the Obsidian vault, internet, self-improvement,
// documents and folder access, the Inner World, memory and history.
import { api, el, escapeHtml, toast, toastError, confirmDialog, confirmExportFirst, emit } from '../util.js';
import { state, loadSettings } from '../state.js';
import { refreshList, newChat } from '../chat.js';
import { settleDelete } from '../history.js';
import { switchView } from '../nav.js';
import { LANGUAGE_NAMES } from '../practice.js';
import { checkNow as checkUpdatesNow } from '../updates.js';
import { save, render } from './core.js';
import { text, toggle, select, fillSelect, field, folder, card, result, showResult } from './fields.js';

// Learning: language practice. The tracker and decks live in the vault (Learning/, Languages/).
export function learningCard() {
  const langs = [['', 'Off'], ...Object.entries(LANGUAGE_NAMES).filter(([c]) => c !== 'en').map(([c, n]) => [c, n])];
  const englishOnly = /\.en$/i.test(state.settings.stt.localModel) && state.settings.stt.engine === 'local';
  return card(
    'learning',
    'Learning',
    'Say “help me understand…”, “coach me through this proof” or “let’s study” for understanding-first tutoring; formulas render on screen and are read aloud in words. What you understood, what is shaky and your open questions are kept in <code>Learning/</code> in the vault; vocabulary decks with spaced repetition in <code>Languages/</code>. Skills: <code>/explain</code>, <code>/proof-coach</code>, <code>/teach-back</code>, <code>/study-session</code>, <code>/drill</code>, <code>/converse</code>.',
    select('learning.practiceLanguage', 'Language practice', langs, { hint: `While on, speech recognition listens for that language and replies are spoken by a voice for it (the “Practice” pill in the title bar ends it). The assistant turns it on when you say “let’s practice French”.${englishOnly ? ' <b>Your speech model is English-only:</b> pick a multilingual one in Voice input.' : ''}` }),
    select('learning.practiceVoice', 'Voice during practice', [['system', 'A Windows voice for that language'], ['assistant', 'The persona’s own voice (if it speaks the language)']], { hint: 'Windows voices for other languages: Windows Settings → Time & language → Speech → Add voices. Natural voices sound best.' }),
  );
}

export async function calendarCard() {
  const st = await api.calendar.status().catch(() => ({}));
  const line = !st.vault
    ? el('div', { class: 'test-result err' }, '✕ The schedule lives in the vault, which is off. Turn the vault on above.')
    : st.unreadable
      ? el('div', { class: 'test-result err' }, `✕ Schedule.md couldn’t be read: ${st.unreadable}`)
      : el('div', { class: `test-result ${st.problems ? 'err' : 'ok'}` }, `✓ Schedule.md in your vault · ${st.recurring || 0} repeating, ${st.events || 0} single entries${st.problems ? ` · ${st.problems} line(s) couldn’t be read` : ''}`);
  return card(
    'calendar',
    'Calendar',
    `Nothing to connect: tell ${state.settings.agent.name} your schedule (“I have Linear Algebra every Monday at 10:00 in H1 until February”, “dentist on the 28th at 2”) and it keeps it in <b>Schedule.md</b> in its vault. You can add and edit entries in the Calendar view, or edit the note in Obsidian. Nothing leaves this computer.`,
    toggle('calendar.enabled', 'Enable the calendar', () => emit('status-refresh')),
    line,
    el('div', { class: 'grid2' }, text('calendar.daysAhead', 'Days ahead in the agent’s context', { type: 'number' }), el('div', { style: { alignSelf: 'end' } }, el('button', { class: 'btn', onclick: () => switchView('calendar') }, 'Open the calendar'))),
  );
}

// The GitHub line fills in by itself once gh answers (a network call): the card never holds up the page.
let ghStatus = null; // { at, promise }: Settings redraws often; gh is asked at most once a minute
export function githubCard() {
  const line = el('div', { class: 'test-result' }, 'Checking GitHub…');
  const repos = folder('github.workspace', 'Repos folder', { placeholder: '~/SirenRepos', hint: 'Where repositories are cloned. Keep it out of OneDrive/Dropbox.' });
  // Written even before the card is on screen: the answer can come before the render lands, and a
  // card that was superseded is simply never shown. Only this card's latest check writes the line.
  let asked = 0;
  const check = async (fresh) => {
    const mine = ++asked;
    if (state.settings.github?.enabled === false) return ((line.className = 'test-result'), (line.textContent = 'GitHub is off.'));
    if (fresh) (line.className = 'test-result'), (line.textContent = 'Checking GitHub…');
    if (fresh || !ghStatus || Date.now() - ghStatus.at > 60000) ghStatus = { at: Date.now(), promise: api.github.status().catch((e) => ({ connected: false, error: e.message })) };
    const st = await ghStatus.promise;
    if (mine !== asked) return;
    line.className = `test-result ${st.connected ? 'ok' : 'err'}`;
    line.textContent = st.connected ? `✓ Connected as ${st.login} (through the GitHub CLI)` : `✕ ${st.error || 'Not connected'}`;
    if (st.workspace) repos.querySelector('input').placeholder = st.workspace;
  };
  check(false);
  const again = el('button', {
    class: 'btn small',
    onclick: async () => {
      again.disabled = true; // gh is a network call: one at a time
      await check(true);
      again.disabled = false;
    },
  }, '⟳ Check again');
  return card(
    'github',
    'GitHub',
    `Lets ${state.settings.agent.name} read your repositories, issues and pull requests, and work on them when you ask: it clones a repo into the folder below, changes it on a new branch and commits there (approved per your permission mode). <b>Pushing and opening a pull request always ask you first</b>, it never touches the default branch directly and never merges. Uses the GitHub CLI: install it and run <code>gh auth login</code> once.`,
    toggle('github.enabled', 'Enable GitHub', () => render()),
    repos,
    line,
    el('div', { class: 'row' }, again),
  );
}

export async function obsidianCard() {
  const [st, def, known] = await Promise.all([api.obsidian.status().catch(() => ({})), api.obsidian.defaultPath().catch(() => ''), api.obsidian.vaults().catch(() => [])]);
  const line = el('div', { class: `test-result ${st.ok ? 'ok' : 'err'}` }, st.ok ? `✓ ${st.count} notes in ${st.path}` : st.enabled === false ? 'Vault disabled.' : '✕ Vault folder unavailable');
  const after = () => (emit('status-refresh'), render());
  return card(
    'obsidian',
    `${state.settings.agent.name}'s Obsidian vault`,
    'The agent’s own second brain: a real Obsidian vault it reads <b>and writes</b> — research, notes, journal, its memories (Memory/) and a changelog of its self-changes. Open it in Obsidian any time.',
    toggle('obsidian.enabled', 'Enable the vault', after),
    folder('obsidian.vaultPath', 'Vault folder', { placeholder: def, hint: `Leave empty for the agent’s own vault (<code>${escapeHtml(def)}</code>). You can also point it at an existing vault.`, onChange: after }),
    adoptField(known, after),
    toggle('obsidian.gitHistory', 'Keep a version history of every note (undo any agent edit)'),
    el('div', { class: 'grid2' }, toggle('journal.enabled', 'Auto-journal: log each conversation to the daily note'), text('journal.idleMinutes', 'Journal after (minutes quiet)', { type: 'number' })),
    toggle('journal.handoffOnClose', 'When I close the app, note where we left off (continue from there next time; also saved as “Where We Left Off” in the vault)'),
    el(
      'div',
      { class: 'row', style: { flexWrap: 'wrap' } },
      el('button', { class: 'btn', onclick: () => api.obsidian.openInObsidian().catch(toastError) }, '◆ Open in Obsidian'),
      el('button', { class: 'btn', onclick: () => api.obsidian.openFolder() }, '📁 Open folder'),
      st.registered ? '' : el('button', { class: 'btn', onclick: async () => { try { await api.obsidian.register(); toast('Registered — the vault now appears in Obsidian’s vault list.'); render(); } catch (e) { toastError(e); } } }, 'Register in Obsidian'),
    ),
    line,
  );
}

// Adopt one of the vaults Obsidian already knows (structure is added; nothing is overwritten).
function adoptField(known, after) {
  if (!known.length) return '';
  const sel = el('select', { class: 'input' });
  fillSelect(sel, [['', '— use one of your Obsidian vaults —'], ...known.filter((v) => v.exists).map((v) => [v.path, `${v.name} (${v.path})`])], '');
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    if (!(await confirmDialog('Use this vault?', `The agent will use “${sel.value}” as its vault. It adds its structure (VAULT-INDEX, Profile, Active Priorities, Daily Notes, Jobs, Memory…) without overwriting anything.`, 'Use it', false))) return;
    await save('obsidian.vaultPath', sel.value);
    after();
  });
  return field('Or adopt an existing Obsidian vault', sel);
}

export function webCard() {
  const p = state.settings.web.provider;
  const out = result();
  const extra = [];
  if (p === 'searxng') extra.push(text('web.searxngUrl', 'SearXNG URL', { placeholder: 'http://localhost:8080', hint: 'Self-hosted, free. JSON output must be enabled in its settings.yml.' }));
  if (p === 'brave') extra.push(text('web.braveKey', 'Brave Search API key', { type: 'password' }));
  if (p === 'tavily') extra.push(text('web.tavilyKey', 'Tavily API key', { type: 'password' }));
  return card(
    'web',
    'Internet',
    'Lets the agent search the web and read pages. With the Claude account provider, Claude Code’s built-in web search is used instead.',
    toggle('web.enabled', 'Allow internet access'),
    toggle('agentWindow.enabled', 'Agent window: let the agent open and use websites (and the globe) in a browser window you can watch'),
    el('div', { class: 'hint' }, 'The agent window has its own sign-ins (separate from your browser), no camera, microphone or downloads, and never opens anything on this computer or your network. Clicking and typing on a page follow your permission mode; passwords and payment details are always yours to type. ', el('a', { href: '#', onclick: (e) => (e.preventDefault(), api.agentWindow.open()) }, 'Open it')),
    select('web.provider', 'Search provider', [['duckduckgo', 'DuckDuckGo (free, no key)'], ['searxng', 'SearXNG (self-hosted)'], ['brave', 'Brave Search API'], ['tavily', 'Tavily API']], { onChange: () => render() }),
    ...extra,
    el('div', { class: 'row' }, el('button', {
      class: 'btn primary',
      onclick: async () => {
        showResult(out, true, 'Searching…');
        try {
          const r = await api.web.search('latest news today');
          showResult(out, true, `✓ ${r.results.length} results via ${r.provider}\n${r.results.slice(0, 3).map((x) => `• ${x.title}`).join('\n')}`);
        } catch (err) {
          showResult(out, false, `✕ ${err.message}`);
        }
      },
    }, '🌐 Test search')),
    out,
  );
}

export async function selfCard() {
  const [st, root] = await Promise.all([api.self.status().catch((e) => ({ available: false, reason: e.message })), api.code.root().catch(() => '')]);
  const line = el(
    'div',
    { class: `test-result ${st.available && st.isRepo ? 'ok' : st.available ? '' : 'err'}` },
    !st.available ? `✕ ${st.reason}` : st.isRepo ? `✓ Change history active (git) · current version ${st.head}${st.dirty?.length ? ` · ${st.dirty.length} uncommitted file(s)` : ''}` : 'History will start on the first change.',
  );
  return card(
    'code',
    'Self-improvement',
    'Ask the agent for new features and it implements them by editing its own source code. Every change is syntax-checked and recorded so you can review, revert or restore any version from <b>More → Changes Siren made to itself</b>.',
    toggle('code.enabled', 'Let the agent read its own source code'),
    toggle('code.allowSelfModify', 'Let the agent modify its own code (tracked & revertible)', () => render()),
    folder('code.rootPath', 'Code root', { placeholder: root, hint: `Leave empty for this app’s own source (<code>${escapeHtml(root)}</code>).` }),
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => switchView('evolution') }, '⑂ Open Changes Siren made')),
    line,
  );
}

export async function docsCard() {
  // Only the workspace folder by default; every other folder is one the user added here (and can remove).
  const extra = state.settings.documents.allowedRoots || [];
  const ws = state.settings.documents.workspace;
  const list = el('div', { class: 'field' });
  list.append(el('label', {}, 'Folders the agent may use'));
  const row = (p, note, action) => el('div', { class: 'row' }, el('code', { class: 'path', style: { flex: 1, fontSize: '12px' } }, p), note ? el('span', { class: 'hint' }, note) : '', action || '');
  if (ws) list.append(row(ws, 'workspace'));
  for (const r of extra) list.append(row(r, '', el('button', { class: 'btn small', onclick: async () => (await save('documents.allowedRoots', extra.filter((x) => x !== r)), render()) }, 'Remove')));
  if (!ws && !extra.length) list.append(el('div', { class: 'hint' }, 'None yet: set a workspace folder above. Until then the agent can only use its vault and files you open yourself.'));
  const add = el('button', {
    class: 'btn',
    onclick: async () => {
      const dir = await api.dialog.pickFolder('Allow the agent to use the files in…');
      if (dir && dir !== ws) {
        await save('documents.allowedRoots', [...new Set([...extra, dir])]);
        render();
      }
    },
  }, '＋ Add folder');
  return card(
    'documents',
    'Documents & folder access',
    'The agent may only use the files in its workspace folder and in folders you add below, plus its own vault (and its own code, when code access is on). Files you open yourself are always allowed. Remove a folder to take access away; it applies from the next message.',
    folder('documents.workspace', 'Agent workspace folder', {
      placeholder: 'e.g. the folder with your university or work files',
      hint: 'Where you keep the files you work on. When you ask for a file without saying where ("open the quarterly report PDF"), the agent looks here first.',
      onChange: () => render(),
    }),
    list,
    el('div', { class: 'row' }, add),
  );
}

export function worldCard() {
  return card(
    'world',
    'Inner World',
    'A small village where your personas live a fictional day, growing with your real progress (World in the rail). Its chronicle and the residents’ memories are notes in your vault under “Inner World/”.',
    toggle('innerWorld.enabled', 'Awake: every morning a narrator writes the village’s day (one model call a day, plus an occasional one when a resident reflects)'),
    toggle('innerWorld.townsfolk', 'Two villagers of its own live there too (Wren the archivist and Bram the gardener)'),
    select('innerWorld.season', 'Season', [['auto', 'Follow the calendar'], ['spring', 'Always spring'], ['summer', 'Always summer'], ['autumn', 'Always autumn'], ['winter', 'Always winter']]),
    select('innerWorld.art', 'Art', [['rendered', 'Rendered 3D models (Kenney, CC0)'], ['drawn', 'Drawn by code']]),
    select('innerWorld.fps', 'Frame rate', [['auto', 'Automatic (30, or 15 on Balanced)'], ['15', '15 frames a second (lightest)'], ['30', '30 frames a second'], ['60', '60 frames a second'], ['120', '120 frames a second (smoothest, uses the most power; needs a 120 Hz display)']]),
  );
}

export async function dataCard() {
  const [mems, convs, info, memDir] = await Promise.all([api.memory.list().catch(() => []), api.conv.list().catch(() => []), api.app.info(), api.memory.dir().catch(() => '')]);
  // A destructive action: asked first (with Export first when there is an export), once at a time, and it
  // says whether it worked.
  const danger = (label, title, msg, fn, exportFn = null) => {
    const ask = () => (exportFn ? confirmExportFirst(title, msg, label, exportFn) : confirmDialog(title, msg, label));
    const b = el('button', {
      class: 'btn danger',
      onclick: async () => {
        if (b.disabled || !(await ask())) return;
        b.disabled = true;
        try {
          toast((await fn()) || `${label}: done.`);
        } catch (err) {
          toastError(err);
        } finally {
          render();
        }
      },
    }, label);
    return b;
  };
  // An export returns where the file went (null when the save dialog was cancelled).
  const exporter = (what, run) => async () => {
    const p = await run().catch(toastError);
    if (p) toast(`${what} exported to ${p}`);
  };
  return card(
    'data',
    'Memory & history',
    `Data folder: <code>${escapeHtml(info.dataDir)}</code>`,
    folder('memory.vaultPath', 'Memories folder', { placeholder: memDir, hint: 'One Markdown file per memory — editable in any text editor or even inside your Obsidian vault.' }),
    toggle('memory.stream', 'Memory stream: the assistant notes small observations (Stream/ in the vault) and recalls the most relevant ones with each message'),
    toggle('memory.reflect', 'Reflect on the stream: once enough has happened, draw a few insights from it in the background (one model call)'),
    toggle('privacy.encryptConversations', 'Encrypt conversations on this computer (with your system keychain: only your user account on this computer can read them; existing ones are converted in the background)'),
    el('div', { class: 'row' }, el('span', { class: 'muted', style: { flex: 1 } }, `${mems.length} memories · ${convs.length} conversations`)),
    el(
      'div',
      { class: 'row', style: { flexWrap: 'wrap' } },
      el('button', { class: 'btn', onclick: () => api.memory.openDir() }, 'Open vault folder'),
      el('button', { class: 'btn', onclick: exporter('Memory', () => api.memory.export('md')) }, 'Export memory'),
      el('button', { class: 'btn', onclick: exporter('History', () => api.conv.export()) }, 'Export history'),
    ),
    el(
      'div',
      { class: 'row', style: { flexWrap: 'wrap' } },
      danger('Clear history', 'Clear all conversations', 'Delete every conversation? This cannot be undone.', async () => (settleDelete(), await api.conv.clear(), newChat(), refreshList(), 'All conversations deleted.'), () => api.conv.export()),
      danger('Clear memory', 'Delete all memories', 'Delete every memory? This cannot be undone.', async () => (await api.memory.clear(), emit('memory-changed'), 'Memory cleared.'), () => api.memory.export('md')),
      danger(
        'Reset settings',
        'Reset settings',
        'Your personas (their master prompts, looks and voices), your API keys, and your connector and folder permissions go back to the defaults, and the setup wizard opens the next time the app starts. Memories, notes and conversations are kept, and so is a copy of your old settings, in the data folder.',
        async () => {
          const r = await api.settings.reset();
          await loadSettings();
          return r?.kept ? `Settings reset. Your old settings are in ${r.kept.split(/[\\/]/).pop()} in the data folder.` : 'Settings reset.';
        },
      ),
    ),
    toggle('updates.check', 'Check for new versions once a day (one request to GitHub; nothing is downloaded until you click Download)'),
    toggle('privacy.reportIssues', 'Offer anonymized problem reports for the Siren project on GitHub when something breaks (you see the text and send it yourself)'),
    (() => {
      const out = el('span', { class: 'muted' });
      return el('div', { class: 'row', style: { flexWrap: 'wrap' } }, el('button', { class: 'btn', onclick: () => checkUpdatesNow(out) }, 'Check for updates now'), out);
    })(),
    el(
      'div',
      { class: 'hint' },
      `Siren Assistant v${info.version} · Electron ${info.electron} · ${info.platform} · `,
      el('a', { href: '#', onclick: (e) => (e.preventDefault(), api.shell.openExternal('https://github.com/Andreas-Erick/fullstack-agent/blob/main/PRIVACY.md')) }, 'Privacy & disclaimers'),
    ),
  );
}
