import { ipcMain } from 'electron';

import { buildGraphData } from './buildGraphData.js';
import { loadGraphLayoutCache, saveGraphLayoutCache } from '../graphLayoutCache.js';

export function registerGraphIpc({ getActiveState } = {}) {
  ipcMain.handle('nesviz:getGraphData', async () => {
    const s = typeof getActiveState === 'function' ? getActiveState() : null;
    if (!s?.ines) {
      return {
        ok: true,
        hasRom: false,
        hasAnalysis: false,
        nodes: [],
        edges: [],
        rom: null,
        mapper: null,
        stats: null
      };
    }

    const graph = buildGraphData({
      rawAnalysis: s.rawAnalysis,
      displayAnalysis: s.displayAnalysis,
      rawToDisplayBlockIds: s.rawToDisplayBlockIds
    });

    return {
      ...graph,
      hasRom: true,
      rom: {
        filename: s.filename,
        mapperNumber: s.ines.mapperNumber,
        prgSize: s.ines.prg.length
      },
      mapper: s.displayAnalysis?.mapper || { kind: null, meta: s.ines.analysisMapper || null },
      stats: s.displayAnalysis?.stats || null
    };
  });

  ipcMain.handle('nesviz:getGraphLayoutCache', async () => {
    const s = typeof getActiveState === 'function' ? getActiveState() : null;
    if (!s?.romHash) return { ok: true, hasCache: false };
    try {
      const layout = await loadGraphLayoutCache(s.romHash);
      return { ok: true, hasCache: true, layout };
    } catch (err) {
      if (err?.code === 'ENOENT') return { ok: true, hasCache: false };
      console.warn('Graph layout cache load failed:', err);
      return { ok: false, error: `Graph layout cache load failed: ${err?.message || String(err)}` };
    }
  });

  ipcMain.handle('nesviz:saveGraphLayoutCache', async (_evt, payload) => {
    const s = typeof getActiveState === 'function' ? getActiveState() : null;
    if (!s?.romHash) return { ok: false, error: 'No active ROM' };
    try {
      const filePath = await saveGraphLayoutCache(s.romHash, payload || null);
      return { ok: true, filePath };
    } catch (err) {
      console.warn('Graph layout cache save failed:', err);
      return { ok: false, error: `Graph layout cache save failed: ${err?.message || String(err)}` };
    }
  });
}
