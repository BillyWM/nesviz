import { OPCODES } from '../../cpu6502/opcodes.js';
import { ANALYSIS_PHASE_IDS } from '../analysisConstants.js';
import { EDGE_KINDS, FLOW_TYPES } from '../cfg/constants.js';
import { getBranchPredicateForMnemonic } from '../domains/flagEffects.js';
import { FLAG_VALUE } from '../domains/flagsDomain.js';
import { makeEdgeId } from '../identity.js';
import {
  requireArray,
  requireInteger,
  requireObject,
  requireString
} from '../dataShape.js';
import { transferInstruction } from './transfer.js';
import { abstractStateFromSerializable, isBottomState } from './state.js';

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
  for (const instruction of requireArray(instructions, 'expandCfg frontier instructions')) {
    requireObject(instruction, 'expandCfg frontier instruction');
    const id = requireInteger(instruction.instructionId, 'expandCfg frontier instruction.instructionId') >>> 0;
    if (out.has(id)) throw new Error(`Duplicate expandCfg frontier instruction ${id}`);
    out.set(id, instruction);
  }
  return out;
}

function blockStateMap(blockStates) {
  const out = new Map();
  for (const blockState of requireArray(blockStates, 'expandCfg frontier blockStates')) {
    requireObject(blockState, 'expandCfg frontier blockState');
    out.set(requireString(blockState.blockInstanceId, 'expandCfg frontier blockState.blockInstanceId'), blockState);
  }
  return out;
}

function executionIndex(executions) {
  const out = new Map();
  for (const execution of requireArray(executions, 'expandCfg frontier instructionExecutions')) {
    requireObject(execution, 'expandCfg frontier instructionExecution');
    const blockInstanceId = requireString(execution.blockInstanceId, 'expandCfg frontier execution.blockInstanceId');
    const instructionId = requireInteger(execution.instructionId, 'expandCfg frontier execution.instructionId') >>> 0;
    out.set(`${blockInstanceId}|${instructionId}`, execution);
  }
  return out;
}

function opcodeMnemonic(instruction) {
  const entry = OPCODES[requireInteger(instruction.opcode, 'expandCfg frontier instruction.opcode') & 0xff];
  return typeof entry?.mnemonic === 'string' ? entry.mnemonic : null;
}

function targetSiteFromState(state, targetCpuAddr, env) {
  let mapperContext = null;
  if (typeof env.mapper.contextFromMapperState === 'function') {
    mapperContext = env.mapper.contextFromMapperState(state.mapperState);
  } else {
    mapperContext = env.contexts[env.contextKey];
  }
  if (!mapperContext) return null;

  const resolved = env.mapper.resolveControlTarget(mapperContext, targetCpuAddr & 0xffff, {
    policy: 'exactOnly',
    purpose: 'expandCfgFrontier'
  });
  requireObject(resolved, 'expandCfg frontier target resolution');
  if (!resolved.ok) return null;
  const target = requireObject(resolved.target, 'expandCfg frontier target');
  requireString(target.siteKey, 'expandCfg frontier target.siteKey');
  requireString(target.contextKey, 'expandCfg frontier target.contextKey');
  requireObject(target.mapperContext, 'expandCfg frontier target.mapperContext');
  requireInteger(target.cpuAddr, 'expandCfg frontier target.cpuAddr');
  requireInteger(target.romOff, 'expandCfg frontier target.romOff');
  return target;
}

function edgeKindsForBranch(state, mnemonic) {
  const predicate = getBranchPredicateForMnemonic(mnemonic);
  if (!predicate) return [EDGE_KINDS.BRANCH_TAKEN, EDGE_KINDS.BRANCH_NOT_TAKEN];
  const flagValue = state.flags?.[predicate.flag] || FLAG_VALUE.UNKNOWN;
  if (flagValue === FLAG_VALUE.TRUE || flagValue === FLAG_VALUE.FALSE) {
    return flagValue === predicate.value ? [EDGE_KINDS.BRANCH_TAKEN] : [EDGE_KINDS.BRANCH_NOT_TAKEN];
  }
  return [EDGE_KINDS.BRANCH_TAKEN, EDGE_KINDS.BRANCH_NOT_TAKEN];
}

function candidateEdgesForInstruction(state, instruction) {
  const flow = requireObject(instruction.flow, 'expandCfg frontier instruction.flow');
  const mnemonic = opcodeMnemonic(instruction);
  if (flow.type === FLOW_TYPES.CALL) {
    return [
      { edgeKind: EDGE_KINDS.CALL, targetCpuAddr: requireInteger(flow.target, 'expandCfg call target') & 0xffff },
      { edgeKind: EDGE_KINDS.FALLTHROUGH, targetCpuAddr: requireInteger(flow.fallthrough, 'expandCfg call fallthrough') & 0xffff }
    ];
  }
  if (flow.type === FLOW_TYPES.JUMP) {
    return [{ edgeKind: EDGE_KINDS.JUMP, targetCpuAddr: requireInteger(flow.target, 'expandCfg jump target') & 0xffff }];
  }
  if (flow.type === FLOW_TYPES.BRANCH) {
    return edgeKindsForBranch(state, mnemonic).map((edgeKind) => ({
      edgeKind,
      targetCpuAddr: edgeKind === EDGE_KINDS.BRANCH_TAKEN
        ? (requireInteger(flow.target, 'expandCfg branch target') & 0xffff)
        : (requireInteger(flow.fallthrough, 'expandCfg branch fallthrough') & 0xffff)
    }));
  }
  return [];
}

function makeFrontierId({ blockInstanceId, instructionId, edgeKind, targetSiteKey }) {
  return `${ANALYSIS_PHASE_IDS.EXPAND_CFG}:${blockInstanceId}:${instructionId >>> 0}:${edgeKind}:${targetSiteKey}`;
}

