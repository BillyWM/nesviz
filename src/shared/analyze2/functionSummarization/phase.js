import { ADDRESSING_MODES as AM } from '../../cpu6502/addressingModes.js';
import { OPCODES } from '../../cpu6502/opcodes.js';
import { canonicalizeCpuAddr } from '../../utils/addressUtils.js';
import { ANALYSIS_PHASE_IDS } from '../analysisConstants.js';
import { EDGE_KINDS, FLOW_TYPES, isExecutableEdgeKind } from '../cfg/constants.js';
import { requireArray, requireObject } from '../dataShape.js';
import { flagsWrittenByMnemonic } from '../domains/flagEffects.js';
import { WRITE_EFFECT_KINDS, classifyCpuWriteEffect } from '../mapper/writeEffects.js';

const STORE_MNEMONICS = new Set(['STA', 'STX', 'STY']);
const MEMORY_RMW_MNEMONICS = new Set(['ASL', 'LSR', 'ROL', 'ROR', 'INC', 'DEC']);
const STACK_PUSH_PULL_MNEMONICS = new Set(['PHA', 'PHP', 'PLA', 'PLP']);
const EXPLICIT_STACK_MNEMONICS = new Set(['PHA', 'PHP', 'PLA', 'PLP', 'TSX', 'TXS']);
const STACK_POINTER_MNEMONICS = new Set(['PHA', 'PHP', 'PLA', 'PLP', 'JSR', 'RTS', 'RTI', 'TXS']);
const FUNCTION_SUMMARY_EFFECT_VERSION = 7;
const STACK_DEPTH_LIMIT = 64;
const AND_EFFECT_KEYS = new Set([
  'normalCallReturnOnly'
]);
const STACK_EFFECT_KEYS = new Set([
  'usesExplicitStack',
  'normalCallReturnOnly',
  'mayChangeStackPointer',
  'usesTsx',
  'usesTxs',
  'explicitStackDeltaKnown',
  'explicitStackDelta',
  'explicitStackMinDepth',
  'explicitStackMaxDepth',
  'explicitStackBalanced',
  'explicitStackUnbalancedReturn',
  'mayReadCallerStack',
  'mayWriteCallerStack',
  'stackContentsPreserved',
  'mayWriteStackRange',
  'stackReturnSafe'
]);
const DERIVED_EFFECT_KEYS = new Set([
  'alwaysReturnsNormally',
  'mapperUnchanged',
  'clobbersRegister',
  'doesntClobberA',
  'doesntClobberX',
  'doesntClobberY',
  'doesntClobberRegisters',
  'clobbersFlags',
  'doesntClobberN',
  'doesntClobberV',
  'doesntClobberD',
  'doesntClobberI',
  'doesntClobberZ',
  'doesntClobberC',
  'doesntClobberFlags',
  'stackContentsPreserved',
  'stackReturnSafe',
  'ramUnchanged'
]);

function emptyEffects() {
  return {
    mayReturnNormally: false,
    alwaysReturnsNormally: false,
    mayNotReturn: false,
    mayNotReturnWithoutTailJump: false,
    mayNotReturnWithoutTailJumpOrBoundary: false,
    mayTailJump: false,
    hasIndirectControl: false,
    callsUnknownTarget: false,
    hasRtsTrickOrUnknownReturn: false,

    mayWriteMapper: false,
    mapperWriteRanges: [],
    unknownMapperEffect: false,
    mapperUnchanged: false,

    clobbersA: false,
    clobbersX: false,
    clobbersY: false,
    clobbersRegister: false,
    doesntClobberA: true,
    doesntClobberX: true,
    doesntClobberY: true,
    doesntClobberRegisters: true,

    clobbersN: false,
    clobbersV: false,
    clobbersD: false,
    clobbersI: false,
    clobbersZ: false,
    clobbersC: false,
    clobbersFlags: false,
    doesntClobberN: true,
    doesntClobberV: true,
    doesntClobberD: true,
    doesntClobberI: true,
    doesntClobberZ: true,
    doesntClobberC: true,
    doesntClobberFlags: true,

    usesExplicitStack: false,
    normalCallReturnOnly: true,
    mayChangeStackPointer: false,
    usesTsx: false,
    usesTxs: false,
    explicitStackDeltaKnown: true,
    explicitStackDelta: 0,
    explicitStackMinDepth: 0,
    explicitStackMaxDepth: 0,
    explicitStackBalanced: true,
    explicitStackUnbalancedReturn: false,
    mayReadCallerStack: false,
    mayWriteCallerStack: false,
    stackContentsPreserved: true,
    mayWriteStackRange: false,
    stackReturnSafe: false,

    mayWriteRam: false,
    ramWriteRanges: [],
    mayWriteZeroPage: false,
    mayWriteStackRam: false,
    mayWriteUnknownRam: false,
    ramUnchanged: false
  };
}

function cloneEffects(effects) {
  return {
    ...effects,
    mapperWriteRanges: (effects.mapperWriteRanges || []).map((range) => ({ ...range })),
    ramWriteRanges: (effects.ramWriteRanges || []).map((range) => ({ ...range }))
  };
}

function finishConvenience(effects) {
  if (!Number.isFinite(effects.explicitStackDelta)) effects.explicitStackDelta = 0;
  if (!Number.isFinite(effects.explicitStackMinDepth)) effects.explicitStackMinDepth = 0;
  if (!Number.isFinite(effects.explicitStackMaxDepth)) effects.explicitStackMaxDepth = 0;
  if (effects.explicitStackDeltaKnown !== false) effects.explicitStackDeltaKnown = true;
  effects.explicitStackBalanced = effects.explicitStackDeltaKnown &&
    effects.explicitStackDelta === 0 &&
    effects.explicitStackUnbalancedReturn !== true;

  effects.clobbersRegister = effects.clobbersA || effects.clobbersX || effects.clobbersY;
  effects.doesntClobberA = !effects.clobbersA;
  effects.doesntClobberX = !effects.clobbersX;
  effects.doesntClobberY = !effects.clobbersY;
  effects.doesntClobberRegisters = !effects.clobbersRegister;

  effects.clobbersFlags = effects.clobbersN || effects.clobbersV || effects.clobbersD ||
    effects.clobbersI || effects.clobbersZ || effects.clobbersC;
  effects.doesntClobberN = !effects.clobbersN;
  effects.doesntClobberV = !effects.clobbersV;
  effects.doesntClobberD = !effects.clobbersD;
  effects.doesntClobberI = !effects.clobbersI;
  effects.doesntClobberZ = !effects.clobbersZ;
  effects.doesntClobberC = !effects.clobbersC;
  effects.doesntClobberFlags = !effects.clobbersFlags;

  effects.mapperUnchanged = !effects.mayWriteMapper && !effects.unknownMapperEffect;
  effects.ramUnchanged = !effects.mayWriteRam && !effects.mayWriteUnknownRam;
  effects.stackContentsPreserved = !effects.usesExplicitStack && !effects.mayWriteStackRange;
  effects.stackReturnSafe = effects.normalCallReturnOnly &&
    effects.explicitStackDeltaKnown &&
    effects.explicitStackBalanced &&
    effects.explicitStackMinDepth >= 0 &&
    !effects.mayReadCallerStack &&
    !effects.mayWriteCallerStack &&
    !effects.mayWriteStackRange &&
    !effects.hasRtsTrickOrUnknownReturn;
  return effects;
}

