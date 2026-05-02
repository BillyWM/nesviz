import { cpuToRomOffWithMapper } from '../map/cpuToRomOff.js';
import { disasmOneAt } from '../../cpu6502/disasm.js';
import { hexN } from '../../cpu6502/fmt.js';
import { clamp } from '../../utils/numberUtils.js';

import { DEFAULT_PROBABLE_CONFIG } from './config.js';

function probBlockId(romStart) {
  return `prob:${hexN(romStart, 6)}`;
}

function decodeLinear({ prgBytes, mapper, cpuStart, romStart, maxBytes }) {
  const lines = [];
  const boundaries = new Set();
  boundaries.add(romStart);

  let pc = cpuStart & 0xffff;
  let decodedBytes = 0;

  while (decodedBytes < maxBytes) {
    const instr = disasmOneAt(prgBytes, mapper, pc);
    if (!instr.ok) {
      return { ok: false, lines, decodedBytes, stop: 'decode_fail' };
    }

    lines.push({
      cpuAddr: pc,
      romOff: instr.romOff,
      len: instr.len,
      bytesText: instr.bytesText,
      asm: instr.text,
      mnemonic: instr.mnemonic,
      mode: instr.mode,
      flow: instr.flow
    });

    decodedBytes += instr.len;
    boundaries.add(instr.romOff);
    boundaries.add(instr.romOff + instr.len);

    const f = instr.flow;
    // For the scan we keep going linearly until a hard terminator. Calls still fall through. 🤖
    if (f.type === 'jump' || f.type === 'jmp_ind' || f.type === 'stop' || f.type === 'illegal') {
      return { ok: true, lines, decodedBytes, stop: f.type };
    }

    pc = (pc + instr.len) & 0xffff;
  }

  return { ok: true, lines, decodedBytes, stop: 'max_bytes' };
}

function scoreChunk({ mapper, lines, romStart, romEnd, stop }, cfg) {
  const byRom = new Map();
  for (let i = 0; i < lines.length; i++) byRom.set(lines[i].romOff, i);

  let reachable = 0;
  let total = lines.length;
  let branchCount = 0;
  let branchHits = 0;
  let illegalPenalty = 0;

  // Graph reachability over instruction boundaries (rom offsets). 🤖
  const q = [];
  const seen = new Set();
  q.push(romStart);
  seen.add(romStart);

  while (q.length) {
    const ro = q.pop();
    const idx = byRom.get(ro);
    if (idx == null) continue;
    reachable++;

    const ln = lines[idx];
    const nextRo = ln.romOff + ln.len;
    const f = ln.flow;

    function enqueueCpuTarget(cpuAddr) {
      const tRo = cpuToRomOffWithMapper(mapper, cpuAddr, fetchCtx);
      if (tRo == null) return;
      if (tRo < romStart || tRo >= romEnd) return;
      if (!byRom.has(tRo)) return;
      if (!seen.has(tRo)) {
        seen.add(tRo);
        q.push(tRo);
      }
    }

    if (f.type === 'branch') {
      branchCount++;
      const tRo = cpuToRomOffWithMapper(mapper, f.target, fetchCtx);
      if (tRo != null && tRo >= romStart && tRo < romEnd && byRom.has(tRo)) branchHits++;
      enqueueCpuTarget(f.target);
      enqueueCpuTarget(f.fallthrough);
    } else if (f.type === 'call') {
      enqueueCpuTarget(f.fallthrough);
    } else if (f.type === 'jump') {
      enqueueCpuTarget(f.target);
    } else if (f.type === 'jmp_ind' || f.type === 'stop' || f.type === 'illegal') {
      // no successors
    } else {
      // straight-line fallthrough
      if (byRom.has(nextRo) && !seen.has(nextRo)) {
        seen.add(nextRo);
        q.push(nextRo);
      }
    }
  }

  const reachableRatio = total > 0 ? reachable / total : 0;
  const branchHitRate = branchCount > 0 ? branchHits / branchCount : 1;

  // Penalize early/illegal stops. 🤖
  if (cfg.scoreIllegalStops) {
    if (stop === 'illegal' || stop === 'decode_fail') illegalPenalty = 1;
  }

  const decodeLen = clamp((romEnd - romStart) / cfg.maxDecodeBytes, 0, 1);

  let score = 0;
  if (cfg.scoreReachability) score += cfg.wReachableRatio * reachableRatio;
  if (cfg.scoreBranchTargets) score += cfg.wBranchHitRate * branchHitRate;
  score += cfg.wDecodeLen * decodeLen;
  score -= cfg.wIllegalStopPenalty * illegalPenalty;

  return { score, reachableRatio, branchHitRate, branchCount, stop };
}

export function scanProbableCode({ prgBytes, mapper, knownBitmap, scanRange, config }) {
  const cfg = { ...DEFAULT_PROBABLE_CONFIG, ...(config || {}) };
  if (!cfg.enabled) return [];

  const prgSize = prgBytes.length | 0;
  const rangeStart = scanRange?.start ?? 0;
  const rangeEnd = scanRange?.end ?? prgSize;

  const blocks = [];
  const claimed = new Uint8Array(prgSize);

  function isUnknown(off) {
    if (off < 0 || off >= prgSize) return false;
    if (claimed[off]) return false;
    return (knownBitmap?.[off] ?? 0) === 0;
  }

  let off = rangeStart;
  while (off < rangeEnd) {
    while (off < rangeEnd && !isUnknown(off)) off++;
    if (off >= rangeEnd) break;

    const runStart = off;
    while (off < rangeEnd && isUnknown(off)) off++;
    const runEnd = off;
    const runLen = runEnd - runStart;

    if (runLen < cfg.minUnknownRun) continue;

    // Try candidate starts inside the run; keep the best scoring chunk. 🤖
    let best = null;
    for (let s = runStart; s < runEnd; s += cfg.startStride) {
      const cpuStarts = mapper.romOffToCpuAddrs(s);
      if (!cpuStarts.length) continue;

      const decoded = decodeLinear({
        prgBytes,
        mapper,
        cpuStart: cpuStarts[0],
        romStart: s,
        maxBytes: Math.min(cfg.maxDecodeBytes, runEnd - s)
      });

      const romEnd = decoded.lines.length
        ? decoded.lines[decoded.lines.length - 1].romOff + decoded.lines[decoded.lines.length - 1].len
        : s;

      if (romEnd <= s) continue;

      const scored = scoreChunk({ mapper, lines: decoded.lines, romStart: s, romEnd, stop: decoded.stop }, cfg);
      if (scored.score < cfg.minScore) continue;

      if (!best || scored.score > best.scored.score) {
        best = { start: s, end: romEnd, decoded, scored };
      }
    }

    if (!best) continue;

    // Claim bytes so we don't emit overlapping chunks. 🤖
    for (let i = best.start; i < Math.min(best.end, prgSize); i++) claimed[i] = 1;

    blocks.push({
      id: probBlockId(best.start),
      romStart: best.start,
      romEnd: best.end,
      confidence: 'probable',
      instances: mapper.romOffToCpuAddrs(best.start).map((cpuStart) => ({ ctxId: 'nrom', cpuStart })),
      lines: best.decoded.lines,
      probable: {
        score: best.scored.score,
        reachableRatio: best.scored.reachableRatio,
        branchHitRate: best.scored.branchHitRate,
        branchCount: best.scored.branchCount,
        stop: best.scored.stop
      }
    });

    if (blocks.length >= cfg.maxChunks) break;
  }

  return blocks.sort((a, b) => a.romStart - b.romStart);
}
