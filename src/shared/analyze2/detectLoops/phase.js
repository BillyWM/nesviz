import { ADDRESSING_MODES as AM } from '../../cpu6502/addressingModes.js';
import { OPCODES } from '../../cpu6502/opcodes.js';
import { NES_CPU_REGISTER_ADDRS } from '../../nes/namedRegisters.js';
import { canonicalizeCpuAddr } from '../../utils/addressUtils.js';
import { ANALYSIS_PHASE_IDS } from '../analysisConstants.js';
import { abstractStateFromSerializable, cloneState, isBottomState } from '../abstractInterpretation/state.js';
import { transferInstruction } from '../abstractInterpretation/transfer.js';
import { edgeKey } from '../cfgTopology/graphTopology.js';
import {
  flagsWrittenByMnemonic,
  isConditionalBranchMnemonic,
  predicateForBranchEdge
} from '../domains/flagEffects.js';
import { FLAG_VALUE } from '../domains/flagsDomain.js';
import {
  MEMORY_ACCESS_LIMITS,
  classifyResolvedAccess,
  resolveCpuAddressValuesForInstruction
} from '../semanticFacts/effectiveAddressSets.js';
import {
  buildInstructionMap,
  requireArray,
  requireInteger,
  requireObject,
  requireString
} from '../dataShape.js';
import { discoverLoopCandidates } from '../loopSummarization/loopCandidates.js';

function makeCounters(graphKind) {
  return {
    graphKind,
    candidateLoops: 0,
    detectedLoops: 0,
    skippedSummarizedLoops: 0,
    waitsForVblank: 0,
    waitsForSprite0Hit: 0,
    waitsForFlag: 0,
    spinLoop: 0
  };
}

function opcodeEntry(instruction) {
  requireObject(instruction, 'detectLoops instruction');
  requireInteger(instruction.opcode, 'detectLoops instruction.opcode');
  return OPCODES[instruction.opcode & 0xff] || null;
}

function instructionRecord(instruction, execution = null) {
  const entry = opcodeEntry(instruction);
  return {
    instruction,
    execution,
    entry,
    mnemonic: entry ? entry.mnemonic : '???',
    mode: entry ? entry.mode : null
  };
}

function mapByString(items, key, label) {
  const out = new Map();
  const arr = requireArray(items, label);
  for (let i = 0; i < arr.length; i += 1) {
    const item = requireObject(arr[i], `${label}[${i}]`);
    const id = requireString(item[key], `${label}[${i}].${key}`);
    if (out.has(id)) throw new Error(`Duplicate ${label} ${key} ${id}`);
    out.set(id, item);
  }
  return out;
}

function buildExecutionIndex(executions) {
  const out = new Map();
  for (const execution of requireArray(executions, 'detectLoops instructionExecutions')) {
    const item = requireObject(execution, 'detectLoops instructionExecution');
    const key = `${requireString(item.blockInstanceId, 'instructionExecution.blockInstanceId')}:${requireInteger(item.instructionId, 'instructionExecution.instructionId') >>> 0}`;
    out.set(key, item);
  }
  return out;
}

function buildBlockStateIndex(abstractInterpretation) {
  const out = new Map();
  const states = Array.isArray(abstractInterpretation?.blockStates) ? abstractInterpretation.blockStates : [];
  for (const state of states) {
    const item = requireObject(state, 'detectLoops blockState');
    out.set(requireString(item.blockInstanceId, 'detectLoops blockState.blockInstanceId'), item);
  }
  return out;
}

function makeIndexes(context) {
  return {
    context,
    instructionById: buildInstructionMap(context.instructions, 'detectLoops instructions'),
    blockById: mapByString(context.blocks, 'blockId', 'detectLoops blocks'),
    blockInstanceById: mapByString(context.blockInstances, 'blockInstanceId', 'detectLoops blockInstances'),
    executionByBlockAndInstruction: buildExecutionIndex(context.instructionExecutions),
    blockStateById: buildBlockStateIndex(context.abstractInterpretation)
  };
}

