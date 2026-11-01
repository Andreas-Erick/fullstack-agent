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