function addRange(ranges, start, endInclusive) {
  let normalized = {
    start: Number(start) & 0xffff,
    endInclusive: Number(endInclusive) & 0xffff
  };
  if (normalized.endInclusive < normalized.start) {
    addRange(ranges, normalized.start, 0xffff);
    addRange(ranges, 0, normalized.endInclusive);
    return;
  }
  const kept = [];
  for (const range of ranges) {
    if (range.endInclusive + 1 < normalized.start || normalized.endInclusive + 1 < range.start) {
      kept.push(range);
      continue;
    }
    normalized = {
      start: Math.min(normalized.start, range.start),
      endInclusive: Math.max(normalized.endInclusive, range.endInclusive)
    };
  }
  ranges.length = 0;
  ranges.push(...kept);
  ranges.push(normalized);
  ranges.sort((a, b) => a.start - b.start || a.endInclusive - b.endInclusive);
}

function mergeRanges(target, source) {
  for (const range of source || []) addRange(target, range.start, range.endInclusive);
}

function effectsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function joinEffects(a, b) {
  const out = cloneEffects(a);
  for (const [key, value] of Object.entries(b)) {
    if (key === 'mapperWriteRanges' || key === 'ramWriteRanges') continue;
    if (STACK_EFFECT_KEYS.has(key)) continue;
    if (DERIVED_EFFECT_KEYS.has(key)) continue;
    if (AND_EFFECT_KEYS.has(key)) {
      out[key] = Boolean(out[key]) && Boolean(value);
      continue;
    }
    if (typeof value === 'boolean') out[key] = out[key] || value;
  }
  mergeRanges(out.mapperWriteRanges, b.mapperWriteRanges);
  mergeRanges(out.ramWriteRanges, b.ramWriteRanges);
  return finishConvenience(out);
}

function composeStackEffects(out, caller, callee) {
  out.usesExplicitStack = caller.usesExplicitStack || callee.usesExplicitStack;
  out.normalCallReturnOnly = caller.normalCallReturnOnly && callee.normalCallReturnOnly;
  out.mayChangeStackPointer = caller.mayChangeStackPointer || callee.mayChangeStackPointer;
  out.usesTsx = caller.usesTsx || callee.usesTsx;
  out.usesTxs = caller.usesTxs || callee.usesTxs;
  out.mayWriteStackRange = caller.mayWriteStackRange || callee.mayWriteStackRange;
  out.mayReadCallerStack = caller.mayReadCallerStack || callee.mayReadCallerStack;
  out.mayWriteCallerStack = caller.mayWriteCallerStack || callee.mayWriteCallerStack;
  out.explicitStackUnbalancedReturn = caller.explicitStackUnbalancedReturn || callee.explicitStackUnbalancedReturn;

  const callerKnown = caller.explicitStackDeltaKnown !== false;
  const calleeKnown = callee.explicitStackDeltaKnown !== false;
  out.explicitStackDeltaKnown = callerKnown && calleeKnown;
  if (!out.explicitStackDeltaKnown) {
    out.explicitStackDelta = 0;
    out.explicitStackMinDepth = 0;
    out.explicitStackMaxDepth = 0;
    out.explicitStackBalanced = false;
    return out;
  }

  const callerDelta = caller.explicitStackDelta || 0;
  const calleeDelta = callee.explicitStackDelta || 0;
  const calleeMin = callee.explicitStackMinDepth || 0;
  const calleeMax = callee.explicitStackMaxDepth || 0;
  out.explicitStackDelta = callerDelta + calleeDelta;
  out.explicitStackMinDepth = Math.min(caller.explicitStackMinDepth || 0, callerDelta + calleeMin);
  out.explicitStackMaxDepth = Math.max(caller.explicitStackMaxDepth || 0, callerDelta + calleeMax);
  if (callerDelta + calleeMin < 0) out.mayReadCallerStack = true;
  if (callerDelta < 0 && callee.usesExplicitStack) out.mayWriteCallerStack = true;
  return out;
}

function joinCalleeEffects(caller, callee) {
  const out = joinEffects(caller, callee);
  composeStackEffects(out, caller, callee);
  out.mayReturnNormally = caller.mayReturnNormally;
  out.mayNotReturn = caller.mayNotReturn ||
    callee.mayNotReturn ||
    callee.mayTailJump ||
    callee.hasIndirectControl ||
    callee.callsUnknownTarget ||
    callee.hasRtsTrickOrUnknownReturn;
  out.mayNotReturnWithoutTailJump = caller.mayNotReturnWithoutTailJump ||
    callee.mayNotReturn ||
    callee.mayTailJump ||
    callee.hasIndirectControl ||
    callee.callsUnknownTarget ||
    callee.hasRtsTrickOrUnknownReturn;
  out.mayNotReturnWithoutTailJumpOrBoundary = caller.mayNotReturnWithoutTailJumpOrBoundary ||
    callee.mayNotReturn ||
    callee.mayTailJump ||
    callee.hasIndirectControl ||
    callee.callsUnknownTarget ||
    callee.hasRtsTrickOrUnknownReturn;
  out.mayTailJump = caller.mayTailJump || callee.mayTailJump;
  out.alwaysReturnsNormally = out.mayReturnNormally &&
    !out.mayNotReturn &&
    !out.mayTailJump &&
    !out.hasIndirectControl &&
    !out.callsUnknownTarget &&
    !out.hasRtsTrickOrUnknownReturn;
  return finishConvenience(out);
}

function opcodeEntry(instruction) {
  return OPCODES[Number(instruction.opcode) & 0xff] || null;
}

function instructionWritesMemory(entry) {
  if (!entry) return false;
  if (STORE_MNEMONICS.has(entry.mnemonic)) return true;
  if (MEMORY_RMW_MNEMONICS.has(entry.mnemonic)) return entry.mode !== AM.ACCUMULATOR;
  return false;
}

function registerWritesFor(entry) {
  if (!entry) return [];
  const { mnemonic, mode } = entry;
  const out = [];
  if (mnemonic === 'LDA' || mnemonic === 'ADC' || mnemonic === 'SBC' || mnemonic === 'AND' ||
      mnemonic === 'ORA' || mnemonic === 'EOR' || mnemonic === 'PLA' || mnemonic === 'TXA' ||
      mnemonic === 'TYA') out.push('a');
  if ((mnemonic === 'ASL' || mnemonic === 'LSR' || mnemonic === 'ROL' || mnemonic === 'ROR') && mode === AM.ACCUMULATOR) out.push('a');
  if (mnemonic === 'LDX' || mnemonic === 'INX' || mnemonic === 'DEX' || mnemonic === 'TAX' || mnemonic === 'TSX') out.push('x');
  if (mnemonic === 'LDY' || mnemonic === 'INY' || mnemonic === 'DEY' || mnemonic === 'TAY') out.push('y');
  return out;
}

function writeAddressesForInstruction(entry, instruction) {
  const operand = Number(instruction.operand) & 0xffff;
  if (!instructionWritesMemory(entry)) return { kind: 'none', values: [] };
  if (entry.mode === AM.ZERO_PAGE) return { kind: 'known', values: [operand & 0xff] };
  if (entry.mode === AM.ZERO_PAGE_X || entry.mode === AM.ZERO_PAGE_Y) {
    return { kind: 'known', values: Array.from({ length: 256 }, (_, index) => (operand + index) & 0xff) };
  }
  if (entry.mode === AM.ABSOLUTE) return { kind: 'known', values: [operand & 0xffff] };
  if (entry.mode === AM.ABSOLUTE_X || entry.mode === AM.ABSOLUTE_Y) {
    return { kind: 'known', values: Array.from({ length: 256 }, (_, index) => (operand + index) & 0xffff) };
  }
  if (entry.mode === AM.INDIRECT_X || entry.mode === AM.INDIRECT_Y) return { kind: 'unknownIndirect', values: [] };
  return { kind: 'unknown', values: [] };
}

