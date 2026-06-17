import { OPCODES } from '../../cpu6502/opcodes.js';
import { ADDRESSING_MODES as AM } from '../../cpu6502/addressingModes.js';
import { abstractStateFromSerializable, cloneState, isBottomState } from '../abstractInterpretation/state.js';
import { transferInstruction } from '../abstractInterpretation/transfer.js';
import { abstractByteFromSerializable } from '../abstractInterpretation/abstractByteDomain.js';
import { scalarToValues } from '../abstractInterpretation/byteScalarDomain.js';
import { buildInstructionMap, requireArray, requireObject } from '../dataShape.js';
import { discoverLoopCandidates } from '../loopSummarization/loopCandidates.js';
import { buildLoopRecognizerIndexes, summarizeCounterLoopCandidate } from '../loopSummarization/counterLoopRecognizer.js';
import {
  MEMORY_ACCESS_LIMITS,
  classifyResolvedAccess,
  enumerateByteValues,
  memoryAccessKindForInstruction,
  opcodeEntryForAccess,
  resolveCpuAddressValuesForInstruction
} from './effectiveAddressSets.js';
import { NES_CPU_REGISTER_ADDRS } from '../../nes/namedRegisters.js';

const DEFAULT_COLLECT_STEP_MS = 8;

function makeBlockMaps(graph) {
  const blockById = new Map();
  for (const block of requireArray(graph.blocks, 'populateMemoryMap blocks')) blockById.set(block.blockId, block);
  const blockInstanceById = new Map();
  for (const blockInstance of requireArray(graph.blockInstances, 'populateMemoryMap blockInstances')) blockInstanceById.set(blockInstance.blockInstanceId, blockInstance);
  const blockStateById = new Map();
  for (const blockState of requireArray(graph.abstractInterpretation?.blockStates, 'populateMemoryMap abstractInterpretation.blockStates')) blockStateById.set(blockState.blockInstanceId, blockState);
  return { blockById, blockInstanceById, blockStateById };
}

function operandFromInstruction(instruction) {
  return instruction.operand === null || instruction.operand === undefined ? null : (instruction.operand >>> 0);
}

function compactAddressSet(values) {
  const sorted = Array.from(new Set(values)).sort((a, b) => a - b);
  if (sorted.length === 1) return { kind: 'exact', start: sorted[0], end: sorted[0], values: [sorted[0]] };
  let contiguous = true;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      contiguous = false;
      break;
    }
  }
  if (contiguous) return { kind: 'range', start: sorted[0], end: sorted[sorted.length - 1], values: sorted };
  return { kind: 'set', start: sorted[0], end: sorted[sorted.length - 1], values: sorted };
}

function incrementCounter(counters, key) {
  counters[key] = (counters[key] || 0) + 1;
}

function skipCounterName(reason) {
  if (reason === 'unknownIndex' || reason === 'unknownPointer') return 'skippedUnknownAddress';
  if (reason === 'hugeAddressSet') return 'skippedHugeAddressSet';
  if (reason === 'mixedAddressSpace') return 'skippedMixedAddressSpace';
  if (reason === 'ambiguousMapper') return 'skippedAmbiguousMapper';
  if (reason === 'romWrite') return 'skippedRomWrite';
  return 'skippedUnsupportedAccess';
}

function makeFact({ block, blockInstance, instruction, entry, accessKind, addressResolution, classified, factIndex }) {
  const firstPointer = Array.isArray(addressResolution.pointerZpAddrs)
    ? addressResolution.pointerZpAddrs[0]
    : addressResolution.pointerZpAddr;
  const addressSet = compactAddressSet(classified.values);
  return {
    id: `memoryAccess:${factIndex}`,
    kind: 'memoryAccess',
    space: classified.space,
    access: accessKind,
    addressSet,
    instructionId: instruction.instructionId >>> 0,
    blockInstanceId: blockInstance.blockInstanceId,
    blockId: block.blockId,
    romOff: instruction.romOff >>> 0,
    cpuAddr: null,
    mnemonic: entry.mnemonic,
    addressingMode: entry.mode,
    operand: operandFromInstruction(instruction),
    mode: addressResolution.mode,
    pointerZpAddr: Number.isInteger(firstPointer) ? (firstPointer & 0xff) : null,
    pointerZpAddrs: Array.isArray(addressResolution.pointerZpAddrs) ? addressResolution.pointerZpAddrs.map((value) => value & 0xff) : [],
    indexRegister: addressResolution.indexRegister || null,
    producedBy: 'populateMemoryMap'
  };
}

