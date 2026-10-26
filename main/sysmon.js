// The system monitor in the title bar: CPU, RAM, disk and GPU load, for the user only. The numbers go
// to the window (`system:stats`) and nowhere else: not to the AI, the prompt, a tool or the log.
// It samples only while the window watches (it stops when the window is hidden or the meter is off).
// GPU: NVIDIA cards through nvidia-smi (load, VRAM, temperature), others through Windows' GPU engine
// counters (load only); each runs as one long-lived process that prints a line every interval, so
// nothing is spawned per sample. Macs with Apple silicon: the GPU's load and how much of the shared
// (unified) memory it uses from ioreg, and RAM as Activity Monitor counts it (vm_stat), because
// os.freemem() there leaves out cached and compressed memory and would show the Mac as nearly full.
// The parsing is pure (tested in test/sysmon.test.js).
const os = require('os');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const log = require('./logger');

const INTERVAL_MS = 2000;
const isWin = process.platform === 'win32';

// ------------------------------------------------------------ pure
/** CPU busy share (0–100) between two os.cpus() snapshots. */
function cpuPercent(prev, next) {
  let idle = 0;
  let total = 0;
  next.forEach((c, i) => {
    const p = prev[i];
    if (!p) return;
    for (const k of Object.keys(c.times)) total += c.times[k] - p.times[k];
    idle += c.times.idle - p.times.idle;
  });
  return total > 0 ? Math.round(Math.min(100, Math.max(0, (1 - idle / total) * 100))) : 0;
}

/** One nvidia-smi CSV line (index, name, load %, VRAM used MiB, VRAM total MiB, temperature °C). */
function parseNvidia(line) {
  const f = String(line).split(',').map((x) => x.trim());
  if (f.length < 6) return null;
  const num = (v) => (/^\d+(\.\d+)?$/.test(v) ? Number(v) : null);
  if (num(f[2]) === null) return null;
  return { id: `nv${f[0]}`, name: f[1], load: num(f[2]), vramUsedMB: num(f[3]), vramTotalMB: num(f[4]), tempC: num(f[5]) };
}

/** A Windows counter line from the loop below: "<load>" (all adapters' 3D engines, busiest adapter). */
function parseCounter(line) {
  const v = Number(String(line).trim().replace(',', '.'));
  return Number.isFinite(v) ? { id: 'gpu', name: 'GPU', load: Math.round(Math.min(100, Math.max(0, v))) } : null;
}

/**
 * macOS vm_stat → memory in use as Activity Monitor's "Memory Used": app memory (anonymous pages that
 * aren't purgeable), wired memory and what the compressor occupies. Cached files don't count. Bytes.
 */
function parseVmStat(text) {
  const t = String(text || '');
  const page = Number(/page size of (\d+) bytes/.exec(t)?.[1]);
  const n = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(t)?.[1] || 0);
  if (!page) return null;
  const app = Math.max(0, n('Anonymous pages') - n('Pages purgeable')) || n('Pages active');
  return (app + n('Pages wired down') + n('Pages occupied by compressor')) * page;
}

/** macOS ioreg (IOAccelerator) → the Apple GPU's load (%) and the shared memory it uses (MB). */
function parseIoreg(text) {
  const t = String(text || '');
  const load = /"Device Utilization %"\s*=\s*(\d+)/.exec(t);
  if (!load) return null;
  const mem = /"In use system memory"\s*=\s*(\d+)/.exec(t);
  return { load: Math.min(100, Number(load[1])), sharedUsedMB: mem ? Math.round(Number(mem[1]) / 2 ** 20) : null };
}

const GB = 1024 ** 3;
const round1 = (x) => Math.round(x * 10) / 10;

// ------------------------------------------------------------ sampling
let timer = null;
let lastCpus = null;
let gpuProc = null;
let gpus = new Map(); // id -> latest reading
let gpuSource = null; // 'nvidia' | 'windows' | 'apple' | 'none' | null (not checked yet)
const isMac = process.platform === 'darwin';
let macUsed = null; // bytes in use, from the last vm_stat (macOS)
let latest = null;
let send = () => {};
const diskRoot = isWin ? `${(process.env.SystemDrive || 'C:').replace(/\\?$/, '')}\\` : '/';

