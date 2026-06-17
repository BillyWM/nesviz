import { ADDRESSING_MODES as AM } from '../../cpu6502/addressingModes.js';
import { canonicalizeCpuAddr } from '../../utils/addressUtils.js';
import { OPCODES } from '../../cpu6502/opcodes.js';
import { EDGE_KINDS } from '../cfg/constants.js';
import { edgeKey } from '../cfgTopology/graphTopology.js';
import { requireInteger, requireObject } from '../dataShape.js';
import {
  flagsWrittenByMnemonic,
  getBranchPredicateForMnemonic,
  getCompareRegisterForMnemonic,
  getRegisterUpdateFlagEffect,
  invertBranchPredicate,
  isConditionalBranchMnemonic,
  predicateForBranchEdge
} from '../domains/flagEffects.js';
import { FLAG_VALUE } from '../domains/flagsDomain.js';
import { classifyInstructionWriteEffect } from '../mapper/writeEffects.js';
import { abstractByteFromParts, abstractByteToSerializable, exactByte } from '../abstractInterpretation/abstractByteDomain.js';
import { rangeScalar } from '../abstractInterpretation/byteScalarDomain.js';

const COUNTER_REGISTERS = Object.freeze(['x', 'y']);
const REGISTER_LOAD = Object.freeze({ x: 'LDX', y: 'LDY' });
const REGISTER_INC = Object.freeze({ x: 'INX', y: 'INY' });
const REGISTER_DEC = Object.freeze({ x: 'DEX', y: 'DEY' });

function opcodeEntry(instruction) {
  requireObject(instruction, 'loop recognizer instruction');
  requireInteger(instruction.opcode, 'loop recognizer instruction.opcode');
  return OPCODES[instruction.opcode & 0xff] || null;
}

function instructionRecord(instruction, execution) {
  const entry = opcodeEntry(instruction);
  return {
    instruction,
    execution,
    entry,
    mnemonic: entry ? entry.mnemonic : '???',
    mode: entry ? entry.mode : null
  };
}

export function buildLoopRecognizerIndexes(context) {
  const instructionById = new Map(context.instructions.map((instruction) => [instruction.instructionId >>> 0, instruction]));
  const executionsByBlockInstanceId = new Map();
  for (const execution of context.instructionExecutions) {
    const list = executionsByBlockInstanceId.get(execution.blockInstanceId) || [];
    const instruction = instructionById.get(execution.instructionId >>> 0);
    if (instruction) list.push(instructionRecord(instruction, execution));
    executionsByBlockInstanceId.set(execution.blockInstanceId, list);
  }
  return { instructionById, executionsByBlockInstanceId };
}

function recordsForBlock(indexes, blockInstanceId) {
  return indexes.executionsByBlockInstanceId.get(blockInstanceId) || [];
}

function immediateByte(record) {
  if (!record || record.mode !== AM.IMMEDIATE) return null;
  if (!Number.isInteger(record.instruction.operand)) return null;
  return record.instruction.operand & 0xff;
}

function directRamSource(record) {
  if (!record || (record.mode !== AM.ZERO_PAGE && record.mode !== AM.ABSOLUTE)) return null;
  if (!Number.isInteger(record.instruction.operand)) return null;
  const cpuAddr = record.mode === AM.ZERO_PAGE ? (record.instruction.operand & 0xff) : (record.instruction.operand & 0xffff);
  const canonical = canonicalizeCpuAddr(cpuAddr);
  if (canonical.space !== 'zp' && canonical.space !== 'ram') return null;
  return {
    kind: 'entryRamByte',
    cpuAddr,
    canonicalRamAddr: canonical.addr & 0x07ff,
    addressSpace: canonical.space,
    mode: record.mode,
    instructionId: record.instruction.instructionId >>> 0
  };
}

