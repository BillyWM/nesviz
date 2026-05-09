import { buildCandidateDataflowProofs } from './candidateDataflowProofs.js';

function isCandidateBlock(block) {
  return block?.vsaRole === 'candidate' || block?.confidence === 'probable';
}

function isProofControlFlowEdgeKind(kind) {
  return kind === 'branch_taken' || kind === 'call' || kind === 'jump' || kind === 'jump_table';
}

function terminalKind(block) {
  const last = block?.lines?.[block.lines.length - 1] || null;
  const flow = last?.flow?.type || null;
  if (!last) return 'missing';
  if (flow === 'stop' || flow === 'jump' || flow === 'jmp_ind') return flow;
  if (flow === 'branch' || flow === 'call') return flow;
  return 'fallthrough';
}

function blockHasRealTerminator(block) {
  const last = block?.lines?.[block.lines.length - 1] || null;
  const mnemonic = last?.mnemonic || null;
  const flow = last?.flow?.type || null;
  if (mnemonic === 'RTS' || mnemonic === 'RTI') return true;
  return flow === 'jump' || flow === 'jmp_ind' || flow === 'branch' || flow === 'call' || flow === 'stop';
}

function hasDirectedCycle(blockIds, succs) {
  const visiting = new Set();
  const visited = new Set();

  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const to of succs.get(id) || []) {
      if (!blockIds.has(to)) continue;
      if (visit(to)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const id of blockIds || []) {
    if (visit(id)) return true;
  }
  return false;
}

function blockParticipatesInDirectedCycle(blockId, blockIds, succs) {
  if (typeof blockId !== 'string' || !blockIds?.has(blockId)) return false;

  function canReachTarget(start, target) {
    const stack = [start];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const to of succs.get(id) || []) {
        if (!blockIds.has(to)) continue;
        stack.push(to);
      }
    }
    return false;
  }

  for (const to of succs.get(blockId) || []) {
    if (!blockIds.has(to)) continue;
    if (to === blockId || canReachTarget(to, blockId)) return true;
  }
  return false;
}

function blockExplicitControlSiteCount(block) {
  let count = 0;
  for (const line of block?.lines || []) {
    const flow = line?.flow?.type || null;
    if (flow === 'branch' || flow === 'jump' || flow === 'jmp_ind' || flow === 'call') count++;
  }
  return count;
}

function blockHasBranchOrJumpTerminator(block) {
  const last = block?.lines?.[block.lines.length - 1] || null;
  const flow = last?.flow?.type || null;
  return flow === 'branch' || flow === 'jump' || flow === 'jmp_ind' || flow === 'call';
}

function collectWeakProofNeighborhood(blockId, candidateProofSuccs, candidateProofPreds) {
  const ids = new Set();
  if (typeof blockId !== 'string' || !blockId) return ids;
  const stack = [blockId];
  ids.add(blockId);

  while (stack.length) {
    const id = stack.pop();
    for (const next of [...(candidateProofSuccs.get(id) || []), ...(candidateProofPreds.get(id) || [])]) {
      if (ids.has(next)) continue;
      ids.add(next);
      stack.push(next);
    }
  }

  return ids;
}

function internalCfgStructureForBlock(blockId, blocksById, candidateProofSuccs, candidateProofPreds) {
  const blockIds = collectWeakProofNeighborhood(blockId, candidateProofSuccs, candidateProofPreds);
  const ids = Array.from(blockIds || []);
  const block = blocksById.get(blockId);
  const internalOutCount = (candidateProofSuccs.get(blockId) || new Set()).size;
  const internalInCount = (candidateProofPreds.get(blockId) || new Set()).size;
  const localInternalConnectionCount = internalOutCount + internalInCount;
  let internalConnectionCount = 0;
  let branchOrJumpBlockCount = 0;
  let realTerminatorCount = 0;
  let explicitControlSiteCount = 0;
  let straightLineOnly = ids.length === 1;

  for (const id of ids) {
    const b = blocksById.get(id);
    if (blockHasBranchOrJumpTerminator(b)) {
      branchOrJumpBlockCount++;
      straightLineOnly = false;
    }
    if (blockHasRealTerminator(b)) realTerminatorCount++;
    explicitControlSiteCount += blockExplicitControlSiteCount(b);
    for (const to of candidateProofSuccs.get(id) || []) {
      if (blockIds.has(to)) internalConnectionCount++;
    }
  }

  const hasInternalCycle = hasDirectedCycle(blockIds, candidateProofSuccs);
  const localHasInternalCycle = blockParticipatesInDirectedCycle(blockId, blockIds, candidateProofSuccs);
  const strong = ids.length >= 3
    && internalConnectionCount >= 3
    && hasInternalCycle
    && branchOrJumpBlockCount >= 2
    && explicitControlSiteCount >= 2
    && realTerminatorCount >= 1
    && localInternalConnectionCount > 0;

  return {
    blockId,
    supportBlockIds: ids,
    supportBlockCount: ids.length,
    localInternalConnectionCount,
    internalConnectionCount,
    internalEdgeCount: internalConnectionCount,
    internalInCount,
    internalOutCount,
    branchOrJumpBlockCount,
    explicitControlSiteCount,
    localExplicitControlSiteCount: blockExplicitControlSiteCount(block),
    realTerminatorCount,
    localRealTerminatorCount: blockHasRealTerminator(block) ? 1 : 0,
    straightLineOnly,
    hasInternalCycle,
    localHasInternalCycle,
    strong
  };
}

