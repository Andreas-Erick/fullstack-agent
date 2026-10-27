# Keyboard and screen readers

Siren can be used without a mouse. Tab moves through the title bar, the rail and the open view in
reading order; Shift+Tab goes back. Keyboard focus always shows a ring in the accent colour (a mouse
click does not). Keep this page current when a view gets or changes a shortcut (`main/guide.js`
entry `keyboard` points here).

## Everywhere

| Keys | What it does |
| --- | --- |
| Ctrl+1 … Ctrl+8 | Chat, Face, Memory, Calendar, Knowledge, Documents, Evolution, Skills |
| Ctrl+Shift+1 / 2 / 3 | Chat layout: chat only, split, face |
| Ctrl+N | New chat |
| Ctrl+Shift+N | Quick note |
| Ctrl+, | Settings |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom in, out, reset |
| F11 | Full screen (on the Face view: the face alone) |
| Esc | Stop speaking; leave the face's full screen; close a dialog |
| Push-to-talk key (Settings → Voice input) | Hold to speak |

**The rail:** Tab into it, then ↑ / ↓ (Home / End) move between views and Enter or Space opens one.
The open view is marked as the current page for screen readers.

## Per view

| View | Keys | Esc |
| --- | --- | --- |
| Chat | Enter sends, Shift+Enter a new line; `/` suggests skills (↑ ↓, Tab or Enter picks) | Closes the skill suggestions, else stops speaking |
| Calendar | ← / → previous / next, T today, N new entry; Enter on a day opens it | Closes the entry editor |
| Skill tree | Tab to a skill, Enter for its details | — |
| Inner World | Arrows or WASD pan, + / - zoom, 0 the whole island; the side panel lists every place and resident as buttons | Leaves the timelapse, stops following, steps outside, clears the selection (in that order) |
| Inner World timelapse | Space play / pause (when focus is not on a button); Tab reaches the bar's play button, slider and speed | Leaves the timelapse |
| Architecture | + / - zoom, 0 or Home everything, L the lessons, R the replay, Space play / pause in the replay | Leaves the replay, else goes up one level |
| Vault → Growth | Space play / pause | Closes the replay |
| Agent window | Ctrl+L or a click edits the address | Leaves the address bar, else stops loading |
| Pop-out document | — | Closes the window |

The canvas views (the village, the architecture map, the skill tree, the replays) mirror what they
draw in HTML panels and lists, so a screen reader reaches the same content.

## Screen readers

- A finished reply is read once, in full (the hidden live region `#chatLive`); streamed words are not
  read one by one, and opening an old conversation does not read it all out.
- Errors are announced the same way. The Inner World's "now" banner is a polite live region.
- Approvals open as dialogs: answer with their buttons (Tab reaches them) or by voice.
