import { ipcMain } from 'electron';

import { extractArtifacts } from '../shared/artifacts/extractArtifacts.js';
import {
  getBookmarksForRom,
  setBookmarkForRom,
  getRomOffsetLabelsForRom,
  setRomOffsetLabelForRom,
  getCpuAddressLabelsForRom,
  setCpuAddressLabelForRom
} from './userDataStore.js';

function getActiveRom(active) {
  if (!active?.romHash) return null;
  return active;
}

function normalizeNonNegativeNumber(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n >>> 0;
}

function requireActiveRom(getActiveState) {
  const active = typeof getActiveState === 'function' ? getActiveState() : null;
  const rom = getActiveRom(active);
  if (!rom) return null;
  return rom;
}

export function registerRomFeaturesIpc({ getActiveState } = {}) {
  ipcMain.handle('nesviz:getArtifacts', async () => {
    const active = typeof getActiveState === 'function' ? getActiveState() : null;
    if (!active?.rawAnalysis && !active?.displayAnalysis) {
      return { ok: false, error: 'No analysis loaded' };
    }

    return extractArtifacts({
      rawAnalysis: active.rawAnalysis || null,
      displayAnalysis: active.displayAnalysis || null
    });
  });

  ipcMain.handle('nesviz:getActiveLabels', async () => {
    const active = typeof getActiveState === 'function' ? getActiveState() : null;
    const rom = getActiveRom(active);
    if (!rom) {
      return { ok: true, hasRom: false, bookmarks: [], labels: {}, addrLabels: {} };
    }

    const romId = rom.romHash;
    const bookmarks = await getBookmarksForRom(romId);
    const labels = await getRomOffsetLabelsForRom(romId);
    const addrLabels = await getCpuAddressLabelsForRom(romId);
    return { ok: true, hasRom: true, bookmarks, labels, addrLabels };
  });

  ipcMain.handle('nesviz:setBookmarkAtRomOff', async (_evt, { romOff, set } = {}) => {
    const rom = requireActiveRom(getActiveState);
    if (!rom) return { ok: false, error: 'Load a ROM first.' };

    const off = normalizeNonNegativeNumber(romOff);
    if (off === null) return { ok: false, error: 'Invalid romOff' };

    const romId = rom.romHash;
    const bookmarks = await setBookmarkForRom(romId, off, set === true);
    return { ok: true, bookmarks };
  });

  ipcMain.handle('nesviz:setRomLabel', async (_evt, { romOff, label } = {}) => {
    const rom = requireActiveRom(getActiveState);
    if (!rom) return { ok: false, error: 'Load a ROM first.' };

    const off = normalizeNonNegativeNumber(romOff);
    if (off === null) return { ok: false, error: 'Invalid romOff' };

    const romId = rom.romHash;
    const labels = await setRomOffsetLabelForRom(romId, off, label);
    return { ok: true, labels };
  });

  ipcMain.handle('nesviz:setAddrLabel', async (_evt, { cpuAddr, label } = {}) => {
    const rom = requireActiveRom(getActiveState);
    if (!rom) return { ok: false, error: 'Load a ROM first.' };

    const addr = normalizeNonNegativeNumber(cpuAddr);
    if (addr === null) return { ok: false, error: 'Invalid cpuAddr' };

    const romId = rom.romHash;
    const addrLabels = await setCpuAddressLabelForRom(romId, addr, label);
    return { ok: true, addrLabels };
  });
}