function recordsForBlockInstance(indexes, blockInstanceId) {
  const instance = indexes.blockInstanceById.get(blockInstanceId);
  if (!instance) return [];
  const block = indexes.blockById.get(instance.blockId);
  if (!block || !Array.isArray(block.instructionIds)) return [];

  return block.instructionIds.map((instructionId) => {
    const id = instructionId >>> 0;
    const instruction = indexes.instructionById.get(id);
    if (!instruction) return null;
    return instructionRecord(instruction, indexes.executionByBlockAndInstruction.get(`${blockInstanceId}:${id}`) || null);
  }).filter(Boolean);
}

function lastRecordForBlockInstance(indexes, blockInstanceId) {
  const records = recordsForBlockInstance(indexes, blockInstanceId);
  return records.length ? records[records.length - 1] : null;
}

function envForBlockInstance(indexes, blockInstance) {
  return {
    mapper: indexes.context.mapper,
    prgBytes: indexes.context.prgBytes,
    contexts: indexes.context.contexts,
    contextKey: blockInstance.contextKey
  };
}

function instructionStatesForBlockInstance(indexes, blockInstanceId) {
  const blockInstance = indexes.blockInstanceById.get(blockInstanceId);
  if (!blockInstance) return new Map();
  const block = indexes.blockById.get(blockInstance.blockId);
  if (!block || !Array.isArray(block.instructionIds)) return new Map();
  const blockState = indexes.blockStateById.get(blockInstanceId);
  if (!blockState) return new Map();

  const options = { mapperDomain: indexes.context.mapper.mapperDomain };
  let state = abstractStateFromSerializable(blockState.inState, options);
  if (isBottomState(state)) return new Map();

  const env = envForBlockInstance(indexes, blockInstance);
  const out = new Map();
  for (const instructionId of block.instructionIds) {
    const id = instructionId >>> 0;
    const instruction = indexes.instructionById.get(id);
    if (!instruction) continue;
    out.set(id, state);
    state = transferInstruction(cloneState(state, options), instruction, env, options);
  }
  return out;
}

function stateBeforeRecord(indexes, blockInstanceId, record) {
  if (!record) return null;
  const states = instructionStatesForBlockInstance(indexes, blockInstanceId);
  return states.get(record.instruction.instructionId >>> 0) || null;
}

function resolvedCpuAddrsForRecord(indexes, blockInstanceId, record) {
  const state = stateBeforeRecord(indexes, blockInstanceId, record);
  if (!state) return null;
  const resolved = resolveCpuAddressValuesForInstruction(state, record.instruction, MEMORY_ACCESS_LIMITS);
  if (!resolved.ok) return null;
  return resolved.values.map((value) => value & 0xffff);
}

function resolvedAccessForRecord(indexes, blockInstanceId, record, accessKind) {
  const state = stateBeforeRecord(indexes, blockInstanceId, record);
  const blockInstance = indexes.blockInstanceById.get(blockInstanceId);
  if (!state || !blockInstance) return null;
  const resolved = resolveCpuAddressValuesForInstruction(state, record.instruction, MEMORY_ACCESS_LIMITS);
  if (!resolved.ok) return null;
  const classified = classifyResolvedAccess(state, resolved.values, accessKind, envForBlockInstance(indexes, blockInstance), MEMORY_ACCESS_LIMITS, {
    mapperDomain: indexes.context.mapper.mapperDomain
  });
  return classified.ok ? classified : null;
}

function operandCpuAddr(record) {
  if (!record || !Number.isInteger(record.instruction?.operand)) return null;
  if (record.mode === AM.ZERO_PAGE || record.mode === AM.ZERO_PAGE_X || record.mode === AM.ZERO_PAGE_Y) {
    return record.instruction.operand & 0xff;
  }
  if (record.mode === AM.ABSOLUTE || record.mode === AM.ABSOLUTE_X || record.mode === AM.ABSOLUTE_Y) {
    return record.instruction.operand & 0xffff;
  }
  return null;
}

function directOperandCpuAddr(record) {
  if (!record || !Number.isInteger(record.instruction?.operand)) return null;
  if (record.mode === AM.ZERO_PAGE) return record.instruction.operand & 0xff;
  if (record.mode === AM.ABSOLUTE) return record.instruction.operand & 0xffff;
  return null;
}

