import { buildCandidateEvidence } from '../vsa/candidateEvidence.js';
import { buildProbablePromotionDebug } from './promotionDebug.js';

function evidenceForBlock(blockId, evidenceByBlockId) {
  const ev = evidenceByBlockId.get(blockId);
  const kinds = new Set();
  const details = [];
  if (!ev) return { kinds, details };

  for (const kind of ev.kinds || []) kinds.add(kind);
  for (const detail of ev.details || []) details.push({ blockId, ...detail });
  return { kinds, details };
}

function evidenceForSupportBlockIds(blockIds, evidenceByBlockId) {
  const kinds = new Set();
  const details = [];
  for (const blockId of blockIds || []) {
    const ev = evidenceByBlockId.get(blockId);
    if (!ev) continue;
    for (const kind of ev.kinds || []) kinds.add(kind);
    for (const detail of ev.details || []) details.push({ blockId, ...detail });
  }
  return { kinds, details };
}

function mergeEvidenceDetails(...sets) {
  const out = [];
  const seen = new Set();
  for (const details of sets || []) {
    for (const detail of details || []) {
      if (!detail || typeof detail !== 'object') continue;
      const key = JSON.stringify(detail);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(detail);
    }
  }
  return out;
}

function hasAny(kinds, names) {
  for (const name of names || []) {
    if (kinds.has(name)) return true;
  }
  return false;
}

function candidateBlockKeepReason({ ownKinds, supportKinds, internal }) {
  if (ownKinds.has('directLinkToConfirmed')) return 'directLinkToConfirmed';
  if (ownKinds.has('directLinkFromConfirmed')) return 'directLinkFromConfirmed';
  if (hasAny(ownKinds, ['vsaIndirectJumpTargetToConfirmed', 'vsaBankedTargetToConfirmed'])) return 'vsaControlToConfirmed';
  if (ownKinds.has('vsaCandidateControlCluster')) return 'vsaCandidateControlCluster';
  if (ownKinds.has('romReadPointerIndirectUse')) return 'romReadPointerIndirectUse';
  if (ownKinds.has('pointerToIndirectUse')) return 'pointerToIndirectUse';
  if (ownKinds.has('strongStreamReader')) return 'strongStreamReader';
  if (internal?.strong) return 'strongInternalCfg';

  // Candidate seed/context facts are deliberately weak: they only help after the block's proof neighborhood
  // links them to real data/control behavior. The neighborhood is computed per block from proof CFG edges;
  // it is not an island-level keep decision.
  if (supportKinds.has('goalDrivenSeedContext') && hasAny(supportKinds, ['romReadMeaningfulUse', 'romReadToPointer', 'pointerToIndirectUse', 'romReadPointerIndirectUse', 'strongStreamReader'])) {
    return 'goalDrivenVerifiedReaderBundle';
  }
  if (supportKinds.has('tightRomRead') && supportKinds.has('romReadToPointer')) return 'romReadPointerBundle';
  if (supportKinds.has('tightRomRead') && supportKinds.has('romReadMeaningfulUse') && internal?.localInternalConnectionCount > 0) return 'dataReaderWithControlShapeBundle';
  if (hasAny(supportKinds, ['vsaIndirectJumpTargetToCandidate', 'vsaBankedTargetToCandidate']) && internal?.hasInternalCycle && internal?.localInternalConnectionCount > 0) {
    return 'vsaCandidateControlBundle';
  }

  return null;
}

function evidenceKindsForDebug(ownKinds, internal) {
  const out = new Set(ownKinds || []);

  // Header/debug evidence is intentionally raw-block-local. Promotion rules may inspect a proof
  // neighborhood to decide whether this block has a valid structural role, but the UI must not show
  // ROM/dataflow evidence that belongs to neighboring raw blocks as if it belonged to this one.
  if (internal?.localInternalConnectionCount > 0) out.add('internalCfgConnection');
  if (internal?.localHasInternalCycle) out.add('internalCfgCycle');
  if (internal?.strong) out.add('strongInternalCfg');

  return Array.from(out).sort();
}

function buildCandidateIslands(candidateIds, candidateSuccs, candidatePreds) {
  const unseen = new Set(candidateIds || []);
  const islands = [];
  while (unseen.size) {
    const first = unseen.values().next().value;
    const stack = [first];
    unseen.delete(first);
    const ids = new Set([first]);
    while (stack.length) {
      const id = stack.pop();
      for (const next of [...(candidateSuccs.get(id) || []), ...(candidatePreds.get(id) || [])]) {
        if (!unseen.has(next)) continue;
        unseen.delete(next);
        ids.add(next);
        stack.push(next);
      }
    }
    islands.push(ids);
  }
  return islands;
}

