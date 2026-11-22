# ENG-03 / ENG-04: per-brain lists derived from the brain table

## What changed

`renderer/js/braintable.mjs` rows gained `blurb`, `prefer` (rank per smart-routing task), `defaults`
(own-section defaults besides apiKey), `visionByModel` (openai) and `userPicksModel` (local). The table
now also exports `preferFor(task)`, `DEFAULT_ORDER`, `sectionDefaults()`, `SECRET_KEYS`, `MODEL_KEYS`,
`agentSettable()`. Derived from them, with every value unchanged (test/brainrows.test.js snapshots the
old literals):

- `main/store.js` DEFAULTS: the own sections (`...braintable.sectionDefaults()`) and `routing.order`
  (`braintable.DEFAULT_ORDER`: routed brains by `route`, local left out as before; router.order appends it).
- `main/store.js` SECRET_FIELDS: `...braintable.SECRET_KEYS` (every own section's apiKey).
- `main/tools.js` SETTABLE: `...braintable.agentSettable()` (only `MODEL_KEYS` = model/fastModel/deepModel,
  never baseUrl or apiKey; none for `userPicksModel`, i.e. local). Now exported, as is store.SECRET_FIELDS
  and router.PREFER.
- `main/router.js` PREFER: per `TASK_LABEL` task, `brains.preferFor(task)` (from `prefer` ranks).
- `renderer/js/attachcore.mjs` SEES_IMAGES: from `vision`; null for the router path and `visionByModel`.
- `renderer/js/settings.js` PROVIDER_HINT removed: the row's `blurb`.
- `main/codemap.js` settingsDefaults() evaluates DEFAULTS with the real braintable (pure) in scope, so
  `npm run check` still sees gemini/local/... sections (settings.js binds `groq.apiKey`, `local.baseUrl`).
- `test/permissions.test.js` adds the table's part to its static read of SETTABLE / SECRET_FIELDS and
  requires the spreads to be there (and the only spread in SETTABLE).

## Suggested CLAUDE.md wording (brain catalogue paragraph)

Replace "A new brain is one row (`test/brains.test.js`)." with:

> A row also carries `blurb` (Settings' Multi-provider line), `prefer` (smart-routing rank per task →
> `router.PREFER`), `vision`/`visionByModel` (→ `attachcore.SEES_IMAGES`) and, for a brain with its own
> section on the OpenAI path, `defaults` (→ store.js DEFAULTS via `sectionDefaults()`; its apiKey goes
> into SECRET_FIELDS via `SECRET_KEYS`; its model keys into tools.js SETTABLE via `agentSettable()`,
> never its address or key; `userPicksModel` keeps them out, as for local). The default
> `routing.order` is `DEFAULT_ORDER`. A new brain on the OpenAI path with its own address and key is
> one row plus updating the snapshot in `test/brainrows.test.js` (deliberately: it pins what gets
> encrypted and what the agent may change), the ids in `test/brains.test.js`, and the brain_switch
> description's list of names in `main/tools/brain.js` (its enum follows the table). A brain on a new
> path (not OpenAI-compatible) still needs its runner in llm.js and readiness in brains.js `configured`.

## Changelog line

- Internal: the per-brain lists (settings defaults, encrypted keys, what the agent may change, smart
  routing's preferences, which brains see pictures, the Settings blurbs) now follow from the brain
  table's rows, so adding an OpenAI-compatible brain is one row; nothing changes for users.

## What still isn't "one row"

- `test/brainrows.test.js` SNAPSHOT and `test/brains.test.js` (ids/order) must be updated: intended,
  since a new row widens SETTABLE (model keys only) and SECRET_FIELDS.
- `main/tools/brain.js` brain_switch description names the brains in prose (the enum is derived).
- A brain whose settings need more than baseUrl/model/fastModel/deepModel/apiKey (e.g. extra fields
  in Settings' provider card, `renderer/js/settings.js` providerConfig special cases) needs code there.
- Non-OpenAI paths (a new SDK) need an llm.js runner and brains.js readiness, as before.
- `brand.LEGACY` if a new default changes behaviour for existing installs (none here).