function loadSource(record, mnemonic) {
  if (!record || record.mnemonic !== mnemonic) return null;
  const immediate = immediateByte(record);
  if (immediate !== null) {
    return {
      kind: 'exactByte',
      value: immediate,
      instructionId: record.instruction.instructionId >>> 0
    };
  }
  return directRamSource(record);
}

function clobbersAccumulator(record) {
  if (!record || !record.entry) return false;
  const mnemonic = record.mnemonic;
  if (mnemonic === 'LDA' || mnemonic === 'TXA' || mnemonic === 'TYA' || mnemonic === 'PLA') return true;
  if (mnemonic === 'ADC' || mnemonic === 'SBC' || mnemonic === 'AND' || mnemonic === 'ORA' || mnemonic === 'EOR') return true;
  return (mnemonic === 'ASL' || mnemonic === 'LSR' || mnemonic === 'ROL' || mnemonic === 'ROR') && record.mode === AM.ACCUMULATOR;
}

function findAccumulatorLoadSourceBefore(records, beforeIndex) {
  for (let cursor = beforeIndex - 1; cursor >= 0; cursor -= 1) {
    const record = records[cursor];
    const source = loadSource(record, 'LDA');
    if (source) return { source, sourceRecord: record };
    if (clobbersAccumulator(record)) return null;
  }
  return null;
}

function transferMnemonicForRegister(registerName) {
  if (registerName === 'x') return 'TAX';
  if (registerName === 'y') return 'TAY';
  return null;
}

function sameInitializerSource(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'exactByte') return (a.value & 0xff) === (b.value & 0xff);
  if (a.kind === 'entryRamByte') return (a.canonicalRamAddr & 0x07ff) === (b.canonicalRamAddr & 0x07ff);
  return false;
}

function findInitializerSourceInEntryBlock(records, registerName) {
  const registerLoadMnemonic = REGISTER_LOAD[registerName];
  const transferMnemonic = transferMnemonicForRegister(registerName);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record.entry) continue;

    const directSource = loadSource(record, registerLoadMnemonic);
    if (directSource) {
      return {
        ok: true,
        source: directSource,
        initializerRecord: record,
        initializerSourceRecord: record
      };
    }

    if (record.mnemonic === transferMnemonic) {
      const accumulatorSource = findAccumulatorLoadSourceBefore(records, index);
      if (!accumulatorSource) return { ok: false, reason: 'unknownInitializer' };
      return {
        ok: true,
        source: accumulatorSource.source,
        initializerRecord: record,
        initializerSourceRecord: accumulatorSource.sourceRecord
      };
    }

    if (clobbersRegister(record, registerName)) break;
  }
  return { ok: false, reason: 'unknownInitializer' };
}

function findInitializerValue(candidate, registerName, indexes) {
  const entryEdges = candidate.entryEdges.filter((edge) => edge.toBlockInstanceId === candidate.headerBlockInstanceId);
  if (entryEdges.length === 0 || entryEdges.length !== candidate.entryEdges.length) return { ok: false, reason: 'ambiguousEntry' };
  let source = null;
  let initializerRecord = null;
  let initializerSourceRecord = null;
  for (const edge of entryEdges) {
    const records = recordsForBlock(indexes, edge.fromBlockInstanceId);
    const found = findInitializerSourceInEntryBlock(records, registerName);
    if (!found.ok) return found;
    if (source !== null && !sameInitializerSource(source, found.source)) return { ok: false, reason: 'ambiguousEntry' };
    source = found.source;
    initializerRecord = found.initializerRecord;
    initializerSourceRecord = found.initializerSourceRecord;
  }
  if (!source) return { ok: false, reason: 'unknownInitializer' };
  return {
    ok: true,
    value: source.kind === 'exactByte' ? source.value : null,
    source,
    initializerRecord,
    initializerSourceRecord
  };
}

function makeByteFromRange(min, max, step = 1) {
  const lo = min & 0xff;
  const hi = max & 0xff;
  if (lo > hi) return null;
  return abstractByteToSerializable(abstractByteFromParts({ scalar: rangeScalar(lo, hi, step) }));
}

