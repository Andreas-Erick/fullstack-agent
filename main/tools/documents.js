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
      'Save a diagram or another self-contained HTML page you made (e.g. following the diagram-design skill: one HTML file with inline SVG and its own styles) to the vault’s Diagrams/ folder and show it in a document window. Scripts and anything that could run are removed, so draw with SVG and CSS only. Parts marked data-step="1", "2"… are shown a step at a time in the app (Back / Next / Play; all at once elsewhere); CSS @keyframes animation works. Returns the saved path.',
    parameters: obj({ title: str('Short title, becomes the file name'), html: str('The complete HTML page (or an SVG)'), open: bool('Show it now (default true)'), monitor: { ...MONITOR, description: `${MONITOR.description} Optional.` } }, ['title', 'html']),
    run: async (a, ctx) => {
      const r = await require('../diagrams').save(a.title, a.html);
      ctx.emit({ type: 'vault_changed', path: r.vaultPath });
      const shown = a.open === false ? null : documents.popup().open(r.path, { monitor: a.monitor });
      return { saved: r.vaultPath, opened: Boolean(shown), monitor: shown?.monitor, embedInPdf: `![[${r.vaultPath}]]` };
    },
  },
  {
    name: 'chart_create',
    group: 'documents',
    description:
      'Draw an exact, often interactive chart, computed by the app (never sketch a plot by hand), saved in the vault\'s Diagrams/ folder and shown; put it into a PDF with the returned embedInPdf line. Kinds: line (formulas in x and/or points; discrete: true = stems, for pmfs), scatter, bar, histogram (data → bins; density + a pdf series on top), parametric (x, y in t), polar (r in theta), field (vector field dx, dy: phase portraits, gradients), heatmap (fn in x and y with contours and colorScale "log": loss landscapes, decision functions; or matrix: attention, confusion), geometry (shapes only, equal axes: robot arms, vectors, projections), simulate (sim over time: dynamics, control loops, optimizers), 3d (surface z = f(x, y) and items: points, segments, polylines, polygons, curves: camera frustums, point clouds, 3D arms; the user drags it to turn it). Interactive: params are sliders any formula can use, and play animates one; defs are named values computed from them in order (e.g. x1 = l1 cos(q1); inverse kinematics with atan2 and acos), usable in every formula and in shapes/items points. shapes (any 2D kind): point, segment, polyline (joints: true draws a robot arm), polygon, circle (r), arrow, text, with points [[x, y], …] as numbers or formulas. sim: { vars: [{ name, init }], ode: { var: rate } (RK4; tEnd, steps) or map: { var: next value } (iterations: gradient descent, momentum, Adam) }; on a simulate chart series are formulas of t and the vars, and path: [var, var] draws the trajectory on any 2D chart (a descent path over a heatmap, a phase portrait); a blow-up is marked "diverged". xScale/yScale "log" (Bode plots, learning curves). Use params whenever how something changes is the point. Formulas: x (y, z, t, theta where the kind has them), params, defs, pi, e, + - * / ^, sin cos tan asin acos atan sinh cosh tanh exp ln log (base 10) log2 sqrt cbrt abs floor ceil round sign fact, normpdf(x, mu, sigma) normcdf exppdf(x, lambda) unifpdf(x, a, b) binompmf(k, n, p) poissonpmf(k, lambda) choose min max mod atan2(y, x); "2x" and "a sin(bx)" work.',
    parameters: obj(
      {
        title: str('Chart title (also the file name)'),
        kind: { type: 'string', enum: ['line', 'scatter', 'bar', 'histogram', 'parametric', 'polar', 'field', 'heatmap', 'geometry', 'simulate', '3d'], description: 'Default line' },
        series: {
          type: 'array',
          description: 'line/scatter: [{ label, fn } or { label, points }]; bar: [{ label, values }]; parametric: [{ label, x, y }] (in t); polar: [{ label, r }] (in theta); simulate: [{ label, fn }] (in t and the sim vars; default every var); others: optional fn curves on top',
          items: { type: 'object', properties: { label: str('Legend label'), fn: str('A formula'), discrete: bool('Stems at whole numbers'), x: str('Parametric x(t)'), y: str('Parametric y(t)'), r: str('Polar r(theta)'), color: str('blue | orange | green | pink | yellow | sky | black'), points: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, values: { type: 'array', items: { type: 'number' } } }, additionalProperties: false },
        },
        params: {
          type: 'array',
          description: 'Sliders: [{ name, label?, min, max, value?, step? }] (up to 6; short names such as a, k, q1, mu; not x, y, z, t, theta, pi, e or a function name)',
          items: { type: 'object', properties: { name: str('Short name used in the formulas'), label: str('What it means'), min: { type: 'number' }, max: { type: 'number' }, value: { type: 'number' }, step: { type: 'number' } }, required: ['name', 'min', 'max'], additionalProperties: false },
        },
        play: str('A parameter to animate when the chart opens'),
        defs: { type: 'array', description: 'Named values from the params, in order: [{ name, fn }] (up to 16)', items: { type: 'object', properties: { name: str('Short name'), fn: str('Formula of params and earlier defs') }, required: ['name', 'fn'], additionalProperties: false } },
        shapes: { type: 'array', description: '2D geometry: [{ type, points: [[x, y], …], r?, text?, label?, color?, joints?, fill? }]', items: { type: 'object', properties: { type: { type: 'string', enum: ['point', 'segment', 'polyline', 'polygon', 'circle', 'arrow', 'text'] }, points: { type: 'array', items: { type: 'array', items: { type: ['number', 'string'] } } }, r: { type: ['number', 'string'] }, text: str('Caption'), label: str('Legend label'), color: str('Colour name'), joints: bool('Draw as a robot arm'), fill: bool('Fill (polygon, circle)') }, additionalProperties: false } },
        sim: { type: 'object', description: '{ vars: [{ name, init }], ode: { var: rate } or map: { var: next }, tEnd?, steps?, dt? }', properties: { vars: { type: 'array', items: { type: 'object', properties: { name: str('Variable'), init: { type: ['number', 'string'] } }, required: ['name'], additionalProperties: false } }, ode: { type: 'object', additionalProperties: { type: 'string' } }, map: { type: 'object', additionalProperties: { type: 'string' } }, tEnd: { type: ['number', 'string'] }, steps: { type: 'number' }, dt: { type: 'number' } }, additionalProperties: false },
        path: { type: 'array', items: { type: 'string' }, description: 'Two sim vars to draw as a trajectory, e.g. ["x", "y"]' },
        pathLabel: str('Legend label of the path'),
        fn: str('Heatmap: f(x, y)'),
        contours: { type: ['number', 'boolean'], description: 'Heatmap: contour lines (default 8; false for none)' },
        colorScale: { type: 'string', enum: ['linear', 'log'], description: 'Heatmap colours (log for steep functions)' },
        zRange: { type: 'array', items: { type: 'number' }, description: 'Heatmap: colour range' },
        matrix: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Heatmap of a matrix (rows)' },
        rowLabels: { type: 'array', items: { type: 'string' } },
        colLabels: { type: 'array', items: { type: 'string' } },
        surface: { type: 'object', properties: { fn: str('z as a formula in x and y'), xRange: { type: 'array', items: { type: 'number' } }, yRange: { type: 'array', items: { type: 'number' } }, grid: { type: 'number' }, label: str('Legend label') }, additionalProperties: false, description: '3d: a surface' },
        items: { type: 'array', description: '3d: [{ type: points | segment | polyline | polygon | arrow | curve, points: [[x, y, z], …] (numbers or formulas), or x, y, z in t with tRange (curve); label?, text? (label written at its end), color?, width? }]', items: { type: 'object', properties: { type: { type: 'string', enum: ['points', 'segment', 'polyline', 'polygon', 'arrow', 'curve'] }, points: { type: 'array', items: { type: 'array', items: { type: ['number', 'string'] } } }, x: str('Curve x(t)'), y: str('Curve y(t)'), z: str('Curve z(t)'), tRange: { type: 'array', items: { type: 'number' } }, label: str('Label'), text: bool('Write the label at the item'), color: str('Colour name'), width: { type: 'number' } }, additionalProperties: false } },
        view: { type: 'object', properties: { azimuth: { type: 'number' }, elevation: { type: 'number' } }, additionalProperties: false, description: '3d: starting view in degrees (default -55, 25)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Bar charts: the category names' },
        data: { type: 'array', items: { type: 'number' }, description: 'Histogram: the values' },
        bins: { type: 'number', description: 'Histogram: number of bins' },
        density: bool('Histogram: scale bars to a density'),
        field: { type: 'object', properties: { dx: str('x component (x, y)'), dy: str('y component (x, y)'), label: str('Legend label') }, additionalProperties: false, description: 'Vector field' },
        xRange: { type: 'array', items: { type: 'number' }, description: '[from, to]; needed with formulas in x, fields and heatmaps' },
        yRange: { type: 'array', items: { type: 'number' }, description: '[from, to]; needed for fields and heatmaps, else automatic' },
        xScale: { type: 'string', enum: ['linear', 'log'] },
        yScale: { type: 'string', enum: ['linear', 'log'] },
        tRange: { type: 'array', items: { type: 'number' }, description: 'Parametric: t range (default [0, 2pi])' },
        thetaRange: { type: 'array', items: { type: 'number' }, description: 'Polar: theta range (default [0, 2pi])' },
        xLabel: str('x-axis label'),
        yLabel: str('y-axis label'),
        open: bool('Show it now (default true)'),
      },
      ['title'],
    ),
    run: async (a, ctx) => {
      const core = require('../chartcore');
      const svg = core.render(a);
      const live = core.params(a).length > 0 || a.kind === '3d'; // sliders, or a 3D scene to turn
      const diagrams = require('../diagrams');
      const r = await diagrams.save(a.title, live ? diagrams.chartPage(a, svg) : svg);
      ctx.emit({ type: 'vault_changed', path: r.vaultPath });
      const shown = a.open === false ? null : documents.popup().open(r.path);
      return { saved: r.vaultPath, opened: Boolean(shown), interactive: live ? `${core.params(a).length ? `sliders for ${core.params(a).map((p) => p.name).join(', ')}${a.play ? `, ${a.play} playing` : ''}` : ''}${a.kind === '3d' ? `${core.params(a).length ? '; ' : ''}drag it to turn it` : ''}: tell the user` : undefined, embedInPdf: `![[${r.vaultPath}]]` };
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
      "Create a PDF the user can keep, print or send: from Markdown you write (a summary, study sheet, report, letter, checklist…) or from a vault note (vault_note). Formulas in $…$ / $$…$$ are typeset. Put diagrams and charts in by their saved path on a line of its own: ![[Diagrams/2026-10-27 Krebs cycle.html]] (optionally ![[…|caption]]), as returned by diagram_save and chart_create. Saved in the user's workspace folder (or Documents/Siren Exports) without overwriting anything, and opened in a window unless open is false. Remote images are not included.",
    parameters: obj({ title: str('Document title (also the file name)'), content: str('Markdown content (omit when exporting a vault note)'), vault_note: str('Vault note to export instead (path or name)'), open: bool('Open it afterwards (default true)') }, ['title']),
    run: async (a) => {
      let markdown = a.content;
      if (a.vault_note) markdown = (await obsidian.readNote(a.vault_note)).content.replace(/^---[\s\S]*?---\s*/, '');
      if (!String(markdown || '').trim()) throw new Error('Give the content (Markdown) or a vault_note to export.');
      // Diagrams and charts from the vault's Diagrams/ folder, drawn into the PDF.
      const root = await obsidian.vaultPath();
      const read = (rel) => require('fs').promises.readFile(require('../files').resolveInside(root, rel), 'utf8');
      const doc = root ? await require('../diagrams').embedDiagrams(markdown, read) : { markdown, embeds: [] };
      const r = await pdf.create({ title: a.title, markdown: doc.markdown, embeds: doc.embeds });
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