function addEvidence(map, blockId, kind, detail = null) {
  if (typeof blockId !== 'string' || !blockId) return;
  let ev = map.get(blockId);
  if (!ev) {
    ev = { blockId, kinds: new Set(), details: [] };
    map.set(blockId, ev);
  }
  ev.kinds.add(kind);
  if (detail) ev.details.push({ kind, ...detail });
}

function addCandidateEdge(succs, preds, from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return;
  if (!succs.has(from)) succs.set(from, new Set());
  if (!preds.has(to)) preds.set(to, new Set());
  succs.get(from).add(to);
  preds.get(to).add(from);
}

export function buildCandidateEvidence({ blocks = [], edges = [], observationsResult = null, memoryDiscoveries = null } = {}) {
  const blocksById = new Map((blocks || []).map((block) => [block.id, block]));
  const evidenceByBlockId = new Map();
  const candidateIds = new Set();
  const confirmedIds = new Set();

  for (const block of blocks || []) {
    if (!block?.id) continue;
    if (isCandidateBlock(block)) candidateIds.add(block.id);
    else confirmedIds.add(block.id);
    if (!isCandidateBlock(block)) continue;
    for (const reason of block.leaderReasons || []) {
      // Candidate seed reasons explain why we tested a block. They are not promotion proof by themselves.
      if (reason?.kind === 'speculative_dispatch_seed') addEvidence(evidenceByBlockId, block.id, 'dispatchSeedContext', { basis: reason.basis || null });
      if (reason?.kind === 'candidate_seed' && reason?.source === 'goalDrivenMonotone') addEvidence(evidenceByBlockId, block.id, 'goalDrivenSeedContext');
    }
  }

  const candidateSuccs = new Map();
  const candidatePreds = new Map();
  const candidateProofSuccs = new Map();
  const candidateProofPreds = new Map();

  for (const edge of edges || []) {
    if (!edge?.from || !edge?.to) continue;
    const fromCandidate = candidateIds.has(edge.from);
    const toCandidate = candidateIds.has(edge.to);
    const proofEdge = isProofControlFlowEdgeKind(edge.kind);
    if (fromCandidate && toCandidate) {
      addCandidateEdge(candidateSuccs, candidatePreds, edge.from, edge.to);
      if (proofEdge) addCandidateEdge(candidateProofSuccs, candidateProofPreds, edge.from, edge.to);
    }
    if (proofEdge && fromCandidate && confirmedIds.has(edge.to)) addEvidence(evidenceByBlockId, edge.from, 'directLinkToConfirmed', { edgeKind: edge.kind || null, to: edge.to });
    if (proofEdge && confirmedIds.has(edge.from) && toCandidate) addEvidence(evidenceByBlockId, edge.to, 'directLinkFromConfirmed', { edgeKind: edge.kind || null, from: edge.from });
  }

  for (const [blockId, proof] of buildCandidateDataflowProofs({ candidateIds, observationsResult, memoryDiscoveries }).proofsByBlockId.entries()) {
    for (const item of proof || []) addEvidence(evidenceByBlockId, blockId, item.kind, item);
  }

  for (const fact of observationsResult?.candidateControlFlowFacts || []) {
    if (!fact?.tight || !candidateIds.has(fact.fromRawBlockId)) continue;
    const targetIds = Array.isArray(fact.targetRawBlockIds) ? fact.targetRawBlockIds : [];
    const candidateTargets = targetIds.filter((id) => candidateIds.has(id));
    const confirmedTargets = targetIds.filter((id) => confirmedIds.has(id));
    const baseKind = fact.kind === 'vsaBankedTarget' ? 'vsaBankedTarget' : 'vsaIndirectJumpTarget';

    if (confirmedTargets.length) {
      addEvidence(evidenceByBlockId, fact.fromRawBlockId, `${baseKind}ToConfirmed`, {
        siteKey: fact.siteKey || null,
        targetRawBlockIds: confirmedTargets
      });
    }
    if (candidateTargets.length) {
      for (const to of candidateTargets) {
        addCandidateEdge(candidateSuccs, candidatePreds, fact.fromRawBlockId, to);
        addCandidateEdge(candidateProofSuccs, candidateProofPreds, fact.fromRawBlockId, to);
      }
      addEvidence(evidenceByBlockId, fact.fromRawBlockId, `${baseKind}ToCandidate`, {
        siteKey: fact.siteKey || null,
        targetRawBlockIds: candidateTargets
      });
      if (candidateTargets.length >= 2) {
        addEvidence(evidenceByBlockId, fact.fromRawBlockId, 'vsaCandidateControlCluster', {
          siteKey: fact.siteKey || null,
          targetRawBlockIds: candidateTargets,
          basis: fact.basis || null
        });
      }
    }
  }

  for (const id of candidateIds) {
    const block = blocksById.get(id);
    if (blockHasRealTerminator(block)) addEvidence(evidenceByBlockId, id, 'realTerminatorContext', { terminalKind: terminalKind(block) });
  }

  return {
    candidateIds,
    confirmedIds,
    blocksById,
    evidenceByBlockId,
    candidateSuccs,
    candidatePreds,
    internalCfgStructureForBlock: (blockId) => internalCfgStructureForBlock(blockId, blocksById, candidateProofSuccs, candidateProofPreds)
  };
}