function applyRegisterAndFlagEffects(effects, entry) {
  for (const register of registerWritesFor(entry)) {
    if (register === 'a') effects.clobbersA = true;
    if (register === 'x') effects.clobbersX = true;
    if (register === 'y') effects.clobbersY = true;
  }
  const writtenFlags = flagsWrittenByMnemonic(entry?.mnemonic || '');
  if (writtenFlags.has('n')) effects.clobbersN = true;
  if (writtenFlags.has('v')) effects.clobbersV = true;
  if (writtenFlags.has('d')) effects.clobbersD = true;
  if (writtenFlags.has('i')) effects.clobbersI = true;
  if (writtenFlags.has('z')) effects.clobbersZ = true;
  if (writtenFlags.has('c')) effects.clobbersC = true;
}

function applyControlEffects(effects, instruction, entry, functionInfo) {
  const flow = instruction.flow || {};
  if (flow.type === FLOW_TYPES.STOP && flow.reason === 'rts') effects.mayReturnNormally = true;
  if (flow.type === FLOW_TYPES.STOP && flow.reason !== 'rts') {
    effects.mayNotReturn = true;
    effects.mayNotReturnWithoutTailJump = true;
    effects.mayNotReturnWithoutTailJumpOrBoundary = true;
    if (flow.reason === 'rti') effects.hasRtsTrickOrUnknownReturn = true;
  }
  if (flow.type === FLOW_TYPES.JMP_INDIRECT) {
    effects.hasIndirectControl = true;
    effects.mayNotReturn = true;
    effects.mayNotReturnWithoutTailJump = true;
    effects.mayNotReturnWithoutTailJumpOrBoundary = true;
  }
  if (entry?.mnemonic === 'RTI') effects.hasRtsTrickOrUnknownReturn = true;
  if (functionInfo.tailJumpInstructionIds.has(instruction.instructionId >>> 0)) {
    effects.mayTailJump = true;
    effects.mayNotReturn = true;
  }
  if (functionInfo.unknownCallInstructionIds.has(instruction.instructionId >>> 0)) {
    effects.callsUnknownTarget = true;
  }
}

function applyStackEffects(effects, entry) {
  if (!entry) return;
  if (EXPLICIT_STACK_MNEMONICS.has(entry.mnemonic)) effects.usesExplicitStack = true;
  if (STACK_POINTER_MNEMONICS.has(entry.mnemonic)) effects.mayChangeStackPointer = true;
  if (entry.mnemonic === 'TSX') effects.usesTsx = true;
  if (entry.mnemonic === 'TXS') effects.usesTxs = true;
  if (entry.mnemonic === 'TXS') {
    effects.explicitStackDeltaKnown = false;
    effects.explicitStackBalanced = false;
  }
  if (entry.mnemonic === 'TXS') effects.normalCallReturnOnly = false;
}

function explicitStackDeltaForMnemonic(mnemonic) {
  if (mnemonic === 'PHA' || mnemonic === 'PHP') return 1;
  if (mnemonic === 'PLA' || mnemonic === 'PLP') return -1;
  return 0;
}

function addDepthToSet(depths, depth) {
  if (!Number.isInteger(depth)) return false;
  if (Math.abs(depth) > STACK_DEPTH_LIMIT) return false;
  depths.add(depth);
  return depths.size <= STACK_DEPTH_LIMIT;
}

function cloneDepthSet(depths) {
  return new Set(depths || []);
}

function unionDepthSets(target, source) {
  let changed = false;
  for (const depth of source || []) {
    if (target.has(depth)) continue;
    if (!addDepthToSet(target, depth)) return { changed: true, ok: false };
    changed = true;
  }
  return { changed, ok: true };
}

function internalStackSuccessors(blockInstanceId, functionInfo, indexes, bodySet = functionInfo.body) {
  const out = [];
  for (const edge of indexes.outgoingByBlockInstanceId.get(blockInstanceId) || []) {
    if (!isExecutableEdgeKind(edge.kind)) continue;
    if (!bodySet.has(edge.toBlockInstanceId)) continue;
    if (edge.kind === EDGE_KINDS.CALL || edge.kind === EDGE_KINDS.RETURN ||
        edge.kind === EDGE_KINDS.RTS_TRICK || edge.kind === EDGE_KINDS.PHYSICAL_CONTINUATION) continue;
    out.push(edge.toBlockInstanceId);
  }
  return out;
}

function blockHasReturnExit(blockInstanceId, functionInfo, indexes, includeEntryExits = false) {
  const instance = indexes.blockInstanceById.get(blockInstanceId);
  const block = instance ? indexes.blockById.get(instance.blockId) : null;
  const terminator = block ? blockTerminator(block, indexes.instructionById) : null;
  if (terminator?.flow?.type === FLOW_TYPES.STOP && terminator.flow.reason === 'rts') return true;
  if (!includeEntryExits) return false;
  for (const edge of indexes.outgoingByBlockInstanceId.get(blockInstanceId) || []) {
    if (!isExecutableEdgeKind(edge.kind)) continue;
    if (edge.kind === EDGE_KINDS.CALL || edge.kind === EDGE_KINDS.RETURN ||
        edge.kind === EDGE_KINDS.RTS_TRICK || edge.kind === EDGE_KINDS.PHYSICAL_CONTINUATION) continue;
    if (functionInfo.boundaryEntryBlockInstanceIds.has(edge.toBlockInstanceId)) return true;
    if (functionInfo.tailJumpTargetBlockInstanceIds.has(edge.toBlockInstanceId)) return true;
  }
  return false;
}

function transferStackDepthsThroughBlock(depths, block, indexes, effects) {
  let current = cloneDepthSet(depths);
  for (const instructionId of block.instructionIds || []) {
    const instruction = indexes.instructionById.get(instructionId >>> 0);
    const entry = instruction ? opcodeEntry(instruction) : null;
    const delta = explicitStackDeltaForMnemonic(entry?.mnemonic || '');
    if (delta === 0) continue;

    const next = new Set();
    for (const depth of current) {
      if (delta > 0 && depth < 0) effects.mayWriteCallerStack = true;
      if (delta < 0 && depth <= 0) effects.mayReadCallerStack = true;
      const nextDepth = depth + delta;
      effects.explicitStackMinDepth = Math.min(effects.explicitStackMinDepth, nextDepth);
      effects.explicitStackMaxDepth = Math.max(effects.explicitStackMaxDepth, nextDepth);
      if (!addDepthToSet(next, nextDepth)) {
        effects.explicitStackDeltaKnown = false;
        return null;
      }
    }
    current = next;
  }

  const terminator = blockTerminator(block, indexes.instructionById);
  if (terminator?.flow?.type === FLOW_TYPES.STOP && terminator.flow.reason === 'rts') {
    for (const depth of current) {
      if (depth !== 0) effects.explicitStackUnbalancedReturn = true;
    }
  }
  return current;
}

