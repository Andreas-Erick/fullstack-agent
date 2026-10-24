// Neural-core face: a constellation brain with nine labeled regions, thought-pulses traveling along
// connections, and a CORTEX STATUS panel tied to the real agent state.
import { BaseFace, audio, faceState, baseState, paletteFor, rgba, lerp, lerpColor } from './common.js';
import { state } from '../state.js';

const REGIONS = [
  ['MEMORY', -0.55, -0.25], ['LANGUAGE', -0.25, -0.55], ['REASONING', 0.15, -0.6], ['PLANNING', 0.5, -0.35],
  ['VOICE', 0.62, 0.05], ['PERCEPTION', 0.4, 0.42], ['EMOTION', 0, 0.55], ['TOOLS', -0.42, 0.4], ['VISION', -0.65, 0.1],
];
// Which regions light up in each state.
const ACTIVE = { idle: ['MEMORY'], listening: ['PERCEPTION', 'LANGUAGE', 'VOICE'], thinking: ['REASONING', 'PLANNING', 'MEMORY', 'TOOLS'], speaking: ['VOICE', 'LANGUAGE', 'EMOTION'], alert: ['EMOTION', 'PERCEPTION'] };

export class NeuralFace extends BaseFace {
  constructor(canvas, opts) {
    super(canvas, opts);
    const p = paletteFor('idle');
    this.cur = { main: p.main, accent: p.accent };
    this.pulses = [];
    this.glow = Object.fromEntries(REGIONS.map(([n]) => [n, 0]));
  }

  layout() {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const sx = Math.min(this.w, this.h * 1.4) * 0.42;
    const sy = Math.min(this.h, this.w) * 0.42;
    this.nodes = [];
    REGIONS.forEach(([name, rx, ry], ri) => {
      const n = this.compact ? 7 : 16;
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2;
        const d = rand() * (this.compact ? 0.13 : 0.16);
        this.nodes.push({ region: name, ri, x: cx + (rx + Math.cos(a) * d) * sx, y: cy + (ry + Math.sin(a) * d) * sy, r: 1 + rand() * 2 });
      }
    });
    this.edges = [];
    for (let i = 0; i < this.nodes.length; i++) {
      const a = this.nodes[i];
      const near = this.nodes.map((b, j) => [j, Math.hypot(a.x - b.x, a.y - b.y)]).filter(([j]) => j !== i).sort((p, q) => p[1] - q[1]).slice(0, 3);
      for (const [j] of near) if (j > i) this.edges.push([i, j]);
    }
    // A few long-range connections between regions.
    for (let i = 0; i < REGIONS.length * 3; i++) this.edges.push([(rand() * this.nodes.length) | 0, (rand() * this.nodes.length) | 0]);
    this.centers = REGIONS.map(([name, rx, ry]) => ({ name, x: cx + rx * sx, y: cy + ry * sy }));
  }

  draw(dt) {
    const g = this.ctx;
    const shown = faceState();
    const st = baseState(shown); // core state for motion; colors use the exact one
    const target = paletteFor(shown);
    const k = 1 - Math.pow(0.02, dt);
    this.cur.main = lerpColor(this.cur.main, target.main, k);
    this.cur.accent = lerpColor(this.cur.accent, target.accent, k);
    const { main, accent } = this.cur;
    const { level } = audio();
    const active = ACTIVE[st] || ACTIVE.idle;
    for (const [name] of REGIONS) this.glow[name] = lerp(this.glow[name], active.includes(name) ? 0.6 + level * 0.4 : 0.12, 1 - Math.pow(0.05, dt));
    g.clearRect(0, 0, this.w, this.h);

    g.lineWidth = 1;
    for (const [i, j] of this.edges) {
      const a = this.nodes[i];
      const b = this.nodes[j];
      g.strokeStyle = rgba(main, 0.05 + (this.glow[a.region] + this.glow[b.region]) * 0.08);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }

    const rate = st === 'thinking' ? 40 : st === 'speaking' ? 10 + level * 40 : st === 'listening' ? 8 + level * 30 : 2;
    if (Math.random() < rate * dt) {
      const e = this.edges[(Math.random() * this.edges.length) | 0];
      this.pulses.push({ e, t: 0, v: 0.8 + Math.random() * 1.5 });
    }
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const p of this.pulses) {
      p.t += dt * p.v;
      const a = this.nodes[p.e[0]];
      const b = this.nodes[p.e[1]];
      const x = lerp(a.x, b.x, p.t);
      const y = lerp(a.y, b.y, p.t);
      g.fillStyle = rgba(accent, 0.9 * (1 - p.t));
      g.beginPath();
      g.arc(x, y, 2.2, 0, Math.PI * 2);
      g.fill();
    }
    this.pulses = this.pulses.filter((p) => p.t < 1);
    for (const n of this.nodes) {
      const gl = this.glow[n.region];
      g.fillStyle = rgba(main, 0.25 + gl * 0.75);
      g.beginPath();
      g.arc(n.x, n.y, n.r * (1 + gl * 0.6), 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    if (!this.compact) {
      g.font = '600 10px "Orbitron", sans-serif';
      g.textAlign = 'center';
      for (const c of this.centers) {
        g.fillStyle = rgba(main, 0.3 + this.glow[c.name] * 0.7);
        g.fillText(c.name, c.x, c.y - 28);
      }
      // CORTEX STATUS panel
      const x = 24;
      const y = this.h - 120;
      g.textAlign = 'left';
      g.fillStyle = rgba(main, 0.9);
      g.font = '700 11px "Orbitron", sans-serif';
      g.fillText('CORTEX STATUS', x, y);
      g.font = '12px "JetBrains Mono", Consolas, monospace';
      g.fillStyle = rgba(main, 0.75);
      g.fillText(`STATE   ${st.toUpperCase()}`, x, y + 20);
      g.fillText(`SIGNAL  [${'|'.repeat(Math.round(level * 12)).padEnd(12, '.')}]`, x, y + 38);
      g.fillText(`REGIONS ${active.join(' · ')}`, x, y + 56);
      if (state.alert) g.fillText(`ALERT   ${String(state.alert.message).slice(0, 48)}`, x, y + 74);
    }
  }
}
