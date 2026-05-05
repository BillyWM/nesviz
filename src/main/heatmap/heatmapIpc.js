import { ipcMain } from 'electron';

import { buildHeatmapDataForState } from './heatmapData.js';

export function registerHeatmapIpc({ getActiveState } = {}) {
  ipcMain.handle('nesviz:getHeatmapData', async () => {
    const s = typeof getActiveState === 'function' ? getActiveState() : null;
    return buildHeatmapDataForState(s);
  });
}
