// Configuration for the "probable code" linear scan. 🤖
//
// IMPORTANT: this module defines the *shape* of the config consumed by:
//   - scanUnknown.js (start selection + decode)
//   - scoreChunk.js (scoring heuristics)
//
// Keep all tunables here so heuristics can be disabled/tweaked without touching core analysis. 🤖

export const DEFAULT_PROBABLE_CONFIG = {
  enabled: true,

  // If true, promoted probable chunks are converted into CPU entrypoints and fed back into CFG discovery. 🤖
  promoteToCfg: true,
  // Hard cap on how many probable chunks we will promote in one pass (keptChunks will still be reported). 🤖
  maxPromotedChunks: 64,

  // Only scan unknown runs at least this big. 🤖
  minUnknownRangeBytes: 32,

  // Chunk decode limits. 🤖
  probeMaxBytes: 96,
  maxChunkBytes: 2048,

  // Candidate start selection. 🤖
  // Probe every byte by default so we don't miss "other parity" entrypoints.
  // 6502 instruction boundaries are not aligned, and real code often starts on odd/even offsets. 🤖
  startStride: 1,
  maxProbeStartsPerRange: 8,

  // Require probes to decode a reasonable amount before we trust their score.
  // Very short probes can score deceptively well (e.g., a couple instructions with no branches).
  // This is only used during *probe* start selection; full promotion still uses minChunkBytes. 🤖
  minProbeDecodedBytes: 32,

  // Promotion thresholds. 🤖
  minChunkBytes: 128,
  minTotalScore: 25,
  minReachableRatio: 0.8,
  minBranchHitRate: 0.7,

  // Scoring toggles. 🤖
  heuristics: {
    branchBoundary: true,
    reachability: true,
    terminator: true,
    absTargetPlausibility: true
  },

  // Scoring weights. 🤖
  // NOTE: names must match scoreChunk.js expectations. 🤖
  weights: {
    // Branch target → instruction boundary consistency. 🤖
    branchGood: 8,
    branchMidInstrBad: -25,
    branchOutside: -4,

    // Reachability buckets. 🤖
    reachableHigh: 20,
    reachableMid: 5,
    reachableLow: -15,

    // Terminator plausibility. 🤖
    endsOnTerminator: 8,
    endsOnCap: -5,

    // Absolute target plausibility (low weight). 🤖
    absTargetIoRange: -6,
    absTargetOnBoundary: 2
  }
};
