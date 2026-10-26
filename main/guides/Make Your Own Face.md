# Make your own face

{{name}} can wear any face you like. A face is one small web page that draws itself and reacts to what {{name}} is doing: listening, thinking, speaking, sleeping. You can design one with any AI app (Claude, ChatGPT, Gemini…): copy the prompt below, describe the face you want where it says so, and save what it gives you.

## How to install a face

1. In {{name}}, open the **Face** view and click **＋ Custom faces**. This opens the faces folder.
2. Make a new folder there, named after your face (letters, numbers and dashes, e.g. `moon-oracle`).
3. Save the page the AI wrote as `index.html` in that folder. Optionally add a `face.json` with a title and a one-line description:
   `{ "title": "Moon Oracle", "tagline": "A silver mask that glows when it speaks" }`
4. Back in {{name}}: **Settings → Persona → Face**, pick your face. Every persona can have its own.

Faces run sandboxed: they can't reach the internet, your files or the app. If a face shows nothing, ask the AI to fix it and paste in what you see.

## The prompt

Copy everything between the lines.

---

Create an animated face for my desktop AI assistant as ONE self-contained HTML file (index.html). The face I want: **[DESCRIBE YOUR FACE HERE: the character or object, the mood, the style, the colors if you have a preference, what it should do when it talks]**.

Technical contract (follow it exactly):

1. The file is self-contained: inline CSS and JavaScript only. No external scripts, fonts, images or network requests of any kind (the face runs in a sandbox without network access). Draw with a `<canvas>` (2D context) or inline SVG.
2. Include this line in `<head>`: `<script src="core.js"></script>`. It provides a global `AV` object. Call `AV.init()` once at startup. Then read these values in your animation loop (`requestAnimationFrame`):
   - `AV.state`: one of `'idle'`, `'listening'`, `'thinking'`, `'working'` (running tools), `'speaking'`, `'happy'` (a reply just finished), `'sleeping'` (idle for a while), `'alert'` (something needs attention). Give each state a clearly different look and motion; transitions between states must ease smoothly over about half a second, never jump.
   - `AV.level`: the voice or microphone loudness, 0 to 1. Use it while speaking (mouth, glow, ripples) and while listening.
   - `AV.samples`: 64 waveform samples from -1 to 1 while speaking. Use them for a visible waveform or vibration.
   - `AV.colors()`: returns `[mainColor, accentColor]` as hex strings for the current state, from the user's theme. Use these for all main colors (ease toward them when they change) so the face matches the app's theme. In the alert state it returns red.
   - `AV.env.name`: the assistant's name (you may show it subtly); `AV.env.alert`: the alert message or null.
   Add a safe fallback so the face still animates if `AV` is missing (e.g. when the file is opened directly in a browser): state `'idle'`, level 0, colors `['#2dd4bf', '#38bdf8']`.
3. Layout: the page background must be transparent (`html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }`). The face fills the window, stays centered, keeps its proportions, and nothing is ever cut off at the edges, at any size from a small 160×160 panel to a full 4K screen. Handle window resizing and high-DPI screens (devicePixelRatio, capped at 2).
4. Motion and comfort: idle is calm and alive (breathing, slow drift, occasional blinks); thinking and working look busy (spinning, scanning, pulsing); speaking follows the voice closely; sleeping is slow and dim. Respect `prefers-reduced-motion` by slowing everything down a lot. No flashing faster than 3 times per second.
5. Performance: keep it light enough for 60 frames per second on a laptop: no per-pixel loops over the whole canvas, reuse objects, cap particle counts.
6. Output only the complete index.html, ready to save, with short comments explaining the main parts.

---

## Tips

- Ask for changes in plain words: "make the eyes bigger", "more glow when it speaks", "calmer while thinking".
- Give the AI a reference: "in the style of a stained-glass window", "like a 1980s arcade robot", "a watercolor fox".
- The colors follow your theme by default, so switching themes recolors your face. If you want fixed colors, say so in the description.
