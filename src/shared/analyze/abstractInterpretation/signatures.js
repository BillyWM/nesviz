import { EDGE_KINDS, isExecutableEdgeKind } from '../cfg/constants.js';
import { requireArray, requireObject, requireString } from '../dataShape.js';
import { edgeKey } from '../cfgTopology/graphTopology.js';

export const ABSTRACT_INTERPRETATION_CACHE_VERSION = 9;

function canonicalize(value) {
  if (value instanceof Map) {
    return Array.from(value.entries())
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([key, item]) => [key, canonicalize(item)]);
  }
  if (value instanceof Set) return Array.from(value).sort().map((item) => canonicalize(item));
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function stableSignature(value) {
  return JSON.stringify(canonicalize(value));
}

function indexBy(items, keyName, label) {
  const out = new Map();
  for (const item of requireArray(items, label)) {
    requireObject(item, `${label} item`);
    const key = requireString(item[keyName], `${label}.${keyName}`);
    if (out.has(key)) throw new Error(`Duplicate ${label} ${key}`);
    out.set(key, item);
  }
  return out;
}

function indexInstructions(instructions) {
  const out = new Map();
  for (const instruction of requireArray(instructions, 'abstract interpretation signature instructions')) {
    requireObject(instruction, 'abstract interpretation signature instruction');
    const id = Number(instruction.instructionId) >>> 0;
    if (out.has(id)) throw new Error(`Duplicate abstract interpretation signature instruction ${id}`);
    out.set(id, instruction);
  }
  return out;
}

function groupBy(items, keyName, label) {
  const out = new Map();
  for (const item of requireArray(items, label)) {
    requireObject(item, `${label} item`);
    const key = requireString(item[keyName], `${label}.${keyName}`);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(item);
  }
  return out;
}

function executableGraphIndexes(graph, blockInstanceIds, options = {}) {
  const includeReturnEdges = options.includeReturnEdges !== false;
  const successors = new Map(Array.from(blockInstanceIds).map((id) => [id, []]));
  const hasIncoming = new Set();
  for (const edge of graph.edges) {
    if (!isExecutableEdgeKind(edge.kind)) continue;
    if (!includeReturnEdges && edge.kind === EDGE_KINDS.RETURN) continue;
    const from = requireString(edge.fromBlockInstanceId, 'abstract interpretation signature edge.fromBlockInstanceId');
    const to = requireString(edge.toBlockInstanceId, 'abstract interpretation signature edge.toBlockInstanceId');
    if (!blockInstanceIds.has(from) || !blockInstanceIds.has(to)) continue;
    successors.get(from).push(to);
    hasIncoming.add(to);
  }
  for (const list of successors.values()) list.sort();
  return { successors, hasIncoming };
}

function reachableFromRoots(rootIds, successors) {
  const reachable = new Set();
  const stack = Array.from(rootIds).sort();
  while (stack.length > 0) {
    const id = stack.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const successor of successors.get(id) || []) {
      if (!reachable.has(successor)) stack.push(successor);
    }
  }
  return reachable;
}

function sourceSccNodes(nodeIds, successors) {
  const nodeSet = new Set(nodeIds);
  const indexByNode = new Map();
  const lowlinkByNode = new Map();
  const stack = [];
  const onStack = new Set();
  const sccs = [];
  let nextIndex = 0;

  function connect(nodeId) {
    indexByNode.set(nodeId, nextIndex);
    lowlinkByNode.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const successor of successors.get(nodeId) || []) {
      if (!nodeSet.has(successor)) continue;
      if (!indexByNode.has(successor)) {
        connect(successor);
        lowlinkByNode.set(nodeId, Math.min(lowlinkByNode.get(nodeId), lowlinkByNode.get(successor)));
      } else if (onStack.has(successor)) {
        lowlinkByNode.set(nodeId, Math.min(lowlinkByNode.get(nodeId), indexByNode.get(successor)));
      }
    }

    if (lowlinkByNode.get(nodeId) !== indexByNode.get(nodeId)) return;
    const scc = [];
    while (stack.length > 0) {
      const next = stack.pop();
      onStack.delete(next);
      scc.push(next);
      if (next === nodeId) break;
    }
    sccs.push(scc.sort());
  }

  for (const nodeId of Array.from(nodeSet).sort()) {
    if (!indexByNode.has(nodeId)) connect(nodeId);
  }

  const sccIndexByNode = new Map();
  sccs.forEach((scc, index) => {
    for (const nodeId of scc) sccIndexByNode.set(nodeId, index);
  });

  const sccsWithIncoming = new Set();
  for (const nodeId of nodeSet) {
    const fromScc = sccIndexByNode.get(nodeId);
    for (const successor of successors.get(nodeId) || []) {
      if (!nodeSet.has(successor)) continue;
      const toScc = sccIndexByNode.get(successor);
      if (fromScc !== toScc) sccsWithIncoming.add(toScc);
    }
  }

  const out = [];
  for (let index = 0; index < sccs.length; index += 1) {
    if (!sccsWithIncoming.has(index)) out.push(...sccs[index]);
  }
  return out.sort();
}

