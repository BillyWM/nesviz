import { requireObject } from '../dataShape.js';
import { ABSTRACT_INTERPRETATION_CACHE_VERSION } from './signatures.js';

function downstreamClosure(seedSccIds, topology) {
  const dirty = new Set(seedSccIds);
  const queue = Array.from(seedSccIds);
  while (queue.length > 0) {
    const id = queue.shift();
    for (const next of topology.sccSuccessors.get(id) || []) {
      if (dirty.has(next)) continue;
      dirty.add(next);
      queue.push(next);
    }
  }
  return dirty;
}

function oldDownstreamClosure(seedSccIds, oldCache) {
  const successors = oldCache?.sccSuccessors && typeof oldCache.sccSuccessors === 'object' ? oldCache.sccSuccessors : {};
  const dirty = new Set(seedSccIds);
  const queue = Array.from(seedSccIds);
  while (queue.length > 0) {
    const id = queue.shift();
    for (const next of successors[id] || []) {
      if (dirty.has(next)) continue;
      dirty.add(next);
      queue.push(next);
    }
  }
  return dirty;
}

function addReason(reasons, sccId, reason) {
  if (!reasons.has(sccId)) reasons.set(sccId, []);
  reasons.get(sccId).push(reason);
}

function mapOldSccsToCurrentDirty(oldSccIds, oldCache, topology, currentNodeIds) {
  const currentSccIds = new Set();
  const currentNodeSet = new Set(currentNodeIds);
  const oldSccRecords = new Map((oldCache?.sccRecords || []).map((record) => [record.sccId, record]));
  for (const oldSccId of oldSccIds) {
    const record = oldSccRecords.get(oldSccId);
    if (!record || !Array.isArray(record.nodeIds)) continue;
    for (const nodeId of record.nodeIds) {
      if (!currentNodeSet.has(nodeId)) continue;
      const currentSccId = topology.sccIdByNodeId.get(nodeId);
      if (currentSccId) currentSccIds.add(currentSccId);
    }
  }
  return currentSccIds;
}

