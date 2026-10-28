// AV — the API for custom faces. Include it in your face's index.html with
//   <script src="core.js"></script>
// then read these in your draw loop:
//   AV.state    'idle' | 'listening' | 'thinking' | 'working' | 'speaking' | 'happy' | 'sleeping' | 'alert'
//               (working = running tools, happy = a reply just finished, sleeping = idle for a while;
//               treat them like thinking / speaking / idle if your face doesn't show them)
//   AV.level    0..1 voice / mic level
//   AV.samples  64 waveform samples (-1..1) while speaking
//   AV.env      { name, colors: { bg, accent, accent2, text, … }, states: { idle: [main, accent], … }, alert }
//   AV.init(onUpdate?)  start listening for updates (optionally get a callback on each one)
// Updates arrive once per display frame (60, 120, 144 Hz…; ~30/s on the Balanced profile), so draw
// with your own requestAnimationFrame loop and move by elapsed time, not by frame count.
// Faces run sandboxed: no network access and no access to the app.
(function () {
  const AV = {
    state: 'idle',
    level: 0,
    samples: new Array(64).fill(0),
    env: { name: 'Siren', colors: {}, states: {}, alert: null },
    init(onUpdate) {
      window.addEventListener('message', (e) => {
        const m = e.data;
        if (!m || m.type !== 'av') return;
        AV.state = m.state;
        AV.level = m.level;
        AV.samples = m.samples;
        AV.env = m.env;
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
  window.AV = AV;
})();
