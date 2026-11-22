# Keyboard and screen readers

Siren can be used without a mouse. Tab moves through the title bar, the rail and the open view in
reading order; Shift+Tab goes back. Keyboard focus always shows a ring in the accent colour (a mouse
click does not). Keep this page current when a view gets or changes a shortcut (`main/guide.js`
entry `keyboard` points here).

## Everywhere

| Keys | What it does |
| --- | --- |
| Ctrl+1 … Ctrl+9 | Chat, Face, Memory, Calendar, Vault, Documents, Evolution, Skills, Notes |
| Ctrl+Shift+1 / 2 / 3 | Chat layout: chat only, split, face |
| Ctrl+N | New chat (while the Notes view is open: a new note, also right after Ctrl+9) |
| Ctrl+H | History: your earlier chats and the search through them (opens the chat; again: back to the message box) |
| Ctrl+Shift+N | ⚡ Dump: a blank page for a brain dump (Notes) |
| Ctrl+, | Settings |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom in, out, reset |
| F11 | Full screen (on the Face view: the face alone) |
| Esc | Stop speaking; then stop a reply that is still being written (chat and face); leave the face's full screen; close a dialog (on a form you've changed it asks first: Keep editing / Discard); say no to an approval; close History |
| End | Jump to the latest message (chat) |
| F2 | Rename the open chat (chat, when you're not typing in a field) |
| Push-to-talk key (Settings → Voice input) | Hold to speak |

Say “cancel”, “never mind” or “stop working” to stop a reply; “stop” or “quiet” only stops the voice.
Say “try again” after a reply failed or was stopped: your message is sent again (not while a message waits
for its files).

**The rail:** Tab into it, then ↑ / ↓ (Home / End) move between views and Enter or Space opens one.
The open view is marked as the current page for screen readers.

**More places:** the chat's splitter (Split layout): Tab to it, ← / → resize the face panel, Home / End go to the limits.
The ⋯ menus: ↑ / ↓ move between items, Esc closes the menu. The calendar month: only the selected day is a Tab stop; the
arrow keys move between days (past the edge, to the next or previous month), Enter on a day starts a new entry. The system
panel (the title bar's meter): Esc closes it.

## Per view

| View | Keys | Esc |
| --- | --- | --- |
| Chat | Enter sends, Shift+Enter a new line; `/` suggests skills (↑ ↓, Tab or Enter picks); Enter on a focused [[note]] link opens it (also on the reply card and in the Vault); ↑ in an empty message box edits your last message (Enter sends it in place of the old one; nothing while a reply is being written or a message waits for its files); Ctrl+V in the chat attaches a copied image (or copied files), while copied text is pasted as text (a browser's “Copy image” that also copies text pastes the text); Delete or Backspace on a focused attachment chip removes it | Closes the skill suggestions, else cancels editing (the box gets back what was in it), else stops speaking, else stops the reply; closes the reply card (Face layout) when it has focus |
| Chat → History | Type to search: titles at once, words from the messages a moment later; ↓ goes into the list, ↑ ↓ Home End move, Enter opens (Enter in the search opens the first), Delete deletes the chat; while it is open over the chat, Tab stays inside it | Closes it, back to the message box; in the side panel: clears the search |
| Calendar | ← / → previous / next, T today, N new entry; Enter on a day starts a new entry on it (Enter on an entry inside the day opens its details; on “+N more” it selects the day) | Closes the entry editor |
| Notes | Ctrl+N new note, Ctrl+E edit / show rendered (or click the text to edit right there; Enter on the rendered note edits it; on a focused [[link]] it opens the link), Ctrl+S save now; while writing: Ctrl+B bold, Ctrl+I italic, Enter continues a list (on an empty item it ends it), Tab / Shift+Tab indent list items; `[[` suggests notes to link (↑ ↓, Enter or Tab picks); ↓ from the search goes into the list, ↑ ↓ move through it. In ⚡ Dump: Ctrl+Enter saves and gives a fresh page | Closes the link suggestions, else clears the search; in Dump: saves and closes |
| Inner World | Arrows or WASD (also with Shift or Caps Lock) pan, + / - zoom, 0 the whole island; the side panel lists every place and resident as buttons | Leaves the timelapse, stops following, steps outside, clears the selection (in that order) |
| Inner World timelapse | Space play / pause (when focus is not on a button); Tab reaches the bar's play button, slider and speed | Leaves the timelapse |
| Architecture | + / - zoom, 0 or Home everything, L the lessons, R the replay, Space play / pause in the replay | Leaves the replay, else goes up one level |
| Vault → Growth | Space play / pause | Closes the replay |
| Settings | On the tab bar: ← / → the previous / next section, Home / End the first / last; the search field looks through every section. Tab reaches every switch (in setup too, the privacy step's checkbox among them) and Space turns it on or off; a switch keeps the focus when the page redraws | Clears the search |
| Agent window | Ctrl+L or a click edits the address; F5 reloads; Alt+← / Alt+→ back / forward | Leaves the address bar, else stops loading |
| Pop-out document | Ctrl+= / Ctrl+- zoom, Ctrl+0 fit | Closes the window |

The canvas views (the village, the architecture map, the replays) mirror what they
draw in HTML panels and lists, so a screen reader reaches the same content.

## Screen readers

- A finished reply is read once, in full (the hidden live region `#chatLive`); streamed words are not
  read one by one, and opening an old conversation does not read it all out.
- Errors are announced the same way. The Inner World's "now" banner is a polite live region.
- Dialogs: focus moves into the dialog and back to where you were when it closes; Tab moves only through
  the dialog (and any notice). Esc closes a dialog; on a form you've changed it asks first (Keep editing /
  Discard).
- Approvals open above every other dialog (notices stay on top) and take the focus on the card: Enter does
  nothing until you Tab to a button; answer with their buttons or by voice. While the question is spoken,
  Esc first stops the voice; Esc then says no.
- Notices are read out politely, one at a time, and stay while the pointer or the keyboard focus is on them.

## Phone and tablet

- Android (phone app): Back closes, in this order, the “Can't reach your computer” screen, the conversation
  list, the full-screen face, an open note (back to the Notes list) or building (back outside), a screen from
  More (back to More) or another tab (back to the chat); from the bare chat or the pairing screen it leaves
  the app.