function makeExactByte(value) {
  return abstractByteToSerializable(exactByte(value & 0xff));
}

function childBodyBlockIds(candidate, candidateById) {
  const out = new Set();
  for (const childId of candidate.childLoopIds) {
    const child = candidateById.get(childId);
    if (!child) continue;
    for (const blockInstanceId of child.bodyBlockInstanceIds) out.add(blockInstanceId);
  }
  return out;
}

function exitEdgeForTail(candidate) {
  const reentryKey = candidate.reentryEdgeKey;
  const tailEdges = candidate.exitEdges.filter((edge) => edge.fromBlockInstanceId === candidate.tailBlockInstanceId);
  return tailEdges.find((edge) => edgeKey(edge) !== reentryKey) || null;
}

function clobbersRegister(record, registerName) {
  if (!record || !record.entry) return false;
  const mnemonic = record.mnemonic;
  if (registerName === 'x') return mnemonic === 'LDX' || mnemonic === 'TAX' || mnemonic === 'TSX' || mnemonic === 'INX' || mnemonic === 'DEX';
  if (registerName === 'y') return mnemonic === 'LDY' || mnemonic === 'TAY' || mnemonic === 'INY' || mnemonic === 'DEY';
  return false;
}

function instructionMayCall(record) {
  return record?.mnemonic === 'JSR';
}

function scanSafety({ candidate, context, indexes, counterRegister, allowedInstructionIds, childSummaryByLoopId, candidateById }) {
  const childIds = childBodyBlockIds(candidate, candidateById);
  for (const childId of candidate.childLoopIds) {
    const summary = childSummaryByLoopId.get(childId);
    if (!summary) return { ok: false, reason: 'childLoopBail' };
    if (summary.effects?.mayAffectCodeMapping) return { ok: false, reason: 'mapperWriteInChildLoop' };
    if ((summary.effects?.modifiesRegisters || []).includes(counterRegister)) return { ok: false, reason: 'childClobbersCounter' };
  }

  for (const blockInstanceId of candidate.bodyBlockInstanceIds) {
    if (childIds.has(blockInstanceId)) continue;
    const records = recordsForBlock(indexes, blockInstanceId);
    for (const record of records) {
      const effect = classifyInstructionWriteEffect({ mapper: context.mapper, instruction: record.instruction });
      if (effect.mayAffectCodeMapping) return { ok: false, reason: 'mapperWriteInLoop' };
      if (instructionMayCall(record)) return { ok: false, reason: 'callInLoop' };
      if (clobbersRegister(record, counterRegister) && !allowedInstructionIds.has(record.instruction.instructionId >>> 0)) {
        return { ok: false, reason: 'counterClobber' };
      }
    }
  }

  return { ok: true };
}

function findTailBranch(candidate, indexes) {
  const records = recordsForBlock(indexes, candidate.tailBlockInstanceId);
  if (records.length < 1) return { ok: false, reason: 'ambiguousTailBranch' };
  const branchIndex = records.length - 1;
  const branch = records[branchIndex];
  if (!branch.entry || branch.mode !== AM.RELATIVE || !isConditionalBranchMnemonic(branch.mnemonic)) {
    return { ok: false, reason: 'unsupportedBranchPredicate' };
  }
  const reentryPredicate = predicateForBranchEdge(branch.mnemonic, candidate.reentryEdge.kind);
  if (!reentryPredicate) return { ok: false, reason: 'unsupportedBranchPredicate' };
  const exitEdge = exitEdgeForTail(candidate);
  const exitPredicate = exitEdge
    ? predicateForBranchEdge(branch.mnemonic, exitEdge.kind)
    : invertBranchPredicate(reentryPredicate);
  return { ok: true, records, branchIndex, branch, reentryPredicate, exitPredicate, exitEdge };
}

