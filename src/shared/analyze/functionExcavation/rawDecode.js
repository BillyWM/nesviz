import { ADDRESSING_MODES as AM } from '../../cpu6502/addressingModes.js';
import { OPCODES } from '../../cpu6502/opcodes.js';
import { decodeInstructionAtRomOff } from '../cfg/decode.js';
import { requireInteger } from '../dataShape.js';

const HARD_TERMINATOR_MNEMONICS = new Set(['JMP', 'RTS', 'RTI', 'BRK']);
const CONTROL_TRANSFER_MNEMONICS = new Set([
  'BCC', 'BCS', 'BEQ', 'BMI', 'BNE', 'BPL', 'BVC', 'BVS',
  'JMP', 'JSR', 'RTS', 'RTI', 'BRK'
]);

export function readRawU16le(bytes, off) {
  return ((bytes[off] & 0xff) | ((bytes[off + 1] & 0xff) << 8)) & 0xffff;
}

export function opcodeEntryForInstruction(instruction) {
  if (!instruction || typeof instruction !== 'object') throw new Error('raw decode instruction is required');
  return OPCODES[instruction.opcode & 0xff] || null;
}

export function decodeRawInstructionAtRomOff({ prgBytes, romOff }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('decodeRawInstructionAtRomOff requires PRG bytes');
  const normalizedRomOff = requireInteger(romOff, 'raw decode romOff') >>> 0;
  const decoded = decodeInstructionAtRomOff({
    prgBytes,
    romOff: normalizedRomOff,
    cpuAddr: normalizedRomOff & 0xffff
  });
  if (!decoded.ok) return decoded;

  const entry = opcodeEntryForInstruction(decoded.instruction);
  if (!entry) {
    return {
      ok: false,
      reason: 'illegalOpcode',
      romOff: normalizedRomOff,
      opcode: decoded.instruction.opcode & 0xff
    };
  }

  return {
    ok: true,
    instruction: {
      ...decoded.instruction,
      mnemonic: entry.mnemonic,
      mode: entry.mode
    }
  };
}

export function isRawHardTerminator(instruction) {
  const entry = opcodeEntryForInstruction(instruction);
  if (!entry) return true;
  return HARD_TERMINATOR_MNEMONICS.has(entry.mnemonic);
}

export function nextRawFallthroughRomOff(instruction) {
  if (isRawHardTerminator(instruction)) return null;
  return ((instruction.romOff >>> 0) + (instruction.size >>> 0)) >>> 0;
}


export function canonicalPpuRegisterForCpuAddr(cpuAddr) {
  const normalized = cpuAddr & 0xffff;
  if (normalized < 0x2000 || normalized > 0x3fff) return null;
  return 0x2000 + (normalized & 0x0007);
}

export function isRawControlTransfer(instruction) {
  const entry = opcodeEntryForInstruction(instruction);
  if (!entry) return true;
  return CONTROL_TRANSFER_MNEMONICS.has(entry.mnemonic);
}

export function rawImmediateLoadRegister(instruction) {
  const entry = opcodeEntryForInstruction(instruction);
  if (!entry || entry.mode !== AM.IMMEDIATE) return null;
  if (entry.mnemonic === 'LDA') return 'A';
  if (entry.mnemonic === 'LDX') return 'X';
  if (entry.mnemonic === 'LDY') return 'Y';
  return null;
}

export function isRawImmediateLoad(instruction, register = null, value = null) {
  const loadedRegister = rawImmediateLoadRegister(instruction);
  if (loadedRegister === null) return false;
  if (register !== null && loadedRegister !== register) return false;
  if (value === null) return true;
  return (instruction.operand & 0xff) === (value & 0xff);
}

export function isRawLdaImmediate(instruction, value = null) {
  return isRawImmediateLoad(instruction, 'A', value);
}

export function isRawAbsoluteStoreToCanonicalPpuRegister(instruction, canonicalCpuAddr, register = null) {
  const entry = opcodeEntryForInstruction(instruction);
  if (!entry || entry.mode !== AM.ABSOLUTE) return false;
  const storeRegister = rawStoreRegister(instruction);
  if (storeRegister === null) return false;
  if (register !== null && storeRegister !== register) return false;
  const canonical = canonicalPpuRegisterForCpuAddr(instruction.operand & 0xffff);
  if (canonical === null) return false;
  return canonical === (canonicalCpuAddr & 0xffff);
}

export function isRawAbsoluteStaToCanonicalPpuRegister(instruction, canonicalCpuAddr) {
  return isRawAbsoluteStoreToCanonicalPpuRegister(instruction, canonicalCpuAddr, 'A');
}

export function isRawAbsoluteReadFromCanonicalPpuRegister(instruction, canonicalCpuAddr, allowedMnemonics = null) {
  const entry = opcodeEntryForInstruction(instruction);
  if (!entry || entry.mode !== AM.ABSOLUTE) return false;
  if (allowedMnemonics instanceof Set && !allowedMnemonics.has(entry.mnemonic)) return false;
  const canonical = canonicalPpuRegisterForCpuAddr(instruction.operand & 0xffff);
  if (canonical === null) return false;
  return canonical === (canonicalCpuAddr & 0xffff);
}

export function rawStoreRegister(instruction) {
  const entry = opcodeEntryForInstruction(instruction);
  if (!entry) return null;
  if (entry.mnemonic === 'STA') return 'A';
  if (entry.mnemonic === 'STX') return 'X';
  if (entry.mnemonic === 'STY') return 'Y';
  return null;
}

