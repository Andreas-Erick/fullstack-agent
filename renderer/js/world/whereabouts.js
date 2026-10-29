// Who is where in the village, shared by the desktop's World view and the phone's world screen.
// Pure: no DOM, no clock (times are passed in), so test/whereabouts.test.js can run it in Node.
//  - The active persona goes where its work is (a tool sends it: the Library when it researches, the
//    Workshop when it writes code…), walking there along the roads; while it thinks it heads to the
//    Garden; with nothing to do it takes a walk through the village, place to place.
//  - The other personas are off duty: they relax at the Hearth (by the fire, at the table).
//  - Townsfolk follow the narrator's plan for their day. Everyone sleeps at night, and a narrated
//    scene gathers the residents it names.

export const TRAVEL_MS = 6000; // walking to a new piece of work
export const STROLL_WALK_MS = 45000; // one leg of a walk through the village
export const STROLL_PAUSE_MS = 20000; // looking around at each place on the way
export const NIGHT = { from: 23 * 60, to: 6 * 60 };

const RELAX = [
  { place: 'hearth', activity: 'relaxing by the fire' },
  { place: 'hearth', activity: 'having tea at the table' },
];
const PAUSE = {
  library: 'browsing the shelves',
  cafe: 'stopping for a coffee',
  workshop: 'looking in at the forge',
  garden: 'sitting by the fountain',
  grounds: 'watching the training',
  observatory: 'looking at the star charts',
  archive: 'leafing through the files',
  stage: 'watching from the seats',
  lookout: 'taking in the view',
  hearth: 'warming up by the fire',
};

export const asleepAt = (m) => m < NIGHT.to || m >= NIGHT.from;

/** The places a walk passes, in a ring around the village's middle (so it never doubles back). */
export function strollOrder(sites, ids) {
  const list = ids.filter((id) => sites[id]);
  if (list.length < 2) return list;
  const cx = list.reduce((a, id) => a + sites[id].gx, 0) / list.length;
  const cy = list.reduce((a, id) => a + sites[id].gy, 0) / list.length;
  return list.sort((a, b) => Math.atan2(sites[a].gy - cy, sites[a].gx - cx) - Math.atan2(sites[b].gy - cy, sites[b].gx - cx));
}

/** Where the active persona is headed now: its work, or the Garden to think; null = free to stroll. */
export function activeTarget({ live, agentState }) {
  if (live) return { place: live.place, activity: live.label, working: true };
  if (['thinking', 'working'].includes(agentState)) return { place: 'garden', activity: 'thinking it over', thinking: true };
  return null;
}

/** An off-duty persona at minute m: asleep at night, otherwise relaxing in the Hearth. */
export function offDuty(m, i = 0) {
  if (asleepAt(m)) return { place: 'hearth', activity: 'asleep', asleep: true };
  return { ...RELAX[i % RELAX.length] };
}

/** A townsfolk at minute m: their plan's place (walking for walkMin after a change), or asleep. */
export function byPlan(plan, m, toMinutes, walkMin) {
  if (asleepAt(m)) return { place: 'hearth', activity: 'asleep', asleep: true };
  if (!plan?.length) return { place: 'garden', activity: 'strolling' };
  let idx = -1;
  plan.forEach((b, j) => toMinutes(b.start) !== null && toMinutes(b.start) <= m && (idx = j));
  if (idx < 0) return { place: 'hearth', activity: 'asleep', asleep: true };
  const out = { place: plan[idx].place, activity: plan[idx].activity };
  const since = m - toMinutes(plan[idx].start);
  const prev = idx > 0 ? plan[idx - 1].place : 'hearth';
  if (walkMin && since < walkMin && prev !== out.place) Object.assign(out, { from: prev, k: since / walkMin });
  return out;
}

/**
 * The active persona's movement between frames: walks to each new target, strolls when free.
 * update({ target, order, now }) → { place, activity, from?, k?, working?, thinking? }
 * (from + k: on the road from `from` to `place`, k of the way.)
 */
export function createWalker(start = 'hearth') {
  let at = start; // the place last reached
  let trip = null; // { from, to, at, target }
  let stroll = null; // { start, from }
  const travel = (to, now) => {
    if (trip && trip.to === to) return;
    // Half way down a road: the new trip starts from whichever end is nearer.
    const from = trip && now - trip.at < TRAVEL_MS / 2 ? trip.from : trip ? trip.to : at;
    trip = from === to ? null : { from, to, at: now };
    at = from === to ? to : at;
  };
  return {
    update({ target, order = [], now }) {
      if (target) {
        stroll = null;
        travel(target.place, now);
        if (!trip) return { ...target, place: target.place };
        const k = (now - trip.at) / TRAVEL_MS;
        if (k >= 1) {
          at = trip.to;
          trip = null;
          return { ...target };
        }
        return { ...target, from: trip.from, k, walking: true };
      }
      if (trip) {
        // Free again while still on the way: arrive first, then wander off.
        const k = (now - trip.at) / TRAVEL_MS;
        if (k < 1) return { place: trip.to, activity: 'on the way', from: trip.from, k, walking: true };
        at = trip.to;
        trip = null;
      }
      if (order.length < 2) return { place: at, activity: PAUSE[at] || 'looking around' };
      stroll ||= { start: now, from: at };
      const i0 = Math.max(0, order.indexOf(stroll.from));
      // A walk that starts somewhere off the ring first heads for its first place.
      const offRing = !order.includes(stroll.from);
      const cycle = STROLL_WALK_MS + STROLL_PAUSE_MS;
      const t = now - stroll.start;
      const leg = Math.floor(t / cycle);
      const within = t - leg * cycle;
      const from = leg === 0 && offRing ? stroll.from : order[(i0 + leg + (offRing ? -1 : 0) + order.length) % order.length];
      const to = order[(i0 + leg + (offRing ? 0 : 1)) % order.length];
      if (within < STROLL_WALK_MS && from !== to) {
        at = from;
        return { place: to, activity: 'taking a walk through the village', from, k: within / STROLL_WALK_MS, walking: true };
      }
      at = to;
      return { place: to, activity: PAUSE[to] || 'looking around' };
    },
    get place() {
      return trip ? trip.to : at;
    },
  };
}