function isPpuStatusAddr(cpuAddr) {
  if (!Number.isInteger(cpuAddr)) return false;
  const addr = cpuAddr & 0xffff;
  if (addr < 0x2000 || addr > 0x3fff) return false;
  return ((addr - NES_CPU_REGISTER_ADDRS.PPUSTATUS_2002) & 0x07) === 0;
}

function canonicalRamSource(record) {
  const cpuAddr = directOperandCpuAddr(record);
  if (cpuAddr === null) return null;
  const canonical = canonicalizeCpuAddr(cpuAddr);
  if (canonical.space !== 'zp' && canonical.space !== 'ram') return null;
  return {
    cpuAddr,
    canonicalRamAddr: canonical.addr & 0x07ff,
    addressSpace: canonical.space
  };
}

function branchInfo(candidate, indexes) {
  const record = lastRecordForBlockInstance(indexes, candidate.tailBlockInstanceId);
  if (!record || !record.entry || record.mode !== AM.RELATIVE || !isConditionalBranchMnemonic(record.mnemonic)) return null;
  const reentryPredicate = predicateForBranchEdge(record.mnemonic, candidate.reentryEdge.kind);
  if (!reentryPredicate) return null;
  return { record, reentryPredicate };
}

function findFlagSourceBefore(records, branchRecord, predicate) {
  const branchIndex = records.findIndex((record) => record.instruction.instructionId === branchRecord.instruction.instructionId);
  if (branchIndex < 0) return null;
  for (let index = branchIndex - 1; index >= 0; index -= 1) {
    const record = records[index];
    const written = flagsWrittenByMnemonic(record.mnemonic);
    if (written.has(predicate.flag)) return { record, index };
  }
  return null;
}

function clobbersAccumulator(record) {
  if (!record || !record.entry) return false;
  const mnemonic = record.mnemonic;
  if (mnemonic === 'LDA' || mnemonic === 'TXA' || mnemonic === 'TYA' || mnemonic === 'PLA') return true;
  if (mnemonic === 'ADC' || mnemonic === 'SBC' || mnemonic === 'AND' || mnemonic === 'ORA' || mnemonic === 'EOR') return true;
  return (mnemonic === 'ASL' || mnemonic === 'LSR' || mnemonic === 'ROL' || mnemonic === 'ROR') && record.mode === AM.ACCUMULATOR;
}

function findAccumulatorLoadBefore(records, beforeIndex, predicate) {
  for (let cursor = beforeIndex - 1; cursor >= 0; cursor -= 1) {
    const record = records[cursor];
    if (record.mnemonic === 'LDA' && predicate(record)) return { record, index: cursor };
    if (clobbersAccumulator(record)) return null;
  }
  return null;
}

function ppuStatusReadSource(record, indexes, blockInstanceId) {
  const sourceAddr = operandCpuAddr(record);
  if (isPpuStatusAddr(sourceAddr)) return true;
  const readAddrs = resolvedCpuAddrsForRecord(indexes, blockInstanceId, record);
  return !!(readAddrs && readAddrs.some((addr) => isPpuStatusAddr(addr)));
}

function ppuStatusSourceForPredicate(records, branchRecord, predicate, indexes, blockInstanceId) {
  const source = findFlagSourceBefore(records, branchRecord, predicate);
  if (!source) return null;
  const sourceRecord = source.record;

  if ((sourceRecord.mnemonic === 'BIT' || sourceRecord.mnemonic === 'LDA')
    && ppuStatusReadSource(sourceRecord, indexes, blockInstanceId)) {
    return { sourceRecord, readRecord: sourceRecord, statusMask: sourceRecord.mnemonic === 'BIT' ? null : 0x80 };
  }

  if (sourceRecord.mnemonic === 'AND' && sourceRecord.mode === AM.IMMEDIATE) {
    const previous = findAccumulatorLoadBefore(
      records,
      source.index,
      (record) => ppuStatusReadSource(record, indexes, blockInstanceId)
    );
    if (previous) {
      return { sourceRecord, readRecord: previous.record, statusMask: sourceRecord.instruction.operand & 0xff };
    }
  }

  return null;
}

