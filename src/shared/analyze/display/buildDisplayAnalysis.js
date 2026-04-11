import { DEFAULT_COALESCE_CONFIG } from '../coalesce/config.js';
import { buildCoalescedAnalysisView } from '../coalesce/coalesceView.js';
import { runPointsOfInterestRecognizers } from '../recognize/pointsOfInterest.js';

export function buildDisplayAnalysis(rawAnalysis, config = DEFAULT_COALESCE_CONFIG) {
  const { analysis, blockAliases } = buildCoalescedAnalysisView(rawAnalysis, config);
  runPointsOfInterestRecognizers(analysis);
  return { analysis, blockAliases };
}