function sample() {
  const cpus = os.cpus();
  const cpu = lastCpus ? cpuPercent(lastCpus, cpus) : 0;
  lastCpus = cpus;
  const total = os.totalmem();
  if (isMac) execFile('vm_stat', [], { timeout: 1500 }, (err, out) => (macUsed = err ? null : parseVmStat(out)));
  const used = isMac && macUsed ? Math.min(total, macUsed) : total - os.freemem();
  fs.statfs(diskRoot, (err, st) => {
    const disk = err ? null : { root: diskRoot, usedGB: round1(((st.blocks - st.bfree) * st.bsize) / GB), totalGB: round1((st.blocks * st.bsize) / GB) };
    latest = {
      at: Date.now(),
      cpu: { load: cpu, cores: cpus.length, model: cpus[0]?.model?.trim() || '' },
      ram: { usedGB: round1(used / GB), totalGB: round1(total / GB), load: Math.round((used / total) * 100), unified: gpuSource === 'apple' },
      disk: disk && { ...disk, load: disk.totalGB ? Math.round((disk.usedGB / disk.totalGB) * 100) : 0 },
      gpus: [...gpus.values()],
      gpuSource,
    };
    send(latest);
  });
}

// One long-lived reader per GPU source; each stdout line is a reading.
function readLines(child, onLine) {
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
}