function classifyPpuStatusWait(candidate, indexes, kind, sourceMatcher) {
  const branch = branchInfo(candidate, indexes);
  if (!branch) return null;

  const records = recordsForBlockInstance(indexes, candidate.tailBlockInstanceId);
  const source = ppuStatusSourceForPredicate(records, branch.record, branch.reentryPredicate, indexes, candidate.tailBlockInstanceId);
  if (!source) return null;
  if (!sourceMatcher(source, branch.reentryPredicate)) return null;

  const readAddrs = resolvedCpuAddrsForRecord(indexes, candidate.tailBlockInstanceId, source.readRecord);
  if (readAddrs && !readAddrs.some((addr) => isPpuStatusAddr(addr))) return null;

  return makeDetectedLoop({ candidate, kind, branchRecord: branch.record, evidence: {
    branchInstructionId: branch.record.instruction.instructionId >>> 0,
    flagSourceInstructionId: source.sourceRecord.instruction.instructionId >>> 0,
    readInstructionId: source.readRecord.instruction.instructionId >>> 0,
    ppuRegister: 'PPUSTATUS_2002'
  } });
}

function classifyWaitsForVblank(candidate, indexes) {
  return classifyPpuStatusWait(candidate, indexes, 'waitsForVblank', (source, predicate) => (
    (source.sourceRecord.mnemonic === 'BIT' && predicate.flag === 'n' && predicate.value === FLAG_VALUE.FALSE) ||
    (source.sourceRecord.mnemonic === 'LDA' && predicate.flag === 'n' && predicate.value === FLAG_VALUE.FALSE) ||
    (source.sourceRecord.mnemonic === 'AND' && (source.statusMask & 0x80) !== 0 && predicate.flag === 'z' && predicate.value === FLAG_VALUE.TRUE)
  ));
}

function classifyWaitsForSprite0Hit(candidate, indexes) {
  return classifyPpuStatusWait(candidate, indexes, 'waitsForSprite0Hit', (source, predicate) => (
    (source.sourceRecord.mnemonic === 'BIT' && predicate.flag === 'v' && predicate.value === FLAG_VALUE.FALSE) ||
    (source.sourceRecord.mnemonic === 'AND' && (source.statusMask & 0x40) !== 0 && predicate.flag === 'z' && predicate.value === FLAG_VALUE.TRUE)
  ));
}

function directRamWriteTarget(record) {
  const cpuAddr = directOperandCpuAddr(record);
  if (cpuAddr === null) return null;
  const canonical = canonicalizeCpuAddr(cpuAddr);
  if (canonical.space !== 'zp' && canonical.space !== 'ram') return null;
  return {
    cpuAddr,
    canonicalRamAddr: canonical.addr & 0x07ff,
    addressSpace: canonical.space
  };
}

function memoryWriteAccessKind(record) {
  const mnemonic = record?.mnemonic;
  if (mnemonic === 'STA' || mnemonic === 'STX' || mnemonic === 'STY') return 'write';
  if (mnemonic === 'INC' || mnemonic === 'DEC') return 'readWrite';
  if ((mnemonic === 'ASL' || mnemonic === 'LSR' || mnemonic === 'ROL' || mnemonic === 'ROR') && record.mode !== AM.ACCUMULATOR) return 'readWrite';
  return null;
}

function loopWritesWatchedRam(candidate, indexes, watched) {
  for (const blockInstanceId of candidate.bodyBlockInstanceIds) {
    for (const record of recordsForBlockInstance(indexes, blockInstanceId)) {
      const accessKind = memoryWriteAccessKind(record);
      if (!accessKind) continue;
      const classified = resolvedAccessForRecord(indexes, blockInstanceId, record, accessKind);
      if (classified && classified.space === 'ram') {
        if (classified.values.some((value) => (value & 0x07ff) === (watched.canonicalRamAddr & 0x07ff))) return true;
        continue;
      }
      const target = directRamWriteTarget(record);
      if (target) {
        if ((target.canonicalRamAddr & 0x07ff) === (watched.canonicalRamAddr & 0x07ff)) return true;
        continue;
      }
      const cpuAddr = operandCpuAddr(record);
      const canonical = cpuAddr === null ? null : canonicalizeCpuAddr(cpuAddr);
      if (!canonical || canonical.space === 'zp' || canonical.space === 'ram') return true;
    }
  }
  return false;
}