function findUpdateBefore(records, index, registerName) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const record = records[cursor];
    const updateEffect = getRegisterUpdateFlagEffect(record.mnemonic);
    if (updateEffect && updateEffect.registerName === registerName) return { record, index: cursor, effect: updateEffect };
    if (clobbersRegister(record, registerName)) return null;
  }
  return null;
}

function findUpdateRunBefore(records, index, registerName) {
  const lastUpdate = findUpdateBefore(records, index, registerName);
  if (!lastUpdate) return null;

  const recordsInRun = [lastUpdate.record];
  let firstIndex = lastUpdate.index;
  for (let cursor = lastUpdate.index - 1; cursor >= 0; cursor -= 1) {
    const record = records[cursor];
    const updateEffect = getRegisterUpdateFlagEffect(record.mnemonic);
    if (!updateEffect || updateEffect.registerName !== registerName || updateEffect.direction !== lastUpdate.effect.direction) break;
    recordsInRun.unshift(record);
    firstIndex = cursor;
  }

  return {
    record: lastUpdate.record,
    records: recordsInRun,
    index: lastUpdate.index,
    firstIndex,
    effect: lastUpdate.effect,
    step: recordsInRun.length
  };
}

function findFlagSourceBeforeBranch(records, branchIndex, predicate) {
  for (let index = branchIndex - 1; index >= 0; index -= 1) {
    const record = records[index];
    const written = flagsWrittenByMnemonic(record.mnemonic);
    if (!written.has(predicate.flag)) continue;

    const updateEffect = getRegisterUpdateFlagEffect(record.mnemonic);
    if (updateEffect && (predicate.flag === 'n' || predicate.flag === 'z')) {
      return {
        ok: true,
        source: {
          kind: 'counterUpdate',
          record,
          index,
          registerName: updateEffect.registerName,
          direction: updateEffect.direction,
          flag: predicate.flag
        }
      };
    }

    const compareRegister = getCompareRegisterForMnemonic(record.mnemonic);
    if (compareRegister && record.mode === AM.IMMEDIATE && (predicate.flag === 'z' || predicate.flag === 'c')) {
      if (!COUNTER_REGISTERS.includes(compareRegister)) return { ok: false, reason: 'unsupportedFlagSource' };
      const update = findUpdateRunBefore(records, index, compareRegister);
      if (!update) return { ok: false, reason: 'noCounterUpdate' };
      const immediate = immediateByte(record);
      if (immediate === null) return { ok: false, reason: 'unsupportedFlagSource' };
      return {
        ok: true,
        source: {
          kind: 'compareImmediate',
          record,
          index,
          registerName: compareRegister,
          immediate,
          updateRecord: update.record,
          updateRecords: update.records,
          updateIndex: update.index,
          updateFirstIndex: update.firstIndex,
          direction: update.effect.direction,
          step: update.step,
          flag: predicate.flag
        }
      };
    }

    return { ok: false, reason: 'unsupportedFlagSource' };
  }
  return { ok: false, reason: 'unsupportedFlagSource' };
}

function makeCounter({ registerName, direction, initialValue, limitValue, headerMin, headerMax, reentryMin, reentryMax, exitValue, control, step = 1 }) {
  const headerByte = makeByteFromRange(headerMin, headerMax, step);
  const reentryByte = makeByteFromRange(reentryMin, reentryMax, step);
  const exitByte = exitValue === null || exitValue === undefined ? null : makeExactByte(exitValue);
  if (!headerByte || !reentryByte) return { ok: false, reason: 'oneTripOrEmptyLoop' };
  return {
    ok: true,
    counter: {
      registerName,
      direction,
      step,
      initialValue: initialValue & 0xff,
      limitValue: limitValue === null || limitValue === undefined ? null : limitValue & 0xff,
      headerByte,
      reentryByte,
      exitByte,
      control
    }
  };
}