function applyFunctionStackDepthEffects(effects, functionInfo, indexes, bodySet = functionInfo.body, includeEntryExits = false) {
  if (effects.explicitStackDeltaKnown === false) return;

  const entryBlockInstanceId = functionInfo.entryBlockInstanceId;
  if (!bodySet.has(entryBlockInstanceId)) return;
  const inDepthsByBlock = new Map([[entryBlockInstanceId, new Set([0])]]);
  const queue = [entryBlockInstanceId];
  const queued = new Set(queue);
  const normalReturnDepths = new Set();

  while (queue.length) {
    const blockInstanceId = queue.shift();
    queued.delete(blockInstanceId);
    const inputDepths = inDepthsByBlock.get(blockInstanceId);
    const instance = indexes.blockInstanceById.get(blockInstanceId);
    const block = instance ? indexes.blockById.get(instance.blockId) : null;
    if (!inputDepths || !block) continue;

    const outputDepths = transferStackDepthsThroughBlock(inputDepths, block, indexes, effects);
    if (!outputDepths) return;

    const terminator = blockTerminator(block, indexes.instructionById);
    if (blockHasReturnExit(blockInstanceId, functionInfo, indexes, includeEntryExits)) {
      const result = unionDepthSets(normalReturnDepths, outputDepths);
      if (!result.ok) {
        effects.explicitStackDeltaKnown = false;
        return;
      }
    }

    for (const successorId of internalStackSuccessors(blockInstanceId, functionInfo, indexes, bodySet)) {
      let successorDepths = inDepthsByBlock.get(successorId);
      if (!successorDepths) {
        successorDepths = new Set();
        inDepthsByBlock.set(successorId, successorDepths);
      }
      const result = unionDepthSets(successorDepths, outputDepths);
      if (!result.ok) {
        effects.explicitStackDeltaKnown = false;
        return;
      }
      if (result.changed && !queued.has(successorId)) {
        queue.push(successorId);
        queued.add(successorId);
      }
    }
  }

  if (normalReturnDepths.size > 1) {
    effects.explicitStackDeltaKnown = false;
    return;
  }
  if (normalReturnDepths.size === 1) {
    effects.explicitStackDelta = Array.from(normalReturnDepths)[0];
  }
}

function applyKnownWriteEffects(effects, mapper, instruction, entry) {
  const resolved = writeAddressesForInstruction(entry, instruction);
  if (resolved.kind === 'none') return;
  if (resolved.kind !== 'known') {
    effects.mayWriteRam = true;
    effects.mayWriteUnknownRam = true;
    effects.mayWriteMapper = true;
    effects.unknownMapperEffect = true;
    return;
  }

  for (const cpuAddr of resolved.values) {
    const writeEffect = classifyCpuWriteEffect(mapper, cpuAddr & 0xffff);
    if (writeEffect.kind === WRITE_EFFECT_KINDS.DEFINITE_MAPPER_WRITE ||
        writeEffect.kind === WRITE_EFFECT_KINDS.POSSIBLE_MAPPER_WRITE ||
        writeEffect.kind === WRITE_EFFECT_KINDS.UNKNOWN_MAY_AFFECT_MAPPING) {
      effects.mayWriteMapper = true;
      if (writeEffect.kind === WRITE_EFFECT_KINDS.UNKNOWN_MAY_AFFECT_MAPPING) effects.unknownMapperEffect = true;
      else addRange(effects.mapperWriteRanges, cpuAddr & 0xffff, cpuAddr & 0xffff);
    }

    const canonical = canonicalizeCpuAddr(cpuAddr & 0xffff);
    if (canonical.space === 'zp' || canonical.space === 'ram') {
      const ramAddr = canonical.addr & 0x07ff;
      effects.mayWriteRam = true;
      addRange(effects.ramWriteRanges, ramAddr, ramAddr);
      if (ramAddr <= 0xff) effects.mayWriteZeroPage = true;
      if (ramAddr >= 0x100 && ramAddr <= 0x1ff) {
        effects.mayWriteStackRam = true;
        effects.mayWriteStackRange = true;
      }
    }
  }
}

function mapBy(items, key) {
  return new Map(requireArray(items, `function summarization ${key} items`).map((item) => [item[key], item]));
}

function addToMapList(map, key, value) {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  list.push(value);
}

function buildIndexes(context) {
  const blockById = mapBy(context.blocks, 'blockId');
  const blockInstanceById = mapBy(context.blockInstances, 'blockInstanceId');
  const instructionById = new Map(requireArray(context.instructions, 'function summarization instructions')
    .map((instruction) => [instruction.instructionId >>> 0, instruction]));
  const outgoingByBlockInstanceId = new Map();
  const incomingByBlockInstanceId = new Map();
  const callEdgesByInstruction = new Map();
  const edges = typeof context.edgesForGraph === 'function'
    ? context.edgesForGraph()
    : requireArray(context.edges, 'function summarization edges');

  for (const edge of edges) {
    if (!isExecutableEdgeKind(edge.kind)) continue;
    addToMapList(outgoingByBlockInstanceId, edge.fromBlockInstanceId, edge);
    addToMapList(incomingByBlockInstanceId, edge.toBlockInstanceId, edge);
    if (edge.kind === EDGE_KINDS.CALL) addToMapList(callEdgesByInstruction, `${edge.fromBlockInstanceId}:${edge.fromInstructionId >>> 0}`, edge);
  }

  return { blockById, blockInstanceById, instructionById, outgoingByBlockInstanceId, incomingByBlockInstanceId, callEdgesByInstruction, edges };
}

function blockTerminator(block, instructionById) {
  const ids = Array.isArray(block?.instructionIds) ? block.instructionIds : [];
  if (!ids.length) return null;
  return instructionById.get(Number(ids[ids.length - 1]) >>> 0) || null;
}

function discoverEntryBlockInstanceIds(context, indexes) {
  const entries = new Set();
  for (const seed of requireArray(context.seedSites, 'function summarization seedSites')) {
    const instance = context.blockInstances.find((item) => item.siteKey === seed.siteKey);
    if (instance) entries.add(instance.blockInstanceId);
  }
  for (const edge of indexes.edges) {
    if (edge.kind === EDGE_KINDS.CALL) entries.add(edge.toBlockInstanceId);
  }
  for (const instance of context.blockInstances) {
    const incoming = indexes.incomingByBlockInstanceId.get(instance.blockInstanceId) || [];
    if (incoming.length === 0) entries.add(instance.blockInstanceId);
  }
  return entries;
}

