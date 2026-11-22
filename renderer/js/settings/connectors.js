// Permission levels per connector or extension, the Extensions card and the Claude connectors section.
import { api, el, toastError, emit } from '../util.js';
import { state } from '../state.js';
import { save } from './core.js';
import { toggle, card, result, showResult } from './fields.js';

// Per connector or extension (by server key): ask every time, allow its reading tools (list, get,
// search…), allow all but deleting, or allow everything (claudecode.js approve()).
const levelLists = () => ({ all: new Set(state.settings.claudeCode.connectorsAllowed || []), read: new Set(state.settings.claudeCode.connectorsReadOnly || []), write: new Set(state.settings.claudeCode.connectorsWrite || []) });
const levelOf = (key) => {
  const l = levelLists();
  return l.all.has(key) ? 'all' : l.write.has(key) ? 'write' : l.read.has(key) ? 'read' : 'ask';
};
// Saved in the main process on the stored lists (main.js claude:setConnectorLevel): rebuilding all
// three lists from this window's copy erased "Always allow…" choices made in an approval meanwhile.
async function setLevel(key, level) {
  state.settings = await api.claude.setConnectorLevel(key, level);
  emit('settings', state.settings);
}
function permissionLevel(key, { disabled = false, name = key } = {}) {
  const level = levelOf(key);
  const box = el('select', { class: 'input allow-level', disabled, 'aria-label': `Permission for ${name}` }, ...[['ask', 'Ask every time'], ['read', 'Allow reading'], ['write', 'Allow all but deleting'], ['all', 'Allow everything']].map(([v, l]) => el('option', { value: v, selected: v === level }, l)));
  box.addEventListener('change', () => setLevel(key, box.value).catch((err) => {
    box.value = levelOf(key);
    toastError(err);
  }));
  return box;
}

// Extensions (main/extensions.js): MCP servers the app runs for the Claude account brain.
export let extensionProgress = null;
export function extensionsCard() {
  const list = el('div', { class: 'connector-list', style: { maxHeight: 'none' } });
  const progress = el('div', { class: 'hint' });
  extensionProgress = progress;
  const draw = async () => {
    const items = await api.extensions.status().catch(() => []);
    list.innerHTML = '';
    for (const x of items) {
      const on = el('input', { type: 'checkbox', checked: x.on });
      on.addEventListener('change', async () => {
        // A sensible starting permission for the extension (changeable next to it).
        if (on.checked && levelOf(x.key) === 'ask' && x.defaultLevel !== 'ask') await setLevel(x.key, x.defaultLevel);
        await save(`extensions.${x.id}`, on.checked);
        draw();
      });
      const rows = [
        el('div', { class: 'row' }, el('label', { class: 'toggle' }, on, el('span', { class: 'sw' }), el('b', {}, x.name)), el('span', { style: { flex: 1 } }), el('span', { class: 'hint' }, 'Permission'), permissionLevel(x.key, { name: x.name })),
        el('div', { class: 'hint' }, `${x.about} Source: ${x.source}.`),
      ];
      if (x.id === 'godseye') {
        const pathInput = el('input', { class: 'input', value: x.path, placeholder: 'Folder of your gods-eye-view checkout', spellcheck: 'false' });
        pathInput.addEventListener('change', async () => {
          await save('extensions.godseyePath', pathInput.value.trim());
          draw();
        });
        const browse = el('button', {
          class: 'btn small',
          onclick: async () => {
            const d = await api.dialog.pickFolder('God’s Eye View folder');
            if (!d) return;
            await save('extensions.godseyePath', d);
            draw();
          },
        }, 'Browse…');
        const install = el('button', {
          class: 'btn small',
          onclick: async () => {
            const parent = await api.dialog.pickFolder('Install God’s Eye View into which folder?');
            if (!parent) return;
            install.disabled = true;
            progress.textContent = 'Starting…';
            try {
              const r = await api.extensions.install(parent);
              await save('extensions.godseyePath', r.dir);
              progress.textContent = `✓ Installed in ${r.dir}`;
            } catch (err) {
              progress.textContent = `✕ ${err.message}`;
            }
            install.disabled = false;
            draw();
          },
        }, x.ready ? '⟳ Reinstall' : '⬇ Install it for me');
        const status = x.ready ? (x.running ? `✓ ready · globe server running${x.startedByNexus ? ' (started by Siren)' : ''}` : '✓ ready · the globe server starts when needed') : `✕ ${x.reason}`;
        rows.push(
          el('div', { class: 'row' }, el('div', { style: { flex: 1 } }, pathInput), browse, install),
          el(
            'div',
            { class: 'row', style: { flexWrap: 'wrap' } },
            el('span', { class: 'hint' }, status),
            el('span', { style: { flex: 1 } }),
            x.on && x.ready ? el('button', { class: 'btn small primary', onclick: () => api.extensions.openGlobe().then(draw, toastError) }, '🌍 Open the globe') : '',
            x.running && x.startedByNexus ? el('button', { class: 'btn small', onclick: () => api.extensions.stop().then(() => setTimeout(draw, 800)) }, 'Stop server') : '',
          ),
          progress,
        );
      }
      list.append(el('div', { class: 'extension glass' }, ...rows));
    }
  };
  draw();
  return card(
    'extensions',
    'Extensions',
    'Extra abilities for the <b>Claude account brain</b>: MCP servers the app runs for it. Their tools go through the permission level you choose, with or without Claude connectors. Changes take effect from the next conversation.',
    list,
  );
}

