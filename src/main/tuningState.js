import { ipcMain } from 'electron';
import { DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K } from '../shared/analyze/probable/config.js';

function buildDefaults() {
  return {
    maxProbeStartsPerRange: DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K.maxProbeStartsPerRange | 0,
    minChunkBytes: DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K.minChunkBytes | 0,
    minShortChunkBytes: DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K.minShortChunkBytes | 0,
    shortChunkMinScore: DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K.shortChunkMinScore | 0,
    requireGoodTerminatorForShortChunks: !!DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K.requireGoodTerminatorForShortChunks
  };
}

const defaultTuning = buildDefaults();
let currentTuning = { ...defaultTuning };
const listeners = new Set();

function sanitizePatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if (patch.maxProbeStartsPerRange != null) out.maxProbeStartsPerRange = Math.max(1, patch.maxProbeStartsPerRange | 0);
  if (patch.minChunkBytes != null) out.minChunkBytes = Math.max(1, patch.minChunkBytes | 0);
  if (patch.minShortChunkBytes != null) out.minShortChunkBytes = Math.max(1, patch.minShortChunkBytes | 0);
  if (patch.shortChunkMinScore != null) out.shortChunkMinScore = Math.max(0, patch.shortChunkMinScore | 0);
  if (patch.requireGoodTerminatorForShortChunks != null) out.requireGoodTerminatorForShortChunks = !!patch.requireGoodTerminatorForShortChunks;
  return out;
}

function broadcast() {
  const payload = { tuning: getTuningState() };
  for (const fn of listeners) {
    try { fn(payload); } catch {}
  }
}

export function setTuningUpdateListener(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getTuningState() {
  return { ...currentTuning };
}

export function getTuningDefaults() {
  return { ...defaultTuning };
}

export function applyTuningPatch(patch) {
  currentTuning = { ...currentTuning, ...sanitizePatch(patch) };
  broadcast();
  return getTuningState();
}

export function resetTuningState() {
  currentTuning = { ...defaultTuning };
  broadcast();
  return getTuningState();
}

export function registerTuningIpc() {
  ipcMain.handle('nesviz:getTuningState', async () => ({ ok: true, tuning: getTuningState(), defaults: getTuningDefaults() }));
  ipcMain.handle('nesviz:setTuningState', async (_evt, payload) => ({ ok: true, tuning: applyTuningPatch(payload?.patch || null) }));
  ipcMain.handle('nesviz:resetTuningState', async () => ({ ok: true, tuning: resetTuningState(), defaults: getTuningDefaults() }));
}
