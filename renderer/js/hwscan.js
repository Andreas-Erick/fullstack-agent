// Hardware scan (optional, local): what this computer has and what that means for the speech model
// and the brain. Shared by the setup wizard and Settings → Health.
import { api, el, toast, toastError } from './util.js';
import { state, saveSettings } from './state.js';

async function hasWebGpu() {
  try {
    return Boolean(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

/** Runs the scan and renders the results (with Apply buttons) into box. */
export async function scanInto(box) {
  box.innerHTML = '';
  box.append(el('div', { class: 'muted' }, 'Scanning this computer… (processor, memory, graphics card; nothing leaves this computer)'));
  try {
    const { hardware: hw, recommendations: rec } = await api.hardware.scan({ webgpu: await hasWebGpu() });
    box.innerHTML = '';
    const gpus = hw.gpus.length ? hw.gpus.map((g) => `${g.name}${g.vramGB ? ` · ${g.vramGB} GB` : ''}${g.unified ? ' (shared memory)' : ''}`).join('\n') : 'none found';
    box.append(
      el(
        'div',
        { class: 'hw-grid' },
        el('b', {}, 'Processor'), el('span', {}, `${hw.cpu} (${hw.cpuThreads} threads)`),
        el('b', {}, 'Memory'), el('span', {}, `${hw.ramGB} GB (${hw.freeRamGB} GB free)`),
        el('b', {}, 'Graphics'), el('span', { style: { whiteSpace: 'pre-line' } }, gpus),
        el('b', {}, 'WebGPU'), el('span', {}, hw.webgpu ? 'available (fast local speech recognition)' : 'not available'),
      ),
    );
    const sttLabel = rec.stt.localModel.split('/').pop();
    const current = state.settings.stt.localModel === rec.stt.localModel && state.settings.stt.engine === 'local';
    const apply = el('button', {
      class: 'btn small',
      disabled: current,
      onclick: async () => {
        await saveSettings({ stt: { engine: 'local', localModel: rec.stt.localModel } });
        apply.disabled = true;
        apply.textContent = '✓ Applied';
        toast(`Speech model set to ${sttLabel}. It downloads the first time you talk.`);
      },
    }, current ? '✓ In use' : 'Apply');
    box.append(
      el('div', { class: 'rec' }, el('span', {}, el('b', {}, `Speech recognition: ${sttLabel}. `), rec.stt.why), apply),
      el('div', { class: 'rec' }, el('span', {}, el('b', {}, rec.brain.local === 'no' ? 'Brain: use a cloud provider. ' : `Brain: a local ${rec.brain.size} model is ${rec.brain.local === 'possible' ? 'possible' : 'possible but limited'}. `), rec.brain.why)),
      ...rec.notes.map((n) => el('div', { class: 'rec note' }, n)),
    );
    return { hw, rec };
  } catch (err) {
    box.innerHTML = '';
    box.append(el('div', { class: 'test-result err' }, `Scan failed: ${err.message}`));
    toastError(err);
    return null;
  }
}