// The user's claude.ai connectors and Claude Code plugins, used through the Claude account brain.
const CONNECTOR_STATUS = { connected: ['ok', 'connected'], 'needs-auth': ['warn', 'needs sign-in'], failed: ['err', 'not connecting'], 'not-configured': ['muted', 'not set up'] };
function formatConnector(c) {
  const raw = String(c.name || '');
  const pm = /^plugin:([^:]+):(.+)$/i.exec(raw);
  if (pm) {
    const cat = pm[1].replace(/[-_]+/g, ' ').trim();
    const title = pm[2].replace(/[-_]+/g, ' ').trim().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
    return { title, source: `${cat} plugin` };
  }
  const title = raw.replace(/^claude\.ai\s+/i, '').trim();
  const source = c.source === 'plugin' ? 'plugin' : c.source === 'connector' ? 'connector' : 'MCP server';
  return { title, source };
}
export function connectorsSection() {
  const list = el('div', { class: 'connector-list' });
  const out = result();
  // What works first: connected, then needs sign-in, failing, not set up; claude.ai connectors before plugins.
  const RANK = { connected: 0, 'needs-auth': 1, failed: 2, 'not-configured': 3 };
  const draw = (items) => {
    list.innerHTML = '';
    const sorted = [...items].sort((a, b) => (RANK[a.status] ?? 4) - (RANK[b.status] ?? 4) || (a.source === 'connector' ? 0 : 1) - (b.source === 'connector' ? 0 : 1) || a.name.localeCompare(b.name));
    for (const c of sorted) {
      const [cls, label] = CONNECTOR_STATUS[c.status] || ['muted', c.status];
      const { title, source } = formatConnector(c);
      // Always changeable: a level set before a service is connected applies once it is (a greyed-out
      // list looked broken).
      const box = permissionLevel(c.key, { name: title });
      list.append(
        el(
          'div',
          { class: 'connector' },
          el('span', { class: `dot ${cls}` }),
          el('span', { class: 'name', title: c.name }, title),
          el('span', { class: `meta ${cls}` }, `${source} · ${label}`),
          el('label', { class: 'allow', title: 'Allow reading: tools that only look things up (list, get, search…) run without asking; anything that creates, sends, changes or deletes still asks. Allow all but deleting: creating and changing run on their own, deleting, removing or archiving still asks. Allow everything: no questions, except that deleting or inviting people asks once a turn has read outside content (Settings → Safety), so only for services where nothing can go wrong.' }, box),
        ),
      );
    }
  };
  const check = el('button', {
    class: 'btn',
    onclick: async () => {
      check.disabled = true;
      showResult(out, true, 'Checking your connectors and plugins… (each one is contacted; this can take half a minute)');
      try {
        const items = await api.claude.connectors();
        const ok = items.filter((c) => c.status === 'connected').length;
        const msg = `${ok ? '✓' : '•'} ${ok} of ${items.length} connected. To sign in to one marked “needs sign-in”, run /mcp in Claude Code or connect it on claude.ai → Settings → Connectors.`;
        out.className = `test-result ${ok ? 'ok' : ''}`.trim();
        out.textContent = msg;
        draw(items);
      } catch (err) {
        showResult(out, false, `✕ ${err.message}`);
      } finally {
        check.disabled = false;
      }
    },
  }, '🔌 Check connectors');
  return el(
    'div',
    { class: 'field' },
    toggle('claudeCode.connectors', 'Use my Claude connectors'),
    toggle('claudeCode.plugins', 'Also load my Claude Code plugins (their skills cost about 4,000 tokens per message)'),
    el('div', { class: 'hint', html: 'The agent can use the connectors on your claude.ai account (Todoist, Google Calendar, Canva, Figma…) and your Claude Code plugins, through the Claude account brain only. It looks them up when a task needs one. <b>Every call asks you first</b>, even in auto mode (one yes covers that service for the rest of the reply), unless you allow it below: “Allow reading” lets it look things up without asking (what routines need) while anything that creates, sends, changes or deletes still asks. What they return is treated as external content. Data you send goes to that service.' }),
    el('div', { class: 'row' }, check),
    out,
    list,
  );
}