function makeParametricCounter({ registerName, direction, initialSource, limitValue, exitValue, control }) {
  if (!initialSource || initialSource.kind !== 'entryRamByte') return { ok: false, reason: 'unknownInitializer' };
  return {
    ok: true,
    counter: {
      registerName,
      direction,
      step: Number.isInteger(control.step) ? control.step : 1,
      initialValue: null,
      limitValue: limitValue === null || limitValue === undefined ? null : limitValue & 0xff,
      initialSource,
      headerByte: null,
      reentryByte: null,
      exitByte: exitValue === null || exitValue === undefined ? null : makeExactByte(exitValue),
      control,
      template: {
        kind: 'initialSourceByte',
        controlKind: control.kind,
        flag: control.flag,
        reentryValue: control.reentryValue,
        direction,
        step: Number.isInteger(control.step) ? control.step : 1,
        limitValue: limitValue === null || limitValue === undefined ? null : limitValue & 0xff
      }
    }
  };
}

function deriveFromUpdateSource(source, initialValue, reentryPredicate) {
  const registerName = source.registerName;
  const direction = source.direction;
  const initial = initialValue & 0xff;
  const control = {
    kind: 'updateFlag',
    flag: reentryPredicate.flag,
    reentryValue: reentryPredicate.value
  };

  if (direction === 'down' && reentryPredicate.flag === 'z' && reentryPredicate.value === FLAG_VALUE.FALSE) {
    if (initial <= 1) return { ok: false, reason: 'oneTripOrEmptyLoop' };
    return makeCounter({ registerName, direction, initialValue: initial, limitValue: 0x00, headerMin: 0x01, headerMax: initial, reentryMin: 0x01, reentryMax: (initial - 1) & 0xff, exitValue: 0x00, control });
  }

  if (direction === 'down' && reentryPredicate.flag === 'n' && reentryPredicate.value === FLAG_VALUE.FALSE) {
    if (initial === 0x00 || initial > 0x7f) return { ok: false, reason: 'wraparoundCounterShape' };
    return makeCounter({ registerName, direction, initialValue: initial, limitValue: 0xff, headerMin: 0x00, headerMax: initial, reentryMin: 0x00, reentryMax: (initial - 1) & 0xff, exitValue: 0xff, control });
  }

  if (direction === 'down' && reentryPredicate.flag === 'n' && reentryPredicate.value === FLAG_VALUE.TRUE) {
    if (initial <= 0x80) return { ok: false, reason: 'oneTripOrEmptyLoop' };
    return makeCounter({ registerName, direction, initialValue: initial, limitValue: 0x7f, headerMin: 0x80, headerMax: initial, reentryMin: 0x80, reentryMax: (initial - 1) & 0xff, exitValue: 0x7f, control });
  }

  if (direction === 'up' && reentryPredicate.flag === 'z' && reentryPredicate.value === FLAG_VALUE.FALSE) {
    if (initial >= 0xff) return { ok: false, reason: 'oneTripOrEmptyLoop' };
    return makeCounter({ registerName, direction, initialValue: initial, limitValue: 0x00, headerMin: initial, headerMax: 0xff, reentryMin: (initial + 1) & 0xff, reentryMax: 0xff, exitValue: 0x00, control });
  }

  if (direction === 'up' && reentryPredicate.flag === 'n' && reentryPredicate.value === FLAG_VALUE.FALSE) {
    if (initial >= 0x7f) return { ok: false, reason: 'oneTripOrEmptyLoop' };
    return makeCounter({ registerName, direction, initialValue: initial, limitValue: 0x80, headerMin: initial, headerMax: 0x7f, reentryMin: (initial + 1) & 0xff, reentryMax: 0x7f, exitValue: 0x80, control });
  }

  if (direction === 'up' && reentryPredicate.flag === 'n' && reentryPredicate.value === FLAG_VALUE.TRUE) {
    if (initial < 0x7f || initial >= 0xff) return { ok: false, reason: 'wraparoundCounterShape' };
    return makeCounter({ registerName, direction, initialValue: initial, limitValue: 0x00, headerMin: initial, headerMax: 0xff, reentryMin: Math.max((initial + 1) & 0xff, 0x80), reentryMax: 0xff, exitValue: 0x00, control });
  }

  return { ok: false, reason: 'unsupportedPredicateForUpdate' };
}

