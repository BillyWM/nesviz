// Coalesced-view tuning lives here so it's easy to find and tweak. 🤖
// These settings should only affect *display blocks* (a derived view), never the underlying discovered CFG. 🤖

export const DEFAULT_COALESCE_CONFIG = {
  // If a conditional branch's taken target is within this many *instructions* from the fallthrough path,
  // we treat it as a short forward-skip and keep the region in a single coalesced block. 🤖
  // (Backward branches are handled separately because they usually represent loops.) 🤖
  branchInlineMaxInstr: 16,

  // Special-case for the common pattern:
  //   Bxx join
  //   JMP somewhere
  // join:
  // Here, the JMP is "possibly skipped" by the near branch, so we prefer to keep the JMP stub together
  // with its surrounding code instead of forcing a new display block boundary. 🤖
  jmpSkipMaxInstr: 8,

  // Only treat tiny JMP-only blocks as potential "skippable JMP stubs". 🤖
  // (We don't want to swallow large unconditional-jump regions by accident.) 🤖
  maxJmpStubInstr: 2,

  // If we encounter a long ROM-contiguous run made *entirely* of control-flow instructions
  // (branches, JMP, JSR), coalesce it into a single display block. 🤖
  //
  // This is deliberately a late-stage readability heuristic for "dispatch" style code
  // where long sequences are mostly calls/jumps/branches and basic-block splitting becomes noisy. 🤖
  enableControlFlowRunCoalesce: true,

  // Require at least this many consecutive control-flow instructions to activate the run coalescer. 🤖
  // This prevents tiny sequences (e.g. a single JSR) from overriding normal block boundaries. 🤖
  controlFlowRunMinInstr: 2
};
