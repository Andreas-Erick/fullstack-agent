// Hardware scan for the setup wizard (optional, local only, nothing is sent anywhere): CPU, memory,
// graphics cards with their memory (VRAM), then recommendations — which speech model fits, and
// whether a local brain is realistic or a cloud provider is the better choice.
const os = require('os');
const { execFile } = require('child_process');
const { app } = require('electron');
const log = require('./logger');

const GB = 1024 ** 3;

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out))));
}

// NVIDIA cards report exact VRAM through nvidia-smi when the driver is installed.
async function nvidia() {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  return out
    .split('\n')
    .map((l) => l.split(',').map((s) => s.trim()))
    .filter(([name, mb]) => name && Number(mb))
    .map(([name, mb]) => ({ name, vramGB: Math.round((Number(mb) / 1024) * 10) / 10, vendor: 'NVIDIA' }));
}

// Windows: adapter names from WMI; the 64-bit memory size from the display-class registry keys
// (WMI's AdapterRAM stops at 4 GB).
async function windowsGpus() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$k='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'",
    "Get-ChildItem $k | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.DriverDesc) { '{0}|{1}' -f $p.DriverDesc, $p.'HardwareInformation.qwMemorySize' } }",
  ].join('; ');
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 9000);
  const seen = new Set();
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().split('|'))
    .filter(([name]) => name && !/basic display|remote display|virtual|parsec|meta|idd/i.test(name) && !seen.has(name) && seen.add(name))
    .map(([name, bytes]) => ({ name, vramGB: Number(bytes) ? Math.round((Number(bytes) / GB) * 10) / 10 : null, vendor: vendorOf(name) }));
}

async function macGpus() {
  const out = await run('system_profiler', ['SPDisplaysDataType', '-json'], 9000);
  try {
    return (JSON.parse(out).SPDisplaysDataType || []).map((g) => {
      const vram = String(g.spdisplays_vram || g.spdisplays_vram_shared || '').match(/(\d+)\s*(GB|MB)/i);
      return { name: g.sppci_model || g._name, vramGB: vram ? Number(vram[1]) / (vram[2].toUpperCase() === 'MB' ? 1024 : 1) : null, vendor: vendorOf(g.sppci_model || ''), unified: /apple/i.test(g.sppci_model || g._name || '') };
    });
  } catch {
    return [];
  }
}

async function linuxGpus() {
  const out = await run('lspci', []);
  return out
    .split('\n')
    .filter((l) => /VGA|3D controller|Display controller/i.test(l))
    .map((l) => {
      const name = l.split(':').slice(2).join(':').trim();
      return { name, vramGB: null, vendor: vendorOf(name) };
    });
}

function vendorOf(name) {
  return /nvidia|geforce|rtx|gtx|quadro/i.test(name) ? 'NVIDIA' : /amd|radeon/i.test(name) ? 'AMD' : /intel|iris|uhd/i.test(name) ? 'Intel' : /apple/i.test(name) ? 'Apple' : '';
}

async function gpus() {
  const nv = await nvidia();
  const platform = process.platform === 'win32' ? await windowsGpus() : process.platform === 'darwin' ? await macGpus() : await linuxGpus();
  // nvidia-smi is exact for NVIDIA cards; keep the others from the platform list.
  const list = [...nv, ...platform.filter((g) => !(g.vendor === 'NVIDIA' && nv.length))];
  // A Mac with Apple silicon always has its GPU in the chip, sharing the memory, even when
  // system_profiler didn't answer.
  if (process.platform === 'darwin' && process.arch === 'arm64' && !list.some((g) => g.unified)) list.push({ name: `${os.cpus()[0]?.model?.trim() || 'Apple silicon'} GPU`, vramGB: null, vendor: 'Apple', unified: true });
  return list;
}

/**
 * How much of a Mac's unified memory its GPU may use: macOS lets the GPU wire about two thirds of the
 * memory up to 36 GB, and three quarters above. The rest stays for macOS and the apps (this one too).
 */
function gpuMemoryBudget(ramGB) {
  return Math.round(ramGB * (ramGB > 36 ? 0.75 : 2 / 3) * 10) / 10;
}