export function rootBlockInstanceIdsForGraph(graph) {
  const blockInstanceIds = new Set(graph.blockInstances.map((instance) => requireString(instance.blockInstanceId, 'abstract interpretation signature blockInstanceId')));
  const roots = new Set();
  const seedSiteKeys = new Set(graph.seedSites.map((seed) => requireString(seed.siteKey, 'abstract interpretation signature seed siteKey')));
  const { successors, hasIncoming } = executableGraphIndexes(graph, blockInstanceIds);
  const acceptedEntrySuccessors = executableGraphIndexes(graph, blockInstanceIds, { includeReturnEdges: false }).successors;

  for (const instance of graph.blockInstances) {
    if (seedSiteKeys.has(instance.siteKey)) roots.add(instance.blockInstanceId);
  }

  const reachableFromSeedRoots = reachableFromRoots(roots, successors);
  const acceptedUnreachedIds = graph.blockInstances
    .filter((instance) => instance.seedKind === 'acceptedCode' && instance.reachability === 'acceptedPhysicalCode')
    .map((instance) => requireString(instance.blockInstanceId, 'abstract interpretation signature accepted blockInstanceId'))
    .filter((blockInstanceId) => !reachableFromSeedRoots.has(blockInstanceId));

  for (const blockInstanceId of sourceSccNodes(acceptedUnreachedIds, acceptedEntrySuccessors)) {
    roots.add(blockInstanceId);
  }

  if (roots.size > 0) return Array.from(roots).sort();

  for (const id of blockInstanceIds) {
    if (!hasIncoming.has(id)) roots.add(id);
  }
  return Array.from(roots).sort();
}

export function buildAbstractInterpretationOptionsSignature({ graphKind, scalarSetCap, setCap, widenDelay, maxNarrowingRounds, mapperDomain }) {
  return stableSignature({
    cacheVersion: ABSTRACT_INTERPRETATION_CACHE_VERSION,
    graphKind,
    domains: ['flags', 'knownBits', 'byteScalar', 'reducedBytes', 'mapper', 'provenance', 'shadowStack'],
    scalarSetCap,
    setCap,
    widenDelay,
    maxNarrowingRounds,
    mapperDomain: mapperDomain?.id || null
  });
}

function relevantLoopSummariesForScc(scc, topology, loopSummaries) {
  const summaries = Array.isArray(loopSummaries?.summaries) ? loopSummaries.summaries : [];
  if (!summaries.length) return [];
  const nodes = new Set(scc.nodes || []);
  const relevantEdgeKeys = new Set([
    ...(topology.internalEdgeKeysBySccId.get(scc.id) || []),
    ...(topology.incomingEdgeKeysBySccId.get(scc.id) || []),
    ...(topology.outgoingEdgeKeysBySccId.get(scc.id) || [])
  ]);
  return summaries.filter((summary) => {
    if (nodes.has(summary.headerBlockInstanceId)) return true;
    if (summary.reentryEdgeKey && relevantEdgeKeys.has(summary.reentryEdgeKey)) return true;
    if (summary.exitEdgeKey && relevantEdgeKeys.has(summary.exitEdgeKey)) return true;
    if (Array.isArray(summary.bodyBlockInstanceIds) && summary.bodyBlockInstanceIds.some((id) => nodes.has(id))) return true;
    return false;
  }).sort((a, b) => String(a.loopId || '').localeCompare(String(b.loopId || '')));
}

