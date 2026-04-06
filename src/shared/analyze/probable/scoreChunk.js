// Score a decoded straight-line chunk for "code-likeness". 🤖
// This is deliberately heuristic-y, but kept fully centralized and configurable. 🤖

import { isChunkInterruptRoot } from './rtiVectorHeuristic.js';
import { evaluateProbableSemanticRepeats } from './semanticRepeats.js';

function inCpuIoRange(cpuAddr) {
  const a = cpuAddr & 0xffff;
  // PPU/APU/controller etc. 🤖
  return a >= 0x2000 && a <= 0x401f;
}

function highestMatchingBucket(decodedBytes, buckets, scores) {
  if (!Array.isArray(buckets) || !Array.isArray(scores)) return { bucket: null, score: 0 };
  let bestBucket = null;
  let bestScore = 0;
  const n = Math.min(buckets.length, scores.length);
  for (let i = 0; i < n; i++) {
    const bucket = buckets[i] | 0;
    if (decodedBytes >= bucket) {
      bestBucket = bucket;
      bestScore = scores[i] | 0;
    }
  }
  return { bucket: bestBucket, score: bestScore };
}

export function scoreChunk({ chunk, mapper, config, probableContext = null }) {
  const w = config.weights;
  const heur = config.heuristics;

  let total = 0;
  const details = {
    branchGood: 0,
    branchMidInstrBad: 0,
    branchOutside: 0,
    reachableRatio: 1,
    endsOnTerminator: !!chunk.endsOnTerminator,
    terminatorMnemonic: chunk.terminatorMnemonic || null,
    rtiInterruptRoot: false,
    endsOnCap: !!chunk.endsOnCap,
    suspiciousBitwiseImmediateWall: false,
    endReason: chunk.endReason || null,
    lastFlowType: chunk.lastFlowType || null,
    decodedBytesBucket: null,
    decodedBytesBonus: 0,
    badTailPenalty: 0,
    hardRejected: false,
    hardRejectReason: null,
    maxExactCmpRun: 0,
    maxExactCpxRun: 0,
    maxExactCpyRun: 0,
    maxExactLoadImmRun: 0,
    maxExactLoadOtherRun: 0,
    maxExactImmBitwiseRun: 0,
    maxExactAndRun: 0,
    maxExactOraRun: 0,
    maxExactEorRun: 0,
    maxExactRolRun: 0,
    maxExactRorRun: 0,
    maxExactClcRun: 0,
    maxExactSecRun: 0,
    maxExactCldRun: 0,
    maxExactSedRun: 0,
    maxExactClvRun: 0,
    maxExactCliRun: 0,
    maxExactSeiRun: 0,
    suspiciousRepeatRunCount: 0,
    repeatPatternPenalty: 0,
    semanticBitwiseRepeatRunCount: 0,
    semanticBitwiseRepeatPenalty: 0,
    semanticRotateRepeatRunCount: 0,
    semanticRotateRepeatPenalty: 0,
    semanticFlagRepeatRunCount: 0,
    semanticFlagRepeatPenalty: 0,
    periodicPrefixPeriod: null,
    periodicPrefixBytes: 0,
    periodicPrefixRatio: 0,
    periodicPrefixSupport: false
  };

  // A) Branch target -> instruction boundary consistency. 🤖
  if (heur.branchBoundary) {
    for (const ins of chunk.instructions) {
      if (ins.branchTargetOff == null) continue;
      const t = ins.branchTargetOff;
      if (t < chunk.startOff || t >= chunk.endOff) {
        details.branchOutside++;
        total += w.branchOutside;
        continue;
      }
      if (chunk.boundaries.has(t)) {
        details.branchGood++;
        total += w.branchGood;
      } else {
        details.branchMidInstrBad++;
        total += w.branchMidInstrBad;
      }
    }
  }

  // B) Internal reachability (fallthrough + relative branches only). 🤖
  if (heur.reachability) {
    const reachable = computeReachableBoundaries(chunk);
    const ratio = chunk.instructions.length ? reachable.size / chunk.instructions.length : 0;
    details.reachableRatio = ratio;
    if (ratio >= 0.85) total += w.reachableHigh;
    else if (ratio >= 0.6) total += w.reachableMid;
    else total += w.reachableLow;
  }

  // C) Reward longer clean legal decode runs, but in saturating buckets rather than linearly. 🤖
  if (heur.decodedBytesBuckets) {
    const { bucket, score } = highestMatchingBucket(chunk.decodedBytes | 0, heur.decodedBytesBuckets, w.decodedBytesBucketScores);
    if (bucket != null && score) {
      details.decodedBytesBucket = bucket;
      details.decodedBytesBonus = score;
      total += score;
    }
  }

  // D) Terminator plausibility. 🤖
  if (heur.terminator) {
    if (chunk.endsOnTerminator) {
      const term = chunk.terminatorMnemonic;
      if (term === 'RTS') total += w.endsOnGoodTerminator;
      else if (term === 'RTI') {
        const rooted = isChunkInterruptRoot({ chunk, probableContext: probableContext ? { ...probableContext, mapper } : { mapper } });
        details.rtiInterruptRoot = rooted;
        total += rooted ? w.endsOnRtiInterruptRoot : w.endsOnRtiNonInterruptRoot;
        if (!rooted) {
          details.hardRejected = true;
          details.hardRejectReason = 'rti_not_vector_root';
        }
      }
      else if (term === 'JMP') total += w.endsOnJumpTerminator;
      else if (term === 'BRK') total += w.endsOnBrkTerminator;
    }
    if (chunk.endsOnCap) total += w.endsOnCap;
  }

  // E) A bad tail (decode failure / unmapped) is suspicious, but much less so after a long clean run. 🤖
  if (heur.badTailPenalty) {
    const endReason = chunk.endReason;
    if (endReason === 'decode_fail' || endReason === 'unmapped') {
      let penalty = 0;
      if (chunk.decodedBytes < heur.badTailShortBytes) penalty += w.badTailShort;
      else if (chunk.decodedBytes < heur.badTailMediumBytes) penalty += w.badTailMedium;
      else penalty += w.badTailLong;
      if ((chunk.lastFlowType || null) === 'next') penalty += w.badTailFlowNextExtra;
      details.badTailPenalty = penalty;
      total += penalty;
    }
  }

  // F) Conservative rejection of data-like immediate bitwise-op walls. 🤖
  if (heur.suspiciousBitwiseImmediateWall) {
    const s = chunk.stats || {};
    const insnCount = Math.max(1, chunk.instructions.length || 0);
    const bitwiseImmediateCount = s.bitwiseImmediateCount || 0;
    const bitwiseImmediateRatio = bitwiseImmediateCount / insnCount;
    const supportingStructure = (s.branchCount || 0) + (s.callCount || 0) + (s.jumpCount || 0) + (s.storeCount || 0) + (s.stackCount || 0);
    if (
      bitwiseImmediateCount >= heur.suspiciousBitwiseImmediateWallMinCount &&
      bitwiseImmediateRatio >= heur.suspiciousBitwiseImmediateWallMinRatio &&
      (s.maxBitwiseImmediateRun || 0) >= heur.suspiciousBitwiseImmediateWallMinRun &&
      supportingStructure <= heur.suspiciousBitwiseImmediateWallMaxSupportOps
    ) {
      details.suspiciousBitwiseImmediateWall = true;
      total += w.suspiciousBitwiseImmediateWall;
    }
  }

  // G) Repeated exact-byte instruction patterns. 🤖
  if (heur.repeatedExactPatterns) {
    const rs = chunk.repeatStats || {};
    details.maxExactCmpRun = rs.maxExactCmpRun || 0;
    details.maxExactCpxRun = rs.maxExactCpxRun || 0;
    details.maxExactCpyRun = rs.maxExactCpyRun || 0;
    details.maxExactLoadImmRun = rs.maxExactLoadImmRun || 0;
    details.maxExactLoadOtherRun = rs.maxExactLoadOtherRun || 0;
    details.maxExactImmBitwiseRun = rs.maxExactImmBitwiseRun || 0;

    if ((details.maxExactCmpRun || 0) >= heur.exactCompareRejectRun) {
      details.hardRejected = true;
      details.hardRejectReason = 'repeat_cmp';
    }
    if (!details.hardRejected && (details.maxExactCpxRun || 0) >= heur.exactCompareRejectRun) {
      details.hardRejected = true;
      details.hardRejectReason = 'repeat_cpx';
    }
    if (!details.hardRejected && (details.maxExactCpyRun || 0) >= heur.exactCompareRejectRun) {
      details.hardRejected = true;
      details.hardRejectReason = 'repeat_cpy';
    }

    let suspiciousRepeatRunCount = 0;
    let repeatPatternPenalty = 0;
    for (const run of rs.repeatRuns || []) {
      const m = run.mnemonic;
      const mode = run.mode;
      const n = run.runLength | 0;

      if ((m === 'LDA' || m === 'LDX' || m === 'LDY') && mode === 'imm') {
        if (n >= heur.exactLoadImmPenaltyRun) {
          suspiciousRepeatRunCount++;
          repeatPatternPenalty += (n >= heur.exactLoadImmPenaltyRunStrong) ? w.exactLoadImmRepeatPenaltyStrong : w.exactLoadImmRepeatPenalty;
        }
      } else if ((m === 'LDA' || m === 'LDX' || m === 'LDY')) {
        if (n >= heur.exactLoadOtherPenaltyRun) {
          suspiciousRepeatRunCount++;
          repeatPatternPenalty += (n >= heur.exactLoadOtherPenaltyRunStrong) ? w.exactLoadOtherRepeatPenaltyStrong : w.exactLoadOtherRepeatPenalty;
        }
      }
    }

    const semanticRepeat = evaluateProbableSemanticRepeats({
      instructions: chunk.instructions || [],
      decodedBytes: chunk.decodedBytes,
      repeatStats: rs,
      config
    });
    const priorHardRejected = details.hardRejected;
    const priorHardRejectReason = details.hardRejectReason;
    Object.assign(details, semanticRepeat);

    suspiciousRepeatRunCount += semanticRepeat.suspiciousRepeatRunCount || 0;
    repeatPatternPenalty += semanticRepeat.repeatPatternPenalty || 0;

    if (priorHardRejected) {
      details.hardRejected = true;
      details.hardRejectReason = priorHardRejectReason;
    } else if (semanticRepeat.hardRejected) {
      details.hardRejected = true;
      details.hardRejectReason = semanticRepeat.hardRejectReason || null;
    }

    details.suspiciousRepeatRunCount = suspiciousRepeatRunCount;
    details.repeatPatternPenalty = repeatPatternPenalty;
    total += repeatPatternPenalty;
  }

  // H) Absolute target plausibility (low weight). 🤖
  if (heur.absTargetPlausibility) {
    for (const ins of chunk.instructions) {
      if (ins.absTargetCpu == null) continue;
      const cpuT = ins.absTargetCpu;
      if (inCpuIoRange(cpuT)) {
        total += w.absTargetIoRange;
        continue;
      }
      const romT = mapper?.cpuToRomOffInCtx ? mapper.cpuToRomOffInCtx(chunk.fetchCtx, cpuT) : mapper?.cpuToRomOff?.(cpuT);
      if (romT == null) continue;
      // If the absolute target maps into the same decoded chunk and lands on a decoded boundary, that's a small bonus. 🤖
      if (romT >= chunk.startOff && romT < chunk.endOff && chunk.boundaries.has(romT)) {
        total += w.absTargetOnBoundary;
      }
    }
  }

  const branchTotal = details.branchGood + details.branchMidInstrBad + details.branchOutside;
  const branchHitRate = branchTotal ? (details.branchGood / branchTotal) : null;

  return {
    totalScore: total,
    decodedBytes: chunk.decodedBytes,
    branchHitRate,
    reachableRatio: details.reachableRatio,
    hardRejected: details.hardRejected,
    hardRejectReason: details.hardRejectReason,
    details
  };
}

function computeReachableBoundaries(chunk) {
  // Build adjacency keyed by instruction index rather than raw offsets for speed. 🤖
  const byOff = new Map();
  for (let i = 0; i < chunk.instructions.length; i++) {
    byOff.set(chunk.instructions[i].off, i);
  }

  const adj = new Map();
  for (let i = 0; i < chunk.instructions.length; i++) {
    const ins = chunk.instructions[i];
    const edges = [];
    const nextOff = ins.off + ins.len;
    if (byOff.has(nextOff)) edges.push(byOff.get(nextOff));
    if (ins.branchTargetOff != null && byOff.has(ins.branchTargetOff)) edges.push(byOff.get(ins.branchTargetOff));
    adj.set(i, edges);
  }

  const seen = new Set();
  const stack = [0];
  while (stack.length) {
    const i = stack.pop();
    if (seen.has(i)) continue;
    seen.add(i);
    const edges = adj.get(i) || [];
    for (const j of edges) {
      if (!seen.has(j)) stack.push(j);
    }
  }

  return seen;
}
