import { ANALYSIS_PHASE_IDS } from '../analysisConstants.js';
import { requireObject } from '../dataShape.js';
import { generateSummary } from './generateSummary.js';

export function createGenerateSummaryPhase(context) {
  return {
    name: ANALYSIS_PHASE_IDS.GENERATE_SUMMARY,
    stepOne() {
      const summary = generateSummary(context);
      context.summary = requireObject(summary, 'analysis summary');
      const displayArtifacts = requireObject(context.displayArtifacts, 'displayArtifacts');
      context.displayArtifacts = {
        ...displayArtifacts,
        displayAnalysis: {
          ...requireObject(displayArtifacts.displayAnalysis, 'displayArtifacts.displayAnalysis'),
          mapper: requireObject(summary.mapper, 'analysis summary.mapper'),
          stats: requireObject(summary.stats, 'analysis summary.stats'),
          summary
        }
      };
      context.diagnostics.phaseSummaries.push({
        name: ANALYSIS_PHASE_IDS.GENERATE_SUMMARY,
        status: 'complete',
        counters: { blockCount: summary.stats.blockCount, instructionCount: summary.stats.instructionCount }
      });
      return { status: 'complete' };
    },
    progress() {
      return { phase: ANALYSIS_PHASE_IDS.GENERATE_SUMMARY };
    }
  };
}
