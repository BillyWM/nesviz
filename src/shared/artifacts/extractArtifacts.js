import { requireArray, requireObject } from '../analyze2/dataShape.js';

// Transitional compatibility extractor for the old ArtifactPanel contract.
// Real artifacts (POIs, jump tables, memory-map spans, semantic facts, etc.)
// should be rebuilt as separate consumers of the finished analysis shape, not
// produced by the analysis runner itself.
export function extractArtifacts(finishedAnalysis) {
  const rawAnalysis = requireObject(finishedAnalysis.rawAnalysis, 'finishedAnalysis.rawAnalysis');
  const displayAnalysis = finishedAnalysis.displayAnalysis && typeof finishedAnalysis.displayAnalysis === 'object'
    ? finishedAnalysis.displayAnalysis
    : null;
  const summary = rawAnalysis.summary && typeof rawAnalysis.summary === 'object'
    ? rawAnalysis.summary
    : (displayAnalysis?.summary && typeof displayAnalysis.summary === 'object' ? displayAnalysis.summary : null);
  const mapper = summary?.mapper || displayAnalysis?.mapper || null;
  const stats = summary?.stats || displayAnalysis?.stats || null;

  return {
    ok: true,
    artifacts: [],
    unresolvedSites: requireArray(rawAnalysis.frontiers, 'rawAnalysis.frontiers'),
    pointsOfInterest: [],
    mapper: requireObject(mapper, 'analysis artifacts mapper'),
    stats: requireObject(stats, 'analysis artifacts stats')
  };
}
