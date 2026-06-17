import { ANALYSIS_PHASE_IDS } from '../analysisConstants.js';
import { decodeInstructionAtSite } from '../cfg/decode.js';
import { makeEdgeId } from '../identity.js';
import {
  requireArray,
  requireInteger,
  requireObject,
  requireString
} from '../dataShape.js';

function makePhaseSummary(counters) {
  return {
    name: ANALYSIS_PHASE_IDS.EXPAND_CFG,
    status: 'complete',
    counters: { ...counters }
  };
}

function indexBy(items, keyName, label) {
  const out = new Map();
  for (const item of requireArray(items, label)) {
    requireObject(item, `${label} item`);
    const key = requireString(item[keyName], `${label} item.${keyName}`);
    if (out.has(key)) throw new Error(`Duplicate ${label} ${key}`);
    out.set(key, item);
  }
  return out;
}

function requireSite(site, label) {
  requireObject(site, label);
  requireString(site.siteKey, `${label}.siteKey`);
  requireString(site.contextKey, `${label}.contextKey`);
  requireInteger(site.cpuAddr, `${label}.cpuAddr`);
  requireInteger(site.romOff, `${label}.romOff`);
  requireObject(site.mapperContext, `${label}.mapperContext`);
  return site;
}

function blockContainsInstruction(block, instructionId) {
  return Array.isArray(block?.instructionIds)
    && block.instructionIds.some((id) => (Number(id) >>> 0) === (Number(instructionId) >>> 0));
}

function existingEdge(context, edgeId) {
  return requireArray(context.edges, 'expandCfg context.edges').some((edge) => edge && edge.edgeId === edgeId) ||
    requireArray(context.syntheticEdges || [], 'expandCfg context.syntheticEdges').some((edge) => edge && edge.edgeId === edgeId);
}

function createSeed(frontier) {
  const target = requireSite(frontier.target, 'expandCfg frontier.target');
  return {
    ...target,
    seedKind: ANALYSIS_PHASE_IDS.EXPAND_CFG,
    expandCfgFrontierId: frontier.frontierId
  };
}

function rejectFrontier(context, frontier, reason, detail = {}) {
  context.markExpandCfgAttempt(frontier.frontierId, {
    state: 'rejected',
    reason,
    rejectedAt: ANALYSIS_PHASE_IDS.EXPAND_CFG,
    detail
  });
}

function targetBlockInstanceForFrontier(context, frontier, blockInstanceBySiteKey) {
  const target = requireSite(frontier.target, 'expandCfg frontier.target');
  return blockInstanceBySiteKey.get(target.siteKey) || null;
}

function materializeEdge(context, frontier, indexes, counters) {
  const sourceBlockInstanceId = requireString(frontier.sourceBlockInstanceId, 'expandCfg frontier.sourceBlockInstanceId');
  const sourceInstructionId = requireInteger(frontier.sourceInstructionId, 'expandCfg frontier.sourceInstructionId') >>> 0;
  const edgeKind = requireString(frontier.edgeKind, 'expandCfg frontier.edgeKind');
  const target = requireSite(frontier.target, 'expandCfg frontier.target');
  const sourceInstance = indexes.blockInstanceById.get(sourceBlockInstanceId);
  const targetInstance = indexes.blockInstanceBySiteKey.get(target.siteKey);
  if (!sourceInstance) {
    rejectFrontier(context, frontier, 'sourceBlockInstanceMissing', { sourceBlockInstanceId });
    counters.rejected += 1;
    return false;
  }
  if (!targetInstance) return false;

  const sourceBlock = indexes.blockById.get(sourceInstance.blockId);
  const targetBlock = indexes.blockById.get(targetInstance.blockId);
  if (!sourceBlock || !blockContainsInstruction(sourceBlock, sourceInstructionId)) {
    rejectFrontier(context, frontier, 'sourceInstructionMissing', { sourceBlockInstanceId, sourceInstructionId });
    counters.rejected += 1;
    return false;
  }
  if (!targetBlock || (targetBlock.romStart >>> 0) !== (target.romOff >>> 0)) {
    rejectFrontier(context, frontier, 'targetBlockMismatch', {
      targetBlockInstanceId: targetInstance.blockInstanceId,
      targetRomOff: target.romOff >>> 0
    });
    counters.rejected += 1;
    return false;
  }

  const edgeId = makeEdgeId(sourceBlockInstanceId, targetInstance.blockInstanceId, edgeKind);
  if (existingEdge(context, edgeId)) {
    context.markExpandCfgAttempt(frontier.frontierId, {
      state: 'edgeMaterialized',
      edgeId,
      targetBlockInstanceId: targetInstance.blockInstanceId
    });
    counters.alreadyMaterialized += 1;
    return true;
  }

  context.syntheticEdges.push({
    edgeId,
    fromBlockInstanceId: sourceBlockInstanceId,
    toBlockInstanceId: targetInstance.blockInstanceId,
    kind: edgeKind,
    fromInstructionId: sourceInstructionId,
    targetCpuAddr: target.cpuAddr & 0xffff,
    targetRomOff: target.romOff >>> 0,
    producedBy: ANALYSIS_PHASE_IDS.EXPAND_CFG,
    expandCfgFrontierId: frontier.frontierId
  });
  context.markExpandCfgAttempt(frontier.frontierId, {
    state: 'edgeMaterialized',
    edgeId,
    targetBlockInstanceId: targetInstance.blockInstanceId
  });
  counters.edgesAdded += 1;
  return true;
}