function discoverFunctionBody(entryBlockInstanceId, entrySet, indexes) {
  const body = new Set();
  const callees = new Set();
  const unknownCallInstructionIds = new Set();
  const tailJumpInstructionIds = new Set();
  const tailJumpTargetBlockInstanceIds = new Set();
  const boundaryEntryBlockInstanceIds = new Set();
  const queue = [entryBlockInstanceId];

  while (queue.length) {
    const blockInstanceId = queue.shift();
    if (body.has(blockInstanceId)) continue;
    if (blockInstanceId !== entryBlockInstanceId && entrySet.has(blockInstanceId)) continue;
    const instance = indexes.blockInstanceById.get(blockInstanceId);
    const block = instance ? indexes.blockById.get(instance.blockId) : null;
    if (!instance || !block) continue;
    body.add(blockInstanceId);

    const terminator = blockTerminator(block, indexes.instructionById);
    const outgoing = indexes.outgoingByBlockInstanceId.get(blockInstanceId) || [];
    for (const edge of outgoing) {
      if (edge.kind === EDGE_KINDS.CALL) {
        callees.add(edge.toBlockInstanceId);
        continue;
      }
      if (edge.kind === EDGE_KINDS.RETURN || edge.kind === EDGE_KINDS.RTS_TRICK || edge.kind === EDGE_KINDS.PHYSICAL_CONTINUATION) continue;
      if (edge.kind === EDGE_KINDS.JUMP && entrySet.has(edge.toBlockInstanceId) && edge.toBlockInstanceId !== entryBlockInstanceId) {
        if (terminator) tailJumpInstructionIds.add(terminator.instructionId >>> 0);
        tailJumpTargetBlockInstanceIds.add(edge.toBlockInstanceId);
        continue;
      }
      if (entrySet.has(edge.toBlockInstanceId) && edge.toBlockInstanceId !== entryBlockInstanceId) {
        boundaryEntryBlockInstanceIds.add(edge.toBlockInstanceId);
        continue;
      }
      if (isExecutableEdgeKind(edge.kind)) queue.push(edge.toBlockInstanceId);
    }
  }

  for (const blockInstanceId of body) {
    const instance = indexes.blockInstanceById.get(blockInstanceId);
    const block = instance ? indexes.blockById.get(instance.blockId) : null;
    const terminator = block ? blockTerminator(block, indexes.instructionById) : null;
    if (!terminator || terminator.flow?.type !== FLOW_TYPES.CALL) continue;
    const key = `${blockInstanceId}:${terminator.instructionId >>> 0}`;
    if (!(indexes.callEdgesByInstruction.get(key) || []).length) unknownCallInstructionIds.add(terminator.instructionId >>> 0);
  }

  return { body, callees, unknownCallInstructionIds, tailJumpInstructionIds, tailJumpTargetBlockInstanceIds, boundaryEntryBlockInstanceIds };
}

function structuralSignature(functionInfo, indexes) {
  const blocks = Array.from(functionInfo.body).sort().map((blockInstanceId) => {
    const instance = indexes.blockInstanceById.get(blockInstanceId);
    const block = indexes.blockById.get(instance.blockId);
    return {
      blockInstanceId,
      blockId: instance.blockId,
      instructionIds: block.instructionIds.map((id) => id >>> 0)
    };
  });
  const instructions = [];
  for (const item of blocks) {
    for (const instructionId of item.instructionIds) {
      const instruction = indexes.instructionById.get(instructionId);
      if (!instruction) continue;
      instructions.push({
        id: instruction.instructionId >>> 0,
        romOff: instruction.romOff >>> 0,
        opcode: instruction.opcode & 0xff,
        operand: instruction.operand === null ? null : (instruction.operand & 0xffff),
        size: instruction.size >>> 0,
        flow: instruction.flow
      });
    }
  }
  const internalEdges = [];
  for (const blockInstanceId of functionInfo.body) {
    for (const edge of indexes.outgoingByBlockInstanceId.get(blockInstanceId) || []) {
      if (!functionInfo.body.has(edge.toBlockInstanceId)) continue;
      internalEdges.push(`${edge.fromBlockInstanceId}:${edge.kind}:${edge.toBlockInstanceId}:${edge.fromInstructionId >>> 0}`);
    }
  }
  internalEdges.sort();
  return JSON.stringify({
    effectVersion: FUNCTION_SUMMARY_EFFECT_VERSION,
    entryBlockInstanceId: functionInfo.entryBlockInstanceId,
    blocks,
    instructions,
    internalEdges,
    callees: Array.from(functionInfo.callees).sort(),
    unknownCalls: Array.from(functionInfo.unknownCallInstructionIds).sort((a, b) => a - b),
    tailJumps: Array.from(functionInfo.tailJumpInstructionIds).sort((a, b) => a - b),
    tailJumpTargets: Array.from(functionInfo.tailJumpTargetBlockInstanceIds).sort(),
    boundaryEntries: Array.from(functionInfo.boundaryEntryBlockInstanceIds).sort()
  });
}

function computeLocalEffects(context, functionInfo, indexes) {
  const effects = emptyEffects();
  for (const blockInstanceId of Array.from(functionInfo.body).sort()) {
    const instance = indexes.blockInstanceById.get(blockInstanceId);
    const block = instance ? indexes.blockById.get(instance.blockId) : null;
    if (!block) continue;
    for (const instructionId of block.instructionIds) {
      const instruction = indexes.instructionById.get(instructionId >>> 0);
      const entry = instruction ? opcodeEntry(instruction) : null;
      if (!instruction || !entry) continue;
      applyRegisterAndFlagEffects(effects, entry);
      applyStackEffects(effects, entry);
      applyKnownWriteEffects(effects, context.mapper, instruction, entry);
      applyControlEffects(effects, instruction, entry, functionInfo);
    }
  }
  applyFunctionStackDepthEffects(effects, functionInfo, indexes);
  if (!effects.mayReturnNormally) {
    effects.mayNotReturn = true;
    if (!functionInfo.tailJumpInstructionIds.size) effects.mayNotReturnWithoutTailJump = true;
    if (!functionInfo.tailJumpInstructionIds.size && !functionInfo.boundaryEntryBlockInstanceIds.size) {
      effects.mayNotReturnWithoutTailJumpOrBoundary = true;
    }
  }
  effects.alwaysReturnsNormally = effects.mayReturnNormally &&
    !effects.mayNotReturn &&
    !effects.mayTailJump &&
    !effects.hasIndirectControl &&
    !effects.callsUnknownTarget &&
    !effects.hasRtsTrickOrUnknownReturn;
  return finishConvenience(effects);
}

function computeReturnRelevantBlocks(functionInfo, indexes) {
  const reverseInternal = new Map();
  const seeds = new Set();
  for (const blockInstanceId of functionInfo.body) {
    reverseInternal.set(blockInstanceId, []);
    if (blockHasReturnExit(blockInstanceId, functionInfo, indexes, true)) seeds.add(blockInstanceId);
  }

  for (const blockInstanceId of functionInfo.body) {
    for (const edge of indexes.outgoingByBlockInstanceId.get(blockInstanceId) || []) {
      if (!isExecutableEdgeKind(edge.kind)) continue;
      if (!functionInfo.body.has(edge.toBlockInstanceId)) continue;
      if (edge.kind === EDGE_KINDS.CALL || edge.kind === EDGE_KINDS.RETURN ||
          edge.kind === EDGE_KINDS.RTS_TRICK || edge.kind === EDGE_KINDS.PHYSICAL_CONTINUATION) continue;
      reverseInternal.get(edge.toBlockInstanceId)?.push(blockInstanceId);
    }
  }

  const relevant = new Set();
  const queue = Array.from(seeds);
  while (queue.length) {
    const blockInstanceId = queue.shift();
    if (relevant.has(blockInstanceId)) continue;
    relevant.add(blockInstanceId);
    for (const predecessorId of reverseInternal.get(blockInstanceId) || []) {
      if (!relevant.has(predecessorId)) queue.push(predecessorId);
    }
  }
  return relevant;
}

