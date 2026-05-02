import { rangesOverlap } from '../../utils/rangeUtils.js';

import { decodeChunkFromRom } from './decodeChunk.js';
import { scoreChunk } from './scoreChunk.js';

// Scan "unknown" PRG regions (bytes not currently marked as code/data) and propose probable code chunks. 🤖
// We only *promote* high-scoring, non-overlapping chunks to avoid flooding the UI with false positives. 🤖

export function scanProbableCode({ prgBytes, mapper, codeBitmap, config, seedProbeOffsets = [], probableContext = null }) {
  const unknownRanges = splitUnknownRangesByBoundaries(
    findUnknownRanges(codeBitmap, config.minUnknownRangeBytes),
    mapper?.probableScanBoundaries ? mapper.probableScanBoundaries() : null,
    config.minUnknownRangeBytes
  );
  const candidates = [];
  const regionStats = [];

  for (const r of unknownRanges) {
    const starts = selectCandidateStarts({ prgBytes, mapper, range: r, config, seedProbeOffsets, probableContext });
    const stat = {
      rangeStart: r.start,
      rangeEnd: r.end,
      rangeLen: r.len,
      probeStartCount: starts.length,
      passingCandidateCount: 0,
      keptCandidateCount: 0,
      bestScore: null
    };
    for (const s of starts) {
      const chunk = decodeChunkFromRom({
        prgBytes,
        mapper,
        startOff: s,
        maxOffExclusive: r.end,
        maxBytes: config.maxChunkBytes
      });
      if (!chunk.ok) continue;

      const sc = scoreChunk({ chunk, mapper, config, probableContext });

      const meetsLen = sc.decodedBytes >= config.minChunkBytes;
      const meetsScore = sc.totalScore >= config.minTotalScore;
      if (sc.hardRejected) continue;
      const meetsReach = sc.reachableRatio >= config.minReachableRatio;
      const meetsBranch = sc.branchHitRate == null || sc.branchHitRate >= config.minBranchHitRate;
      const shortChunkTerminatesWell = chunk.endsOnTerminator && (chunk.terminatorMnemonic === 'RTS' || chunk.terminatorMnemonic === 'JMP' || (chunk.terminatorMnemonic === 'RTI' && !sc.hardRejected));
      const meetsShortChunkBypass = !meetsLen
        && sc.decodedBytes >= (config.minShortChunkBytes ?? 0)
        && sc.totalScore >= (config.shortChunkMinScore ?? Number.MAX_SAFE_INTEGER)
        && (!config.requireGoodTerminatorForShortChunks || shortChunkTerminatesWell);

      if (!(meetsLen || meetsShortChunkBypass) || !meetsScore || !meetsReach || !meetsBranch) continue;

      stat.passingCandidateCount++;
      stat.bestScore = stat.bestScore == null ? sc.totalScore : Math.max(stat.bestScore, sc.totalScore);
      candidates.push({
        romStart: chunk.startOff,
        romEnd: chunk.endOff,
        chunk,
        score: sc,
        rangeStart: r.start,
        rangeEnd: r.end
      });
    }
    regionStats.push(stat);
  }

  // Non-maximum suppression: keep the highest-scoring non-overlapping chunks. 🤖
  candidates.sort((a, b) => (b.score.totalScore - a.score.totalScore) || (b.chunk.decodedBytes - a.chunk.decodedBytes));
  const kept = [];
  for (const c of candidates) {
    if (kept.some((k) => rangesOverlap(c.romStart, c.romEnd, k.romStart, k.romEnd))) continue;
    kept.push(c);
  }

  const keptByRegion = new Map();
  for (const c of kept) {
    const key = `${c.rangeStart}:${c.rangeEnd}`;
    keptByRegion.set(key, (keptByRegion.get(key) || 0) + 1);
  }
  for (const stat of regionStats) {
    const key = `${stat.rangeStart}:${stat.rangeEnd}`;
    stat.keptCandidateCount = keptByRegion.get(key) || 0;
  }

  return { kept, regionStats };
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

function splitUnknownRangesByBoundaries(ranges, boundaries, minLen) {
  if (!Array.isArray(boundaries) || boundaries.length < 2) return ranges;
  const uniq = Array.from(new Set(boundaries.map((n) => n | 0))).sort((a, b) => a - b);
  const out = [];
  for (const r of ranges) {
    let cuts = uniq.filter((b) => b > r.start && b < r.end);
    if (!cuts.length) {
      out.push(r);
      continue;
    }
    let cur = r.start;
    for (const cut of cuts) {
      if ((cut - cur) >= (minLen | 0)) out.push({ start: cur, end: cut, len: cut - cur });
      cur = cut;
    }
    if ((r.end - cur) >= (minLen | 0)) out.push({ start: cur, end: r.end, len: r.end - cur });
  }
  return out;
}

function selectCandidateStarts({ prgBytes, mapper, range, config, seedProbeOffsets, probableContext = null }) {
  const stride = Math.max(1, config.startStride | 0);
  const maxK = Math.max(1, config.maxProbeStartsPerRange | 0);
  const minProbe = Math.max(1, (config.minProbeDecodedBytes ?? 1) | 0);
  const scored = [];
  const added = new Set();

  function maybeScore(off, seedBias = 0) {
    const o = off | 0;
    if (o < range.start || o >= range.end) return;
    if (added.has(o)) return;
    added.add(o);
    const chunk = decodeChunkFromRom({
      prgBytes,
      mapper,
      startOff: o,
      maxOffExclusive: range.end,
      maxBytes: config.probeMaxBytes
    });
    if (!chunk.ok) return;
    if (chunk.decodedBytes < minProbe) return;
    const sc = scoreChunk({ chunk, mapper, config, probableContext });
    const probeScore = sc.totalScore + Math.min(30, chunk.decodedBytes / 8) + seedBias;
    scored.push({ off: o, probeScore });
  }

  // Seeded probe starts (e.g. unresolved exact banked targets) get first consideration. 🤖
  for (const off of seedProbeOffsets || []) maybeScore(off, 12);

  // Always probe the start of the range; then probe with a stride. 🤖
  for (let off = range.start; off < range.end; off += stride) {
    maybeScore(off, 0);
  }

  // Prefer an even spread across the region so we do not over-concentrate starts
  // in one local hot spot and miss viable entrypoints elsewhere in the bank. 🤖
  const picks = selectEvenlySpreadStarts(scored, range, maxK);
  return picks;
}

function selectEvenlySpreadStarts(scored, range, maxK) {
  if (!scored.length) return [];
  const len = Math.max(1, (range.end - range.start) | 0);
  const bucketCount = Math.max(1, Math.min(maxK, len));
  const bucketWidth = Math.max(1, Math.ceil(len / bucketCount));
  const bestByBucket = new Map();

  for (const s of scored) {
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((s.off - range.start) / bucketWidth)));
    const prev = bestByBucket.get(idx);
    if (!prev || s.probeScore > prev.probeScore || (s.probeScore === prev.probeScore && s.off < prev.off)) {
      bestByBucket.set(idx, s);
    }
  }

  const picks = [];
  const chosen = new Set();
  const buckets = Array.from(bestByBucket.keys()).sort((a, b) => a - b);
  for (const idx of buckets) {
    const s = bestByBucket.get(idx);
    if (!s || chosen.has(s.off)) continue;
    picks.push(s.off);
    chosen.add(s.off);
    if (picks.length >= maxK) return picks;
  }

  // If some buckets had no viable starts, backfill with the best remaining scores. 🤖
  const globallySorted = scored.slice().sort((a, b) => b.probeScore - a.probeScore || a.off - b.off);
  for (const s of globallySorted) {
    if (picks.length >= maxK) break;
    if (chosen.has(s.off)) continue;
    picks.push(s.off);
    chosen.add(s.off);
  }
  return picks;
}