function storeSourceRegister(mnemonic) {
  if (mnemonic === 'STA') return 'a';
  if (mnemonic === 'STX') return 'x';
  if (mnemonic === 'STY') return 'y';
  return null;
}

function addressValuesExactly(values, addr) {
  const target = addr & 0xffff;
  return Array.isArray(values)
    && values.length === 1
    && ((Number(values[0]) & 0xffff) === target);
}

function makeOamDmaFact({ block, blockInstance, instruction, entry, state, addressResolution, factIndex, counters, limits }) {
  if (!addressValuesExactly(addressResolution?.values, NES_CPU_REGISTER_ADDRS.OAMDMA_4014)) return null;
  const registerName = storeSourceRegister(entry?.mnemonic);
  if (!registerName) return null;
  const pageValues = enumerateByteValues(state?.registers?.[registerName], limits.maxByteValues);
  if (!pageValues || pageValues.length !== 1) {
    incrementCounter(counters, 'skippedOamDmaUnknownPage');
    return null;
  }
  const page = pageValues[0] & 0xff;
  return {
    id: `oamDma:${factIndex}`,
    kind: 'oamDma',
    page,
    sourceCpuStart: (page << 8) & 0xffff,
    sourceCpuEnd: ((page << 8) | 0xff) & 0xffff,
    sourceRegister: registerName,
    instructionId: instruction.instructionId >>> 0,
    blockInstanceId: blockInstance.blockInstanceId,
    blockId: block.blockId,
    romOff: instruction.romOff >>> 0,
    cpuAddr: null,
    mnemonic: entry.mnemonic,
    addressingMode: entry.mode,
    operand: operandFromInstruction(instruction),
    producedBy: 'populateMemoryMap'
  };
}

function makeCounters() {
  return {
    blockInstancesVisited: 0,
    instructionsReplayed: 0,
    accessFacts: 0,
    loopIndexedAccessFacts: 0,
    loopIndexedReadFacts: 0,
    loopIndexedWriteFacts: 0,
    loopIndexedReadWriteFacts: 0,
    loopIndexedRamFacts: 0,
    loopIndexedRomFacts: 0,
    loopIndexedSummaryProofs: 0,
    loopIndexedDetectedProofs: 0,
    loopIndexedCandidateProofs: 0,
    skippedLoopIndexedNoCounterValues: 0,
    skippedLoopIndexedUnsupportedAccess: 0,
    skippedLoopIndexedAddressResolution: 0,
    ramReadFacts: 0,
    ramWriteFacts: 0,
    ramReadWriteFacts: 0,
    romReadFacts: 0,
    oamDmaFacts: 0,
    skippedOamDmaUnknownPage: 0,
    skippedStackImplied: 0,
    skippedUnknownAddress: 0,
    skippedHugeAddressSet: 0,
    skippedMixedAddressSpace: 0,
    skippedAmbiguousMapper: 0,
    skippedRomWrite: 0,
    skippedUnsupportedAccess: 0,
    skippedBottomState: 0
  };
}

function uniqueSortedNumbers(values, mask = 0xffff) {
  return Array.from(new Set(values.map((value) => Number(value) & mask))).sort((a, b) => a - b);
}

function indexRegisterForMode(mode) {
  if (mode === AM.ZERO_PAGE_X || mode === AM.ABSOLUTE_X || mode === AM.INDIRECT_X) return 'x';
  if (mode === AM.ZERO_PAGE_Y || mode === AM.ABSOLUTE_Y || mode === AM.INDIRECT_Y) return 'y';
  return null;
}

function directIndexedMode(mode) {
  return mode === AM.ZERO_PAGE_X
    || mode === AM.ZERO_PAGE_Y
    || mode === AM.ABSOLUTE_X
    || mode === AM.ABSOLUTE_Y;
}

