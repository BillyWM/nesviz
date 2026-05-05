import { ipcMain } from 'electron';
import { listAnalysisCacheFiles, loadAnalysisCacheFromPath } from '../analysisCache.js';
import { saveMarkovModel, saveCombinedCodeProfile } from './markovStore.js';
import { buildMarkovMapDataForState } from './markovMapData.js';
import {
  trainOpcodeMarkovModelFromBlocks,
  trainMnemonicMarkovModelFromBlocks,
  trainAddressingMarkovModelFromBlocks
} from '../../shared/analyze/markov/opcodeTrainer.js';
import { trainCombinedCodeProfileFromBlocks } from '../../shared/analyze/markov/opcodeProfile.js';

function normalizeSource(source) {
  return source === 'probablePlus' ? 'probablePlus' : 'confirmed';
}

function extractTrainingBlocks(payload) {
  if (!payload || typeof payload !== 'object') return [];
  return Array.isArray(payload.rawAnalysis?.blocks) ? payload.rawAnalysis.blocks : [];
}

export function registerMarkovIpc({ getActiveState } = {}) {
  ipcMain.handle('nesviz:markovTrainOpcodeModel', async (_evt, payload) => {
    const source = normalizeSource(payload?.source);
    const cacheFiles = await listAnalysisCacheFiles();
    if (!cacheFiles.length) {
      return { ok: false, error: 'No cached analyses found.' };
    }

    let usedAnalysisCount = 0;
    const allBlocks = [];

    for (const filePath of cacheFiles) {
      try {
        const cached = await loadAnalysisCacheFromPath(filePath);
        const blocks = extractTrainingBlocks(cached);
        if (!blocks.length) continue;
        usedAnalysisCount += 1;
        for (const block of blocks) allBlocks.push(block);
      } catch {
        // Ignore unreadable cache entries so one bad cache does not break training.
      }
    }

    if (!allBlocks.length) {
      return { ok: false, error: 'Cached analyses did not contain usable blocks.' };
    }

    const opcodeModel = trainOpcodeMarkovModelFromBlocks(allBlocks, { source });
    const addressingModel = trainAddressingMarkovModelFromBlocks(allBlocks, { source });
    const mnemonicModel = trainMnemonicMarkovModelFromBlocks(allBlocks, { source });

    const usedBlockCount = opcodeModel?.stats?.usedBlockCount || 0;
    const usedInstructionCount = opcodeModel?.stats?.usedInstructionCount || 0;
    if (!usedInstructionCount) {
      return { ok: false, error: 'No matching Markov sequences were found in cached analyses.' };
    }

    const modelsByFamily = {
      opcode: opcodeModel,
      addressing: addressingModel,
      mnemonic: mnemonicModel
    };

    const modelPaths = {
      opcode: await saveMarkovModel(opcodeModel, source, 'opcode'),
      addressing: await saveMarkovModel(addressingModel, source, 'addressing'),
      mnemonic: await saveMarkovModel(mnemonicModel, source, 'mnemonic')
    };

    const profile = trainCombinedCodeProfileFromBlocks(allBlocks, modelsByFamily, { source });
    const profilePath = await saveCombinedCodeProfile(profile, source);

    return {
      ok: true,
      source,
      cacheCount: cacheFiles.length,
      usedAnalysisCount,
      usedBlockCount,
      usedInstructionCount,
      sequenceCounts: {
        opcode: opcodeModel?.stats?.sequenceCount || 0,
        addressing: addressingModel?.stats?.sequenceCount || 0,
        mnemonic: mnemonicModel?.stats?.sequenceCount || 0
      },
      modelPaths,
      profilePath,
      profileSampleCount: profile?.stats?.sampleCount || 0
    };
  });

  ipcMain.handle('nesviz:getMarkovMapData', async (_evt, payload) => {
    const activeState = typeof getActiveState === 'function' ? getActiveState() : null;
    return buildMarkovMapDataForState(activeState, payload || null);
  });

}