export function buildAbstractInterpretationSignatures(graph, topology, options) {
  requireObject(graph, 'abstract interpretation signature graph');
  requireObject(topology, 'abstract interpretation signature topology');
  const blocksById = indexBy(graph.blocks, 'blockId', 'abstract interpretation signature blocks');
  const instructionsById = indexInstructions(graph.instructions);
  const executionsByBlockInstanceId = groupBy(graph.instructionExecutions, 'blockInstanceId', 'abstract interpretation signature instructionExecutions');
  const edgeSignatureByEdgeKey = new Map();
  const nodeSignatureByBlockInstanceId = new Map();
  const rootIds = rootBlockInstanceIdsForGraph(graph);
  const rootIdSet = new Set(rootIds);

  for (const edge of graph.edges.filter((item) => isExecutableEdgeKind(item.kind))) {
    const key = edgeKey(edge);
    edgeSignatureByEdgeKey.set(key, stableSignature({
      fromBlockInstanceId: edge.fromBlockInstanceId,
      toBlockInstanceId: edge.toBlockInstanceId,
      kind: edge.kind || ''
    }));
  }

  for (const instance of graph.blockInstances) {
    const blockInstanceId = requireString(instance.blockInstanceId, 'abstract interpretation signature blockInstanceId');
    const block = blocksById.get(instance.blockId);
    if (!block) throw new Error(`Missing block ${instance.blockId} for signature ${blockInstanceId}`);
    const executions = executionsByBlockInstanceId.get(blockInstanceId) || [];
    const executionByInstructionId = new Map(executions.map((execution) => [Number(execution.instructionId) >>> 0, execution]));
    const instructionItems = requireArray(block.instructionIds, `${block.blockId}.instructionIds`).map((instructionId) => {
      const normalized = Number(instructionId) >>> 0;
      const instruction = instructionsById.get(normalized);
      if (!instruction) throw new Error(`Missing instruction ${normalized} for signature ${blockInstanceId}`);
      const execution = executionByInstructionId.get(normalized);
      if (!execution) throw new Error(`Missing execution ${normalized} for signature ${blockInstanceId}`);
      return { instruction, execution };
    });
    nodeSignatureByBlockInstanceId.set(blockInstanceId, stableSignature({
      blockInstance: instance,
      block,
      root: rootIdSet.has(blockInstanceId),
      instructionItems
    }));
  }

  const sccSignatureBySccId = new Map();
  for (const scc of topology.sccs) {
    const relevantLoopSummaries = relevantLoopSummariesForScc(scc, topology, options.loopSummaries);
    const internalEdgeKeys = topology.internalEdgeKeysBySccId.get(scc.id) || [];
    const incomingEdgeKeys = topology.incomingEdgeKeysBySccId.get(scc.id) || [];
    const outgoingEdgeKeys = topology.outgoingEdgeKeysBySccId.get(scc.id) || [];
    sccSignatureBySccId.set(scc.id, stableSignature({
      graphKind: graph.graphKind,
      nodes: scc.nodes,
      cyclic: !!scc.cyclic,
      headers: scc.headers || [],
      rootIds: scc.nodes.filter((id) => rootIdSet.has(id)).sort(),
      nodeSignatures: scc.nodes.map((id) => [id, nodeSignatureByBlockInstanceId.get(id)]),
      internalEdgeSignatures: internalEdgeKeys.map((key) => [key, edgeSignatureByEdgeKey.get(key)]),
      incomingEdgeSignatures: incomingEdgeKeys.map((key) => [key, edgeSignatureByEdgeKey.get(key)]),
      outgoingEdgeSignatures: outgoingEdgeKeys.map((key) => [key, edgeSignatureByEdgeKey.get(key)]),
      loopSummaries: relevantLoopSummaries
    }));
  }

  const graphSignature = stableSignature({
    graphKind: graph.graphKind,
    nodes: Array.from(nodeSignatureByBlockInstanceId.entries()).sort(([a], [b]) => a.localeCompare(b)),
    edges: Array.from(edgeSignatureByEdgeKey.entries()).sort(([a], [b]) => a.localeCompare(b)),
    roots: rootIds,
    topology: topology.topologySignature || null,
    loopSummaries: Array.isArray(options.loopSummaries?.summaries) ? options.loopSummaries.summaries : []
  });

  return {
    graphSignature,
    topologySignature: topology.topologySignature || '',
    nodeSignatureByBlockInstanceId,
    edgeSignatureByEdgeKey,
    rootIds,
    sccSignatureBySccId
  };
}