function preflightSeed(context, frontier, counters) {
  const target = requireSite(frontier.target, 'expandCfg frontier.target');
  const decoded = decodeInstructionAtSite({
    prgBytes: context.prgBytes,
    mapper: context.mapper,
    mapperContext: target.mapperContext,
    cpuAddr: target.cpuAddr & 0xffff
  });
  requireObject(decoded, 'expandCfg decoded target');
  if (decoded.ok) return true;
  rejectFrontier(context, frontier, 'decodeFailed', {
    decodeReason: typeof decoded.reason === 'string' ? decoded.reason : 'decodeFailed',
    opcode: typeof decoded.opcode === 'number' ? decoded.opcode & 0xff : null,
    cpuAddr: target.cpuAddr & 0xffff,
    romOff: target.romOff >>> 0
  });
  counters.rejected += 1;
  return false;
}

function seedTarget(context, frontier, counters) {
  if (!preflightSeed(context, frontier, counters)) return false;
  const seed = createSeed(frontier);
  const result = context.addSeedSite(seed);
  context.markExpandCfgAttempt(frontier.frontierId, {
    state: 'seeded',
    targetSiteKey: seed.siteKey
  });
  if (result.added) counters.seedsAdded += 1;
  else counters.duplicateSeeds += 1;
  return result.added;
}

function buildIndexes(context) {
  const blockInstanceById = indexBy(context.blockInstances, 'blockInstanceId', 'expandCfg blockInstances');
  const blockInstanceBySiteKey = new Map();
  for (const instance of requireArray(context.blockInstances, 'expandCfg blockInstances')) {
    requireObject(instance, 'expandCfg blockInstance');
    if (typeof instance.siteKey === 'string') blockInstanceBySiteKey.set(instance.siteKey, instance);
  }
  return {
    blockById: indexBy(context.blocks, 'blockId', 'expandCfg blocks'),
    blockInstanceById,
    blockInstanceBySiteKey
  };
}

export function createExpandCfgPhase(context) {
  return {
    name: ANALYSIS_PHASE_IDS.EXPAND_CFG,
    stepOne() {
      const counters = {
        frontiers: requireArray(context.expandCfgFrontiers, 'expandCfg context.expandCfgFrontiers').length,
        considered: 0,
        seedsAdded: 0,
        duplicateSeeds: 0,
        edgesAdded: 0,
        alreadyMaterialized: 0,
        rejected: 0,
        skippedTerminal: 0
      };
      const indexes = buildIndexes(context);

      for (const frontier of context.expandCfgFrontiers) {
        requireObject(frontier, 'expandCfg frontier');
        const frontierId = requireString(frontier.frontierId, 'expandCfg frontier.frontierId');
        const attempt = context.expandCfgAttemptForId(frontierId);
        const state = typeof attempt?.state === 'string' ? attempt.state : 'pending';
        if (state === 'edgeMaterialized' || state === 'rejected') {
          counters.skippedTerminal += 1;
          continue;
        }
        counters.considered += 1;

        const targetInstance = targetBlockInstanceForFrontier(context, frontier, indexes.blockInstanceBySiteKey);
        if (targetInstance) {
          materializeEdge(context, frontier, indexes, counters);
          continue;
        }
        if (state === 'pending') seedTarget(context, frontier, counters);
      }

      const newWork = counters.seedsAdded + counters.edgesAdded;
      if (newWork > 0 && typeof context.noteNewCfgWork === 'function') {
        context.noteNewCfgWork({
          phaseId: ANALYSIS_PHASE_IDS.EXPAND_CFG,
          reason: ANALYSIS_PHASE_IDS.EXPAND_CFG,
          count: newWork
        });
      }

      context.expandCfg = {
        producedBy: ANALYSIS_PHASE_IDS.EXPAND_CFG,
        counters: { ...counters }
      };
      context.diagnostics.phaseSummaries.push(makePhaseSummary(counters));
      return { status: 'complete' };
    },
    progress() {
      return { phase: ANALYSIS_PHASE_IDS.EXPAND_CFG };
    }
  };
}
