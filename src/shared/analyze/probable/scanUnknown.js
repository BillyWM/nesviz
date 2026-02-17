import { decodeChunkFromRom } from './decodeChunk.js';
import { scoreChunk } from './scoreChunk.js';

// Scan "unknown" PRG regions (bytes not currently marked as code/data) and propose probable code chunks. 🤖
// We only *promote* high-scoring, non-overlapping chunks to avoid flooding the UI with false positives. 🤖

export function scanProbableCode({ prgBytes, mapper, codeBitmap, config }) {
  const unknownRanges = findUnknownRanges(codeBitmap, config.minUnknownRangeBytes);
  const candidates = [];

  for (const r of unknownRanges) {
    const starts = selectCandidateStarts({ prgBytes, mapper, range: r, config });
    for (const s of starts) {
      const chunk = decodeChunkFromRom({
        prgBytes,
        mapper,
        startOff: s,
        maxOffExclusive: r.end,
        maxBytes: config.maxChunkBytes
      });
      if (!chunk.ok) continue;

      const sc = scoreChunk({ chunk, mapper, config });

      const meetsLen = sc.decodedBytes >= config.minChunkBytes;
      const meetsScore = sc.totalScore >= config.minTotalScore;
      const meetsReach = sc.reachableRatio >= config.minReachableRatio;
      const meetsBranch = sc.branchHitRate == null || sc.branchHitRate >= config.minBranchHitRate;

      if (!meetsLen || !meetsScore || !meetsReach || !meetsBranch) continue;

      candidates.push({
        romStart: chunk.startOff,
        romEnd: chunk.endOff,
        chunk,
        score: sc
      });
    }
  }

  // Non-maximum suppression: keep the highest-scoring non-overlapping chunks. 🤖
  candidates.sort((a, b) => (b.score.totalScore - a.score.totalScore) || (b.chunk.decodedBytes - a.chunk.decodedBytes));
  const kept = [];
  for (const c of candidates) {
    if (kept.some((k) => rangesOverlap(c.romStart, c.romEnd, k.romStart, k.romEnd))) continue;
    kept.push(c);
  }

  return kept;
}

function findUnknownRanges(codeBitmap, minLen) {
  const bm = codeBitmap || new Uint8Array(0);
  const ranges = [];
  let i = 0;
  while (i < bm.length) {
    // Treat any non-zero as known (code/data). 🤖
    while (i < bm.length && bm[i] !== 0) i++;
    const start = i;
    while (i < bm.length && bm[i] === 0) i++;
    const end = i;
    const len = end - start;
    if (len >= (minLen | 0)) ranges.push({ start, end, len });
  }
  return ranges;
}

function selectCandidateStarts({ prgBytes, mapper, range, config }) {
  const stride = Math.max(1, config.startStride | 0);
  const maxK = Math.max(1, config.maxProbeStartsPerRange | 0);
  const minProbe = Math.max(1, (config.minProbeDecodedBytes ?? 1) | 0);
  const scored = [];

  // Always probe the start of the range; then probe with a stride. 🤖
  for (let off = range.start; off < range.end; off += stride) {
    const chunk = decodeChunkFromRom({
      prgBytes,
      mapper,
      startOff: off,
      maxOffExclusive: range.end,
      maxBytes: config.probeMaxBytes
    });
    if (!chunk.ok) continue;
    if (chunk.decodedBytes < minProbe) continue;
    const sc = scoreChunk({ chunk, mapper, config });
    // Favor longer probes as well; very short probes can score deceptively well. 🤖
    const probeScore = sc.totalScore + Math.min(30, chunk.decodedBytes / 8);
    scored.push({ off, probeScore });
  }

  scored.sort((a, b) => b.probeScore - a.probeScore);
  const picks = [];
  for (const s of scored) {
    if (picks.length >= maxK) break;
    picks.push(s.off);
  }
  return picks;
}

function rangesOverlap(a0, a1, b0, b1) {
  return Math.max(a0, b0) < Math.min(a1, b1);
}