function byteValuesFromSummaryByte(byte) {
  if (!byte) return null;
  const normalized = abstractByteFromSerializable(byte);
  const scalarValues = scalarToValues(normalized.scalar, 256);
  if (!scalarValues) return null;
  if (normalized.bits?.kind === 'bottom') return [];
  const knownMask = normalized.bits?.knownMask ?? 0x00;
  const knownValue = normalized.bits?.knownValue ?? 0x00;
  return uniqueSortedNumbers(
    scalarValues.filter((value) => (value & knownMask) === (knownValue & knownMask)),
    0xff
  );
}

function addSummaryByteValues(out, byte) {
  const values = byteValuesFromSummaryByte(byte);
  if (!values || !values.length) return false;
  for (const value of values) out.push(value & 0xff);
  return true;
}

function instructionIndexInBlock(block, instructionId) {
  const ids = requireArray(block.instructionIds, `populateMemoryMap block ${block.blockId}.instructionIds`);
  return ids.findIndex((id) => (id >>> 0) === (instructionId >>> 0));
}

function updateInstructionIds(summary) {
  const out = [];
  for (const id of Array.isArray(summary?.evidence?.updateInstructionIds) ? summary.evidence.updateInstructionIds : []) {
    if (Number.isInteger(id)) out.push(id >>> 0);
  }
  if (Number.isInteger(summary?.evidence?.updateInstructionId)) out.push(summary.evidence.updateInstructionId >>> 0);
  return uniqueSortedNumbers(out, 0xffffffff);
}

function readOccursAfterCounterUpdate(summary, blockInstance, block, instructionId) {
  if (!summary || blockInstance.blockInstanceId !== summary.tailBlockInstanceId) return false;
  const readIndex = instructionIndexInBlock(block, instructionId);
  if (readIndex < 0) return false;
  const updateIndexes = updateInstructionIds(summary)
    .map((id) => instructionIndexInBlock(block, id))
    .filter((index) => index >= 0);
  return updateIndexes.length > 0 && Math.max(...updateIndexes) < readIndex;
}

function loopCounterValuesForInstruction(summary, blockInstance, block, instructionId) {
  const values = [];
  if (readOccursAfterCounterUpdate(summary, blockInstance, block, instructionId)) {
    addSummaryByteValues(values, summary.counter?.reentryByte);
    addSummaryByteValues(values, summary.counter?.exitByte);
  } else {
    addSummaryByteValues(values, summary.counter?.headerByte);
  }
  return values.length ? uniqueSortedNumbers(values, 0xff) : null;
}

function indexedAddressValuesFromLoop(instruction, mode, indexValues) {
  const operand = Number(instruction.operand) & 0xffff;
  if (mode === AM.ZERO_PAGE_X || mode === AM.ZERO_PAGE_Y) {
    return uniqueSortedNumbers(indexValues.map((index) => (operand + index) & 0xff), 0xff);
  }
  if (mode === AM.ABSOLUTE_X || mode === AM.ABSOLUTE_Y) {
    return uniqueSortedNumbers(indexValues.map((index) => (operand + index) & 0xffff), 0xffff);
  }
  return null;
}

function loopSummariesByBodyBlockInstance(loopSummaries) {
  const out = new Map();
  for (const summary of Array.isArray(loopSummaries) ? loopSummaries : []) {
    if (!summary || summary.confidence !== 'proved' || summary.kind !== 'counterLoop') continue;
    if (!summary.counter?.registerName) continue;
    for (const blockInstanceId of Array.isArray(summary.bodyBlockInstanceIds) ? summary.bodyBlockInstanceIds : []) {
      const key = String(blockInstanceId || '');
      if (!key) continue;
      const list = out.get(key) || [];
      list.push(summary);
      out.set(key, list);
    }
  }
  return out;
}

function summarizedReentryEdgeKeys(loopSummaries) {
  const out = new Set();
  if (loopSummaries?.byReentryEdgeKey instanceof Map) {
    for (const key of loopSummaries.byReentryEdgeKey.keys()) out.add(key);
  }
  for (const summary of Array.isArray(loopSummaries?.summaries) ? loopSummaries.summaries : []) {
    if (typeof summary?.reentryEdgeKey === 'string' && summary.reentryEdgeKey) out.add(summary.reentryEdgeKey);
  }
  return out;
}