export function createAbstractInterpretationCachePlan({ oldCache, topology, signatures, optionsSignature }) {
  requireObject(topology, 'abstract interpretation cache topology');
  requireObject(signatures, 'abstract interpretation cache signatures');
  const allSccIds = topology.sccs.map((scc) => scc.id);
  const dirtySeedSccIds = new Set();
  const dirtyReasonsBySccId = new Map();
  const recordByCurrentSccId = new Map();
  const currentNodeIds = Array.from(signatures.nodeSignatureByBlockInstanceId.keys()).sort();
  let usable = true;
  let fallbackReason = null;

  if (!oldCache || typeof oldCache !== 'object') {
    usable = false;
    fallbackReason = 'noCache';
  } else if (oldCache.cacheVersion !== ABSTRACT_INTERPRETATION_CACHE_VERSION) {
    usable = false;
    fallbackReason = 'cacheVersion';
  } else if (oldCache.optionsSignature !== optionsSignature) {
    usable = false;
    fallbackReason = 'optionsSignature';
  }

  if (!usable) {
    for (const sccId of allSccIds) addReason(dirtyReasonsBySccId, sccId, fallbackReason);
    return {
      usable: false,
      fallbackReason,
      reusableSccIds: new Set(),
      dirtySccIds: new Set(allSccIds),
      dirtyReasonsBySccId,
      recordByCurrentSccId,
      counters: {
        cacheUsable: 0,
        fallback: 1,
        reusableSccs: 0,
        dirtySccs: allSccIds.length,
        reusedBlockStates: 0,
        recomputedBlockStates: currentNodeIds.length
      }
    };
  }

  const oldRecordsBySignature = new Map();
  for (const record of oldCache.sccRecords || []) {
    if (!record || typeof record.sccSignature !== 'string') continue;
    if (!oldRecordsBySignature.has(record.sccSignature)) oldRecordsBySignature.set(record.sccSignature, []);
    oldRecordsBySignature.get(record.sccSignature).push(record);
  }

  for (const scc of topology.sccs) {
    const signature = signatures.sccSignatureBySccId.get(scc.id);
    const candidates = oldRecordsBySignature.get(signature) || [];
    const recordIndex = candidates.findIndex((record) => Array.isArray(record.nodeIds)
      && record.nodeIds.length === scc.nodes.length
      && record.nodeIds.every((nodeId, index) => nodeId === scc.nodes[index])
      && scc.nodes.every((nodeId) => record.blockStates && record.blockStates[nodeId]));
    if (recordIndex >= 0) {
      const [record] = candidates.splice(recordIndex, 1);
      recordByCurrentSccId.set(scc.id, record);
      continue;
    }
    dirtySeedSccIds.add(scc.id);
    addReason(dirtyReasonsBySccId, scc.id, 'sccChanged');
  }

  const oldNodeSignatures = oldCache.nodeSignatureByBlockInstanceId || {};
  const currentNodeSet = new Set(currentNodeIds);
  const deletedOldSccIds = new Set();
  for (const nodeId of Object.keys(oldNodeSignatures)) {
    if (currentNodeSet.has(nodeId)) continue;
    const oldSccId = oldCache.sccIdByNodeId ? oldCache.sccIdByNodeId[nodeId] : null;
    if (oldSccId) deletedOldSccIds.add(oldSccId);
  }

  if (deletedOldSccIds.size > 0) {
    const oldAffected = oldDownstreamClosure(deletedOldSccIds, oldCache);
    const mapped = mapOldSccsToCurrentDirty(oldAffected, oldCache, topology, currentNodeIds);
    for (const sccId of mapped) {
      dirtySeedSccIds.add(sccId);
      addReason(dirtyReasonsBySccId, sccId, 'oldDeletedNodeDownstream');
    }
  }

  const dirtySccIds = downstreamClosure(dirtySeedSccIds, topology);
  for (const sccId of dirtySccIds) {
    if (!dirtyReasonsBySccId.has(sccId)) addReason(dirtyReasonsBySccId, sccId, 'downstream');
    recordByCurrentSccId.delete(sccId);
  }

  const reusableSccIds = new Set(allSccIds.filter((sccId) => !dirtySccIds.has(sccId) && recordByCurrentSccId.has(sccId)));
  const reusedBlockStates = Array.from(reusableSccIds).reduce((sum, sccId) => sum + (recordByCurrentSccId.get(sccId)?.nodeIds?.length || 0), 0);

  return {
    usable: true,
    fallbackReason: null,
    reusableSccIds,
    dirtySccIds,
    dirtyReasonsBySccId,
    recordByCurrentSccId,
    counters: {
      cacheUsable: 1,
      fallback: 0,
      reusableSccs: reusableSccIds.size,
      dirtySccs: dirtySccIds.size,
      reusedBlockStates,
      recomputedBlockStates: Math.max(0, currentNodeIds.length - reusedBlockStates)
    }
  };
}

function objectFromMap(map) {
  const out = {};
  for (const [key, value] of map.entries()) out[key] = value;
  return out;
}

export function createAbstractInterpretationCache({ graph, topology, signatures, optionsSignature, result }) {
  const blockStateById = new Map();
  for (const blockState of result.blockStates || []) blockStateById.set(blockState.blockInstanceId, blockState);

  const sccRecords = topology.sccs.map((scc) => {
    const blockStates = {};
    for (const nodeId of scc.nodes) {
      const blockState = blockStateById.get(nodeId);
      if (blockState) blockStates[nodeId] = {
        inState: blockState.inState,
        outState: blockState.outState,
        inReturnContexts: Array.isArray(blockState.inReturnContexts) ? blockState.inReturnContexts.slice() : [],
        outReturnContexts: Array.isArray(blockState.outReturnContexts) ? blockState.outReturnContexts.slice() : []
      };
    }
    return {
      sccId: scc.id,
      sccSignature: signatures.sccSignatureBySccId.get(scc.id),
      nodeIds: [...scc.nodes],
      cyclic: !!scc.cyclic,
      headers: [...(scc.headers || [])],
      blockStates
    };
  });

  return {
    cacheVersion: ABSTRACT_INTERPRETATION_CACHE_VERSION,
    optionsSignature,
    graphKind: graph.graphKind,
    graphSignature: signatures.graphSignature,
    topologySignature: signatures.topologySignature,
    nodeSignatureByBlockInstanceId: objectFromMap(signatures.nodeSignatureByBlockInstanceId),
    edgeSignatureByEdgeKey: objectFromMap(signatures.edgeSignatureByEdgeKey),
    sccIdByNodeId: objectFromMap(topology.sccIdByNodeId),
    sccSuccessors: objectFromMap(topology.sccSuccessors),
    sccRecords
  };
}
