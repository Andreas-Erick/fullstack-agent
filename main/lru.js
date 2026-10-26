// A Map with a size budget: least recently used entries go first once the total passes `max`.
// Used for the vault note cache (obsidian.js), which otherwise grows with every note ever read.
class SizedLru {
  constructor(max, sizeOf = (v) => String(v?.text ?? v ?? '').length) {
    this.max = max;
    this.sizeOf = sizeOf;
    this.map = new Map();
    this.size = 0;
  }

  get(key) {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    this.map.delete(key); // most recent last
    this.map.set(key, hit);
    return hit;
  }

  set(key, value) {
    this.delete(key);
    const size = this.sizeOf(value);
    if (size > this.max / 4) return this; // one huge note never pushes out everything else
    this.map.set(key, value);
    this.size += size;
    for (const [k, v] of this.map) {
      if (this.size <= this.max) break;
      this.map.delete(k);
      this.size -= this.sizeOf(v);
    }
    return this;
  }

  delete(key) {
    const old = this.map.get(key);
    if (old === undefined) return false;
    this.map.delete(key);
    this.size -= this.sizeOf(old);
    return true;
  }

  clear() {
    this.map.clear();
    this.size = 0;
  }
}

module.exports = { SizedLru };
