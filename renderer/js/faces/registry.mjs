// The built-in faces, listed once. Everything that names them derives from this list: the desktop's
// gallery (faces/host.js), the phone client (renderer/remote/app.js), the watch's recording page
// (js/facecapture.js), the files the companion server serves and the tools' face names (main/facesregistry.js),
// and the tests. The phone's service worker can't import it (a classic worker): test/facesregistry.test.js
// holds its cache list to this one. Pure data: no imports, so the phone can load it.
// `module` is relative to renderer/js (the phone serves renderer/js/x as /js/x); `export` is the class.

export const BUILT_IN_FACES = [
  { id: 'siren', title: 'Siren', tagline: 'A sea-nymph who sings: fins spread, a lyre halo turns, song rings ripple with her voice', module: 'faces/siren.js', export: 'SirenFace' },
  { id: 'circuit', title: 'Circuit Board', tagline: 'Living PCB — pulses run the traces', module: 'visualizer.js', export: 'CircuitFace' },
  { id: 'radial', title: 'Radial', tagline: 'Starburst bars around a particle orb', module: 'faces/radial.js', export: 'RadialFace' },
  { id: 'rain', title: 'Code Rain', tagline: 'Glyph rain; a face appears when it speaks', module: 'faces/rain.js', export: 'RainFace' },
  { id: 'neural', title: 'Neural Core', tagline: 'Constellation brain with live regions', module: 'faces/neural.js', export: 'NeuralFace' },
  { id: 'companion', title: 'Companion', tagline: 'A friendly character: eyes and smile show what it is doing', module: 'faces/companion.js', export: 'CompanionFace' },
];

// The face shown when the one asked for isn't built in.
export const DEFAULT_FACE = 'siren';

export const FACE_IDS = BUILT_IN_FACES.map((f) => f.id);

// What the face modules share (relative to renderer/js), and this list itself.
export const FACE_SUPPORT = ['themecore.js', 'faces/env.js', 'faces/common.js', 'faces/registry.mjs'];

// Every file a device needs to draw any built-in face, relative to renderer/js.
export const FACE_FILES = [...FACE_SUPPORT, ...BUILT_IN_FACES.map((f) => f.module)];
