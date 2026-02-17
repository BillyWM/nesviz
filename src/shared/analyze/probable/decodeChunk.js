import { OPCODES } from '../../cpu6502/opcodes.js';

// Decode a straight-line chunk starting at a physical PRG ROM offset. 🤖
// This is *not* recursive descent; we decode linearly following the fallthrough path until a terminator or error. 🤖
// The result is used for "probable code" scoring on bytes that weren't reached by conservative CFG discovery. 🤖

const MODE_LEN = {
  imp: 1,
  acc: 1,
  imm: 2,
  zp: 2,
  zpX: 2,
  zpY: 2,
  abs: 3,
  absX: 3,
  absY: 3,
  ind: 3,
  indX: 2,
  indY: 2,
  rel: 2
};

const BRANCHES = new Set(['BPL', 'BMI', 'BVC', 'BVS', 'BCC', 'BCS', 'BNE', 'BEQ']);

function s8(n) {
  const b = n & 0xff;
  return b < 0x80 ? b : b - 0x100;
}

function u16le(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8)) & 0xffff;
}

function isTerminator(mnemonic, mode) {
  if (mnemonic === 'RTS' || mnemonic === 'RTI' || mnemonic === 'BRK') return true;
  if (mnemonic === 'JMP' && (mode === 'abs' || mode === 'ind')) return true;
  return false;
}

// Returns { ok, startOff, endOff, decodedBytes, instructions, boundaries, branchTargets, endsOnCap, endsOnTerminator } 🤖
export function decodeChunkFromRom({ prgBytes, mapper, startOff, maxOffExclusive, maxBytes }) {
  const start = startOff | 0;
  const maxOff = maxOffExclusive | 0;
  const cap = Math.max(1, maxBytes | 0);

  const instructions = [];
  const boundaries = new Set();
  const branchTargets = new Set();
  let endsOnCap = false;
  let endsOnTerminator = false;

  let off = start;
  boundaries.add(off);

  while (off < maxOff && (off - start) < cap) {
    const op = prgBytes[off];
    const entry = OPCODES[op];
    if (!entry) {
      return {
        ok: false,
        reason: 'illegal',
        startOff: start,
        endOff: off,
        decodedBytes: off - start,
        instructions,
        boundaries,
        branchTargets,
        endsOnCap,
        endsOnTerminator
      };
    }

    const len = MODE_LEN[entry.mode] ?? 1;
    if (off + len > maxOff) {
      // Would read beyond the scan range; stop cleanly (not an illegal opcode, just out-of-range). 🤖
      break;
    }

    const bytes = Array.from(prgBytes.subarray(off, off + len));

    let branchTargetOff = null;
    if (BRANCHES.has(entry.mnemonic) && entry.mode === 'rel') {
      // Relative branches are position-relative; for NROM, CPU-relative offsets correspond to ROM-relative offsets too. 🤖
      branchTargetOff = off + 2 + s8(bytes[1]);
      branchTargets.add(branchTargetOff);
    }

    let absTargetCpu = null;
    if ((entry.mnemonic === 'JSR' && entry.mode === 'abs') || (entry.mnemonic === 'JMP' && entry.mode === 'abs')) {
      absTargetCpu = u16le(bytes, 1);
    }

    const ins = {
      off,
      op,
      mnemonic: entry.mnemonic,
      mode: entry.mode,
      len,
      branchTargetOff,
      absTargetCpu
    };
    instructions.push(ins);

    const nextOff = off + len;
    if (nextOff < maxOff) boundaries.add(nextOff);

    off = nextOff;

    if (isTerminator(entry.mnemonic, entry.mode)) {
      endsOnTerminator = true;
      break;
    }
  }

  if ((off - start) >= cap) endsOnCap = true;

  return {
    ok: instructions.length > 0,
    reason: 'ok',
    startOff: start,
    endOff: off,
    decodedBytes: off - start,
    instructions,
    boundaries,
    branchTargets,
    endsOnCap,
    endsOnTerminator
  };
}