function deriveParametricFromUpdateSource(source, initialSource, reentryPredicate) {
  const registerName = source.registerName;
  const direction = source.direction;
  const control = {
    kind: 'updateFlag',
    flag: reentryPredicate.flag,
    reentryValue: reentryPredicate.value
  };

  if (direction === 'down' && reentryPredicate.flag === 'z' && reentryPredicate.value === FLAG_VALUE.FALSE) {
    return makeParametricCounter({ registerName, direction, initialSource, limitValue: 0x00, exitValue: 0x00, control });
  }

  if (direction === 'down' && reentryPredicate.flag === 'n' && reentryPredicate.value === FLAG_VALUE.FALSE) {
    return makeParametricCounter({ registerName, direction, initialSource, limitValue: 0xff, exitValue: 0xff, control });
  }

  if (direction === 'down' && reentryPredicate.flag === 'n' && reentryPredicate.value === FLAG_VALUE.TRUE) {
    return makeParametricCounter({ registerName, direction, initialSource, limitValue: 0x7f, exitValue: 0x7f, control });
  }

  if (direction === 'up' && reentryPredicate.flag === 'z' && reentryPredicate.value === FLAG_VALUE.FALSE) {
    return makeParametricCounter({ registerName, direction, initialSource, limitValue: 0x00, exitValue: 0x00, control });
  }

  if (direction === 'up' && reentryPredicate.flag === 'n' && reentryPredicate.value === FLAG_VALUE.FALSE) {
    return makeParametricCounter({ registerName, direction, initialSource, limitValue: 0x80, exitValue: 0x80, control });
  }

  if (direction === 'up' && reentryPredicate.flag === 'n' && reentryPredicate.value === FLAG_VALUE.TRUE) {
    return makeParametricCounter({ registerName, direction, initialSource, limitValue: 0x00, exitValue: 0x00, control });
  }

  return { ok: false, reason: 'unsupportedPredicateForUpdate' };
}

function deriveFromCompareSource(source, initialValue, reentryPredicate) {
  const registerName = source.registerName;
  const direction = source.direction;
  const initial = initialValue & 0xff;
  const limit = source.immediate & 0xff;
  const step = Math.max(1, Number.isInteger(source.step) ? source.step : 1);
  const control = {
    kind: 'compareImmediate',
    flag: reentryPredicate.flag,
    reentryValue: reentryPredicate.value,
    step
  };

  if (direction === 'up' && reentryPredicate.flag === 'z' && reentryPredicate.value === FLAG_VALUE.FALSE) {
    if (limit <= initial) return { ok: false, reason: 'wraparoundCounterShape' };
    const distance = limit - initial;
    if (distance % step !== 0) return { ok: false, reason: 'wraparoundCounterShape' };
    const trips = distance / step;
    if (trips <= 1) return { ok: false, reason: 'oneTripOrEmptyLoop' };
    return makeCounter({ registerName, direction, initialValue: initial, limitValue: limit, headerMin: initial, headerMax: limit - step, reentryMin: initial + step, reentryMax: limit - step, exitValue: limit, control, step });
  }

  if (direction === 'up' && reentryPredicate.flag === 'c' && reentryPredicate.value === FLAG_VALUE.FALSE) {
    if (limit <= initial) return { ok: false, reason: 'wraparoundCounterShape' };
    const trips = Math.ceil((limit - initial) / step);
    if (trips <= 1) return { ok: false, reason: 'oneTripOrEmptyLoop' };
    const exitValue = initial + trips * step;
    if (exitValue > 0xff) return { ok: false, reason: 'wraparoundCounterShape' };
    return makeCounter({ registerName, direction, initialValue: initial, limitValue: limit, headerMin: initial, headerMax: exitValue - step, reentryMin: initial + step, reentryMax: exitValue - step, exitValue, control, step });
  }

  if (direction === 'down' && reentryPredicate.flag === 'z' && reentryPredicate.value === FLAG_VALUE.FALSE) {
    if (initial <= limit) return { ok: false, reason: 'wraparoundCounterShape' };
    const distance = initial - limit;
    if (distance % step !== 0) return { ok: false, reason: 'wraparoundCounterShape' };
    const trips = distance / step;
    if (trips <= 1) return { ok: false, reason: 'oneTripOrEmptyLoop' };
    return makeCounter({ registerName, direction, initialValue: initial, limitValue: limit, headerMin: limit + step, headerMax: initial, reentryMin: limit + step, reentryMax: initial - step, exitValue: limit, control, step });
  }

  if (direction === 'down' && reentryPredicate.flag === 'c' && reentryPredicate.value === FLAG_VALUE.TRUE) {
    if (limit === 0x00 || initial < limit) return { ok: false, reason: 'wraparoundCounterShape' };
    const trips = Math.floor((initial - limit) / step) + 1;
    if (trips <= 1) return { ok: false, reason: 'oneTripOrEmptyLoop' };
    const exitValue = initial - trips * step;
    if (exitValue < 0x00) return { ok: false, reason: 'wraparoundCounterShape' };
    return makeCounter({ registerName, direction, initialValue: initial, limitValue: limit, headerMin: exitValue + step, headerMax: initial, reentryMin: exitValue + step, reentryMax: initial - step, exitValue, control, step });
  }

  return { ok: false, reason: 'unsupportedPredicateForCompare' };
}