function computeLocalReturnEffects(context, functionInfo, indexes) {
  const returnBody = computeReturnRelevantBlocks(functionInfo, indexes);
  const effects = emptyEffects();
  if (!returnBody.size) return finishConvenience(effects);

  let hasLocalRtsReturn = false;
  let hasTailReturnExit = false;
  for (const blockInstanceId of Array.from(returnBody).sort()) {
    const instance = indexes.blockInstanceById.get(blockInstanceId);
    const block = instance ? indexes.blockById.get(instance.blockId) : null;
    if (!block) continue;

    const terminator = blockTerminator(block, indexes.instructionById);
    if (terminator?.flow?.type === FLOW_TYPES.STOP && terminator.flow.reason === 'rts') hasLocalRtsReturn = true;

    for (const edge of indexes.outgoingByBlockInstanceId.get(blockInstanceId) || []) {
      if (functionInfo.tailJumpTargetBlockInstanceIds.has(edge.toBlockInstanceId)) hasTailReturnExit = true;
    }

    for (const instructionId of block.instructionIds) {
      const instruction = indexes.instructionById.get(instructionId >>> 0);
      const entry = instruction ? opcodeEntry(instruction) : null;
      if (!instruction || !entry) continue;
      applyRegisterAndFlagEffects(effects, entry);
      applyStackEffects(effects, entry);
      applyKnownWriteEffects(effects, context.mapper, instruction, entry);
      if (instruction.flow?.type === FLOW_TYPES.JMP_INDIRECT) effects.hasIndirectControl = true;
      if (entry.mnemonic === 'RTI') effects.hasRtsTrickOrUnknownReturn = true;
      if (functionInfo.unknownCallInstructionIds.has(instruction.instructionId >>> 0)) effects.callsUnknownTarget = true;
      if (functionInfo.tailJumpInstructionIds.has(instruction.instructionId >>> 0)) effects.mayTailJump = true;
    }
  }

  applyFunctionStackDepthEffects(effects, functionInfo, indexes, returnBody, true);
  effects.mayReturnNormally = hasLocalRtsReturn;
  effects.mayTailJump = effects.mayTailJump || hasTailReturnExit;
  effects.alwaysReturnsNormally = effects.mayReturnNormally &&
    !effects.mayNotReturn &&
    !effects.mayTailJump &&
    !effects.hasIndirectControl &&
    !effects.callsUnknownTarget &&
    !effects.hasRtsTrickOrUnknownReturn;
  return finishConvenience(effects);
}

function returnCalleesForFunction(functionInfo, indexes) {
  const returnBody = computeReturnRelevantBlocks(functionInfo, indexes);
  const callees = new Set();
  for (const blockInstanceId of returnBody) {
    for (const edge of indexes.outgoingByBlockInstanceId.get(blockInstanceId) || []) {
      if (edge.kind === EDGE_KINDS.CALL) callees.add(edge.toBlockInstanceId);
    }
  }
  return Array.from(callees).sort();
}

function getCache(context) {
  if (!context.functionSummaryCache || typeof context.functionSummaryCache !== 'object') {
    context.functionSummaryCache = { localBySignature: new Map() };
  }
  if (!(context.functionSummaryCache.localBySignature instanceof Map)) {
    context.functionSummaryCache.localBySignature = new Map();
  }
  return context.functionSummaryCache;
}

function tailJumpTargetIsComposableReturn(effects) {
  return effects &&
    effects.alwaysReturnsNormally === true &&
    effects.stackReturnSafe === true &&
    effects.hasIndirectControl !== true &&
    effects.callsUnknownTarget !== true &&
    effects.hasRtsTrickOrUnknownReturn !== true;
}

function classifyComposableTailJumpReturns(fn, transitive) {
  const targetIds = Array.from(fn.tailJumpTargetBlockInstanceIds || []);
  const composableTargetIds = [];
  const composableTargetEffects = [];
  let missingSummaryCount = 0;

  for (const targetId of targetIds) {
    const effects = transitive.get(targetId);
    if (!effects) {
      missingSummaryCount += 1;
      continue;
    }
    if (!tailJumpTargetIsComposableReturn(effects)) continue;
    composableTargetIds.push(targetId);
    composableTargetEffects.push(effects);
  }

  return {
    targetCount: targetIds.length,
    composableTargetIds,
    composableTargetEffects,
    missingSummaryCount,
    allTargetsComposable: targetIds.length > 0 &&
      missingSummaryCount === 0 &&
      composableTargetIds.length === targetIds.length
  };
}

function classifyBoundaryEntrySummaries(fn, transitive) {
  const targetIds = Array.from(fn.boundaryEntryBlockInstanceIds || []);
  const composedTargetIds = [];
  const composedTargetEffects = [];
  let missingSummaryCount = 0;

  for (const targetId of targetIds) {
    const effects = transitive.get(targetId);
    if (!effects) {
      missingSummaryCount += 1;
      continue;
    }
    composedTargetIds.push(targetId);
    composedTargetEffects.push(effects);
  }

  return {
    targetCount: targetIds.length,
    composedTargetIds,
    composedTargetEffects,
    missingSummaryCount,
    allTargetsPresent: targetIds.length > 0 && missingSummaryCount === 0
  };
}

function classifyReturnTargetSummaries(targetIds, transitive) {
  const ids = Array.from(targetIds || []);
  const composedTargetIds = [];
  const composedTargetEffects = [];
  let missingSummaryCount = 0;

  for (const targetId of ids) {
    const effects = transitive.get(targetId);
    if (!effects) {
      missingSummaryCount += 1;
      continue;
    }
    composedTargetIds.push(targetId);
    composedTargetEffects.push(effects);
  }

  return {
    targetCount: ids.length,
    composedTargetIds,
    composedTargetEffects,
    missingSummaryCount,
    allTargetsPresent: ids.length > 0 && missingSummaryCount === 0
  };
}

function joinTailJumpReturnEffects(caller, target) {
  const out = joinEffects(caller, target);
  composeStackEffects(out, caller, target);
  out.mayReturnNormally = caller.mayReturnNormally || target.mayReturnNormally;
  out.mayNotReturn = caller.mayNotReturn || target.mayNotReturn;
  out.mayNotReturnWithoutTailJump = caller.mayNotReturnWithoutTailJump || target.mayNotReturnWithoutTailJump;
  out.mayNotReturnWithoutTailJumpOrBoundary = caller.mayNotReturnWithoutTailJumpOrBoundary ||
    target.mayNotReturnWithoutTailJumpOrBoundary;
  out.mayTailJump = caller.mayTailJump || target.mayTailJump;
  out.alwaysReturnsNormally = out.mayReturnNormally &&
    !out.mayNotReturn &&
    !out.mayTailJump &&
    !out.hasIndirectControl &&
    !out.callsUnknownTarget &&
    !out.hasRtsTrickOrUnknownReturn;
  return finishConvenience(out);
}

function joinBoundaryEntryEffects(caller, target) {
  const out = joinEffects(caller, target);
  composeStackEffects(out, caller, target);
  out.mayReturnNormally = caller.mayReturnNormally || target.mayReturnNormally;
  out.mayNotReturn = caller.mayNotReturn || target.mayNotReturn;
  out.mayNotReturnWithoutTailJump = caller.mayNotReturnWithoutTailJump || target.mayNotReturnWithoutTailJump;
  out.mayNotReturnWithoutTailJumpOrBoundary = caller.mayNotReturnWithoutTailJumpOrBoundary ||
    target.mayNotReturnWithoutTailJumpOrBoundary;
  out.mayTailJump = caller.mayTailJump || target.mayTailJump;
  out.alwaysReturnsNormally = out.mayReturnNormally &&
    !out.mayNotReturn &&
    !out.mayTailJump &&
    !out.hasIndirectControl &&
    !out.callsUnknownTarget &&
    !out.hasRtsTrickOrUnknownReturn;
  return finishConvenience(out);
}