function detectedLoopSourceIds(loopDetections) {
  const out = new Set();
  for (const loop of Array.isArray(loopDetections?.loops) ? loopDetections.loops : []) {
    if (typeof loop?.sourceLoopId === 'string' && loop.sourceLoopId) out.add(loop.sourceLoopId);
    else if (typeof loop?.loopId === 'string' && loop.loopId.startsWith('detectedLoop:')) out.add(loop.loopId.slice('detectedLoop:'.length));
  }
  return out;
}

function collectCounterLoopProofs(graph, counters) {
  const proofs = [];
  const summaryByLoopId = new Map();
  const seenReentry = summarizedReentryEdgeKeys(graph.loopSummaries);
  const detectedSourceIds = detectedLoopSourceIds(graph.loopDetections);

  for (const summary of Array.isArray(graph.loopSummaries?.summaries) ? graph.loopSummaries.summaries : []) {
    if (!summary || summary.confidence !== 'proved' || summary.kind !== 'counterLoop') continue;
    proofs.push({ ...summary, memoryMapLoopSource: 'summary' });
    if (typeof summary.loopId === 'string') summaryByLoopId.set(summary.loopId, summary);
    counters.loopIndexedSummaryProofs += 1;
  }

  if (!graph.cfgTopology || !Array.isArray(graph.edges) || !Array.isArray(graph.instructionExecutions)) return proofs;

  const candidates = discoverLoopCandidates({ topology: graph.cfgTopology, edges: graph.edges });
  const candidateById = new Map(candidates.map((candidate) => [candidate.loopId, candidate]));
  const indexes = buildLoopRecognizerIndexes(graph);
  const ordered = [...candidates].sort((a, b) => (b.depth || 0) - (a.depth || 0) || a.bodyBlockInstanceIds.length - b.bodyBlockInstanceIds.length || a.loopId.localeCompare(b.loopId));

  for (const candidate of ordered) {
    if (seenReentry.has(candidate.reentryEdgeKey)) continue;
    const result = summarizeCounterLoopCandidate({
      candidate,
      context: graph,
      indexes,
      candidateById,
      childSummaryByLoopId: summaryByLoopId
    });
    if (!result.ok) continue;
    const fromDetectedLoop = detectedSourceIds.has(candidate.loopId);
    const summary = {
      ...result.summary,
      memoryMapLoopSource: fromDetectedLoop ? 'detectedLoop' : 'candidate'
    };
    proofs.push(summary);
    if (typeof summary.loopId === 'string') summaryByLoopId.set(summary.loopId, summary);
    if (typeof summary.reentryEdgeKey === 'string') seenReentry.add(summary.reentryEdgeKey);
    if (fromDetectedLoop) counters.loopIndexedDetectedProofs += 1;
    else counters.loopIndexedCandidateProofs += 1;
  }

  return proofs;
}