function deriveParametricFromCompareSource(source, initialSource, reentryPredicate) {
  const registerName = source.registerName;
  const direction = source.direction;
  const limit = source.immediate & 0xff;
  const step = Math.max(1, Number.isInteger(source.step) ? source.step : 1);
  const control = {
    kind: 'compareImmediate',
    flag: reentryPredicate.flag,
    reentryValue: reentryPredicate.value,
    step
  };

  if (direction === 'up' && reentryPredicate.flag === 'z' && reentryPredicate.value === FLAG_VALUE.FALSE) {
    return makeParametricCounter({ registerName, direction, initialSource, limitValue: limit, exitValue: limit, control });
  }

  if (direction === 'up' && reentryPredicate.flag === 'c' && reentryPredicate.value === FLAG_VALUE.FALSE) {
    return makeParametricCounter({ registerName, direction, initialSource, limitValue: limit, exitValue: limit, control });
  }

  if (direction === 'down' && reentryPredicate.flag === 'z' && reentryPredicate.value === FLAG_VALUE.FALSE) {
    return makeParametricCounter({ registerName, direction, initialSource, limitValue: limit, exitValue: limit, control });
  }

  if (direction === 'down' && reentryPredicate.flag === 'c' && reentryPredicate.value === FLAG_VALUE.TRUE) {
    return makeParametricCounter({ registerName, direction, initialSource, limitValue: limit, exitValue: (limit - 1) & 0xff, control });
  }

  return { ok: false, reason: 'unsupportedPredicateForCompare' };
}

