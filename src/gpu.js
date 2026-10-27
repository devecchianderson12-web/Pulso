// Picks the graphics mode that renders Pulso smoothest on this PC, before the app is ready.
// Forcing GPU flags hurts on many drivers, so Pulso starts with Chromium's defaults and, the
// first time, measures real fps and tries other modes until one is smooth. The choice is saved.
const { app, screen } = require('electron');
const settings = require('./settings');

const MODES = [
  { id: 'auto', label: 'Automático' },                                    // Chromium defaults
  { id: 'low', label: 'GPU integrada', sw: ['force_low_power_gpu'] },
  { id: 'gl', label: 'OpenGL', sw: ['use-angle', 'gl'] },
  { id: 'high', label: 'GPU dedicada', sw: ['force_high_performance_gpu'] },
  { id: 'soft', label: 'Sin GPU', soft: true },                           // last resort
];
// Bump to measure again on every install (e.g. after changing the switches below).
// 2: software-emulated GPUs now count as failed, so PCs tuned with 1.3.0 measure again.
const TUNE_VERSION = 2;

let tune;
let mode;

// Highest fps among GPU modes with at least 20 fps; "soft" only if none works.
// Without a GPU the frame clock isn't tied to the monitor, so its fps can't be compared.
function bestMode(tried) {
  const gpu = Object.entries(tried).filter(([m, f]) => m !== 'soft' && f >= 20).sort((a, b) => b[1] - a[1]);
  if (gpu.length) return gpu[0][0];
  return tried.soft > 0 ? 'soft' : 'auto';
}

function save() {
  settings.set('gpu', { mode: mode.id, tune, version: TUNE_VERSION });
}

function setup() {
  const stored = settings.get('gpu') || {};
  tune = stored.version === TUNE_VERSION && stored.tune ? stored.tune : { done: false, tried: {} };
  let id = stored.version === TUNE_VERSION && MODES.some((m) => m.id === stored.mode) ? stored.mode : 'auto';
  // 'pending' is set when a mode under test starts and cleared once the window loads.
  // Still set for the same mode means the previous launch hung or crashed: that mode fails.
  if (tune.pending && tune.pendingMode === id) {
    tune.tried[id] = 0;
    const next = MODES.find((m) => !(m.id in tune.tried));
    if (next) id = next.id;
    else { id = bestMode(tune.tried); tune.done = true; }
  }
  mode = MODES.find((m) => m.id === id);
  software = mode.soft || (stored.mode === id && settings.get('gpuSoftware') === true);
  tune.pending = !tune.done;
  tune.pendingMode = tune.done ? undefined : id;
  save();

  if (mode.soft) {
    app.disableHardwareAcceleration();
  } else {
    if (mode.sw) app.commandLine.appendSwitch(...mode.sw);
    // Draw on the GPU inside the main process. As a separate process, NVIDIA's driver treats it
    // as a background app and caps it (20 fps) when "background application max frame rate" is on.
    app.commandLine.appendSwitch('in-process-gpu');
  }
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

function loaded() {
  if (tune.pending) {
    tune.pending = false;
    delete tune.pendingMode;
    save();
  }
}

function relaunch() {
  const args = process.argv.slice(1).filter((a) => a !== '--hidden');
  const exe = process.env.PORTABLE_EXECUTABLE_FILE; // portable: the real .exe, not the temp folder
  app.relaunch(exe ? { execPath: exe, args } : { args });
  setTimeout(() => app.exit(0), 150);
}

// Called with the fps measured by the window. Returns what happens next.
function report(fps, beforeRelaunch) {
  if (tune.done || !Number.isFinite(fps)) return { action: 'none' };
  // A GPU mode that ends up drawing in software is worse than the real software mode: it
  // pays for the GPU process and emulation on top. Count it as failed.
  tune.tried[mode.id] = software && !mode.soft ? 0 : Math.round(fps);
  const next = MODES.find((m) => !(m.id in tune.tried));
  // "Smooth enough" = 85 % of the monitor refresh rate, capped at 52 fps.
  let hz = 60;
  try { hz = screen.getPrimaryDisplay().displayFrequency || 60; } catch { /* keep 60 */ }
  const enough = Math.min(52, hz * 0.85);
  const gpuWorks = Object.entries(tune.tried).some(([m, f]) => m !== 'soft' && f >= 20);
  if ((fps >= enough && !mode.soft) || !next || (next.id === 'soft' && gpuWorks)) {
    const best = bestMode(tune.tried);
    tune.done = true;
    if (best !== mode.id) {
      mode = MODES.find((m) => m.id === best);
      save();
      beforeRelaunch();
      relaunch();
      return { action: 'restart', mode: best };
    }
    save();
    return { action: 'done', mode: mode.id, fps };
  }
  mode = next;
  save();
  beforeRelaunch();
  relaunch();
  return { action: 'restart', mode: next.id };
}

function retune(beforeRelaunch) {
  tune = { done: false, tried: {} };
  mode = MODES[0];
  save();
  beforeRelaunch();
  relaunch();
}

// True when this mode draws with the CPU: software compositing, or a "GPU" that is really a
// software emulation (SwiftShader, Microsoft Basic Render Driver).
// Until detection runs, the previous launch's result is used. Call it once a page has painted:
// before the GPU starts, the feature status reads "disabled" even on a working GPU.
let software = false;
async function detectSoftware() {
  if (mode.soft) {
    software = true;
  } else {
    try {
      const status = app.getGPUFeatureStatus();
      const info = await app.getGPUInfo('basic');
      const active = (info.gpuDevice || []).find((d) => d.active);
      const emulated = Boolean(active) && (active.vendorId === 0x1ae0 ||
        (active.vendorId === 0x1414 && active.deviceId === 0x8c) ||
        /swiftshader|basic render/i.test(active.deviceString || ''));
      software = emulated || /^disabled/.test(status.gpu_compositing);
    } catch {
      // Keep the previous value.
    }
  }
  settings.set('gpuSoftware', software);
  return software;
}

function state() {
  return { done: tune.done, mode: mode.id, label: mode.label, fps: tune.tried[mode.id], software };
}

module.exports = { setup, loaded, report, retune, state, detectSoftware };
