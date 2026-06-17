import { ipcMain } from 'electron';

import { requireArray, requireObject, requireString } from '../../shared/analyze/dataShape.js';
import { buildAbstractInterpretationBlockDebug } from '../../shared/analyze/debug/abstractInterpretationBlockDebug.js';
import { createMapperModel } from '../../shared/analyze/mapper/createMapperModel.js';
import {
  buildBlocksIndex,
  getDisplayBlock,
  getDisplayBlocks,
  requireCodeViewState,
  serializeCodeBlock
} from './codeViewHelpers.js';

function getState(getActiveState) {
  return typeof getActiveState === 'function' ? getActiveState() : null;
}

function createActiveMapper(state) {
  const rawAnalysis = requireObject(state.rawAnalysis, 'rawAnalysis');
  const mapperInfo = requireObject(rawAnalysis.mapper, 'rawAnalysis.mapper');
  const mapperMeta = requireObject(mapperInfo.meta || state.ines?.analysisMapper, 'active mapper metadata');
  const prgBytes = state.ines?.prg || rawAnalysis.prgBytes;
  if (!(prgBytes instanceof Uint8Array)) throw new Error('Active PRG bytes are missing');
  return createMapperModel({ prgBytes, mapperMeta });
}

export function registerCodeViewIpc({ getActiveState } = {}) {
  ipcMain.handle('nesviz:getTimeline', async () => {
    const state = requireCodeViewState(getState(getActiveState));
    if (!state) return { ok: false, error: 'No analysis loaded' };
    const { displayAnalysis } = state;
    return {
      ok: true,
      timeline: requireArray(displayAnalysis.timeline, 'displayAnalysis.timeline'),
      blocksIndex: buildBlocksIndex(displayAnalysis),
      mapper: requireObject(displayAnalysis.mapper, 'displayAnalysis.mapper'),
      stats: requireObject(displayAnalysis.stats, 'displayAnalysis.stats'),
      debug: null,
      vectorDestinationsByFamily: requireObject(displayAnalysis.vectorDestinationsByFamily, 'displayAnalysis.vectorDestinationsByFamily')
    };
  });

  ipcMain.handle('nesviz:getBlock', async (_evt, { blockId }) => {
    const state = requireCodeViewState(getState(getActiveState));
    if (!state) return { ok: false, error: 'No analysis loaded' };
    requireString(blockId, 'blockId');
    const block = getDisplayBlock(state, blockId);
    if (!block) return { ok: false, error: 'Display block not found' };
    return { ok: true, block: serializeCodeBlock(block) };
  });

  ipcMain.handle('nesviz:getBlocks', async (_evt, { blockIds }) => {
    const state = requireCodeViewState(getState(getActiveState));
    if (!state) return { ok: false, error: 'No analysis loaded' };
    const { blocks, missing } = getDisplayBlocks(state, blockIds);
    return { ok: true, blocks: blocks.map(serializeCodeBlock), missing };
  });



  ipcMain.handle('nesviz:getBlockAnalysisDebug', async (_evt, { blockId }) => {
    const active = getState(getActiveState);
    const state = requireCodeViewState(active);
    if (!state) return { ok: false, error: 'No analysis loaded' };
    requireString(blockId, 'blockId');
    const rawAnalysis = requireObject(active.rawAnalysis, 'rawAnalysis');
    if (!rawAnalysis.abstractInterpretation) return { ok: false, error: 'No abstract interpretation data found' };
    const block = getDisplayBlock(state, blockId);
    if (!block) return { ok: false, error: 'Display block not found' };
    try {
      const debug = buildAbstractInterpretationBlockDebug({
        rawAnalysis,
        displayBlock: block,
        mapper: createActiveMapper(active),
        prgBytes: active.ines?.prg
      });
      return { ok: true, debug };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('nesviz:getPrgBytes', async (_evt, { romStart, romEnd }) => {
    const state = getState(getActiveState);
    if (!state?.ines?.prg) return { ok: false, error: 'No ROM loaded' };
    const start = Number(romStart);
    const end = Number(romEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false, error: 'Invalid range' };
    const a = Math.max(0, Math.min(state.ines.prg.length, start | 0));
    const b = Math.max(a, Math.min(state.ines.prg.length, end | 0));
    return { ok: true, romStart: a, romEnd: b, bytes: Array.from(state.ines.prg.subarray(a, b)) };
  });
}
