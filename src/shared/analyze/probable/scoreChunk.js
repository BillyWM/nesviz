// Score a decoded straight-line chunk for "code-likeness". 🤖
// This is deliberately heuristic-y, but kept fully centralized and configurable. 🤖

function inCpuIoRange(cpuAddr) {
  const a = cpuAddr & 0xffff;
  // PPU/APU/controller etc. 🤖
  return a >= 0x2000 && a <= 0x401f;
}

export function scoreChunk({ chunk, mapper, config }) {
  const w = config.weights;
  const heur = config.heuristics;

  let total = 0;
  const details = {
    branchGood: 0,
    branchMidInstrBad: 0,
    branchOutside: 0,
    reachableRatio: 1,
    endsOnTerminator: !!chunk.endsOnTerminator,
    endsOnCap: !!chunk.endsOnCap
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

  // C) Terminator plausibility. 🤖
  if (heur.terminator) {
    if (chunk.endsOnTerminator) total += w.endsOnTerminator;
    if (chunk.endsOnCap) total += w.endsOnCap;
  }

  // D) Absolute target plausibility (weak signal, so low weight). 🤖
  if (heur.absTargetPlausibility) {
    for (const ins of chunk.instructions) {
      if (ins.absTargetCpu == null) continue;
      const cpuT = ins.absTargetCpu;
      if (inCpuIoRange(cpuT)) {
        total += w.absTargetIoRange;
        continue;
      }
      const romT = mapper?.cpuToRomOff?.(cpuT);
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