/** Recommendations from the scan (and whether the renderer found WebGPU). */
function recommend(hw, { webgpu = null } = {}) {
  const ram = hw.ramGB;
  const dedicated = hw.gpus.filter((g) => g.vendor === 'NVIDIA' || g.vendor === 'AMD' || g.unified);
  const unified = dedicated.some((g) => g.unified);
  const vram = Math.max(0, ...dedicated.map((g) => (g.unified ? gpuMemoryBudget(ram) : g.vramGB || 0)));
  // Unified memory is one pool: models on the GPU take it from macOS and the apps, so the large speech
  // model needs a Mac with 16 GB or more.
  const gpuOk = webgpu !== false && vram >= 4 && (!unified || ram >= 16);
  const out = { vramGB: vram || null, unified, tier: '', stt: {}, brain: {}, notes: [] };
  const gpuWord = unified ? `Your Apple chip (${ram} GB of unified memory, about ${Math.round(vram)} GB of it usable by the graphics)` : `Your graphics card (${Math.round(vram)} GB)`;

  if (gpuOk) out.stt = { engine: 'local', localModel: 'onnx-community/whisper-large-v3-turbo', why: `${gpuWord} runs the large Whisper model fast and accurately.` };
  else if (ram >= 16) out.stt = { engine: 'local', localModel: 'Xenova/whisper-small.en', why: 'No suitable graphics card for the large model; Whisper small runs well on your processor.' };
  else out.stt = { engine: 'local', localModel: 'Xenova/whisper-base.en', why: 'A light speech model keeps voice input quick on this computer.' };

  if (vram >= 20) {
    out.tier = 'high';
    out.brain = { local: 'possible', size: '27–32B', why: `With ${Math.round(vram)} GB of ${unified ? 'unified memory for the graphics' : 'graphics memory'} a 27–32B-parameter local model (e.g. through Ollama or LM Studio) runs well; for the best answers a cloud brain (Claude) is still stronger.` };
  } else if (vram >= 10) {
    out.tier = 'good';
    out.brain = { local: 'possible', size: '12–14B', why: `A 12–14B-parameter local model fits in ${Math.round(vram)} GB; good for quick private tasks. Use Claude (or another cloud provider) as the main brain and the local one as a free backup.` };
  } else if (vram >= 6) {
    out.tier = 'ok';
    out.brain = { local: 'limited', size: '7–8B', why: 'Small 7–8B-parameter local models fit, but tool use and accuracy suffer. A cloud brain is recommended.' };
  } else {
    out.tier = 'basic';
    out.brain = { local: 'no', size: '', why: 'Local models would be slow on this computer. Use a cloud brain: your Claude account, or a free-tier key from Gemini or Groq.' };
  }
  if (ram < 8) out.notes.push(`Only ${ram} GB of memory: keep few other apps open while talking to the assistant.`);
  if (unified) out.notes.push(`On a Mac the processor and the graphics share the same ${ram} GB, so a local model and the speech model take memory from your other apps. Balanced performance (Settings → Interface) unloads them when idle.`);
  if (webgpu === false) out.notes.push('WebGPU is not available, so speech recognition runs on the processor.');
  if (hw.cpuThreads < 4) out.notes.push('A processor with few cores: replies and speech recognition may feel slow.');
  return out;
}

async function scan({ webgpu = null } = {}) {
  const started = Date.now();
  const cpus = os.cpus();
  const hw = {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: cpus[0]?.model?.trim() || 'unknown',
    cpuThreads: cpus.length,
    ramGB: Math.round(os.totalmem() / GB),
    freeRamGB: Math.round((os.freemem() / GB) * 10) / 10,
    gpus: await gpus().catch(() => []),
  };
  if (!hw.gpus.length) {
    const info = await app.getGPUInfo('basic').catch(() => null);
    hw.gpus = (info?.gpuDevice || []).map((d) => ({ name: `GPU ${d.vendorId?.toString(16)}:${d.deviceId?.toString(16)}`, vramGB: null, vendor: { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x8086: 'Intel', 0x106b: 'Apple' }[d.vendorId] || '', unified: d.vendorId === 0x106b }));
  }
  hw.webgpu = webgpu;
  const rec = recommend(hw, { webgpu });
  log.info('hardware scan', { ms: Date.now() - started, cpu: hw.cpu, threads: hw.cpuThreads, ramGB: hw.ramGB, gpus: hw.gpus.map((g) => `${g.name}${g.vramGB ? ` ${g.vramGB}GB` : ''}`).join('; '), tier: rec.tier });
  return { hardware: hw, recommendations: rec };
}

module.exports = { scan, recommend, gpuMemoryBudget };
