import {
  ANALYSIS_PHASE_GROUP_IDS,
  ANALYSIS_PHASE_IDS
} from '../../shared/analyze/analysisConstants.js';

function deepFreeze(object) {
  const propNames = Reflect.ownKeys(object);

  for (const name of propNames) {
    const value = object[name];

    if ((value && typeof value === 'object') || typeof value === 'function') {
      deepFreeze(value);
    }
  }

  return Object.freeze(object);
}

function clonePlanEntry(entry) {
  const out = { ...entry };
  if (entry.options && typeof entry.options === 'object') out.options = { ...entry.options };
  return out;
}

export const DEFAULT_ANALYSIS_PLAN = deepFreeze({
  phases: [
    { id: ANALYSIS_PHASE_IDS.INITIALIZE },
    { id: ANALYSIS_PHASE_IDS.SEED_VECTORS },
    { group: ANALYSIS_PHASE_GROUP_IDS.PRIMING },
    { group: ANALYSIS_PHASE_GROUP_IDS.CORE_ANALYSIS },
    { group: ANALYSIS_PHASE_GROUP_IDS.MAPPED_EXPANSION },
    { group: ANALYSIS_PHASE_GROUP_IDS.SEMANTIC_FACTS },
    { id: ANALYSIS_PHASE_IDS.COALESCE },
    { group: ANALYSIS_PHASE_GROUP_IDS.DECORATE_UI },
    { id: ANALYSIS_PHASE_IDS.GENERATE_SUMMARY },
    { id: ANALYSIS_PHASE_IDS.FINALIZE }
  ]
});

export function createDefaultAnalysisPlan() {
  return {
    phases: DEFAULT_ANALYSIS_PLAN.phases.map((entry) => clonePlanEntry(entry))
  };
}