function createFrontier({ blockInstance, instruction, execution, edgeKind, targetCpuAddr, target }) {
  const instructionId = instruction.instructionId >>> 0;
  const frontierId = makeFrontierId({
    blockInstanceId: blockInstance.blockInstanceId,
    instructionId,
    edgeKind,
    targetSiteKey: target.siteKey
  });
  return {
    frontierId,
    producedBy: ANALYSIS_PHASE_IDS.ABSTRACT_INTERPRETATION,
    kind: ANALYSIS_PHASE_IDS.EXPAND_CFG,
    reason: 'absintReachedExactMapperState',
    sourceBlockInstanceId: blockInstance.blockInstanceId,
    sourceBlockId: blockInstance.blockId,
    sourceInstructionId: instructionId,
    sourceSiteKey: execution.siteKey,
    sourceContextKey: execution.contextKey,
    sourceCpuAddr: execution.cpuAddr & 0xffff,
    sourceRomOff: instruction.romOff >>> 0,
    edgeKind,
    targetCpuAddr: targetCpuAddr & 0xffff,
    target
  };
}

function buildIndexes(graph, aiResult) {
  const blockInstanceBySiteKey = new Map();
  for (const instance of requireArray(graph.blockInstances, 'expandCfg frontier blockInstances')) {
    requireObject(instance, 'expandCfg frontier blockInstance');
    if (typeof instance.siteKey === 'string') blockInstanceBySiteKey.set(instance.siteKey, instance);
  }
  return {
    blockById: indexBy(graph.blocks, 'blockId', 'expandCfg frontier blocks'),
    blockInstanceBySiteKey,
    edgeIds: new Set(requireArray(graph.edges, 'expandCfg frontier edges').map((edge) => requireString(edge.edgeId, 'expandCfg frontier edge.edgeId'))),
    instructionById: instructionMap(graph.instructions),
    blockStateById: blockStateMap(aiResult.blockStates),
    executionByBlockAndInstruction: executionIndex(graph.instructionExecutions)
  };
}

function discoverForBlock({ graph, indexes, blockInstance, blockState, context, counters }) {
  const block = indexes.blockById.get(blockInstance.blockId);
  if (!block || !Array.isArray(block.instructionIds) || !block.instructionIds.length) return;
  let state = abstractStateFromSerializable(blockState.inState, { mapperDomain: graph.mapper.mapperDomain });
  if (isBottomState(state)) return;

  for (const rawInstructionId of block.instructionIds) {
    const instructionId = Number(rawInstructionId) >>> 0;
    const instruction = indexes.instructionById.get(instructionId);
    if (!instruction) return;
    const execution = indexes.executionByBlockAndInstruction.get(`${blockInstance.blockInstanceId}|${instructionId}`);
    if (!execution) return;

    const env = {
      mapper: graph.mapper,
      prgBytes: graph.prgBytes,
      contexts: graph.contexts,
      contextKey: execution.contextKey
    };

    for (const candidate of candidateEdgesForInstruction(state, instruction)) {
      counters.candidates += 1;
      const target = targetSiteFromState(state, candidate.targetCpuAddr, env);
      if (!target) {
        counters.targetNotExact += 1;
        continue;
      }
      const targetInstance = indexes.blockInstanceBySiteKey.get(target.siteKey);
      if (targetInstance && indexes.edgeIds.has(makeEdgeId(blockInstance.blockInstanceId, targetInstance.blockInstanceId, candidate.edgeKind))) {
        counters.existingEdges += 1;
        continue;
      }
      const frontier = createFrontier({
        blockInstance,
        instruction,
        execution,
        edgeKind: candidate.edgeKind,
        targetCpuAddr: candidate.targetCpuAddr,
        target
      });
      const result = context.addExpandCfgFrontier(frontier);
      if (result.added) counters.frontiersAdded += 1;
      else counters.duplicates += 1;
    }

    if (instruction.flow?.type !== FLOW_TYPES.NEXT) return;
    state = transferInstruction(state, instruction, env, { mapperDomain: graph.mapper.mapperDomain });
    if (isBottomState(state)) return;
  }
}

export function discoverExpandCfgFrontiersFromAbstractInterpretation(graph, aiResult, context) {
  requireObject(graph, 'expandCfg frontier graph');
  requireObject(aiResult, 'expandCfg frontier AI result');
  requireObject(context, 'expandCfg frontier context');
  const indexes = buildIndexes(graph, aiResult);
  const counters = {
    reachedBlocks: 0,
    candidates: 0,
    existingEdges: 0,
    targetNotExact: 0,
    frontiersAdded: 0,
    duplicates: 0
  };

  for (const blockInstance of requireArray(graph.blockInstances, 'expandCfg frontier blockInstances')) {
    requireObject(blockInstance, 'expandCfg frontier blockInstance');
    const blockState = indexes.blockStateById.get(blockInstance.blockInstanceId);
    if (!blockState) continue;
    const state = abstractStateFromSerializable(blockState.inState, { mapperDomain: graph.mapper.mapperDomain });
    if (isBottomState(state)) continue;
    counters.reachedBlocks += 1;
    discoverForBlock({ graph, indexes, blockInstance, blockState, context, counters });
  }

  if (counters.frontiersAdded > 0 && typeof context.noteNewCfgWork === 'function') {
    context.noteNewCfgWork({
      phaseId: ANALYSIS_PHASE_IDS.ABSTRACT_INTERPRETATION,
      reason: ANALYSIS_PHASE_IDS.EXPAND_CFG,
      count: counters.frontiersAdded
    });
  }

  return { counters };
}
