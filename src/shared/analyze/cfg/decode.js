import { ADDRESSING_MODES as AM, ADDRESSING_MODE_LENGTHS } from '../../cpu6502/addressingModes.js';
import { OPCODES } from '../../cpu6502/opcodes.js';
import { makeInstructionId, makeSiteKey } from '../identity.js';
import { FLOW_TYPES } from './constants.js';
import { requireInteger, requireObject, requireString } from '../dataShape.js';

const BRANCH_MNEMONICS = new Set(['BPL', 'BMI', 'BVC', 'BVS', 'BCC', 'BCS', 'BNE', 'BEQ']);

function readU16le(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8)) & 0xffff;
}

function readS8(n) {
  const b = n & 0xff;
  return b < 0x80 ? b : b - 0x100;
}

function operandForMode(mode, prgBytes, romOff) {
  switch (mode) {
    case AM.IMPLIED:
    case AM.ACCUMULATOR:
      return null;
    case AM.IMMEDIATE:
    case AM.ZERO_PAGE:
    case AM.ZERO_PAGE_X:
    case AM.ZERO_PAGE_Y:
    case AM.INDIRECT_X:
    case AM.INDIRECT_Y:
    case AM.RELATIVE:
      return prgBytes[romOff + 1] & 0xff;
    case AM.ABSOLUTE:
    case AM.ABSOLUTE_X:
    case AM.ABSOLUTE_Y:
    case AM.INDIRECT:
      return readU16le(prgBytes, romOff + 1);
    default:
      throw new Error(`Unsupported addressing mode in decode: ${mode}`);
  }
}

function flowForInstruction(entry, operand, cpuAddr, size) {
  requireObject(entry, 'opcode table entry');
  const mnemonic = requireString(entry.mnemonic, 'opcode mnemonic');
  const mode = requireString(entry.mode, 'opcode addressing mode');
  const next = (cpuAddr + size) & 0xffff;

  if (BRANCH_MNEMONICS.has(mnemonic) && mode === AM.RELATIVE) {
    const target = (cpuAddr + 2 + readS8(operand)) & 0xffff;
    return { type: FLOW_TYPES.BRANCH, target, fallthrough: next };
  }

  if (mnemonic === 'JSR' && mode === AM.ABSOLUTE) {
    return { type: FLOW_TYPES.CALL, target: operand & 0xffff, fallthrough: next };
  }

  if (mnemonic === 'JMP' && mode === AM.ABSOLUTE) {
    return { type: FLOW_TYPES.JUMP, target: operand & 0xffff };
  }

  if (mnemonic === 'JMP' && mode === AM.INDIRECT) {
    return { type: FLOW_TYPES.JMP_INDIRECT, ptrAddr: operand & 0xffff };
  }

  if (mnemonic === 'RTS') return { type: FLOW_TYPES.STOP, reason: 'rts' };
  if (mnemonic === 'RTI') return { type: FLOW_TYPES.STOP, reason: 'rti' };
  if (mnemonic === 'BRK') return { type: FLOW_TYPES.STOP, reason: 'brk' };

  return { type: FLOW_TYPES.NEXT, next };
}

export function decodeInstructionAtRomOff({ prgBytes, romOff, cpuAddr }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('decodeInstructionAtRomOff requires PRG bytes');
  const normalizedRomOff = requireInteger(romOff, 'decode romOff') >>> 0;
  const normalizedCpuAddr = requireInteger(cpuAddr, 'decode cpuAddr') & 0xffff;

  if (normalizedRomOff >= prgBytes.length) {
    return {
      ok: false,
      reason: 'romOffsetOutOfRange',
      cpuAddr: normalizedCpuAddr,
      romOff: normalizedRomOff
    };
  }

  const opcode = prgBytes[normalizedRomOff] & 0xff;
  const entry = OPCODES[opcode];
  if (!entry) {
    return {
      ok: false,
      reason: 'illegalOpcode',
      cpuAddr: normalizedCpuAddr,
      romOff: normalizedRomOff,
      opcode
    };
  }

  const size = ADDRESSING_MODE_LENGTHS[entry.mode];
  if (typeof size !== 'number') {
    throw new Error(`Missing instruction length for addressing mode ${entry.mode}`);
  }
  if (normalizedRomOff + size > prgBytes.length) {
    return {
      ok: false,
      reason: 'instructionTruncated',
      cpuAddr: normalizedCpuAddr,
      romOff: normalizedRomOff,
      opcode
    };
  }

  const operand = operandForMode(entry.mode, prgBytes, normalizedRomOff);
  return {
    ok: true,
    instruction: {
      instructionId: makeInstructionId(normalizedRomOff),
      romOff: normalizedRomOff,
      opcode,
      operand,
      size,
      flow: flowForInstruction(entry, operand, normalizedCpuAddr, size)
    }
  };
}

