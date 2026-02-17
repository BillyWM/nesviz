// Confidence scoring for jump-table artifacts. 🤖
//
// This module is intentionally the *only* place that turns raw signals into a confidence label.
// Recognizers should only extract signals; UI should only display the final verdict. 🤖

const DEFAULT_CONFIG = {
  minEmitScore: 30,
  probableMin: 50,
  certainMin: 80
};

const RULES = [
  { id: 'shape_match', when: (s) => s.shapeMatch && s.shapeMatch !== 'none', weight: 40, msg: 'ptr bytes loaded from ROM using an indexed address expression' },
  { id: 'same_index_expr', when: (s) => s.sameIndexExpr, weight: 15, msg: 'lo/hi reads share the same index expression' },
  { id: 'same_index_source', when: (s) => s.sameIndexSource, weight: 10, msg: 'lo/hi reads use the same index register' },
  { id: 'base_mapped', when: (s) => s.baseReadable, weight: 10, msg: 'table base addresses map into PRG ROM' },
  { id: 'idx_enumerable', when: (s) => s.idxEnumerable, weight: 15, msg: 'index is enumerable (const/set/small range)' },
  { id: 'decoded_targets', when: (s) => (s.targets?.length ?? 0) > 0, weight: 20, msg: 'decoded concrete jump targets from table bytes' }
];

export function scoreJumpTableSignals(signals, config = DEFAULT_CONFIG) {
  const c = { ...DEFAULT_CONFIG, ...(config || {}) };

  let score = 0;
  const evidence = [];
  for (const r of RULES) {
    let ok = false;
    try {
      ok = !!r.when(signals);
    } catch {
      ok = false;
    }
    if (ok) {
      score += r.weight;
      evidence.push({ id: r.id, msg: r.msg, weight: r.weight });
    }
  }

  let confidence = 'weak';
  if (score >= c.probableMin) confidence = 'probable';

  // "Certain" is only granted when we actually decoded targets, to avoid overstating. 🤖
  if (score >= c.certainMin && (signals.targets?.length ?? 0) > 0) confidence = 'certain';

  const status = (signals.targets?.length ?? 0) > 0 ? 'decoded' : 'candidate';

  return {
    score,
    confidence,
    status,
    evidence,
    shouldEmit: score >= c.minEmitScore
  };
}
