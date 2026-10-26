# Connectors, plugins, skills and extensions: what ships with Siren Assistant

*Decision, October 2026 (version 2.0).*

## The question

Siren can reach other services in four ways: Claude connectors (the services a user connects on claude.ai, such as Gmail, Google Calendar, Todoist, Notion), Claude Code plugins, Agent Skills, and the app's own extensions (MCP servers it starts: REA and God's Eye View). Which of these should come with the app, and how should setup present them?

## Decision

| Kind | Ships with the app | On by default | How a user gets more |
| --- | --- | --- | --- |
| Built-in tools (schedule, notes, memory, habits, learning, web search, documents, PDFs, diagrams, routines, GitHub via `gh`) | Yes | Yes | — |
| Agent Skills (`main/skills/`: /explain, /proof-coach, /study-session, /teach-back, /drill, /converse, /goal, /reflect, /weekly-review, /tour) | Yes | Yes | Skills view: write your own, or import from a GitHub repo (e.g. `anthropics/skills`) |
| Claude connectors | No | Off | Connect them on claude.ai → Settings → Connectors; turn on "Use my Claude connectors and plugins" (setup step "Connectors & extras" or Config → AI brain) |
| Claude Code plugins | No | Off (same switch) | `/plugin` in Claude Code |
| Extensions (REA, God's Eye View) | The integration, not the software | Off | Config → Extensions |

## Why nothing third-party is bundled

1. **Connectors belong to the user's Claude account, not to the app.** They are authorized per person on claude.ai (OAuth to their Gmail, their Todoist). An app can't ship them; it can only use the ones a user already connected, through Claude Code.
2. **Every connector widens what can leave the computer.** The privacy promise is that only what a feature the user turned on needs is sent, and only to that service. Defaults stay inside the app; each service is the user's explicit choice, and every call asks first unless they allow that service.
3. **Prompt-injection surface.** Each MCP server adds tools whose results come from outside. The app treats them as external content (the turn is tainted, consequential actions ask), but fewer default servers means fewer ways in.
4. **Maintenance.** Third-party servers change on their own schedule; pinning and updating them would be the app's burden and the user's risk. The two extensions are pinned (REA) or the user's own checkout (God's Eye View).

## How setup presents it

The setup step **Connectors & extras**:

- shows what is built in and needs no setup, and how many skills come included;
- with the Claude account brain: explains connectors and plugins (none bundled, each call asks first, results are data), offers the switch (off by default), suggests connectors that fit the goals the user picked in the previous step (study → Wolfram, Consensus; languages → DeepL; goals and habits → Todoist or TickTick, Google Calendar; work → Gmail, Google Drive, Notion, Slack), opens the claude.ai connector directory, and can check what the user already has;
- with another brain: says connectors need the Claude account brain;
- mentions the extensions (off) and the phone app.

The agent itself suggests a connector at most once per topic when a request would clearly go better with one (`prompt.js`, "Choosing your tools"), and remembers a "no".
