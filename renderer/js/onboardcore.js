// The setup wizard's pure part. The face list: the face in use first (a fresh install's default,
// brand.FACE, is a custom face), then the custom faces, then the built-in ones. The face in use is
// always there, so the wizard can show what is selected and never offers only a way to lose it.
export function faceChoices(current, custom = [], builtIn = []) {
  const own = custom.map((f) => ({ value: f.id, title: f.title, desc: f.tagline || '' }));
  const taken = new Set(own.map((f) => f.title));
  const shipped = builtIn.map((f) => ({ value: f.id, title: taken.has(f.title) ? `${f.title} (built-in)` : f.title, desc: f.tagline || '' }));
  const all = [...own, ...shipped];
  const inUse = all.find((f) => f.value === current);
  if (inUse) return [inUse, ...all.filter((f) => f !== inUse)];
  return current ? [{ value: current, title: 'Your current face', desc: '' }, ...all] : all;
}

export const STEPS = ['welcome', 'privacy', 'hardware', 'brain', 'voice', 'vault', 'goals', 'connect', 'persona', 'tour', 'hello'];

// The ways through the wizard, each ending with its last step: the whole setup; "Quick start" (the
// welcome, then the privacy step, then done); and the privacy step alone, for an install that was set
// up without accepting it. Every one passes the privacy step.
const PATHS = { full: STEPS, quick: ['welcome', 'privacy'], missed: ['privacy'] };
export const stepsFor = (mode) => PATHS[mode] || STEPS;

export const accepted = (settings) => Number(settings?.privacy?.acceptedAt) > 0;

/** What finishing the wizard saves: never `onboarded` without the privacy acceptance (null then). */
export function finishPatch(settings) {
  return accepted(settings) ? { onboarded: true } : null;
}

/** At launch: 'full' (first run), 'missed' (set up, the privacy notice never accepted) or '' (nothing). */
export function launchMode(settings) {
  if (!settings?.onboarded) return 'full';
  return accepted(settings) ? '' : 'missed';
}
