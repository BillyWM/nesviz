// Configuration for the "probable code" linear scan. 🤖
//
// IMPORTANT: this module defines the *shape* of the config consumed by:
//   - scanUnknown.js (start selection + decode)
//   - scoreChunk.js (scoring heuristics)
//
// Keep all tunables here so heuristics can be disabled/tweaked without touching core analysis. 🤖

export const DEFAULT_PROBABLE_CONFIG_NROM = {
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

  // Monotone-table data-first discovery / goal-driven code search. 🤖
  monotoneTableMinEntries: 4,
  goalDrivenMonotoneSearch: true,
  goalDrivenMaxPromotedChunks: 24,
  goalDrivenMaxRawHitsPerTable: 24,
  goalDrivenBacktrackBytes: 8,

  // Promotion thresholds. 🤖
  minChunkBytes: 128,
  minShortChunkBytes: 16,
  shortChunkMinScore: 30,
  requireGoodTerminatorForShortChunks: true,
  minTotalScore: 25,
  minReachableRatio: 0.8,
  minBranchHitRate: 0.7,
  probableCfgSemanticPenaltyRejectThreshold: -40,

  // Scoring toggles. 🤖
  heuristics: {
    branchBoundary: true,
    reachability: true,
    decodedBytesBuckets: [16, 24, 32, 40, 48, 64],
    badTailPenalty: true,
    badTailShortBytes: 16,
    badTailMediumBytes: 32,
    terminator: true,
    rtiMustBeInterruptRoot: true,
    absTargetPlausibility: true,
    suspiciousBitwiseImmediateWall: true,
    suspiciousBitwiseImmediateWallMinCount: 8,
    suspiciousBitwiseImmediateWallMinRatio: 0.6,
    suspiciousBitwiseImmediateWallMinRun: 6,
    suspiciousBitwiseImmediateWallMaxSupportOps: 1,
    repeatedExactPatterns: true,
    exactCompareRejectRun: 2,
    exactLoadImmPenaltyRun: 3,
    exactLoadImmPenaltyRunStrong: 5,
    exactLoadOtherPenaltyRun: 4,
    exactLoadOtherPenaltyRunStrong: 6,
    semanticExactBitwisePenaltyRun: 2,
    semanticExactBitwisePenaltyRunStrong: 4,
    semanticExactBitwiseRejectRun: 6,
    semanticExactEorPenaltyRun: 3,
    semanticExactEorPenaltyRunStrong: 5,
    semanticExactEorRejectRun: 7,
    semanticBitwiseRepeatRunMinRatio: 0.35,
    semanticRotatePenaltyRun: 3,
    semanticRotatePenaltyRunStrong: 5,
    semanticRotateRejectRun: 10,
    semanticRotateRepeatRunMinRatio: 0.35,
    semanticFlagWritePenaltyRun: 2,
    semanticFlagWritePenaltyRunStrong: 3,
    semanticFlagWriteRejectRun: 3,
    semanticInterruptFlagPenaltyRun: 2,
    semanticInterruptFlagPenaltyRunStrong: 3,
    repeatedPrefixPeriodMax: 3,
    repeatedPrefixMinBytes: 12,
    repeatedPrefixMinRatio: 0.5,
    suspiciousRepeatRunEscalationCount: 2
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

    // Nonlinear clean-decode-length bonus; use highest matching bucket only. 🤖
    decodedBytesBucketScores: [2, 4, 7, 10, 13, 15],

    // Terminator plausibility. 🤖
    endsOnGoodTerminator: 8,
    endsOnJumpTerminator: 2,
    endsOnRtiInterruptRoot: 8,
    endsOnRtiNonInterruptRoot: -40,
    endsOnBrkTerminator: -10,
    endsOnCap: -5,

    // Bad tail discount; strongest for short runs, fades for longer clean decodes. 🤖
    badTailShort: -8,
    badTailMedium: -4,
    badTailLong: -1,
    badTailFlowNextExtra: -2,

    // Data-like immediate bitwise-op walls. 🤖
    suspiciousBitwiseImmediateWall: -18,

    // Exact repeated-byte suspicious patterns. 🤖
    exactLoadImmRepeatPenalty: -18,
    exactLoadImmRepeatPenaltyStrong: -36,
    exactLoadOtherRepeatPenalty: -12,
    exactLoadOtherRepeatPenaltyStrong: -24,
    semanticExactBitwiseRepeatPenalty: -18,
    semanticExactBitwiseRepeatPenaltyStrong: -36,
    semanticExactBitwisePeriodicSupportPenalty: -12,
    semanticRotateRepeatPenalty: -18,
    semanticRotateRepeatPenaltyStrong: -36,
    semanticRotatePeriodicSupportPenalty: -12,
    semanticFlagWriteRepeatPenalty: -20,
    semanticFlagWriteRepeatPenaltyStrong: -40,
    semanticInterruptFlagRepeatPenalty: -32,
    semanticInterruptFlagRepeatPenaltyStrong: -64,
    multipleSuspiciousRepeatRunsPenalty: -28,

    // Absolute target plausibility (low weight). 🤖
    absTargetIoRange: -6,
    absTargetOnBoundary: 2
  }
};

export const DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K = {
  ...DEFAULT_PROBABLE_CONFIG_NROM,
  heuristics: {
    ...DEFAULT_PROBABLE_CONFIG_NROM.heuristics
  },
  weights: {
    ...DEFAULT_PROBABLE_CONFIG_NROM.weights
  },
  maxPromotedChunks: 256,
  minUnknownRangeBytes: 16,
  probeMaxBytes: 128,
  maxProbeStartsPerRange: 64,
  minProbeDecodedBytes: 16,
  minChunkBytes: 48,
  minShortChunkBytes: 16,
  shortChunkMinScore: 30,
  requireGoodTerminatorForShortChunks: true,
  minTotalScore: 10,
  minReachableRatio: 0.45,
  minBranchHitRate: 0.35
};

export const DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH32K = {
  ...DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K,
  heuristics: {
    ...DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K.heuristics
  },
  weights: {
    ...DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K.weights
  }
};

export const DEFAULT_PROBABLE_CONFIG = DEFAULT_PROBABLE_CONFIG_NROM;


export function buildProbableConfigFixedSwitch16K(overrides = null) {
  return {
    ...DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K,
    ...(overrides || {}),
    heuristics: { ...DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K.heuristics },
    weights: { ...DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K.weights }
  };
}


export function buildProbableConfigFixedSwitch32K(overrides = null) {
  return {
    ...DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH32K,
    ...(overrides || {}),
    heuristics: { ...DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH32K.heuristics },
    weights: { ...DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH32K.weights }
  };
}