function computeTransitiveSummaries(functionsByEntry) {
  const transitive = new Map();
  for (const fn of functionsByEntry.values()) transitive.set(fn.entryBlockInstanceId, finishConvenience(cloneEffects(fn.localEffects)));
  const returnTransitive = new Map();
  for (const fn of functionsByEntry.values()) returnTransitive.set(fn.entryBlockInstanceId, finishConvenience(cloneEffects(fn.localReturnEffects)));
  const tailJumpReturnCompositionByEntry = new Map();
  const boundaryEntryCompositionByEntry = new Map();

  let changed = true;
  let iterations = 0;
  const maxIterations = Math.max(1, functionsByEntry.size + 1);
  while (changed && iterations < maxIterations) {
    changed = false;
    iterations += 1;
    for (const fn of functionsByEntry.values()) {
      const tailReturnComposition = classifyComposableTailJumpReturns(fn, transitive);
      const boundaryEntryComposition = classifyBoundaryEntrySummaries(fn, transitive);
      const localEffects = cloneEffects(fn.localEffects);
      const tailReturnResolved = tailReturnComposition.allTargetsComposable;
      const boundaryEntriesResolved = boundaryEntryComposition.targetCount === 0 || boundaryEntryComposition.allTargetsPresent;
      if (tailReturnComposition.allTargetsComposable) {
        localEffects.mayTailJump = false;
        localEffects.mayReturnNormally = true;
      }
      localEffects.mayNotReturn = localEffects.mayNotReturnWithoutTailJumpOrBoundary === true ||
        (tailReturnComposition.targetCount > 0 && !tailReturnResolved) ||
        (boundaryEntryComposition.targetCount > 0 && !boundaryEntriesResolved);
      localEffects.mayNotReturnWithoutTailJump = localEffects.mayNotReturnWithoutTailJumpOrBoundary === true ||
        (boundaryEntryComposition.targetCount > 0 && !boundaryEntriesResolved);
      let next = finishConvenience(localEffects);
      for (const targetEffects of tailReturnComposition.composableTargetEffects) {
        next = joinTailJumpReturnEffects(next, targetEffects);
      }
      for (const targetEffects of boundaryEntryComposition.composedTargetEffects) {
        next = joinBoundaryEntryEffects(next, targetEffects);
      }
      for (const calleeId of fn.calleeEntryBlockInstanceIds) {
        const callee = transitive.get(calleeId);
        if (!callee) {
          next.callsUnknownTarget = true;
          continue;
        }
        next = joinCalleeEffects(next, callee);
      }
      next.alwaysReturnsNormally = next.mayReturnNormally &&
        !next.mayNotReturn &&
        !next.mayTailJump &&
        !next.hasIndirectControl &&
        !next.callsUnknownTarget &&
        !next.hasRtsTrickOrUnknownReturn;
      next = finishConvenience(next);
      tailJumpReturnCompositionByEntry.set(fn.entryBlockInstanceId, {
        targetCount: tailReturnComposition.targetCount,
        composedTargetCount: tailReturnComposition.allTargetsComposable
          ? tailReturnComposition.composableTargetIds.length
          : 0,
        allTargetsComposable: tailReturnComposition.allTargetsComposable
      });
      boundaryEntryCompositionByEntry.set(fn.entryBlockInstanceId, {
        targetCount: boundaryEntryComposition.targetCount,
        composedTargetCount: boundaryEntryComposition.composedTargetIds.length,
        missingSummaryCount: boundaryEntryComposition.missingSummaryCount,
        allTargetsPresent: boundaryEntryComposition.allTargetsPresent
      });
      if (!effectsEqual(transitive.get(fn.entryBlockInstanceId), next)) {
        transitive.set(fn.entryBlockInstanceId, next);
        changed = true;
      }

      const returnTailComposition = classifyReturnTargetSummaries(fn.tailJumpTargetBlockInstanceIds, returnTransitive);
      const returnBoundaryComposition = classifyReturnTargetSummaries(fn.boundaryEntryBlockInstanceIds, returnTransitive);
      const localReturnEffects = cloneEffects(fn.localReturnEffects);
      if (returnTailComposition.allTargetsPresent) localReturnEffects.mayTailJump = false;
      let nextReturn = finishConvenience(localReturnEffects);
      for (const targetEffects of returnTailComposition.composedTargetEffects) {
        nextReturn = joinTailJumpReturnEffects(nextReturn, targetEffects);
      }
      for (const targetEffects of returnBoundaryComposition.composedTargetEffects) {
        nextReturn = joinBoundaryEntryEffects(nextReturn, targetEffects);
      }
      for (const calleeId of fn.returnCalleeEntryBlockInstanceIds) {
        const callee = returnTransitive.get(calleeId);
        if (!callee) {
          nextReturn.callsUnknownTarget = true;
          continue;
        }
        nextReturn = joinCalleeEffects(nextReturn, callee);
      }
      nextReturn.alwaysReturnsNormally = nextReturn.mayReturnNormally &&
        !nextReturn.mayNotReturn &&
        !nextReturn.mayTailJump &&
        !nextReturn.hasIndirectControl &&
        !nextReturn.callsUnknownTarget &&
        !nextReturn.hasRtsTrickOrUnknownReturn;
      nextReturn = finishConvenience(nextReturn);
      if (!effectsEqual(returnTransitive.get(fn.entryBlockInstanceId), nextReturn)) {
        returnTransitive.set(fn.entryBlockInstanceId, nextReturn);
        changed = true;
      }
    }
  }
  return { transitive, returnTransitive, iterations, tailJumpReturnCompositionByEntry, boundaryEntryCompositionByEntry };
}

function classifyTailJumpTargets(targetIds, transitive) {
  const out = {
    count: 0,
    missingSummaryCount: 0,
    mayReturnNormallyCount: 0,
    alwaysReturnsNormallyCount: 0,
    stackReturnSafeCount: 0,
    composableReturnCount: 0
  };
  for (const targetId of targetIds || []) {
    out.count += 1;
    const effects = transitive.get(targetId);
    if (!effects) {
      out.missingSummaryCount += 1;
      continue;
    }
    if (effects.mayReturnNormally) out.mayReturnNormallyCount += 1;
    if (effects.alwaysReturnsNormally) out.alwaysReturnsNormallyCount += 1;
    if (effects.stackReturnSafe) out.stackReturnSafeCount += 1;
    if (tailJumpTargetIsComposableReturn(effects)) out.composableReturnCount += 1;
  }
  return out;
}

function buildCounters(functions, cacheHits, cacheMisses, iterations) {
  const counters = {
    functionCount: functions.length,
    summarizedFunctionCount: 0,
    unsummarizedFunctionCount: 0,
    cacheHits,
    cacheSkippedFunctionCount: cacheHits,
    cacheMisses,
    callGraphIterations: iterations,
    mapperUnchangedCount: 0,
    ramUnchangedCount: 0,
    stackReturnSafeCount: 0,
    doesntClobberRegistersCount: 0,
    doesntClobberFlagsCount: 0,
    unknownControlCount: 0,
    unknownCallTargetCount: 0,
    tailJumpReturnComposedFunctionCount: 0,
    tailJumpReturnComposedTargetCount: 0,
    boundaryEntryComposedFunctionCount: 0,
    boundaryEntryComposedTargetCount: 0,
    boundaryEntryMissingSummaryCount: 0
  };
  for (const fn of functions) {
    const effects = fn.effects;
    if (!fn.skippedByCache) {
      if (fn.summaryStatus === 'summarized') counters.summarizedFunctionCount += 1;
      else counters.unsummarizedFunctionCount += 1;
    }
    if (effects.mapperUnchanged) counters.mapperUnchangedCount += 1;
    if (effects.ramUnchanged) counters.ramUnchangedCount += 1;
    if (effects.stackReturnSafe) counters.stackReturnSafeCount += 1;
    if (effects.doesntClobberRegisters) counters.doesntClobberRegistersCount += 1;
    if (effects.doesntClobberFlags) counters.doesntClobberFlagsCount += 1;
    if (effects.hasIndirectControl || effects.hasRtsTrickOrUnknownReturn) counters.unknownControlCount += 1;
    if (effects.callsUnknownTarget) counters.unknownCallTargetCount += 1;
    if (fn.tailJumpReturnComposition?.composedTargetCount > 0) {
      counters.tailJumpReturnComposedFunctionCount += 1;
      counters.tailJumpReturnComposedTargetCount += fn.tailJumpReturnComposition.composedTargetCount;
    }
    if (fn.boundaryEntryComposition?.composedTargetCount > 0) {
      counters.boundaryEntryComposedFunctionCount += 1;
      counters.boundaryEntryComposedTargetCount += fn.boundaryEntryComposition.composedTargetCount;
    }
    counters.boundaryEntryMissingSummaryCount += fn.boundaryEntryComposition?.missingSummaryCount || 0;
  }
  return counters;
}