function canonicalRamReadSource(record, indexes, blockInstanceId) {
  const direct = canonicalRamSource(record);
  const classified = resolvedAccessForRecord(indexes, blockInstanceId, record, 'read');
  if (classified && classified.space === 'ram' && classified.values.length === 1) {
    return {
      cpuAddr: direct ? direct.cpuAddr : (classified.values[0] & 0x07ff),
      canonicalRamAddr: classified.values[0] & 0x07ff,
      addressSpace: (classified.values[0] & 0x07ff) < 0x0100 ? 'zp' : 'ram'
    };
  }
  return direct;
}

function ramFlagSourceForPredicate(records, branchRecord, predicate, indexes, blockInstanceId) {
  const source = findFlagSourceBefore(records, branchRecord, predicate);
  if (!source) return null;
  const sourceRecord = source.record;
  if (sourceRecord.mnemonic === 'LDA' || sourceRecord.mnemonic === 'LDX' || sourceRecord.mnemonic === 'LDY' || sourceRecord.mnemonic === 'BIT') {
    const watched = canonicalRamReadSource(sourceRecord, indexes, blockInstanceId);
    if (!watched) return null;
    return { sourceRecord, readRecord: sourceRecord, watched };
  }
  if (sourceRecord.mnemonic === 'AND' && sourceRecord.mode === AM.IMMEDIATE && predicate.flag === 'z') {
    const previous = findAccumulatorLoadBefore(
      records,
      source.index,
      (record) => !!canonicalRamReadSource(record, indexes, blockInstanceId)
    );
    if (!previous) return null;
    const watched = canonicalRamReadSource(previous.record, indexes, blockInstanceId);
    if (!watched) return null;
    return { sourceRecord, readRecord: previous.record, watched };
  }
  return null;
}

function classifyWaitsForFlag(candidate, indexes) {
  if (!candidate.exitEdges.length) return null;
  const branch = branchInfo(candidate, indexes);
  if (!branch) return null;

  const records = recordsForBlockInstance(indexes, candidate.tailBlockInstanceId);
  const source = ramFlagSourceForPredicate(records, branch.record, branch.reentryPredicate, indexes, candidate.tailBlockInstanceId);
  if (!source) return null;
  const classified = resolvedAccessForRecord(indexes, candidate.tailBlockInstanceId, source.readRecord, 'read');
  if (classified && classified.space === 'ram' && classified.values.length === 1) {
    source.watched = {
      cpuAddr: source.watched.cpuAddr,
      canonicalRamAddr: classified.values[0] & 0x07ff,
      addressSpace: (classified.values[0] & 0x07ff) < 0x0100 ? 'zp' : 'ram'
    };
  }
  if (loopWritesWatchedRam(candidate, indexes, source.watched)) return null;

  return makeDetectedLoop({ candidate, kind: 'waitsForFlag', branchRecord: branch.record, evidence: {
    branchInstructionId: branch.record.instruction.instructionId >>> 0,
    flagSourceInstructionId: source.sourceRecord.instruction.instructionId >>> 0,
    readInstructionId: source.readRecord.instruction.instructionId >>> 0,
    watchedAddress: {
      addressSpace: source.watched.addressSpace,
      cpuAddr: source.watched.cpuAddr & 0xffff,
      canonicalRamAddr: source.watched.canonicalRamAddr & 0x07ff
    }
  } });
}

function classifySpinLoop(candidate, indexes) {
  if (candidate.exitEdges.length !== 0) return null;
  const tail = lastRecordForBlockInstance(indexes, candidate.tailBlockInstanceId);
  return makeDetectedLoop({ candidate, kind: 'spinLoop', branchRecord: tail, evidence: {
    branchInstructionId: tail ? (tail.instruction.instructionId >>> 0) : null
  } });
}

