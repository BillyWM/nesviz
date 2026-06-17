import { EDGE_KINDS, FLOW_TYPES } from '../cfg/constants.js';
import {
  requireArray,
  requireInteger,
  requireObject,
  requireString
} from '../dataShape.js';
import { makeEdgeId } from '../identity.js';
import { ANALYSIS_PHASE_IDS } from '../analysisConstants.js';
import { abstractStateFromSerializable, isBottomState } from './state.js';
import { PROVENANCE_KIND, provenanceFromSerializable } from './provenanceDomain.js';
import { shadowStackPeek } from './shadowStackDomain.js';
import { provePairedIndexedRomReads } from './provenanceQueries.js';

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

function instructionMap(instructions) {
  const out = new Map();
  for (const instruction of requireArray(instructions, 'rtsTrick instructions')) {
    requireObject(instruction, 'rtsTrick instruction');
    const id = requireInteger(instruction.instructionId, 'rtsTrick instruction.instructionId') >>> 0;
    if (out.has(id)) throw new Error(`Duplicate rtsTrick instruction ${id}`);
    out.set(id, instruction);
  }
  return out;
}

function blockStateMap(blockStates) {
  const out = new Map();
  for (const blockState of requireArray(blockStates, 'rtsTrick blockStates')) {
    requireObject(blockState, 'rtsTrick blockState');
    out.set(requireString(blockState.blockInstanceId, 'rtsTrick blockState.blockInstanceId'), blockState);
  }
  return out;
}

function buildExecutionIndex(executions) {
  const byBlockAndInstruction = new Map();
  for (const execution of requireArray(executions, 'rtsTrick instructionExecutions')) {
    requireObject(execution, 'rtsTrick instructionExecution');
    const blockInstanceId = requireString(execution.blockInstanceId, 'rtsTrick execution.blockInstanceId');
    const instructionId = requireInteger(execution.instructionId, 'rtsTrick execution.instructionId') >>> 0;
    const key = `${blockInstanceId}|${instructionId}`;
    if (byBlockAndInstruction.has(key)) throw new Error(`Duplicate rtsTrick execution for ${key}`);
    byBlockAndInstruction.set(key, execution);
  }
  return byBlockAndInstruction;
}

function existingSiteKeys(items) {
  const out = new Set();
  for (const item of requireArray(items, 'rtsTrick site list')) {
    if (item && typeof item.siteKey === 'string') out.add(item.siteKey);
  }
  return out;
}