function materializeLoopIndexedAccessFacts({ graph, maps, instructionById, facts, counters, limits }) {
  const loopProofs = collectCounterLoopProofs(graph, counters);
  const summariesByBlockInstance = loopSummariesByBodyBlockInstance(loopProofs);
  if (!summariesByBlockInstance.size) return [];

  const out = [];

  for (const [blockInstanceId, summaries] of summariesByBlockInstance.entries()) {
    const blockInstance = maps.blockInstanceById.get(blockInstanceId);
    if (!blockInstance) continue;
    const block = maps.blockById.get(blockInstance.blockId);
    if (!block) continue;
    const blockState = maps.blockStateById.get(blockInstance.blockInstanceId);
    if (!blockState) continue;
    const state = abstractStateFromSerializable(blockState.inState, { mapperDomain: graph.mapper.mapperDomain });
    if (isBottomState(state)) continue;

    const env = {
      mapper: graph.mapper,
      prgBytes: graph.prgBytes,
      contexts: graph.contexts,
      contextKey: blockInstance.contextKey
    };

    for (const instructionId of requireArray(block.instructionIds, `populateMemoryMap block ${block.blockId}.instructionIds`)) {
      const instruction = instructionById.get(instructionId >>> 0);
      if (!instruction) continue;
      const entry = opcodeEntryForAccess(instruction) || OPCODES[instruction.opcode & 0xff];
      if (!entry || !directIndexedMode(entry.mode)) continue;
      const accessKind = memoryAccessKindForInstruction(instruction);
      if (accessKind !== 'read' && accessKind !== 'write' && accessKind !== 'readWrite') continue;

      const indexRegister = indexRegisterForMode(entry.mode);
      const matchingSummaries = summaries.filter((summary) => summary.counter?.registerName === indexRegister);
      if (!matchingSummaries.length) continue;

      for (const summary of matchingSummaries) {
        const indexValues = loopCounterValuesForInstruction(summary, blockInstance, block, instruction.instructionId);
        if (!indexValues || !indexValues.length) {
          counters.skippedLoopIndexedNoCounterValues += 1;
          continue;
        }
        const addressValues = indexedAddressValuesFromLoop(instruction, entry.mode, indexValues);
        if (!addressValues || !addressValues.length) {
          counters.skippedLoopIndexedUnsupportedAccess += 1;
          continue;
        }
        const addressResolution = {
          ok: true,
          mode: 'loopIndexed',
          indexRegister,
          values: addressValues
        };
        const classified = classifyResolvedAccess(state, addressValues, accessKind, env, limits, { mapperDomain: graph.mapper.mapperDomain });
        if (!classified.ok) {
          counters.skippedLoopIndexedAddressResolution += 1;
          continue;
        }
        const fact = makeFact({
          block,
          blockInstance,
          instruction,
          entry,
          accessKind,
          addressResolution,
          classified,
          factIndex: facts.length + out.length
        });
        fact.producedBy = 'populateMemoryMapLoop';
        fact.loopId = summary.loopId || null;
        fact.loopSource = summary.memoryMapLoopSource || null;
        out.push(fact);
        counters.accessFacts += 1;
        counters.loopIndexedAccessFacts += 1;
        if (fact.access === 'read') counters.loopIndexedReadFacts += 1;
        else if (fact.access === 'write') counters.loopIndexedWriteFacts += 1;
        else if (fact.access === 'readWrite') counters.loopIndexedReadWriteFacts += 1;
        if (fact.space === 'rom') {
          counters.romReadFacts += 1;
          counters.loopIndexedRomFacts += 1;
        } else if (fact.access === 'read') {
          counters.ramReadFacts += 1;
          counters.loopIndexedRamFacts += 1;
        } else if (fact.access === 'write') {
          counters.ramWriteFacts += 1;
          counters.loopIndexedRamFacts += 1;
        } else if (fact.access === 'readWrite') {
          counters.ramReadWriteFacts += 1;
          counters.loopIndexedRamFacts += 1;
        }
        break;
      }
    }
  }

  return out;
}