export function decodeInstructionAtSite({ prgBytes, mapper, mapperContext, cpuAddr }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('decodeInstructionAtSite requires PRG bytes');
  requireObject(mapper, 'decode mapper');
  requireObject(mapperContext, 'decode mapperContext');
  requireInteger(cpuAddr, 'decode cpuAddr');

  const normalizedCpuAddr = cpuAddr & 0xffff;
  const resolved = mapper.resolveCpuAddress(mapperContext, normalizedCpuAddr, { purpose: 'instructionFetch' });
  requireObject(resolved, 'instruction fetch resolution');
  const contextKey = requireString(resolved.contextKey, 'instruction fetch resolution.contextKey');
  const siteKey = makeSiteKey(contextKey, normalizedCpuAddr);

  if (!resolved.ok) {
    const backing = requireObject(resolved.backing, 'failed instruction fetch backing');
    return {
      ok: false,
      reason: typeof backing.reason === 'string' ? backing.reason : 'instructionBackingNotExact',
      siteKey,
      contextKey,
      cpuAddr: normalizedCpuAddr,
      romOff: null
    };
  }

  const backing = requireObject(resolved.backing, 'instruction fetch backing');
  if (backing.kind !== 'exact') {
    return {
      ok: false,
      reason: typeof backing.reason === 'string' ? backing.reason : 'instructionBackingNotExact',
      siteKey,
      contextKey,
      cpuAddr: normalizedCpuAddr,
      romOff: null
    };
  }

  const romOff = requireInteger(backing.romOff, 'instruction fetch backing.romOff') >>> 0;
  const decoded = decodeInstructionAtRomOff({ prgBytes, romOff, cpuAddr: normalizedCpuAddr });
  if (!decoded.ok) {
    return {
      ...decoded,
      siteKey,
      contextKey
    };
  }

  const size = requireInteger(decoded.instruction.size, 'decoded instruction size');
  for (let i = 0; i < size; i += 1) {
    const byteCpuAddr = (normalizedCpuAddr + i) & 0xffff;
    const byteResolved = mapper.resolveCpuAddress(mapperContext, byteCpuAddr, { purpose: 'instructionFetchByte' });
    requireObject(byteResolved, 'instruction byte fetch resolution');
    if (!byteResolved.ok) {
      return {
        ok: false,
        reason: 'instructionCrossesMappingBoundary',
        siteKey,
        contextKey,
        cpuAddr: normalizedCpuAddr,
        romOff,
        opcode: decoded.instruction.opcode
      };
    }
    const byteBacking = requireObject(byteResolved.backing, 'instruction byte fetch backing');
    const byteRomOff = byteBacking.kind === 'exact' ? requireInteger(byteBacking.romOff, 'instruction byte fetch backing.romOff') >>> 0 : null;
    if (byteRomOff !== ((romOff + i) >>> 0)) {
      return {
        ok: false,
        reason: 'instructionCrossesMappingBoundary',
        siteKey,
        contextKey,
        cpuAddr: normalizedCpuAddr,
        romOff,
        opcode: decoded.instruction.opcode
      };
    }
  }

  const site = {
    siteKey,
    contextKey,
    cpuAddr: normalizedCpuAddr,
    romOff,
    mapperContext,
    backing
  };
  return {
    ok: true,
    site,
    instruction: decoded.instruction
  };
}
