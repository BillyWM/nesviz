import { ipcMain } from 'electron';

import { buildMemoryMapDataForState } from './memoryMapData.js';

export function registerMemoryMapIpc({ getActiveState } = {}) {
  ipcMain.handle('nesviz:getMemoryMapData', async () => {
    const s = typeof getActiveState === 'function' ? getActiveState() : null;
    return buildMemoryMapDataForState(s);
  });
}