export function createMemoryAccessCollector(graph, options = {}) {
  requireObject(graph, 'populateMemoryMap graph');
  const limits = { ...MEMORY_ACCESS_LIMITS, ...(options.limits || {}) };
  const instructionById = buildInstructionMap(graph.instructions, 'populateMemoryMap instructions');
  const maps = makeBlockMaps(graph);
  const blockInstances = Array.from(maps.blockInstanceById.values());
  const counters = makeCounters();
  const facts = [];

  let blockInstanceIndex = 0;
  let current = null;
  let instructionIndex = 0;
  let complete = false;
  let loopFacts = null;

  function finalizeLoopFacts() {
    if (!complete) return [];
    if (loopFacts !== null) return loopFacts;
    loopFacts = materializeLoopIndexedAccessFacts({
      graph,
      maps,
      instructionById,
      facts,
      counters,
      limits
    });
    return loopFacts;
  }

  function beginNextBlock() {
    current = null;
    instructionIndex = 0;

    while (blockInstanceIndex < blockInstances.length) {
      const blockInstance = blockInstances[blockInstanceIndex];
      blockInstanceIndex += 1;
      const block = maps.blockById.get(blockInstance.blockId);
      if (!block) throw new Error(`populateMemoryMap block instance ${blockInstance.blockInstanceId} references missing block ${blockInstance.blockId}`);
      const blockState = maps.blockStateById.get(blockInstance.blockInstanceId);
      if (!blockState) continue;
      let state = abstractStateFromSerializable(blockState.inState, { mapperDomain: graph.mapper.mapperDomain });
      if (isBottomState(state)) {
        counters.skippedBottomState += 1;
        continue;
      }

      counters.blockInstancesVisited += 1;
      current = {
        blockInstance,
        block,
        state,
        instructionIds: requireArray(block.instructionIds, `populateMemoryMap block ${block.blockId}.instructionIds`),
        env: {
          mapper: graph.mapper,
          prgBytes: graph.prgBytes,
          contexts: graph.contexts,
          contextKey: blockInstance.contextKey
        }
      };
      return true;
    }

    complete = true;
    return false;
  }

  function processInstruction() {
    if (complete) return false;
    if (!current && !beginNextBlock()) return false;

    if (instructionIndex >= current.instructionIds.length) {
      current = null;
      instructionIndex = 0;
      return true;
    }

    const instructionId = current.instructionIds[instructionIndex] >>> 0;
    instructionIndex += 1;
    const instruction = instructionById.get(instructionId);
    if (!instruction) throw new Error(`populateMemoryMap block ${current.block.blockId} references missing instruction ${instructionId}`);

    counters.instructionsReplayed += 1;
    const accessKind = memoryAccessKindForInstruction(instruction);
    if (accessKind) {
      const entry = opcodeEntryForAccess(instruction) || OPCODES[instruction.opcode & 0xff];
      const addressResolution = resolveCpuAddressValuesForInstruction(current.state, instruction, limits);
      if (!addressResolution.ok) {
        incrementCounter(counters, skipCounterName(addressResolution.reason));
      } else {
        if (accessKind === 'write') {
          const oamDmaFact = makeOamDmaFact({
            block: current.block,
            blockInstance: current.blockInstance,
            instruction,
            entry,
            state: current.state,
            addressResolution,
            factIndex: facts.length,
            counters,
            limits
          });
          if (oamDmaFact) {
            facts.push(oamDmaFact);
            counters.oamDmaFacts += 1;
          }
        }
        const classified = classifyResolvedAccess(current.state, addressResolution.values, accessKind, current.env, limits, { mapperDomain: graph.mapper.mapperDomain });
        if (!classified.ok) {
          incrementCounter(counters, skipCounterName(classified.reason));
        } else {
          const fact = makeFact({
            block: current.block,
            blockInstance: current.blockInstance,
            instruction,
            entry,
            accessKind,
            addressResolution,
            classified,
            factIndex: facts.length
          });
          facts.push(fact);
          counters.accessFacts += 1;
          if (fact.space === 'rom') counters.romReadFacts += 1;
          else if (fact.access === 'read') counters.ramReadFacts += 1;
          else if (fact.access === 'write') counters.ramWriteFacts += 1;
          else if (fact.access === 'readWrite') counters.ramReadWriteFacts += 1;
        }
      }
    }

    current.state = transferInstruction(cloneState(current.state, { mapperDomain: graph.mapper.mapperDomain }), instruction, current.env, { mapperDomain: graph.mapper.mapperDomain });
    return true;
  }

  function step(maxMilliseconds = DEFAULT_COLLECT_STEP_MS) {
    if (complete) return { status: 'complete' };
    const startedAt = Date.now();
    let didWork = false;
    while (!complete) {
      processInstruction();
      didWork = true;
      if (didWork && Date.now() - startedAt >= maxMilliseconds) break;
    }
    return { status: complete ? 'complete' : 'running' };
  }

  function progress() {
    return {
      stage: complete ? 'collectComplete' : 'collectAccessFacts',
      blockInstanceIndex: Math.min(blockInstanceIndex, blockInstances.length),
      blockInstanceCount: blockInstances.length,
      ...counters
    };
  }

  function result() {
    const extraFacts = finalizeLoopFacts();
    return {
      facts: extraFacts.length ? [...facts, ...extraFacts] : facts,
      counters: { ...counters }
    };
  }

  return { step, progress, result };
}

export function collectMemoryAccessFacts(graph, options = {}) {
  const collector = createMemoryAccessCollector(graph, options);
  while (collector.step(Number.MAX_SAFE_INTEGER).status !== 'complete') {
    // Intentionally empty: synchronous compatibility wrapper.
  }
  return collector.result();
}