function hex(value, width) {
  return `$${(Number(value) >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function formatProofTarget(entry) {
  return `${hex(entry.lowRomOff, 6)}/${hex(entry.highRomOff, 6)}=>CPU ${hex((((entry.highByte << 8) | entry.lowByte) + 1) & 0xffff, 4)}`;
}


function siteRom(instruction) {
  return Number.isFinite(instruction?.romOff) ? hex(instruction.romOff, 6) : 'unknown ROM';
}

function siteCpu(instruction, execution) {
  if (Number.isFinite(execution?.cpuAddr)) return hex(execution.cpuAddr, 4);
  if (Number.isFinite(instruction?.cpuAddr)) return hex(instruction.cpuAddr, 4);
  return 'unknown CPU';
}

function siteKey(blockInstance, instruction, execution, reason) {
  return [
    blockInstance?.blockInstanceId || 'unknownBlock',
    Number(instruction?.instructionId) >>> 0,
    execution?.siteKey || 'unknownSite',
    reason
  ].join('|');
}

function describeProvenance(provenance) {
  const normalized = provenanceFromSerializable(provenance);
  if (normalized.kind === PROVENANCE_KIND.UNKNOWN) return 'unknown';
  if (normalized.kind === PROVENANCE_KIND.NODE) return describeProvenanceNode(normalized.node);
  const items = Array.isArray(normalized.items) ? normalized.items : [];
  const kinds = items.map((node) => describeProvenanceNode(node)).join(',');
  return `set[${items.length}](${kinds})`;
}

function describeProvenanceNode(node) {
  if (!node || typeof node !== 'object') return 'invalid';
  if (node.kind === 'indexedRomRead') {
    const values = Array.isArray(node.indexValues) ? node.indexValues.length : 0;
    const candidates = Array.isArray(node.candidates) ? node.candidates.length : 0;
    return `indexedRomRead(base=${hex(node.cpuBase, 4)}, values=${values}, candidates=${candidates})`;
  }
  if (node.kind === 'jsrReturn') return `jsrReturn(${node.role || 'unknown'})`;
  if (node.kind === 'romRead') return `romRead(${hex(node.romOff, 6)})`;
  if (node.kind === 'ramRead') return `ramRead(${hex(node.cpuAddr, 4)})`;
  if (node.kind === 'op') return `op(${node.op || 'unknown'})`;
  return String(node.kind || 'unknownNode');
}

function describeSlot(slot) {
  if (!slot) return 'missing';
  return describeProvenance(slot.provenance);
}

function logRtsTrickScanStart(context, aiResult) {
  // console.log(`[rtsTrick] scan start: blockInstances=${requireArray(context.blockInstances, 'rtsTrick blockInstances').length}, blockStates=${requireArray(aiResult.blockStates, 'rtsTrick blockStates').length}`);
}

function logRtsTrickScanSummary(counters) {
  // console.log(`[rtsTrick] scan: rts=${counters.rtsTerminators}, withState=${counters.rtsWithState}, stackKnown=${counters.stackKnown}, paired=${counters.pairedPointerTables}, dispatches=${counters.dispatchCount}, entriesResolved=${counters.entriesResolved}, seeds=${counters.seedsAdded}, edges=${counters.syntheticEdgesAdded}, missingState=${counters.skippedMissingBlockState}, missingExecution=${counters.skippedMissingExecution}, unknownStack=${counters.skippedUnknownStack}, unpaired=${counters.skippedUnpaired}, targetNotExact=${counters.skippedTargetNotExact}`);
}

function logRtsTrickSkip(context, blockInstance, instruction, execution, reason, detail = '') {
  if (!context.rtsTrickLoggedSkipKeys) context.rtsTrickLoggedSkipKeys = new Set();
  const key = siteKey(blockInstance, instruction, execution, reason);
  if (context.rtsTrickLoggedSkipKeys.has(key)) return;
  context.rtsTrickLoggedSkipKeys.add(key);
  const extra = detail ? `: ${detail}` : '';
  // console.log(`[rtsTrick] skip at ROM ${siteRom(instruction)} CPU ${siteCpu(instruction, execution)} (${reason})${extra}`);
}

function logProvenRtsTrick(dispatch, proof) {
  const entries = proof.entries.map(formatProofTarget).join(', ');
  console.log(`[rtsTrick] proven at ROM ${hex(dispatch.sourceRomOff, 6)} CPU ${hex(dispatch.sourceCpuAddr, 4)}: ${entries}`);
}

function logResolvedRtsTrick(dispatch, entries) {
  const targets = entries.map((entry) => `${hex(entry.targetRomOff, 6)} (CPU ${hex(entry.targetCpuAddr, 4)})`).join(', ');
  console.log(`[rtsTrick] resolved at ROM ${hex(dispatch.sourceRomOff, 6)} CPU ${hex(dispatch.sourceCpuAddr, 4)} -> ${targets}`);
}

function exactTargetFromMapperState(state, targetCpuAddr, env) {
  let mapperContext = null;
  if (typeof env.mapper.contextFromMapperState === 'function') {
    mapperContext = env.mapper.contextFromMapperState(state.mapperState);
  } else {
    mapperContext = env.contexts[env.contextKey];
  }
  if (!mapperContext) return null;

  const resolved = env.mapper.resolveControlTarget(mapperContext, targetCpuAddr & 0xffff, {
    policy: 'exactOnly',
    purpose: 'rtsTrickTarget'
  });
  requireObject(resolved, 'rtsTrick target resolution');
  if (!resolved.ok) return null;
  const target = requireObject(resolved.target, 'rtsTrick target');
  requireString(target.siteKey, 'rtsTrick target.siteKey');
  requireString(target.contextKey, 'rtsTrick target.contextKey');
  requireObject(target.mapperContext, 'rtsTrick target.mapperContext');
  requireInteger(target.cpuAddr, 'rtsTrick target.cpuAddr');
  requireInteger(target.romOff, 'rtsTrick target.romOff');
  return target;
}

function createRtsTrickSeed(dispatch, target) {
  return {
    ...target,
    seedKind: 'rtsTrick',
    sourceInstructionId: dispatch.sourceInstructionId >>> 0,
    sourceBlockInstanceId: dispatch.sourceBlockInstanceId,
    sourceCpuAddr: dispatch.sourceCpuAddr & 0xffff,
    sourceRomOff: dispatch.sourceRomOff >>> 0
  };
}

function syntheticEdgeExists(context, edgeId) {
  return (context.edges || []).some((edge) => edge.edgeId === edgeId) ||
    (context.syntheticEdges || []).some((edge) => edge.edgeId === edgeId);
}

function addSyntheticEdge(context, dispatch, entry, targetInstance) {
  const edgeId = makeEdgeId(dispatch.sourceBlockInstanceId, targetInstance.blockInstanceId, EDGE_KINDS.RTS_TRICK);
  if (syntheticEdgeExists(context, edgeId)) return false;
  context.syntheticEdges.push({
    edgeId,
    fromBlockInstanceId: dispatch.sourceBlockInstanceId,
    toBlockInstanceId: targetInstance.blockInstanceId,
    kind: EDGE_KINDS.RTS_TRICK,
    fromInstructionId: dispatch.sourceInstructionId >>> 0,
    targetCpuAddr: entry.targetCpuAddr & 0xffff,
    targetRomOff: entry.targetRomOff >>> 0,
    rtsTrickId: dispatch.id,
    pointerEntryIndex: entry.index & 0xff
  });
  return true;
}

function buildIndexes(context, aiResult) {
  const blockInstanceBySiteKey = new Map();
  for (const instance of requireArray(context.blockInstances, 'rtsTrick blockInstances')) {
    requireObject(instance, 'rtsTrick blockInstance');
    if (typeof instance.siteKey === 'string') blockInstanceBySiteKey.set(instance.siteKey, instance);
  }
  return {
    blockById: indexBy(context.blocks, 'blockId', 'rtsTrick blocks'),
    blockInstanceById: indexBy(context.blockInstances, 'blockInstanceId', 'rtsTrick blockInstances'),
    blockInstanceBySiteKey,
    instructionById: instructionMap(context.instructions),
    blockStateById: blockStateMap(aiResult.blockStates),
    executionByBlockAndInstruction: buildExecutionIndex(context.instructionExecutions)
  };
}

function resolveDispatchTargets(dispatch, proof, state, env, counters) {
  const entries = [];
  for (const entry of proof.entries) {
    const encodedReturnAddr = (entry.lowByte | (entry.highByte << 8)) & 0xffff;
    const targetCpuAddr = (encodedReturnAddr + 1) & 0xffff;
    const target = exactTargetFromMapperState(state, targetCpuAddr, env);
    if (!target) {
      counters.skippedTargetNotExact += 1;
      continue;
    }
    entries.push({
      ...entry,
      encodedReturnAddr,
      targetCpuAddr,
      targetSiteKey: target.siteKey,
      targetContextKey: target.contextKey,
      targetRomOff: target.romOff >>> 0,
      target
    });
  }
  return entries;
}

function tryBuildDispatch({ context, indexes, blockInstance, block, instruction, execution, blockState, knownSeedSiteKeys, counters }) {
  const state = abstractStateFromSerializable(blockState.outState, { mapperDomain: context.mapper.mapperDomain });
  if (isBottomState(state)) {
    logRtsTrickSkip(context, blockInstance, instruction, execution, 'bottomState');
    return null;
  }

  const lowSlot = shadowStackPeek(state.shadowStack, 0);
  const highSlot = shadowStackPeek(state.shadowStack, 1);
  if (!lowSlot || !highSlot) {
    counters.skippedUnknownStack += 1;
    logRtsTrickSkip(context, blockInstance, instruction, execution, 'unknownStack', `low=${describeSlot(lowSlot)} high=${describeSlot(highSlot)}`);
    return null;
  }
  counters.stackKnown += 1;

  const proof = provePairedIndexedRomReads(lowSlot.provenance, highSlot.provenance);
  if (!proof.ok) {
    counters.skippedUnpaired += 1;
    logRtsTrickSkip(context, blockInstance, instruction, execution, 'unpairedIndexedReads', `low=${describeSlot(lowSlot)} high=${describeSlot(highSlot)}`);
    return null;
  }
  counters.pairedPointerTables += 1;

  const env = {
    mapper: context.mapper,
    prgBytes: context.prgBytes,
    contexts: context.contexts,
    contextKey: execution.contextKey
  };
  const id = `rtsTrick:${blockInstance.blockInstanceId}:${instruction.instructionId >>> 0}:${execution.siteKey}`;
  const dispatch = {
    id,
    sourceBlockInstanceId: blockInstance.blockInstanceId,
    sourceBlockId: block.blockId,
    sourceInstructionId: instruction.instructionId >>> 0,
    sourceCpuAddr: execution.cpuAddr & 0xffff,
    sourceRomOff: instruction.romOff >>> 0,
    contextKey: execution.contextKey,
    siteKey: execution.siteKey,
    pointerTable: {
      kind: 'splitHiLoPointerTable',
      consumer: 'rtsTrick',
      indexProvKey: proof.indexProvKey,
      indexValues: proof.indexValues.slice(),
      lowRead: proof.lowRead,
      highRead: proof.highRead,
      entries: []
    }
  };

  if (!context.rtsTrickLoggedProofIds) context.rtsTrickLoggedProofIds = new Set();
  if (!context.rtsTrickLoggedProofIds.has(dispatch.id)) {
    context.rtsTrickLoggedProofIds.add(dispatch.id);
    logProvenRtsTrick(dispatch, proof);
  }

  const resolvedEntries = resolveDispatchTargets(dispatch, proof, state, env, counters);
  if (resolvedEntries.length) {
    if (!context.rtsTrickLoggedResolvedKeys) context.rtsTrickLoggedResolvedKeys = new Set();
    const resolvedKey = `${dispatch.id}:${resolvedEntries.map((entry) => entry.targetSiteKey).sort().join(',')}`;
    if (!context.rtsTrickLoggedResolvedKeys.has(resolvedKey)) {
      context.rtsTrickLoggedResolvedKeys.add(resolvedKey);
      logResolvedRtsTrick(dispatch, resolvedEntries);
    }
  }

  for (const entry of resolvedEntries) {
    counters.entriesResolved += 1;
    const { target, ...serializableEntry } = entry;
    dispatch.pointerTable.entries.push(serializableEntry);

    const targetInstance = indexes.blockInstanceBySiteKey.get(entry.targetSiteKey) || null;
    if (targetInstance) {
      if (addSyntheticEdge(context, dispatch, entry, targetInstance)) counters.syntheticEdgesAdded += 1;
      continue;
    }

    if (knownSeedSiteKeys.has(entry.targetSiteKey)) {
      counters.duplicateSeedSites += 1;
      continue;
    }

    const seed = createRtsTrickSeed(dispatch, target);
    const addResult = typeof context.addSeedSite === 'function'
      ? context.addSeedSite(seed)
      : { added: true };
    if (!addResult.added) {
      counters.duplicateSeedSites += 1;
      knownSeedSiteKeys.add(entry.targetSiteKey);
      continue;
    }
    knownSeedSiteKeys.add(entry.targetSiteKey);
    counters.seedsAdded += 1;
  }

  return dispatch;
}

export function resolveRtsTricksFromAbstractInterpretation(graph, aiResult, context) {
  requireObject(graph, 'rtsTrick graph');
  requireObject(aiResult, 'rtsTrick abstractInterpretation');
  requireObject(context, 'rtsTrick context');
  if (!context.syntheticEdges) context.syntheticEdges = [];

  logRtsTrickScanStart(context, aiResult);

  const indexes = buildIndexes(context, aiResult);
  const knownSeedSiteKeys = existingSiteKeys(context.seedSites);
  const counters = {
    rtsTerminators: 0,
    rtsWithState: 0,
    stackKnown: 0,
    pairedPointerTables: 0,
    entriesResolved: 0,
    seedsAdded: 0,
    duplicateSeedSites: 0,
    syntheticEdgesAdded: 0,
    skippedMissingBlockState: 0,
    skippedMissingExecution: 0,
    skippedUnknownStack: 0,
    skippedUnpaired: 0,
    skippedTargetNotExact: 0
  };
  const dispatches = [];

  for (const blockInstance of requireArray(context.blockInstances, 'rtsTrick blockInstances')) {
    const block = indexes.blockById.get(blockInstance.blockId);
    if (!block || !Array.isArray(block.instructionIds) || !block.instructionIds.length) continue;
    const lastInstructionId = Number(block.instructionIds[block.instructionIds.length - 1]) >>> 0;
    const instruction = indexes.instructionById.get(lastInstructionId);
    if (!instruction || instruction.flow?.type !== FLOW_TYPES.STOP || instruction.flow?.reason !== 'rts') continue;
    counters.rtsTerminators += 1;

    const blockState = indexes.blockStateById.get(blockInstance.blockInstanceId);
    if (!blockState) {
      counters.skippedMissingBlockState += 1;
      logRtsTrickSkip(context, blockInstance, instruction, null, 'missingBlockState');
      continue;
    }

    const execution = indexes.executionByBlockAndInstruction.get(`${blockInstance.blockInstanceId}|${lastInstructionId}`);
    if (!execution) {
      counters.skippedMissingExecution += 1;
      logRtsTrickSkip(context, blockInstance, instruction, null, 'missingInstructionExecution');
      continue;
    }
    counters.rtsWithState += 1;

    const dispatch = tryBuildDispatch({
      context,
      indexes,
      blockInstance,
      block,
      instruction,
      execution,
      blockState,
      knownSeedSiteKeys,
      counters
    });
    if (dispatch) dispatches.push(dispatch);
  }

  counters.dispatchCount = dispatches.length;
  counters.syntheticEdgeCount = (context.syntheticEdges || [])
    .filter((edge) => edge.kind === EDGE_KINDS.RTS_TRICK)
    .length;

  const result = {
    producedBy: 'abstractInterpretation',
    dispatches,
    counters: { ...counters }
  };

  const newWork = counters.seedsAdded + counters.syntheticEdgesAdded;
  if (newWork > 0 && typeof context.noteNewCfgWork === 'function') {
    context.noteNewCfgWork({
      phaseId: ANALYSIS_PHASE_IDS.ABSTRACT_INTERPRETATION,
      reason: 'rtsTrick',
      count: newWork
    });
  }

  context.rtsTricks = result;
  logRtsTrickScanSummary(counters);
  return result;
}
