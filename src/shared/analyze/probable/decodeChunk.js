import { disasmOneAtCtx } from '../../cpu6502/disasm.js';
import { buildRepeatStats } from './semanticRepeats.js';
import { s8, u16le } from '../../utils/byteUtils.js';

const BRANCHES = new Set(['BPL', 'BMI', 'BVC', 'BVS', 'BCC', 'BCS', 'BNE', 'BEQ']);

function isTerminator(mnemonic, mode) {
  if (mnemonic === 'RTS' || mnemonic === 'RTI' || mnemonic === 'BRK') return true;
  if (mnemonic === 'JMP' && (mode === 'abs' || mode === 'ind')) return true;
  return false;
}


export function decodeChunkFromRom({ prgBytes, mapper, startOff, maxOffExclusive, maxBytes }) {
  const start = startOff | 0;
  const maxOff = maxOffExclusive | 0;
  const cap = Math.max(1, maxBytes | 0);
  const seedSites = mapper.seedSitesForRomOff ? mapper.seedSitesForRomOff(start) : [];
  if (!seedSites.length) {
    return {
      ok: false,
      reason: 'no_seed_site',
      endReason: 'no_seed_site',
      startOff: start,
      endOff: start,
      decodedBytes: 0,
      instructionCount: 0,
      instructions: [],
      boundaries: new Set(),
      branchTargets: new Set(),
      endsOnCap: false,
      endsOnTerminator: false,
      lastMnemonic: null,
      lastMode: null,
      lastFlowType: null
    };
  }
  const seed = seedSites[0];
  const instructions = [];
  const boundaries = new Set([start]);
  const branchTargets = new Set();
  let endsOnCap = false;
  let endsOnTerminator = false;
  let cpu = seed.cpuAddr & 0xffff;
  let decoded = 0;
  let endReason = 'range_end';
  let lastMnemonic = null;
  let lastMode = null;
  let lastFlowType = null;
  const stats = {
    branchCount: 0,
    callCount: 0,
    jumpCount: 0,
    storeCount: 0,
    stackCount: 0,
    bitwiseImmediateCount: 0,
    maxBitwiseImmediateRun: 0
  };
  let currentBitwiseImmediateRun = 0;

  while (decoded < cap) {
    const instr = disasmOneAtCtx(prgBytes, mapper, seed.fetchCtx, cpu);
    if (!instr.ok || instr.backing?.kind !== 'exact') {
      endReason = instr?.flow?.type === 'unmapped' ? 'unmapped' : 'decode_fail';
      return {
        ok: false,
        reason: instr?.flow?.type || 'decode_fail',
        endReason,
        startOff: start,
        endOff: start + decoded,
        decodedBytes: decoded,
        instructionCount: instructions.length,
        instructions,
        boundaries,
        branchTargets,
        endsOnCap,
        endsOnTerminator,
        fetchCtx: seed.fetchCtx,
        cpuStart: seed.cpuAddr & 0xffff,
        lastMnemonic,
        lastMode,
        lastFlowType,
        repeatStats: buildRepeatStats(instructions)
      };
    }
    const off = instr.backing.romOff | 0;
    if (off < start || off + instr.len > maxOff) {
      endReason = 'range_end';
      break;
    }

    let branchTargetOff = null;
    let branchTargetCpu = null;
    if (BRANCHES.has(instr.mnemonic) && instr.mode === 'rel' && Array.isArray(instr.bytes) && instr.bytes.length > 1) {
      branchTargetCpu = (cpu + 2 + s8(instr.bytes[1])) & 0xffff;
      const targetFetch = mapper.resolveCodeFetch ? mapper.resolveCodeFetch(seed.fetchCtx, branchTargetCpu) : null;
      if (targetFetch?.backing?.kind === 'exact') {
        branchTargetOff = targetFetch.backing.romOff | 0;
        branchTargets.add(branchTargetOff);
      }
    }

    let absTargetCpu = null;
    if ((instr.mnemonic === 'JSR' && instr.mode === 'abs') || (instr.mnemonic === 'JMP' && instr.mode === 'abs')) {
      absTargetCpu = u16le(instr.bytes, 1);
    }

    if (BRANCHES.has(instr.mnemonic)) stats.branchCount++;
    if (instr.mnemonic === 'JSR') stats.callCount++;
    if (instr.mnemonic === 'JMP') stats.jumpCount++;
    if (instr.mnemonic === 'STA' || instr.mnemonic === 'STX' || instr.mnemonic === 'STY') stats.storeCount++;
    if (
      instr.mnemonic === 'PHA' || instr.mnemonic === 'PHP' || instr.mnemonic === 'PLA' || instr.mnemonic === 'PLP' ||
      instr.mnemonic === 'TSX' || instr.mnemonic === 'TXS'
    ) {
      stats.stackCount++;
    }
    const isBitwiseImmediate = instr.mode === 'imm' && (instr.mnemonic === 'EOR' || instr.mnemonic === 'ORA' || instr.mnemonic === 'AND');
    if (isBitwiseImmediate) {
      stats.bitwiseImmediateCount++;
      currentBitwiseImmediateRun++;
      if (currentBitwiseImmediateRun > stats.maxBitwiseImmediateRun) stats.maxBitwiseImmediateRun = currentBitwiseImmediateRun;
    } else {
      currentBitwiseImmediateRun = 0;
    }

    const bytesKey = Array.isArray(instr.bytes) ? instr.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ') : '';

    instructions.push({
      off,
      cpuAddr: cpu,
      op: instr.op,
      mnemonic: instr.mnemonic,
      mode: instr.mode,
      len: instr.len,
      bytes: Array.isArray(instr.bytes) ? instr.bytes.slice() : [],
      bytesKey,
      branchTargetOff,
      branchTargetCpu,
      absTargetCpu
    });

    lastMnemonic = instr.mnemonic;
    lastMode = instr.mode;
    lastFlowType = instr.flow?.type || null;

    decoded += instr.len;
    boundaries.add(off + instr.len);
    cpu = (cpu + instr.len) & 0xffff;

    if (isTerminator(instr.mnemonic, instr.mode)) {
      endsOnTerminator = true;
      endReason = 'terminator';
      break;
    }
  }

  if (decoded >= cap) {
    endsOnCap = true;
    endReason = 'cap';
  }
  return {
    ok: instructions.length > 0,
    reason: 'ok',
    endReason,
    startOff: start,
    endOff: start + decoded,
    decodedBytes: decoded,
    instructionCount: instructions.length,
    instructions,
    boundaries,
    branchTargets,
    endsOnCap,
    endsOnTerminator,
    terminatorMnemonic: instructions.length ? instructions[instructions.length - 1].mnemonic : null,
    stats,
    fetchCtx: seed.fetchCtx,
    cpuStart: seed.cpuAddr & 0xffff,
    lastMnemonic,
    lastMode,
    lastFlowType,
    repeatStats: buildRepeatStats(instructions)
  };
}
