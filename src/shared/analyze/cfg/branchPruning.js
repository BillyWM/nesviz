import { ADDRESSING_MODES as AM } from '../../cpu6502/addressingModes.js';
import { OPCODES } from '../../cpu6502/opcodes.js';
import { requireInstruction, requireObject } from '../dataShape.js';
import {
  FLAG_VALUE,
  boolFlag,
  createUnknownFlags,
  withFlagUpdates
} from '../domains/flagsDomain.js';
import {
  flagsWrittenByMnemonic,
  getBranchPredicateForMnemonic,
  getFixedFlagEffect
} from '../domains/flagEffects.js';

// Strict-CFG branch pruning policy.
// This is not a separate flags domain. It uses the shared analyze flag lattice
// and shared 6502 flag-effect helpers, but keeps the exact CFG behavior local
// and conservative: facts are only tracked within the straight-line decode that
// is currently being materialized and are not joined across CFG predecessors.

function opcodeEntryForInstruction(instruction) {
  requireInstruction(instruction, 'strict CFG branch pruning instruction');
  const entry = OPCODES[instruction.opcode & 0xff];
  if (!entry) throw new Error(`Missing opcode table entry for strict CFG branch pruning opcode ${instruction.opcode}`);
  return entry;
}

function znFromByte(value) {
  const byte = value & 0xff;
  return {
    z: boolFlag(byte === 0),
    n: boolFlag((byte & 0x80) !== 0)
  };
}

function unknownUpdates(flagNames) {
  const updates = {};
  for (const flag of flagNames) updates[flag] = FLAG_VALUE.UNKNOWN;
  return updates;
}

export function createBranchPruningState() {
  return createUnknownFlags();
}

export function updateBranchPruningStateForInstruction(flags, instruction) {
  requireObject(flags, 'strict CFG branch pruning flags');
  const entry = opcodeEntryForInstruction(instruction);
  const mnemonic = entry.mnemonic;
  const mode = entry.mode;

  if ((mnemonic === 'LDA' || mnemonic === 'LDX' || mnemonic === 'LDY') && mode === AM.IMMEDIATE) {
    return withFlagUpdates(flags, znFromByte(instruction.operand));
  }

  const fixedEffect = getFixedFlagEffect(mnemonic);
  if (fixedEffect) return withFlagUpdates(flags, fixedEffect);

  const written = flagsWrittenByMnemonic(mnemonic);
  if (written.size > 0) return withFlagUpdates(flags, unknownUpdates(written));

  return withFlagUpdates(flags, {});
}

export function getBranchFeasibility(instruction, flags) {
  requireObject(flags, 'strict CFG branch pruning flags');
  const entry = opcodeEntryForInstruction(instruction);
  const predicate = getBranchPredicateForMnemonic(entry.mnemonic);
  if (!predicate) {
    return {
      taken: true,
      fallthrough: true,
      forced: null,
      flag: null,
      expected: null,
      actual: null
    };
  }

  const actual = flags[predicate.flag] || FLAG_VALUE.UNKNOWN;
  if (actual === FLAG_VALUE.UNKNOWN || actual === FLAG_VALUE.BOTTOM) {
    return {
      taken: true,
      fallthrough: true,
      forced: null,
      flag: predicate.flag,
      expected: predicate.value,
      actual
    };
  }

  const taken = actual === predicate.value;
  return {
    taken,
    fallthrough: !taken,
    forced: taken ? 'taken' : 'fallthrough',
    flag: predicate.flag,
    expected: predicate.value,
    actual
  };
}

export function isBranchPrunedToSingleEdge(instruction, flags) {
  return getBranchFeasibility(instruction, flags).forced !== null;
}