export function isRawAbsoluteStoreTo(instruction, cpuAddr, register = null) {
  const entry = opcodeEntryForInstruction(instruction);
  if (!entry || entry.mode !== AM.ABSOLUTE) return false;
  if ((instruction.operand & 0xffff) !== (cpuAddr & 0xffff)) return false;
  const storeRegister = rawStoreRegister(instruction);
  if (storeRegister === null) return false;
  return register === null || storeRegister === register;
}

export function isRawAbsoluteStaToPrgSpace(instruction) {
  const entry = opcodeEntryForInstruction(instruction);
  if (!entry || entry.mode !== AM.ABSOLUTE) return false;
  if (entry.mnemonic !== 'STA') return false;
  const operand = instruction.operand & 0xffff;
  return operand >= 0x8000 && operand <= 0xffff;
}

export function isRawAccumulatorLsr(instruction) {
  const entry = opcodeEntryForInstruction(instruction);
  if (!entry || entry.mode !== AM.ACCUMULATOR) return false;
  return entry.mnemonic === 'LSR';
}

export function isRawControllerRead(instruction) {
  const entry = opcodeEntryForInstruction(instruction);
  if (!entry) return false;
  if ((instruction.operand & 0xffff) !== 0x4016 && (instruction.operand & 0xffff) !== 0x4017) return false;
  if (entry.mode !== AM.ABSOLUTE && entry.mode !== AM.ABSOLUTE_X && entry.mode !== AM.ABSOLUTE_Y) return false;
  return entry.mnemonic === 'ADC' ||
    entry.mnemonic === 'AND' ||
    entry.mnemonic === 'BIT' ||
    entry.mnemonic === 'CMP' ||
    entry.mnemonic === 'CPX' ||
    entry.mnemonic === 'CPY' ||
    entry.mnemonic === 'EOR' ||
    entry.mnemonic === 'LDA' ||
    entry.mnemonic === 'LDX' ||
    entry.mnemonic === 'LDY' ||
    entry.mnemonic === 'ORA' ||
    entry.mnemonic === 'SBC';
}

export function decodeRawForwardToHardTerminator({ prgBytes, startRomOff, mustReachRomOff = null }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('decodeRawForwardToHardTerminator requires PRG bytes');
  const start = requireInteger(startRomOff, 'raw forward startRomOff') >>> 0;
  const required = mustReachRomOff === null ? null : (requireInteger(mustReachRomOff, 'raw forward mustReachRomOff') >>> 0);
  const entries = [];
  const seen = new Set();
  let romOff = start;
  let reachedRequired = required === null;

  while (romOff < prgBytes.length) {
    if (seen.has(romOff)) return { ok: false, reason: 'repeatedRomOff', entries, detail: { romOff } };
    seen.add(romOff);

    const decoded = decodeRawInstructionAtRomOff({ prgBytes, romOff });
    if (!decoded.ok) {
      return {
        ok: false,
        reason: 'decodeFailed',
        entries,
        detail: {
          reason: typeof decoded.reason === 'string' ? decoded.reason : 'decodeFailed',
          romOff,
          opcode: typeof decoded.opcode === 'number' ? decoded.opcode & 0xff : null
        }
      };
    }

    const instruction = decoded.instruction;
    entries.push({ instruction });
    if (required !== null && (instruction.romOff >>> 0) === required) reachedRequired = true;

    if (isRawHardTerminator(instruction)) {
      if (!reachedRequired) return { ok: false, reason: 'hardTerminatorBeforeRequiredRomOff', entries };
      return { ok: true, entries, terminator: instruction };
    }

    const nextRomOff = nextRawFallthroughRomOff(instruction);
    if (nextRomOff === null) return { ok: false, reason: 'noRawFallthrough', entries };
    romOff = nextRomOff;
  }

  return { ok: false, reason: 'ranOffEndBeforeHardTerminator', entries };
}

export function decodeRawForwardToAnyRomOff({ prgBytes, startRomOff, targetRomOffs }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('decodeRawForwardToAnyRomOff requires PRG bytes');
  if (!(targetRomOffs instanceof Set)) throw new Error('decodeRawForwardToAnyRomOff requires a Set of target ROM offsets');
  const start = requireInteger(startRomOff, 'raw forward any startRomOff') >>> 0;
  const entries = [];
  const seen = new Set();
  let romOff = start;

  while (romOff < prgBytes.length) {
    if (seen.has(romOff)) return { ok: false, reason: 'repeatedRomOff', entries, detail: { romOff } };
    seen.add(romOff);

    const decoded = decodeRawInstructionAtRomOff({ prgBytes, romOff });
    if (!decoded.ok) {
      return {
        ok: false,
        reason: 'decodeFailed',
        entries,
        detail: {
          reason: typeof decoded.reason === 'string' ? decoded.reason : 'decodeFailed',
          romOff,
          opcode: typeof decoded.opcode === 'number' ? decoded.opcode & 0xff : null
        }
      };
    }

    const instruction = decoded.instruction;
    entries.push({ instruction });
    if (targetRomOffs.has(instruction.romOff >>> 0)) {
      return {
        ok: true,
        targetRomOff: instruction.romOff >>> 0,
        entries
      };
    }

    if (isRawHardTerminator(instruction)) return { ok: false, reason: 'hardTerminatorBeforeTarget', entries };

    const nextRomOff = nextRawFallthroughRomOff(instruction);
    if (nextRomOff === null) return { ok: false, reason: 'noRawFallthrough', entries };
    romOff = nextRomOff;
  }

  return { ok: false, reason: 'ranOffEndBeforeTarget', entries };
}
