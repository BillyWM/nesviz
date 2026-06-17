import { canonicalizeCpuAddr } from '../../utils/addressUtils.js';
import { FLOW_TYPES, FRONTIER_KINDS } from '../cfg/constants.js';
import {
  requireArray,
  requireInteger,
  requireObject,
  requireString
} from '../dataShape.js';
import { resolveMapperCpuAddress } from '../domains/mapper/mapperDomain.js';
import { exactValueFromByte } from './abstractByteDomain.js';
import { readByteAt } from './byteMemory.js';
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
  for (const instruction of requireArray(instructions, 'indirect jump instructions')) {
    requireObject(instruction, 'indirect jump instruction');
    const id = requireInteger(instruction.instructionId, 'indirect jump instruction.instructionId') >>> 0;
    if (out.has(id)) throw new Error(`Duplicate indirect jump instruction ${id}`);
    out.set(id, instruction);
  }
  return out;
}

function blockStateMap(blockStates) {
  const out = new Map();
  for (const blockState of requireArray(blockStates, 'indirect jump blockStates')) {
    requireObject(blockState, 'indirect jump blockState');
    out.set(requireString(blockState.blockInstanceId, 'indirect jump blockState.blockInstanceId'), blockState);
  }
  return out;
}

function executionKey(instructionId, siteKey) {
  return `${instructionId >>> 0}|${siteKey}`;
}

function frontierKey(siteKey, ptrAddr) {
  return `${siteKey}|${ptrAddr & 0xffff}`;
}

function buildExecutionIndexes(executions) {
  const byBlockAndInstruction = new Map();
  const byInstructionAndSite = new Map();

  for (const execution of requireArray(executions, 'indirect jump instructionExecutions')) {
    requireObject(execution, 'indirect jump instructionExecution');
    const instructionId = requireInteger(execution.instructionId, 'indirect jump execution.instructionId') >>> 0;
    const blockInstanceId = requireString(execution.blockInstanceId, 'indirect jump execution.blockInstanceId');
    const siteKey = requireString(execution.siteKey, 'indirect jump execution.siteKey');
    const blockKey = `${blockInstanceId}|${instructionId}`;
    if (byBlockAndInstruction.has(blockKey)) throw new Error(`Duplicate execution for ${blockKey}`);
    byBlockAndInstruction.set(blockKey, execution);
    byInstructionAndSite.set(executionKey(instructionId, siteKey), execution);
  }

  return { byBlockAndInstruction, byInstructionAndSite };
}

function buildIndirectFrontierIndex(frontiers) {
  const out = new Map();
  for (const frontier of requireArray(frontiers, 'indirect jump frontiers')) {
    requireObject(frontier, 'indirect jump frontier');
    if (frontier.kind !== FRONTIER_KINDS.INDIRECT_JUMP) continue;
    const siteKey = requireString(frontier.siteKey, 'indirect jump frontier.siteKey');
    const detail = frontier.detail && typeof frontier.detail === 'object' ? frontier.detail : null;
    if (!detail || !Number.isInteger(detail.ptrAddr)) continue;
    out.set(frontierKey(siteKey, detail.ptrAddr), frontier);
  }
  return out;
}

function indirectHighByteAddr(ptrAddr) {
  const ptr = ptrAddr & 0xffff;
  return (ptr & 0xff00) | ((ptr + 1) & 0x00ff);
}

function exactRamByte(state, cpuAddr) {
  const byte = readByteAt(state.ramBytes, cpuAddr & 0xffff);
  const value = exactValueFromByte(byte);
  if (value === null) return null;
  const canonical = canonicalizeCpuAddr(cpuAddr & 0xffff);
  return {
    value,
    source: {
      kind: canonical.space === 'zp' ? 'zeroPageRam' : 'cpuRam',
      cpuAddr: cpuAddr & 0xffff,
      canonicalAddr: canonical.addr & 0x07ff
    }
  };
}

