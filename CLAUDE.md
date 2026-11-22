# Siren Assistant

A desktop AI assistant (Electron, plain JavaScript, no build step) with a voice, a face, an Obsidian vault for memory, a phone and watch companion, and the ability to change its own code behind checks and tests.

(Formerly Nexus Agent. Internal identifiers keep the old name on purpose: the `NEXUS_*` environment variables, `window.nexus` in the renderer, `window.NexusAndroid`, the `nexus-agent` ping id the phone checks, `startedByNexus`, the Android package `com.nexusagent.android` and the appId `com.nexus.agent` (so installs upgrade in place). User-visible text says Siren / Siren Assistant.)

## Where to read

- [README.md](README.md): what it is, install, develop.
- [docs/adr/](docs/adr/): the architecture decisions and why.
- [docs/ENGINEERING.md](docs/ENGINEERING.md): how to change the app well (read it before anything beyond a small fix).
- [docs/agents/MAP.md](docs/agents/MAP.md): the code map, every module, its rules and its tests. Keep it accurate when the architecture changes.

Run `npm run check` and `npm test` before calling a change done.

## The code map

Claude Code loads the full map through this import:

@docs/agents/MAP.md

## Agent skills

### Issue tracker

Issues live in the repo's GitHub Issues (Andreas-Erick/fullstack-agent), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` (created when needed) and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
