function countKinds(observations) {
  const counts = { store8: 0, read8: 0, cmp8: 0, zpPtr16: 0, valueFlow8: 0, branchFlagUse: 0 };
  for (const observation of observations || []) {
    if (counts[observation?.kind] != null) counts[observation.kind]++;
  }
  return counts;
}

export function filterVsaFactsByRawBlockIds({ observationsResult, keepRawBlockIds } = {}) {
  if (!observationsResult) return null;
  const keep = keepRawBlockIds instanceof Set ? keepRawBlockIds : new Set(keepRawBlockIds || []);
  const source = observationsResult.observations || observationsResult.facts || [];
  const observations = source.filter((obs) => {
    if (typeof obs?.rawBlockId !== 'string' || !obs.rawBlockId) return true;
    return keep.has(obs.rawBlockId);
  });
  const candidateControlFlowFacts = (observationsResult.candidateControlFlowFacts || []).filter((fact) => {
    if (typeof fact?.fromRawBlockId === 'string' && !keep.has(fact.fromRawBlockId)) return false;
    const targets = Array.isArray(fact?.targetRawBlockIds) ? fact.targetRawBlockIds : [];
    return targets.every((id) => typeof id !== 'string' || keep.has(id));
  });
  const counts = countKinds(observations);
  return {
    ...observationsResult,
    observations,
    facts: observations,
    candidateControlFlowFacts,
    stats: {
      ...(observationsResult.stats || {}),
      observationCount: observations.length,
      factCount: observations.length,
      ...counts
    }
  };
}
