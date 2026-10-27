// A history replay over an architecture map (renderer/js/archdraw.js; the Inner World's timelapse uses it
// too, with a place per "file" and its level as the "lines"): the commits of a git history
// (main/replay.js) played in order, so files appear, grow and glow as they are touched. The state
// machine (which files exist at the replayed moment, how warm each one still is) is separate from the
// control bar, so the Architecture view and the vault's Growth replay share both.
import { el } from './util.js';

const COOL_MS = 1600; // how long a touched file stays warm
const TONES = { self: 'c3', revert: 'warn', release: 'ok', baseline: 'c2', manual: 'c1', growth: 'ok' };
export const KIND_WORDS = { self: 'Siren changed herself', revert: 'Reverted', release: 'Release', baseline: 'The beginning', manual: 'By hand', growth: 'Growth' };

/**
 * commits: [{ sha, at, author, subject, kind, files: [{ path, status, added, removed }] }], oldest first.
 * keep(path): whether a path belongs on the map (others are ignored).
 */
export function createReplay(commits, { keep = () => true } = {}) {
  const list = commits.filter((c) => c.files.some((f) => keep(f.path)) || c.kind === 'baseline');
  const state = { index: -1, playing: false, speed: 1, present: new Set(), lines: new Map(), heat: new Map(), tone: 'c1' };
  // So the whole history takes about 40 seconds at 1×, whatever its length.
  const perSecond = Math.max(0.6, Math.min(25, list.length / 40));
  let carry = 0;

  // The world as of commit `i` (every commit up to it applied); the heat only of commit i's files.
  function seek(i) {
    const to = Math.max(-1, Math.min(list.length - 1, i));
    const forward = to > state.index;
    if (!forward || state.index < 0) {
      state.present = new Set();
      state.lines = new Map();
      state.heat = new Map();
      for (let k = 0; k <= to; k++) apply(list[k], k === to);
    } else for (let k = state.index + 1; k <= to; k++) apply(list[k], k === to);
    state.index = to;
    state.tone = TONES[list[to]?.kind] || 'c1';
  }

  function apply(c, warm) {
    for (const f of c.files) {
      if (!keep(f.path)) continue;
      if (f.status === 'D') {
        state.present.delete(f.path);
        state.heat.delete(f.path);
        continue;
      }
      state.present.add(f.path);
      state.lines.set(f.path, Math.max(0, (state.lines.get(f.path) || 0) + (f.added || 0) - (f.removed || 0)));
      if (warm) state.heat.set(f.path, 1);
    }
  }

  /** Advances playback by dt ms; returns true when something changed (the view redraws then). */
  function tick(dt) {
    let changed = false;
    for (const [p, h] of state.heat) {
      const next = h - dt / COOL_MS;
      if (next <= 0) state.heat.delete(p);
      else state.heat.set(p, next);
      changed = true;
    }
    if (!state.playing) return changed;
    carry += (dt / 1000) * perSecond * state.speed;
    const steps = Math.floor(carry);
    if (steps >= 1) {
      carry -= steps;
      if (state.index + steps >= list.length - 1) {
        seek(list.length - 1);
        state.playing = false;
      } else seek(state.index + steps);
      changed = true;
    }
    return changed;
  }

  return {
    get commits() {
      return list;
    },
    get state() {
      return state;
    },
    get current() {
      return list[state.index] || null;
    },
    get done() {
      return state.index >= list.length - 1;
    },
    seek,
    tick,
    play() {
      if (state.index >= list.length - 1) seek(-1);
      state.playing = true;
      carry = 0;
    },
    pause() {
      state.playing = false;
    },
    setSpeed(s) {
      state.speed = s;
    },
    /** What the renderer needs: setReplay(replay.overlay()). */
    overlay: () => ({ present: state.present, heat: state.heat, lines: state.lines, tone: state.tone }),
  };
}

/**
 * The control bar: play/pause, a slider over the commits, the speed, and what the current commit was.
 * onChange() is called after any control changed the replay; the host redraws and keeps ticking.
 * count(state) replaces the "12 files · 3,400 lines" summary.
 */
export function replayBar(replay, { onChange, onClose, noun = 'file', count: countText } = {}) {
  const play = el('button', { class: 'btn replay-play', title: 'Play / pause (Space)' }, '▶');
  const slider = el('input', { type: 'range', class: 'replay-slider', min: -1, max: Math.max(-1, replay.commits.length - 1), value: replay.state.index, step: 1, 'aria-label': 'Moment in the history' });
  const speed = el('select', { class: 'input replay-speed', title: 'Speed' }, ...[0.5, 1, 2, 4].map((s) => el('option', { value: String(s) }, `${s}×`)));
  speed.value = String(replay.state.speed);
  const when = el('div', { class: 'replay-when' });
  const what = el('div', { class: 'replay-what' });
  const count = el('div', { class: 'replay-count' });
  const bar = el('div', { class: 'replay-bar glass' }, play, slider, speed, el('div', { class: 'replay-text' }, when, what), count, onClose ? el('button', { class: 'btn replay-close', title: 'Leave the replay (Esc)', onclick: onClose }, '✕') : '');
  play.onclick = () => (replay.state.playing ? replay.pause() : replay.play(), onChange?.());
  slider.oninput = () => (replay.pause(), replay.seek(Number(slider.value)), onChange?.());
  speed.onchange = () => (replay.setSpeed(Number(speed.value)), onChange?.());
  bar.update = () => {
    const c = replay.current;
    const s = replay.state;
    play.textContent = s.playing ? '❚❚' : replay.done ? '↻' : '▶';
    if (Number(slider.value) !== s.index) slider.value = s.index;
    const n = s.index + 1;
    const total = replay.commits.length;
    when.textContent = c ? `${new Date(c.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${n} of ${total}` : total ? `Before the first change · ${total} changes` : 'No history yet';
    what.replaceChildren(c ? el('span', { class: `replay-kind kind-${c.kind}` }, KIND_WORDS[c.kind] || c.kind) : '', c ? el('span', {}, ` ${c.subject || ''}`) : '');
    count.textContent = countText ? countText(s) : `${s.present.size.toLocaleString()} ${noun}${s.present.size === 1 ? '' : 's'} · ${[...s.lines.values()].reduce((a, b) => a + b, 0).toLocaleString()} lines`;
  };
  bar.update();
  return bar;
}