function summarizeFunctions(context) {
  const indexes = buildIndexes(context);
  const entrySet = discoverEntryBlockInstanceIds(context, indexes);
  const cache = getCache(context);
  let cacheHits = 0;
  let cacheMisses = 0;
  const functionsByEntry = new Map();

  for (const entryBlockInstanceId of Array.from(entrySet).sort()) {
    const instance = indexes.blockInstanceById.get(entryBlockInstanceId);
    if (!instance) continue;
    const block = indexes.blockById.get(instance.blockId);
    if (!block) continue;
    const functionInfo = discoverFunctionBody(entryBlockInstanceId, entrySet, indexes);
    functionInfo.entryBlockInstanceId = entryBlockInstanceId;
    const signature = structuralSignature(functionInfo, indexes);
    let localEffects = cache.localBySignature.get(signature);
    let skippedByCache = false;
    if (localEffects) {
      cacheHits += 1;
      skippedByCache = true;
      localEffects = cloneEffects(localEffects);
    } else {
      cacheMisses += 1;
      localEffects = computeLocalEffects(context, functionInfo, indexes);
      cache.localBySignature.set(signature, cloneEffects(localEffects));
    }
    const localReturnEffects = computeLocalReturnEffects(context, functionInfo, indexes);
    functionsByEntry.set(entryBlockInstanceId, {
      entryBlockInstanceId,
      entryBlockId: instance.blockId,
      entryRomOff: block.romStart >>> 0,
      contextKey: instance.contextKey,
      siteKey: instance.siteKey,
      cpuStart: instance.cpuStart & 0xffff,
      bodyBlockInstanceIds: Array.from(functionInfo.body).sort(),
      calleeEntryBlockInstanceIds: Array.from(functionInfo.callees).sort(),
      returnCalleeEntryBlockInstanceIds: returnCalleesForFunction(functionInfo, indexes),
      tailJumpInstructionIds: Array.from(functionInfo.tailJumpInstructionIds).sort((a, b) => a - b),
      tailJumpTargetBlockInstanceIds: Array.from(functionInfo.tailJumpTargetBlockInstanceIds).sort(),
      boundaryEntryBlockInstanceIds: Array.from(functionInfo.boundaryEntryBlockInstanceIds).sort(),
      localEffects,
      localReturnEffects,
      effects: null,
      returnEffects: null,
      skippedByCache,
      signature
    });
  }

  const { transitive, returnTransitive, iterations, tailJumpReturnCompositionByEntry, boundaryEntryCompositionByEntry } = computeTransitiveSummaries(functionsByEntry);
  const functions = Array.from(functionsByEntry.values()).map((fn) => {
    const effects = transitive.get(fn.entryBlockInstanceId) || finishConvenience(cloneEffects(fn.localEffects));
    const returnEffects = returnTransitive.get(fn.entryBlockInstanceId) || finishConvenience(cloneEffects(fn.localReturnEffects));
    const tailJumpReturnComposition = tailJumpReturnCompositionByEntry.get(fn.entryBlockInstanceId) || {
      targetCount: 0,
      composedTargetCount: 0,
      allTargetsComposable: false
    };
    const boundaryEntryComposition = boundaryEntryCompositionByEntry.get(fn.entryBlockInstanceId) || {
      targetCount: 0,
      composedTargetCount: 0,
      missingSummaryCount: 0,
      allTargetsPresent: false
    };
    const unsummarizedReasons = [];
    if (effects.hasIndirectControl) unsummarizedReasons.push('indirectControl');
    if (effects.callsUnknownTarget) unsummarizedReasons.push('unknownCallTarget');
    if (effects.hasRtsTrickOrUnknownReturn) unsummarizedReasons.push('unknownReturn');
    return {
      entryBlockInstanceId: fn.entryBlockInstanceId,
      entryBlockId: fn.entryBlockId,
      entryRomOff: fn.entryRomOff,
      contextKey: fn.contextKey,
      siteKey: fn.siteKey,
      cpuStart: fn.cpuStart,
      bodyBlockInstanceIds: fn.bodyBlockInstanceIds,
      calleeEntryBlockInstanceIds: fn.calleeEntryBlockInstanceIds,
      returnCalleeEntryBlockInstanceIds: fn.returnCalleeEntryBlockInstanceIds,
      tailJumpInstructionIds: fn.tailJumpInstructionIds,
      tailJumpTargetBlockInstanceIds: fn.tailJumpTargetBlockInstanceIds,
      boundaryEntryBlockInstanceIds: fn.boundaryEntryBlockInstanceIds,
      tailJumpTargetSummary: classifyTailJumpTargets(fn.tailJumpTargetBlockInstanceIds, transitive),
      tailJumpReturnComposition,
      boundaryEntryComposition,
      localEffects: fn.localEffects,
      localReturnEffects: fn.localReturnEffects,
      effects,
      returnEffects,
      summaryStatus: unsummarizedReasons.length ? 'unsummarized' : 'summarized',
      skippedByCache: fn.skippedByCache === true,
      unsummarizedReasons
    };
  }).sort((a, b) => a.entryRomOff - b.entryRomOff || a.entryBlockInstanceId.localeCompare(b.entryBlockInstanceId));
  const byEntryBlockInstanceId = {};
  for (const fn of functions) byEntryBlockInstanceId[fn.entryBlockInstanceId] = fn;

  return {
    producedBy: 'functionSummarization',
    functions,
    byEntryBlockInstanceId,
    counters: buildCounters(functions, cacheHits, cacheMisses, iterations)
  };
}

export function createFunctionSummarizationPhase(context) {
  return {
    name: ANALYSIS_PHASE_IDS.FUNCTION_SUMMARIZATION,
    stepOne() {
      requireObject(context.mapper, 'functionSummarization mapper');
      const result = summarizeFunctions(context);
      context.functionSummarization = result;
      context.diagnostics.phaseSummaries.push({
        name: ANALYSIS_PHASE_IDS.FUNCTION_SUMMARIZATION,
        status: 'complete',
        counters: result.counters
      });
      return { status: 'complete' };
    },
    progress() {
      const counters = context.functionSummarization?.counters || {};
      return {
        phase: ANALYSIS_PHASE_IDS.FUNCTION_SUMMARIZATION,
        detailKind: 'functionSummarization',
        details: counters,
        ...counters
      };
    }
  };
}
