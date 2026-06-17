import { dialog, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { parseInes, readVectorsFromLastPrgBank } from '../../shared/rom/ines.js';
import { updateRecentRoms } from '../menu.js';
import { notifyAnalysisDataChanged } from '../analysisDataEvents.js';
import { receiveAnalysisProgressMessage, resetAnalysisLogProgressState } from '../analysisLogWindow.js';
import { hasAnalysisCache, loadAnalysisCache, saveAnalysisCache } from '../analysisCache.js';
import { recordRecentRomPath, getRecentRomPaths } from '../userDataStore.js';
import { requireArray, requireDisplayBlock, requireObject } from '../../shared/analyze/dataShape.js';
import { ANALYSIS_ENGINE_ID } from '../../shared/analyze/analysisConstants.js';
import { cancelActiveAnalysisExecution, executeAnalysis } from './executeAnalysis.js';
import { createDefaultAnalysisPlan } from './analysisPlan.js';
import { buildBlocksIndex } from '../codeView/codeViewHelpers.js';

let active = null;

function clearActiveAnalysisState(s) {
  if (!s) return;
  s.rawAnalysis = null;
  s.displayAnalysis = null;
  s.rawToDisplayBlockIds = null;
  s.blockById = null;
  s.heatmapCache = null;
}

function applyAnalysisResultToActiveState(s, result) {
  if (!s) throw new Error('No active ROM');
  requireObject(result, 'analysis result');
  const rawAnalysis = requireObject(result.rawAnalysis, 'analysis result.rawAnalysis');
  const displayAnalysis = requireObject(result.displayAnalysis, 'analysis result.displayAnalysis');
  const rawToDisplayBlockIds = requireObject(result.rawToDisplayBlockIds, 'analysis result.rawToDisplayBlockIds');
  const displayBlocks = requireArray(displayAnalysis.blocks, 'displayAnalysis.blocks');
  const explicitDisplayBlocks = requireArray(displayAnalysis.displayBlocks, 'displayAnalysis.displayBlocks');
  if (displayBlocks.length !== explicitDisplayBlocks.length) {
    throw new Error('displayAnalysis.blocks and displayAnalysis.displayBlocks must describe the same display blocks');
  }

  const blockById = new Map();
  for (let i = 0; i < displayBlocks.length; i += 1) {
    const block = requireDisplayBlock(displayBlocks[i], `displayAnalysis.blocks[${i}]`);
    if (explicitDisplayBlocks[i] !== block) {
      requireDisplayBlock(explicitDisplayBlocks[i], `displayAnalysis.displayBlocks[${i}]`);
      if (explicitDisplayBlocks[i].id !== block.id) {
        throw new Error('displayAnalysis.blocks and displayAnalysis.displayBlocks are out of sync');
      }
    }
    if (blockById.has(block.id)) throw new Error(`Duplicate display block id ${block.id}`);
    blockById.set(block.id, block);
  }

  s.rawAnalysis = rawAnalysis;
  s.displayAnalysis = displayAnalysis;
  s.rawToDisplayBlockIds = rawToDisplayBlockIds;
  s.blockById = blockById;
  s.heatmapCache = null;
}

function applyAnalysisDisplayUpdateToActiveState(s, update) {
  if (!s) throw new Error('No active ROM');
  requireObject(update, 'analysis display update');
  if (update.kind !== 'displaySnapshot') return false;
  applyAnalysisResultToActiveState(s, {
    rawAnalysis: requireObject(update.rawAnalysis, 'displaySnapshot.rawAnalysis'),
    displayAnalysis: requireObject(update.displayAnalysis, 'displaySnapshot.displayAnalysis'),
    rawToDisplayBlockIds: requireObject(update.rawToDisplayBlockIds, 'displaySnapshot.rawToDisplayBlockIds')
  });
  return true;
}

async function resolveStartupRomPath() {
  const recent = await getRecentRomPaths();
  for (const filepath of recent) {
    if (!filepath || typeof filepath !== 'string') continue;
    try {
      await fs.access(filepath);
      return filepath;
    } catch {}
  }
  return null;
}

async function openRomFromPath(filepath) {
  const buf = await fs.readFile(filepath);
  const ines = parseInes(buf);
  const vectors = readVectorsFromLastPrgBank(ines);
  const romHash = crypto.createHash('sha1').update(buf).digest('hex');

  await cancelActiveAnalysisExecution();

  active = {
    filepath,
    filename: path.basename(filepath),
    romHash,
    ines,
    vectors,
    rawAnalysis: null,
    displayAnalysis: null,
    rawToDisplayBlockIds: null,
    blockById: null,
    heatmapCache: null
  };

  let hasCachedAnalysis = false;
  try { hasCachedAnalysis = await hasAnalysisCache(romHash); } catch {}

  try {
    const recentRoms = await recordRecentRomPath(filepath, 10);
    updateRecentRoms(recentRoms);
  } catch {}

  try { notifyAnalysisDataChanged(); } catch {}

  return {
    ok: true,
    romHash,
    rom: {
      filename: path.basename(filepath),
      mapperNumber: ines.mapperNumber,
      prgSize: ines.prg.length,
      chrSize: ines.chr.length
    },
    vectors,
    hasCachedAnalysis
  };
}

export function registerAnalysisIpc() {
  ipcMain.handle('nesviz:openRom', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open NES ROM',
      properties: ['openFile'],
      filters: [
        { name: 'NES ROM', extensions: ['nes'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };
    return openRomFromPath(result.filePaths[0]);
  });

  ipcMain.handle('nesviz:openRomPath', async (_evt, { filepath }) => {
    if (!filepath) return { ok: false, error: 'No filepath provided' };
    return openRomFromPath(filepath);
  });

  ipcMain.handle('nesviz:getStartupRomPath', async () => ({ ok: true, filepath: await resolveStartupRomPath() }));

  ipcMain.handle('nesviz:loadActiveAnalysisCache', async () => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };
    if (!s.romHash) return { ok: false, error: 'No ROM hash for the active ROM' };

    let cachedResult;
    try {
      cachedResult = await loadAnalysisCache(s.romHash);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        clearActiveAnalysisState(s);
        try { notifyAnalysisDataChanged(); } catch {}
        return { ok: true, hasCachedAnalysis: false };
      }
      return { ok: false, error: `Cached analysis load failed: ${err?.message || String(err)}` };
    }

    if (cachedResult?.rawAnalysis?.engine !== ANALYSIS_ENGINE_ID && cachedResult?.displayAnalysis?.engine !== ANALYSIS_ENGINE_ID) {
      clearActiveAnalysisState(s);
      try { notifyAnalysisDataChanged(); } catch {}
      return { ok: true, hasCachedAnalysis: false };
    }

    try {
      applyAnalysisResultToActiveState(s, cachedResult);
    } catch (err) {
      return { ok: false, error: `Cached analysis was invalid: ${err?.message || String(err)}` };
    }

    try { notifyAnalysisDataChanged(); } catch {}
    return { ok: true, hasCachedAnalysis: true, stats: requireObject(s.displayAnalysis.stats, 'displayAnalysis.stats') };
  });

  ipcMain.handle('nesviz:runStaticAnalysis', async (evt) => {
    const s = active;
    if (!s) return { ok: false, error: 'Load a ROM first.' };

    const resetProgressMessage = resetAnalysisLogProgressState();
    try { evt.sender.send('nesviz:vsaProgress', resetProgressMessage); } catch {}

    let workerResult;
    try {
      workerResult = await executeAnalysis({
        prgBytes: s.ines.prg,
        vectors: s.vectors,
        mapperKind: s.ines.analysisMapper?.mapperFamily || null,
        mapperMeta: s.ines.analysisMapper || null,
        analysisPlan: createDefaultAnalysisPlan()
      }, {
        onProgress: (progress) => {
          const message = receiveAnalysisProgressMessage(progress || {});
          try { evt.sender.send('nesviz:vsaProgress', message || {}); } catch {}
        },
        onUiUpdate: (update) => {
          if (active !== s) return;
          try {
            const applied = applyAnalysisDisplayUpdateToActiveState(s, update);
            if (!applied) return;
            try {
              evt.sender.send('nesviz:analysisDisplayUpdated', {
                kind: update.kind,
                stage: update.stage || null,
                complete: update.complete === true,
                coalesceRunIndex: Number.isFinite(update.coalesceRunIndex) ? (update.coalesceRunIndex | 0) : null,
                timeline: requireArray(s.displayAnalysis?.timeline, 'displayAnalysis.timeline'),
                blocksIndex: buildBlocksIndex(requireObject(s.displayAnalysis, 'displayAnalysis')),
                mapper: requireObject(s.displayAnalysis?.mapper, 'displayAnalysis.mapper'),
                stats: requireObject(s.displayAnalysis?.stats, 'displayAnalysis.stats'),
                debug: null,
                vectorDestinationsByFamily: requireObject(
                  s.displayAnalysis?.vectorDestinationsByFamily,
                  'displayAnalysis.vectorDestinationsByFamily'
                ),
                rawToDisplayBlockIds: requireObject(s.rawToDisplayBlockIds, 'rawToDisplayBlockIds')
              });
            } catch {}
          } catch (err) {
            console.warn('Analysis display update failed:', err);
          }
        }
      });
    } catch (err) {
      return { ok: false, error: `Static analysis failed: ${err?.message || String(err)}` };
    }

    if (!workerResult?.ok) {
      if (workerResult?.stack) console.error('Analysis worker stack:', workerResult.stack);
      return { ok: false, error: workerResult?.error || 'Static analysis failed' };
    }

    if (active !== s) return { ok: false, error: 'ROM changed during analysis' };
    applyAnalysisResultToActiveState(s, workerResult);

    try {
      await saveAnalysisCache(s.romHash, {
        rawAnalysis: s.rawAnalysis,
        displayAnalysis: s.displayAnalysis,
        rawToDisplayBlockIds: s.rawToDisplayBlockIds
      });
    } catch (err) {
      console.warn('Analysis cache save failed:', err);
    }

    try { notifyAnalysisDataChanged(); } catch {}
    return { ok: true, stats: s.displayAnalysis.stats };
  });

}

export function getActiveAnalysisState() {
  return active;
}

export function getActiveRomSummary() {
  const s = active;
  if (!s) return null;
  const ines = s.ines;
  return {
    filepath: s.filepath,
    filename: s.filename,
    romHash: s.romHash,
    ines: ines
      ? {
          format: ines.format,
          mapperNumber: ines.mapperNumber,
          prgSize: ines.prgSize,
          chrSize: ines.chrSize,
          mirroring: ines.mirroring,
          hasTrainer: !!ines.hasTrainer,
          hasBattery: !!ines.hasBattery,
          fourScreen: !!ines.fourScreen
        }
      : null
  };
}