function exactPrgRomByte(state, cpuAddr, env) {
  const addr = cpuAddr & 0xffff;
  const domainOptions = { mapperDomain: env.mapper.mapperDomain };
  const resolvedByDomain = resolveMapperCpuAddress(state.mapperState, addr, {
    ...domainOptions,
    purpose: 'resolvedIndirectJumpPointerRead'
  });
  requireObject(resolvedByDomain, 'indirect jump mapper-domain pointer read resolution');
  if (resolvedByDomain.kind === 'exact') {
    const romOff = requireInteger(resolvedByDomain.romOff, 'indirect jump pointer read romOff') >>> 0;
    if (romOff >= env.prgBytes.length) return null;
    return {
      value: env.prgBytes[romOff] & 0xff,
      source: { kind: 'prgRom', cpuAddr: addr, romOff }
    };
  }

  // Fixed/no-domain mappers do not have enough information in the mapper domain itself.
  // In those cases the block's concrete execution context is still exact and safe to use.
  if (typeof env.mapper.contextFromMapperState === 'function') return null;

  const mapperContext = env.contexts[env.contextKey];
  if (!mapperContext) return null;
  const resolved = env.mapper.resolveCpuAddress(mapperContext, addr, { purpose: 'resolvedIndirectJumpPointerRead' });
  requireObject(resolved, 'indirect jump context pointer read resolution');
  if (!resolved.ok) return null;
  const backing = requireObject(resolved.backing, 'indirect jump pointer read backing');
  if (backing.kind !== 'exact') return null;
  const romOff = requireInteger(backing.romOff, 'indirect jump context pointer read romOff') >>> 0;
  if (romOff >= env.prgBytes.length) return null;
  return {
    value: env.prgBytes[romOff] & 0xff,
    source: { kind: 'prgRom', cpuAddr: addr, romOff }
  };
}

function exactCpuByte(state, cpuAddr, env) {
  const canonical = canonicalizeCpuAddr(cpuAddr & 0xffff);
  if (canonical.space === 'zp' || canonical.space === 'ram') return exactRamByte(state, cpuAddr);
  if (canonical.space === 'rom') return exactPrgRomByte(state, cpuAddr, env);
  return null;
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
    purpose: 'resolvedIndirectJumpTarget'
  });
  requireObject(resolved, 'resolved indirect jump target resolution');
  if (!resolved.ok) return null;
  const target = requireObject(resolved.target, 'resolved indirect jump target');
  requireString(target.siteKey, 'resolved indirect jump target.siteKey');
  requireString(target.contextKey, 'resolved indirect jump target.contextKey');
  requireObject(target.mapperContext, 'resolved indirect jump target.mapperContext');
  requireInteger(target.cpuAddr, 'resolved indirect jump target.cpuAddr');
  requireInteger(target.romOff, 'resolved indirect jump target.romOff');
  return target;
}

function resolveOneIndirectJump({ graph, indexes, blockInstance, instruction, execution, blockState }) {
  if (blockInstance.reachability === 'physicalOnly') return null;
  if (!instruction.flow || instruction.flow.type !== FLOW_TYPES.JMP_INDIRECT) return null;
  const state = abstractStateFromSerializable(blockState.outState, { mapperDomain: graph.mapper.mapperDomain });
  if (isBottomState(state)) return null;

  const ptrCpuAddr = requireInteger(instruction.flow.ptrAddr, 'resolved indirect jump ptrAddr') & 0xffff;
  const ptrLowCpuAddr = ptrCpuAddr;
  const ptrHighCpuAddr = indirectHighByteAddr(ptrCpuAddr);
  const env = {
    mapper: graph.mapper,
    prgBytes: graph.prgBytes,
    contexts: graph.contexts,
    contextKey: execution.contextKey
  };

  const low = exactCpuByte(state, ptrLowCpuAddr, env);
  if (!low) return null;
  const high = exactCpuByte(state, ptrHighCpuAddr, env);
  if (!high) return null;

  const targetCpuAddr = (low.value | (high.value << 8)) & 0xffff;
  const target = exactTargetFromMapperState(state, targetCpuAddr, env);
  if (!target) return null;

  const frontier = indexes.indirectFrontierBySiteAndPtr.get(frontierKey(execution.siteKey, ptrCpuAddr));
  const id = `resolvedIndirectJump:${blockInstance.blockInstanceId}:${instruction.instructionId >>> 0}:${execution.siteKey}`;
  return {
    resolvedIndirectJumpId: id,
    sourceFrontierId: frontier ? frontier.frontierId : null,
    blockInstanceId: blockInstance.blockInstanceId,
    instructionId: instruction.instructionId >>> 0,
    siteKey: execution.siteKey,
    contextKey: execution.contextKey,
    sourceCpuAddr: execution.cpuAddr & 0xffff,
    sourceRomOff: instruction.romOff >>> 0,
    ptrCpuAddr,
    ptrLowCpuAddr,
    ptrHighCpuAddr,
    lowSource: low.source,
    highSource: high.source,
    targetCpuAddr,
    targetSiteKey: target.siteKey,
    targetContextKey: target.contextKey,
    targetRomOff: target.romOff >>> 0,
    target,
    reason: 'exactIndirectJump'
  };
}