function startNvidia() {
  const child = spawn('nvidia-smi', ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits', `--loop-ms=${INTERVAL_MS}`], { windowsHide: true });
  readLines(child, (line) => {
    const g = parseNvidia(line);
    if (g) gpus.set(g.id, g);
  });
  return child;
}

// Windows' counters: the busiest adapter's 3D engine load (summed over processes, per adapter LUID),
// printed every interval by one PowerShell.
const COUNTER_LOOP = `$ErrorActionPreference='SilentlyContinue'
while ($true) {
  $s = (Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -SampleInterval ${INTERVAL_MS / 1000}).CounterSamples
  $by = @{}
  foreach ($x in $s) { $k = if ($x.InstanceName -match 'luid_0x[0-9a-f]+_0x[0-9a-f]+') { $matches[0] } else { 'gpu' }; $by[$k] = [double]$by[$k] + $x.CookedValue }
  $m = 0; foreach ($v in $by.Values) { if ($v -gt $m) { $m = $v } }
  [Console]::Out.WriteLine([math]::Round($m)); [Console]::Out.Flush()
}`;

function startWindowsCounters() {
  // A fixed script (no input in it), passed encoded: PowerShell reads multi-line blocks from stdin unreliably.
  const encoded = Buffer.from(COUNTER_LOOP, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  readLines(child, (line) => {
    const g = parseCounter(line);
    if (g) gpus.set(g.id, g);
  });
  return child;
}

function hasNvidiaSmi() {
  return new Promise((resolve) => execFile('nvidia-smi', ['-L'], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(!err && /GPU \d/.test(out))));
}

// Apple silicon: one ioreg query per interval (a few milliseconds); the GPU shares the Mac's memory.
function startApple() {
  const name = `${os.cpus()[0]?.model?.trim() || 'Apple'} GPU`;
  const poll = () =>
    execFile('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { timeout: 1500, maxBuffer: 1024 * 1024 }, (err, out) => {
      const g = !err && parseIoreg(out);
      if (g) gpus.set('apple', { id: 'apple', name, load: g.load, sharedUsedMB: g.sharedUsedMB, unified: true });
    });
  poll();
  const t = setInterval(poll, INTERVAL_MS);
  // Shaped like the child processes of the other sources, so start/stop treat it the same.
  return { exitCode: null, on() {}, kill: () => clearInterval(t) };
}

async function startGpu() {
  if (gpuProc || gpuSource === 'none') return;
  if (gpuSource === null) gpuSource = (await hasNvidiaSmi()) ? 'nvidia' : isWin ? 'windows' : isMac && process.arch === 'arm64' ? 'apple' : 'none';
  if (!timer || gpuSource === 'none') return; // stopped meanwhile
  try {
    gpuProc = gpuSource === 'nvidia' ? startNvidia() : gpuSource === 'apple' ? startApple() : startWindowsCounters();
    gpuProc.on('error', (err) => (log.warn('system monitor: GPU reader failed', { source: gpuSource, error: err }), (gpuProc = null)));
    gpuProc.on('exit', () => (gpuProc = null));
  } catch (err) {
    log.warn('system monitor: GPU reader failed', { source: gpuSource, error: err });
  }
}

function stopGpu() {
  const child = gpuProc;
  gpuProc = null;
  gpus = new Map();
  if (!child || child.exitCode !== null) return;
  if (isWin) execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
  else child.kill();
}

/** Starts or stops sampling (the window asks while the meter is visible). Returns the latest stats. */
function watch(on, sink) {
  if (sink) send = sink;
  if (on && !timer) {
    lastCpus = os.cpus();
    timer = setInterval(sample, INTERVAL_MS);
    timer.unref?.();
    sample();
    startGpu();
  } else if (!on && timer) {
    clearInterval(timer);
    timer = null;
    stopGpu();
  }
  return latest;
}

function stop() {
  watch(false);
}

// ------------------------------------------------------------ Bluetooth and network (the details panel)
// Connected Bluetooth devices from Windows' device list: device nodes (not their services) whose
// "is connected" property is set, with the battery level when the device reports one. About a second
// per query, so the panel asks only while it is open. A fixed script, passed encoded.
const BLUETOOTH_QUERY = `$ErrorActionPreference='SilentlyContinue'
$out = @(Get-PnpDevice -Class Bluetooth | Where-Object { $_.InstanceId -match '^(BTHENUM|BTHLE)\\\\DEV_' } | ForEach-Object {
  $p = Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName '{83DA6326-97A6-4088-9453-A1923F573B29} 15','{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2'
  [pscustomobject]@{ name = $_.FriendlyName; connected = [bool]$p[0].Data; battery = $p[1].Data }
})
$radio = @(Get-PnpDevice -Class Bluetooth -PresentOnly | Where-Object { $_.InstanceId -match '^(USB|PCI)\\\\' }).Count
ConvertTo-Json -InputObject @{ devices = $out; radio = $radio } -Compress -Depth 3`;

/** The query's JSON → { radio: bool, devices: [{ name, battery? }] } (connected ones, each name once). */
function parseBluetooth(text) {
  let data;
  try {
    data = JSON.parse(String(text).trim());
  } catch {
    return null;
  }
  const list = Array.isArray(data?.devices) ? data.devices : data?.devices ? [data.devices] : [];
  const seen = new Map();
  for (const d of list) {
    if (!d?.connected || typeof d.name !== 'string' || !d.name.trim()) continue;
    const name = d.name.trim().slice(0, 80);
    const battery = Number.isFinite(Number(d.battery)) && d.battery !== null && d.battery !== '' ? Math.max(0, Math.min(100, Number(d.battery))) : null;
    if (!seen.has(name) || (battery !== null && seen.get(name).battery === null)) seen.set(name, { name, battery });
  }
  return { radio: Number(data?.radio) > 0, devices: [...seen.values()] };
}

let btRunning = null;

/** Connected Bluetooth devices (Windows), or null where this isn't available. */
function bluetooth() {
  if (!isWin) return Promise.resolve(null);
  btRunning ||= new Promise((resolve) => {
    const encoded = Buffer.from(BLUETOOTH_QUERY, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (err, out) => {
      if (err) log.warn('system monitor: Bluetooth query failed', { error: err });
      resolve(err ? null : parseBluetooth(out));
    });
  }).finally(() => (btRunning = null));
  return btRunning;
}

/** The network adapter in use (the first one that is up with a non-internal IPv4 address). */
function network() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/loopback|vethernet|virtual|vmware|vbox|hyper-v|wsl|tailscale|zerotier/i.test(name)) continue;
    if ((addrs || []).some((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))) return { adapter: name };
  }
  return { adapter: null };
}

module.exports = { cpuPercent, parseNvidia, parseCounter, parseVmStat, parseIoreg, parseBluetooth, bluetooth, network, watch, stop, COUNTER_LOOP, BLUETOOTH_QUERY };