function makeDetectedLoop({ candidate, kind, branchRecord, evidence }) {
  const exitEdge = candidate.exitEdges[0] || null;
  return {
    loopId: `detectedLoop:${candidate.loopId}`,
    sourceLoopId: candidate.loopId,
    kind,
    confidence: 'proved',
    headerBlockInstanceId: candidate.headerBlockInstanceId,
    tailBlockInstanceId: candidate.tailBlockInstanceId,
    bodyBlockInstanceIds: [...candidate.bodyBlockInstanceIds],
    reentryEdgeKey: candidate.reentryEdgeKey,
    exitEdgeKey: exitEdge ? edgeKey(exitEdge) : null,
    depth: candidate.depth,
    evidence: {
      ...evidence,
      tailInstructionId: branchRecord ? (branchRecord.instruction.instructionId >>> 0) : null
    }
  };
}

function summarizedReentryEdgeKeys(loopSummaries) {
  const out = new Set();
  if (loopSummaries?.byReentryEdgeKey instanceof Map) {
    for (const key of loopSummaries.byReentryEdgeKey.keys()) out.add(key);
  }
  for (const summary of Array.isArray(loopSummaries?.summaries) ? loopSummaries.summaries : []) {
    if (typeof summary?.reentryEdgeKey === 'string') out.add(summary.reentryEdgeKey);
  }
  return out;
}

function classifyCandidate(candidate, indexes) {
  return classifyWaitsForVblank(candidate, indexes) ||
    classifyWaitsForSprite0Hit(candidate, indexes) ||
    classifyWaitsForFlag(candidate, indexes) ||
    classifySpinLoop(candidate, indexes);
}

function incrementKindCounter(counters, kind) {
  if (kind === 'waitsForVblank') counters.waitsForVblank += 1;
  else if (kind === 'waitsForSprite0Hit') counters.waitsForSprite0Hit += 1;
  else if (kind === 'waitsForFlag') counters.waitsForFlag += 1;
  else if (kind === 'spinLoop') counters.spinLoop += 1;
}

export function createDetectLoopsPhase(context, options = null) {
  const opts = options === null || options === undefined ? {} : requireObject(options, 'detectLoops options');
  const graphKind = typeof opts.graphKind === 'string' ? opts.graphKind : 'exactOnly';
  let counters = makeCounters(graphKind);

  return {
    name: ANALYSIS_PHASE_IDS.DETECT_LOOPS,
    stepOne() {
      counters = makeCounters(graphKind);
      const topology = requireObject(context.cfgTopology, 'detectLoops cfgTopology');
      if (topology.graphKind !== graphKind) {
        throw new Error(`detectLoops graphKind ${graphKind} does not match cfgTopology graphKind ${topology.graphKind}`);
      }
      requireObject(context.abstractInterpretation, 'detectLoops abstractInterpretation');

      const candidates = discoverLoopCandidates({ topology, edges: context.edgesForGraph() });
      const summarized = summarizedReentryEdgeKeys(context.loopSummaries);
      const indexes = makeIndexes(context);
      const loops = [];
      counters.candidateLoops = candidates.length;

      for (const candidate of candidates) {
        if (summarized.has(candidate.reentryEdgeKey)) {
          counters.skippedSummarizedLoops += 1;
          continue;
        }
        const detected = classifyCandidate(candidate, indexes);
        if (!detected) continue;
        loops.push(detected);
        counters.detectedLoops += 1;
        incrementKindCounter(counters, detected.kind);
      }

      context.loopDetections = {
        producedBy: ANALYSIS_PHASE_IDS.DETECT_LOOPS,
        graphKind,
        loops,
        counters: { ...counters }
      };
      context.diagnostics.phaseSummaries.push({
        name: ANALYSIS_PHASE_IDS.DETECT_LOOPS,
        status: 'complete',
        counters: { ...counters }
      });
      return { status: 'complete', progress: this.progress() };
    },
    progress() {
      return {
        phase: ANALYSIS_PHASE_IDS.DETECT_LOOPS,
        detailKind: 'detectLoops',
        details: { ...counters }
      };
    }
  };
}
