import { DEFAULT_COALESCE_CONFIG } from '../coalesce/config.js';
import { buildCoalescedAnalysisView } from '../coalesce/coalesceView.js';
import { buildPointsOfInterest } from '../poi/buildPointsOfInterest.js';
import { attachMonotoneReaderEvidence } from '../data/attachMonotoneReaderEvidence.js';
import { attachMonotoneReaderSpans } from '../data/attachMonotoneReaderSpans.js';
import { synthesizeMonotoneReadFacts } from '../semanticFacts/synthesizeMonotoneReadFacts.js';
import { attachFlowRomTargets } from './attachFlowRomTargets.js';
import { buildLoopGuides } from './buildLoopGuides.js';

function composeRawToDisplayBlockIds(rawBlockIdAliases, coalescedRawToDisplayBlockIds) {
  const out = {};
  const rawBlockIdAliasMap = rawBlockIdAliases && typeof rawBlockIdAliases === 'object' ? rawBlockIdAliases : {};
  const rawToDisplayBlockIdMap = coalescedRawToDisplayBlockIds && typeof coalescedRawToDisplayBlockIds === 'object' ? coalescedRawToDisplayBlockIds : {};

  for (const [rawBlockId, resolvedRawBlockId] of Object.entries(rawBlockIdAliasMap)) {
    if (typeof rawBlockId !== 'string' || !rawBlockId) continue;
    const resolvedId = (typeof resolvedRawBlockId === 'string' && resolvedRawBlockId) ? resolvedRawBlockId : rawBlockId;
    out[rawBlockId] = rawToDisplayBlockIdMap[resolvedId] || resolvedId;
  }

  for (const [rawBlockId, displayBlockId] of Object.entries(rawToDisplayBlockIdMap)) {
    if (typeof rawBlockId !== 'string' || !rawBlockId) continue;
    out[rawBlockId] = (typeof displayBlockId === 'string' && displayBlockId) ? displayBlockId : rawBlockId;
  }

  return out;
}

export function buildDisplayAnalysis(rawAnalysis, config = DEFAULT_COALESCE_CONFIG) {
  const { analysis, rawToDisplayBlockIds } = buildCoalescedAnalysisView(rawAnalysis, config);
  const composedRawToDisplayBlockIds = composeRawToDisplayBlockIds(rawAnalysis?.rawBlockIdAliases || null, rawToDisplayBlockIds);
  analysis.rawToDisplayBlockIds = composedRawToDisplayBlockIds;
  attachFlowRomTargets({ rawAnalysis, displayAnalysis: analysis });
  buildLoopGuides({
    displayBlocks: analysis.blocks,
    observationsResult: analysis.vsaFacts
  });

  analysis.monotoneTables = attachMonotoneReaderEvidence({
    displayBlocks: analysis.blocks,
    monotoneTables: analysis.monotoneTables,
    observationsResult: analysis.vsaFacts,
    rawBlockIdAliases: analysis.rawBlockIdAliases,
    rawToDisplayBlockIds: analysis.rawToDisplayBlockIds
  });
  analysis.monotoneTables = attachMonotoneReaderSpans({
    displayBlocks: analysis.blocks,
    monotoneTables: analysis.monotoneTables,
    observationsResult: analysis.vsaFacts,
    rawBlockIdAliases: analysis.rawBlockIdAliases,
    rawToDisplayBlockIds: analysis.rawToDisplayBlockIds,
    semanticFacts: []
  });
  analysis.semanticFacts = synthesizeMonotoneReadFacts({
    monotoneTables: analysis.monotoneTables
  });

  buildPointsOfInterest(analysis);
  return { analysis, rawToDisplayBlockIds: composedRawToDisplayBlockIds };
}
