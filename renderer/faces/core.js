// AV — the API for custom faces. Include it in your face's index.html with
//   <script src="core.js"></script>
// then read these in your draw loop:
//   AV.state    'idle' | 'listening' | 'thinking' | 'working' | 'speaking' | 'happy' | 'sleeping' | 'alert'
//               (working = running tools, happy = a reply just finished, sleeping = how the assistant
//               starts and after a quiet while;
//               treat them like thinking / speaking / idle if your face doesn't show them)
//   AV.level    0..1 voice / mic level
//   AV.samples  64 waveform samples (-1..1) while speaking
//   AV.env      { name, colors: { bg, accent, accent2, text, … }, states: { idle: [main, accent], … }, alert }
//   AV.maxFps   the most frames a second the app wants now (0 = no limit); core.js holds your
//               requestAnimationFrame loop to it (while the offline voice speaks, and on Balanced)
//   AV.init(onUpdate?)  start listening for updates (optionally get a callback on each one)
// Updates arrive once per display frame (60, 120, 144 Hz…; ~30/s on the Balanced profile), so draw
// with your own requestAnimationFrame loop and move by elapsed time (its timestamp), never by frame count.
// Faces run sandboxed: no network access and no access to the app.
(function () {
  const AV = {
    state: 'sleeping', // the assistant starts asleep: so does the face, until the first update says otherwise
    level: 0,
    samples: new Array(64).fill(0),
    env: { name: 'Siren', colors: {}, states: {}, alert: null },
    maxFps: 0,
    init(onUpdate) {
      window.addEventListener('message', (e) => {
        const m = e.data;
        if (!m || m.type !== 'av') return;
        AV.state = m.state;
        AV.level = m.level;
        AV.samples = m.samples;
        AV.env = m.env;
        AV.maxFps = Number(m.maxFps) || 0;
        if (onUpdate) onUpdate(AV);
      });
      return AV;
    },
    // Convenience: the current [main, accent] colors for the state.
    colors() {
      if (AV.state === 'alert') return ['#ff3b4f', '#ff8c78'];
      return AV.env.states?.[AV.state] || AV.env.states?.idle || ['#00e5ff', '#2f7bff'];
    },
  };

  // The app may hold the face below the display's rate (AV.maxFps: while its offline voice works, and
  // on the Balanced profile). Every callback of one display frame shares its time, so a face with
  // several loops keeps them in step; 0 = no cap.
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  const live = new Map();
  let seq = 0, frameT = -Infinity, frameOk = true, due = 0;
  const allowed = (t) => {
    if (t === frameT) return frameOk;
    frameT = t;
    if (!(AV.maxFps > 0)) return (due = 0), (frameOk = true);
    if (t + 2 < due) return (frameOk = false);
    const step = 1000 / AV.maxFps;
    due = t - due > step ? t + step : due + step;
    return (frameOk = true);
  };
  window.requestAnimationFrame = (cb) => {
    const id = ++seq;
    const tick = (t) => (allowed(t) ? (live.delete(id), cb(t)) : live.set(id, raf(tick)));
    live.set(id, raf(tick));
    return id;
  };
  window.cancelAnimationFrame = (id) => (live.has(id) && caf(live.get(id)), live.delete(id));

  window.AV = AV;
})();
