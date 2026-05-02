// Coalesced-view tuning lives here so it's easy to find and tweak. 🤖
// These settings affect only the derived display view, never the underlying CFG. 🤖

export const DEFAULT_COALESCE_CONFIG = {
  // After the primary hard-stop coalescing pass, allow a display block that ends in a hard stop
  // to absorb nearby code that is reached by a forward branch over that hard stop. The distance
  // is measured forward in instructions through ROM-contiguous coalesced groups. 🤖
  branchOverHardStopMaxInstr: 16
};