function makeSummary({ candidate, kind, counter, branch, update, updateRecords, compare, initializer, initializerSource, exitEdge, modifiesRegisters, flagSource }) {
  const exitKey = exitEdge ? edgeKey(exitEdge) : null;
  return {
    loopId: candidate.loopId,
    kind,
    confidence: 'proved',
    sccId: candidate.sccId,
    headerBlockInstanceId: candidate.headerBlockInstanceId,
    tailBlockInstanceId: candidate.tailBlockInstanceId,
    bodyBlockInstanceIds: [...candidate.bodyBlockInstanceIds],
    reentryEdgeKey: candidate.reentryEdgeKey,
    exitEdgeKey: exitKey,
    depth: candidate.depth,
    parentLoopId: candidate.parentLoopId,
    childLoopIds: [...candidate.childLoopIds],
    counter,
    branch: {
      mnemonic: branch.mnemonic,
      reentryEdgeKey: candidate.reentryEdgeKey,
      exitEdgeKey: exitKey
    },
    effects: {
      modifiesRegisters: [...modifiesRegisters],
      clobbersFlags: true,
      mayWriteRam: false,
      mayCall: false,
      mayAffectCodeMapping: false
    },
    evidence: {
      initializerInstructionId: initializer ? initializer.instruction.instructionId >>> 0 : null,
      initializerSourceInstructionId: initializerSource ? initializerSource.instruction.instructionId >>> 0 : null,
      updateInstructionId: update ? update.instruction.instructionId >>> 0 : null,
      updateInstructionIds: Array.isArray(updateRecords) ? updateRecords.map((record) => record.instruction.instructionId >>> 0) : [],
      compareInstructionId: compare ? compare.instruction.instructionId >>> 0 : null,
      branchInstructionId: branch ? branch.instruction.instructionId >>> 0 : null,
      flagSourceInstructionId: flagSource ? flagSource.instruction.instructionId >>> 0 : null
    }
  };
}

export function summarizeCounterLoopCandidate({ candidate, context, indexes, candidateById, childSummaryByLoopId }) {
  const tail = findTailBranch(candidate, indexes);
  if (!tail.ok) return tail;
  const branchPredicate = getBranchPredicateForMnemonic(tail.branch.mnemonic);
  if (!branchPredicate) return { ok: false, reason: 'unsupportedBranchPredicate' };

  const sourceResult = findFlagSourceBeforeBranch(tail.records, tail.branchIndex, tail.reentryPredicate);
  if (!sourceResult.ok) return sourceResult;
  const source = sourceResult.source;
  const registerName = source.registerName;
  if (!COUNTER_REGISTERS.includes(registerName)) return { ok: false, reason: 'unsupportedFlagSource' };

  const initializer = findInitializerValue(candidate, registerName, indexes);
  if (!initializer.ok) return { ok: false, reason: initializer.reason };

  const derived = initializer.source.kind === 'exactByte'
    ? (source.kind === 'counterUpdate'
      ? deriveFromUpdateSource(source, initializer.value, tail.reentryPredicate)
      : deriveFromCompareSource(source, initializer.value, tail.reentryPredicate))
    : (source.kind === 'counterUpdate'
      ? deriveParametricFromUpdateSource(source, initializer.source, tail.reentryPredicate)
      : deriveParametricFromCompareSource(source, initializer.source, tail.reentryPredicate));
  if (!derived.ok) return derived;

  const updateRecord = source.kind === 'counterUpdate' ? source.record : source.updateRecord;
  const updateRecords = source.kind === 'counterUpdate' ? [source.record] : (Array.isArray(source.updateRecords) ? source.updateRecords : [source.updateRecord]);
  const compareRecord = source.kind === 'compareImmediate' ? source.record : null;
  const allowedInstructionIds = new Set(updateRecords.map((record) => record.instruction.instructionId >>> 0));
  if (compareRecord) allowedInstructionIds.add(compareRecord.instruction.instructionId >>> 0);

  const safe = scanSafety({
    candidate,
    context,
    indexes,
    counterRegister: registerName,
    allowedInstructionIds,
    childSummaryByLoopId,
    candidateById
  });
  if (!safe.ok) return safe;

  return {
    ok: true,
    summary: makeSummary({
      candidate,
      kind: 'counterLoop',
      counter: derived.counter,
      branch: tail.branch,
      update: updateRecord,
      updateRecords,
      compare: compareRecord,
      initializer: initializer.initializerRecord,
      initializerSource: initializer.initializerSourceRecord,
      exitEdge: tail.exitEdge,
      modifiesRegisters: [registerName],
      flagSource: source.record
    })
  };
}
