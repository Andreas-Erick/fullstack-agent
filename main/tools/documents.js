// Agent tools: Documents and document windows (documents.js, docwindows.js), diagrams, PDFs.
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const obsidian = require('../obsidian');
const documents = require('../documents');
const pdf = require('../pdf');
const { obj, str, bool, POSITION, MONITOR } = require('./common');

module.exports = [
  {
    name: 'open_document',
    group: 'documents',
    description:
      'Open a document (PDF, DOCX, Markdown, text, HTML, image) for the user in its own window, and get its text. Several can be open; opening one that is already open brings it forward. Accepts an absolute path, "~/..." or a path relative to the workspace folder or vault. Optionally on a monitor (see list_monitors).',
    parameters: obj({ path: str('File path'), monitor: { ...MONITOR, description: `${MONITOR.description} Optional.` }, position: POSITION }, ['path']),
    untrusted: true,
    run: async (a) => {
      const full = await documents.resolveAllowed(a.path);
      const shown = documents.popup().open(full, { monitor: a.monitor, position: a.position });
      const t = await documents.extractText(full, { maxChars: 12000 }).catch((e) => ({ text: `(could not extract text: ${e.message})` }));
      return { opened: full, monitor: shown.monitor, openDocuments: shown.openDocuments, kind: t.kind, pages: t.pages, text: t.text };
    },
  },
  {
    name: 'diagram_save',
    group: 'documents',
    description:
      'Save a diagram or another self-contained HTML page you made (e.g. following the diagram-design skill: one HTML file with inline SVG and its own styles) to the vault’s Diagrams/ folder and show it in a document window. Scripts and anything that could run are removed, so draw with SVG and CSS only. Returns the saved path.',
    parameters: obj({ title: str('Short title, becomes the file name'), html: str('The complete HTML page (or an SVG)'), open: bool('Show it now (default true)'), monitor: { ...MONITOR, description: `${MONITOR.description} Optional.` } }, ['title', 'html']),
    run: async (a, ctx) => {
      const r = await require('../diagrams').save(a.title, a.html);
      ctx.emit({ type: 'vault_changed', path: r.vaultPath });
      const shown = a.open === false ? null : documents.popup().open(r.path, { monitor: a.monitor });
      return { saved: r.vaultPath, opened: Boolean(shown), monitor: shown?.monitor };
    },
  },
  {
    name: 'list_monitors',
    group: 'documents',
    description: 'The connected monitors, named by where they sit (Left, Center, Right…; the primary one marked) and which monitor each open window (the assistant, each document) is on. Refer to monitors by these names when you talk to the user.',
    parameters: obj({}),
    run: async () => documents.popup().listMonitors(),
  },
  {
    name: 'identify_monitors',
    group: 'documents',
    description: 'Show each monitor\'s name (Left, Center, Right…) big on its screen for a few seconds, so the user can see which is which.',
    parameters: obj({}),
    run: async () => documents.popup().identify(),
  },
  {
    name: 'set_window_state',
    group: 'documents',
    description: 'Make a document window (by name, or "it" for the latest) or your own window ("assistant") full screen, leave full screen, maximize, minimize, or restore it to a normal window. E.g. "make the PDF full screen", "exit full screen", "minimize the document".',
    parameters: obj({ window: str('Document name, "it", or "assistant"'), state: { type: 'string', enum: ['fullscreen', 'exit_fullscreen', 'maximize', 'minimize', 'restore'] } }, ['window', 'state']),
    run: async (a) => documents.popup().setState(a.window, a.state),
  },
  {
    name: 'move_window',
    group: 'documents',
    description:
      'Move a document window (by its name, e.g. "quarterly report", or "it" for the latest) or the assistant\'s own window ("assistant") to a monitor, e.g. "move the quarterly report PDF to the right monitor". position: center (default, keeps the size), maximize, fullscreen, left or right half.',
    parameters: obj({ window: str('Document name, "it", or "assistant"'), monitor: MONITOR, position: POSITION }, ['window', 'monitor']),
    run: async (a) => documents.popup().move(a.window, a.monitor, a.position),
  },
  {
    name: 'find_document',
    group: 'documents',
    description:
      "Find files by name or topic when the user asks for one without a full path (e.g. \"the quarterly report PDF\", \"my CV\"). Searches the user's workspace folder first, then their other document folders; folder names count too. Mention the kind (pdf, word, image) in the query to narrow it. One clear match: open it. Several: ask which. Use this instead of searching the disk yourself.",
    parameters: obj({ query: str('What the user called the file, e.g. "quarterly report pdf"') }, ['query']),
    run: async (a) => documents.findDocuments(a.query),
  },
  {
    name: 'close_document',
    group: 'documents',
    description: 'Close a document window when the user asks: by name (e.g. "quarterly report"), the latest one (no name), or "all".',
    parameters: obj({ name: str('Which document, or "all" (optional; default the latest)') }),
    run: async (a) => {
      const closed = documents.popup().close(a.name);
      return closed.length ? { closed } : { closed: [], note: 'No document window is open.' };
    },
  },
  {
    name: 'read_document',
    group: 'documents',
    description: 'Read the text of a document without displaying it (PDF, DOCX, Markdown, text, HTML).',
    parameters: obj({ path: str('File path') }, ['path']),
    untrusted: true,
    run: async (a) => documents.extractText(a.path, { maxChars: 30000 }),
  },
  {
    name: 'list_recent_documents',
    group: 'documents',
    description: 'List documents the user recently opened in the app.',
    parameters: obj({}),
    run: async () => documents.recent(),
  },
  {
    name: 'create_pdf',
    group: 'documents',
    description:
      "Create a PDF the user can keep, print or send: from Markdown you write (a summary, report, letter, checklist…) or from a vault note (vault_note). Saved in the user's workspace folder (or Documents/Siren Exports) without overwriting anything, and opened in a window unless open is false. Remote images are not included.",
    parameters: obj({ title: str('Document title (also the file name)'), content: str('Markdown content (omit when exporting a vault note)'), vault_note: str('Vault note to export instead (path or name)'), open: bool('Open it afterwards (default true)') }, ['title']),
    run: async (a) => {
      let markdown = a.content;
      if (a.vault_note) markdown = (await obsidian.readNote(a.vault_note)).content.replace(/^---[\s\S]*?---\s*/, '');
      if (!String(markdown || '').trim()) throw new Error('Give the content (Markdown) or a vault_note to export.');
      const r = await pdf.create({ title: a.title, markdown });
      if (a.open !== false) documents.popup().open(r.path);
      return { saved: r.path, sizeKB: r.kb, opened: a.open !== false };
    },
  },
  {
    name: 'quick_note',
    group: 'vault',
    description: 'Jot down a note for the user right away (an idea, a to-do, something to read later): saved as its own dated note in the vault Inbox/ folder. Use vault_write_note instead for organised knowledge.',
    parameters: obj({ text: str('The note (Markdown)'), title: str('Short title (optional; taken from the text otherwise)') }, ['text']),
    run: async (a, ctx) => {
      const r = await obsidian.quickNote(a.text, a.title);
      ctx.emit({ type: 'vault_changed', path: r.path });
      return r;
    },
  },
];