function objectReferencesOnlyDroppedBlock(value, droppedIds) {
  if (!value || typeof value !== 'object') return false;
  const directKeys = ['rawBlockId', 'fromRawBlockId', 'toRawBlockId', 'sourceRawBlockId', 'targetRawBlockId', 'rawHeaderBlockId', 'rawTailBlockId', 'sentinelRawBlockId'];
  for (const key of directKeys) {
    if (typeof value[key] === 'string' && droppedIds.has(value[key])) return true;
  }
  if (typeof value.from === 'string' && droppedIds.has(value.from)) return true;
  if (typeof value.to === 'string' && droppedIds.has(value.to)) return true;
  return false;
}

function filterTopLevelObjects(values, droppedIds) {
  if (!Array.isArray(values) || !droppedIds?.size) return Array.isArray(values) ? values : [];
  return values.filter((value) => !objectReferencesOnlyDroppedBlock(value, droppedIds));
}

export function promoteVsaCandidates({
  blocks = [],
  edges = [],
  unresolvedSites = [],
  artifacts = [],
  vsaFacts = null,
  memoryDiscoveries = null
} = {}) {
  const evidence = buildCandidateEvidence({ blocks, edges, observationsResult: vsaFacts, memoryDiscoveries });
  const candidateIslands = buildCandidateIslands(evidence.candidateIds, evidence.candidateSuccs, evidence.candidatePreds);
  const keptCandidateBlockIds = new Set();
  const droppedCandidateBlockIds = new Set();
  const promotionDecisionByBlockId = new Map();
  const decisions = [];

  for (const blockId of evidence.candidateIds) {
    const ownEvidence = evidenceForBlock(blockId, evidence.evidenceByBlockId);
    const internal = evidence.internalCfgStructureForBlock?.(blockId) || null;
    const supportEvidence = evidenceForSupportBlockIds(internal?.supportBlockIds || [blockId], evidence.evidenceByBlockId);
    const reason = candidateBlockKeepReason({ ownKinds: ownEvidence.kinds, supportKinds: supportEvidence.kinds, internal });
    const decision = {
      blockId,
      kept: Boolean(reason),
      reason: reason || 'unprovenCandidate',
      evidenceKinds: evidenceKindsForDebug(ownEvidence.kinds, internal),
      internal,
      details: mergeEvidenceDetails(ownEvidence.details)
    };

    decisions.push(decision);

    if (reason) {
      keptCandidateBlockIds.add(blockId);
      promotionDecisionByBlockId.set(blockId, decision);
    } else {
      droppedCandidateBlockIds.add(blockId);
    }
  }

  const promotedIslands = buildCandidateIslands(keptCandidateBlockIds, evidence.candidateSuccs, evidence.candidatePreds);
  const keepBlockIds = new Set([...evidence.confirmedIds, ...keptCandidateBlockIds]);
  const promotedBlocks = [];
  for (const block of blocks || []) {
    if (!keepBlockIds.has(block.id)) continue;
    if (keptCandidateBlockIds.has(block.id)) {
      const decision = promotionDecisionByBlockId.get(block.id);
      const candidatePromotion = {
        status: 'accepted',
        reason: decision?.reason || null,
        evidenceKinds: decision?.evidenceKinds || []
      };
      promotedBlocks.push({
        ...block,
        confidence: 'probable',
        vsaRole: 'candidate',
        candidatePromotion,
        probablePromotionDebug: buildProbablePromotionDebug({ ...block, candidatePromotion }, decision)
      });
    } else {
      promotedBlocks.push(block);
    }
  }

  const promotedEdges = (edges || []).filter((edge) => edge?.from && edge?.to && keepBlockIds.has(edge.from) && keepBlockIds.has(edge.to));
  const droppedIds = droppedCandidateBlockIds;

  return {
    blocks: promotedBlocks,
    edges: promotedEdges,
    unresolvedSites: filterTopLevelObjects(unresolvedSites, droppedIds),
    artifacts: filterTopLevelObjects(artifacts, droppedIds),
    keptCandidateBlockIds,
    droppedCandidateBlockIds,
    decisions,
    debug: {
      candidateIslandCount: candidateIslands.length,
      promotedCandidateIslandCount: promotedIslands.length,
      promotedCandidateIslandBlockCounts: promotedIslands.map((island) => island.size).sort((a, b) => b - a),
      keptCandidateBlockCount: keptCandidateBlockIds.size,
      droppedCandidateBlockCount: droppedCandidateBlockIds.size,
      keptReasons: decisions.filter((d) => d.kept).reduce((acc, d) => {
        acc[d.reason] = (acc[d.reason] || 0) + 1;
        return acc;
      }, {})
    }
  };
}