function buildIndexes(graph, aiResult) {
  return {
    blockById: indexBy(graph.blocks, 'blockId', 'indirect jump blocks'),
    blockInstanceById: indexBy(graph.blockInstances, 'blockInstanceId', 'indirect jump blockInstances'),
    instructionById: instructionMap(graph.instructions),
    blockStateById: blockStateMap(aiResult.blockStates),
    indirectFrontierBySiteAndPtr: buildIndirectFrontierIndex(graph.frontiers),
    ...buildExecutionIndexes(graph.instructionExecutions)
  };
}

function existingSiteKeys(items) {
  const out = new Set();
  for (const item of requireArray(items, 'resolved indirect jump site list')) {
    if (item && typeof item.siteKey === 'string') out.add(item.siteKey);
  }
  return out;
}

function createResolvedIndirectSeed(resolution) {
  return {
    ...resolution.target,
    seedKind: 'resolvedIndirectJump',
    sourceFrontierId: resolution.sourceFrontierId,
    sourceInstructionId: resolution.instructionId >>> 0,
    sourceBlockInstanceId: resolution.blockInstanceId,
    sourceCpuAddr: resolution.sourceCpuAddr & 0xffff,
    sourceRomOff: resolution.sourceRomOff >>> 0,
    ptrCpuAddr: resolution.ptrCpuAddr & 0xffff
  };
}

export function resolveIndirectJumpsFromAbstractInterpretation(graph, aiResult, context = null) {
  requireObject(graph, 'resolved indirect jump graph');
  requireObject(aiResult, 'resolved indirect jump AI result');
  const indexes = buildIndexes(graph, aiResult);
  const knownSeedSiteKeys = context ? existingSiteKeys(context.seedSites) : new Set();
  const knownExecutableSiteKeys = existingSiteKeys(graph.blockInstances);
  const resolutions = [];
  const counters = {
    indirectJumpBlocks: 0,
    resolved: 0,
    duplicateSeedSites: 0,
    alreadyExecutableSites: 0,
    addedSeeds: 0
  };

  for (const blockInstance of requireArray(graph.blockInstances, 'resolved indirect jump blockInstances')) {
    requireObject(blockInstance, 'resolved indirect jump blockInstance');
    const block = indexes.blockById.get(blockInstance.blockId);
    if (!block || !Array.isArray(block.instructionIds) || block.instructionIds.length === 0) continue;
    const lastInstructionId = Number(block.instructionIds[block.instructionIds.length - 1]) >>> 0;
    const instruction = indexes.instructionById.get(lastInstructionId);
    if (!instruction || !instruction.flow || instruction.flow.type !== FLOW_TYPES.JMP_INDIRECT) continue;
    counters.indirectJumpBlocks += 1;

    const blockState = indexes.blockStateById.get(blockInstance.blockInstanceId);
    if (!blockState) continue;
    const execution = indexes.byBlockAndInstruction.get(`${blockInstance.blockInstanceId}|${lastInstructionId}`);
    if (!execution) continue;

    const resolution = resolveOneIndirectJump({ graph, indexes, blockInstance, instruction, execution, blockState });
    if (!resolution) continue;
    counters.resolved += 1;
    resolutions.push(resolution);

    if (!context) continue;
    if (knownExecutableSiteKeys.has(resolution.targetSiteKey)) {
      counters.alreadyExecutableSites += 1;
      continue;
    }
    if (knownSeedSiteKeys.has(resolution.targetSiteKey)) {
      counters.duplicateSeedSites += 1;
      continue;
    }

    const seed = createResolvedIndirectSeed(resolution);
    const result = typeof context.addSeedSite === 'function'
      ? context.addSeedSite(seed)
      : { added: true };
    if (!result.added) {
      counters.duplicateSeedSites += 1;
      knownSeedSiteKeys.add(resolution.targetSiteKey);
      continue;
    }
    if (typeof context.addSeedSite !== 'function') {
      context.seedSites.push(seed);
      context.contexts[seed.contextKey] = seed.mapperContext;
    }
    knownSeedSiteKeys.add(resolution.targetSiteKey);
    counters.addedSeeds += 1;
    if (typeof context.noteNewCfgWork === 'function') {
      context.noteNewCfgWork({
        phaseId: 'abstractInterpretation',
        reason: 'resolvedIndirectJump',
        count: 1
      });
    }
  }

  return { resolutions, counters };
}
