// The system monitor (main/sysmon.js): CPU share, the GPU readers' lines, and that the numbers stay
// with the user (no tool, prompt or remote route reads them).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, quietLog, ROOT } = require('./helpers');

stub({ './logger': quietLog });
const sysmon = load('main/sysmon.js');

const cpu = (busy, idle) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });

test('CPU load between two snapshots', () => {
  assert.strictEqual(sysmon.cpuPercent([cpu(100, 900), cpu(100, 900)], [cpu(150, 950), cpu(200, 900)]), 75);
  assert.strictEqual(sysmon.cpuPercent([cpu(1, 1)], [cpu(1, 1)]), 0, 'no time passed');
});

test('nvidia-smi lines: load, VRAM, temperature; junk is ignored', () => {
  assert.deepStrictEqual(sysmon.parseNvidia('0, NVIDIA GeForce RTX 5090 Laptop GPU, 7, 3510, 24463, 43'), { id: 'nv0', name: 'NVIDIA GeForce RTX 5090 Laptop GPU', load: 7, vramUsedMB: 3510, vramTotalMB: 24463, tempC: 43 });
  assert.strictEqual(sysmon.parseNvidia('0, GPU, [N/A], 1, 2, 3'), null);
  assert.strictEqual(sysmon.parseNvidia('error'), null);
});

test('Windows counter lines (CRLF, clamped)', () => {
  assert.strictEqual(sysmon.parseCounter('6\r').load, 6);
  assert.strictEqual(sysmon.parseCounter('140').load, 100);
  assert.strictEqual(sysmon.parseCounter('#< CLIXML'), null);
});

test('Bluetooth: connected devices only, each name once, battery when reported', () => {
  const json = JSON.stringify({ radio: 1, devices: [
    { name: 'soundcore Q20i', connected: true, battery: null },
    { name: 'soundcore Q20i', connected: false, battery: null },
    { name: 'Lenovo Pro WL Keyboard', connected: true, battery: 76 },
    { name: 'Xbox Wireless Controller', connected: false, battery: 40 },
  ] });
  assert.deepStrictEqual(sysmon.parseBluetooth(json), { radio: true, devices: [{ name: 'soundcore Q20i', battery: null }, { name: 'Lenovo Pro WL Keyboard', battery: 76 }] });
  assert.deepStrictEqual(sysmon.parseBluetooth(JSON.stringify({ radio: 0, devices: { name: 'One', connected: true } })), { radio: false, devices: [{ name: 'One', battery: null }] }, 'PowerShell gives a single object, not a list');
  assert.strictEqual(sysmon.parseBluetooth('not json'), null);
});

test('speed test math: megabits per second', () => {
  const netspeed = load('main/netspeed.js');
  assert.strictEqual(netspeed.mbps(10_000_000, 1000), 80);
  assert.strictEqual(netspeed.mbps(1, 0), 0);
});

test('the numbers never reach the assistant or paired devices', () => {
  for (const f of ['main/tools.js', 'main/prompt.js', 'main/companion.js', 'main/llm.js']) {
    assert.ok(!/sysmon|netspeed/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} must not read the system monitor`);
  }
});

test('macOS memory as Activity Monitor counts it: app + wired + compressed, not cached files', () => {
  const out = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                5000.
Pages active:                            300000.
Pages inactive:                          290000.
Pages speculative:                         4000.
Pages wired down:                        120000.
Pages purgeable:                          10000.
File-backed pages:                       280000.
Anonymous pages:                         310000.
Pages occupied by compressor:             50000.`;
  // (310000 - 10000) + 120000 + 50000 pages of 16 KiB = 7.17 GiB in use, though only 5000 pages are "free".
  assert.strictEqual(sysmon.parseVmStat(out), (300000 + 120000 + 50000) * 16384);
  assert.strictEqual(sysmon.parseVmStat('nonsense'), null);
});

test('Apple GPU load and the unified memory it uses, from ioreg', () => {
  const out = `+-o AGXAcceleratorG14X  <class AGXAcceleratorG14X, id 0x1000004d4>
    {
      "PerformanceStatistics" = {"In use system memory"=2147483648,"Device Utilization %"=37,"Renderer Utilization %"=35,"Tiler Utilization %"=12}
      "model" = "Apple M2 Pro"
    }`;
  assert.deepStrictEqual(sysmon.parseIoreg(out), { load: 37, sharedUsedMB: 2048 });
  assert.strictEqual(sysmon.parseIoreg('no accelerator'), null);
});
