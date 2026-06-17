import { requireArray, requireObject, requireString } from '../dataShape.js';
import { EDGE_KINDS, isExecutableEdgeKind } from '../cfg/constants.js';
import { edgeKey } from '../cfgTopology/graphTopology.js';

function edgeByKey(edges) {
  const out = new Map();
  for (const edge of edges) out.set(edgeKey(edge), edge);
  return out;
}

function naturalLoopBodyForEdge(edge, topology) {
  const header = requireString(edge.toBlockInstanceId, 'loop candidate header');
  const tail = requireString(edge.fromBlockInstanceId, 'loop candidate tail');
  const sccIndex = topology.sccIndexByNodeId.get(header);
  if (sccIndex === undefined || topology.sccIndexByNodeId.get(tail) !== sccIndex) return null;
  const scc = topology.sccs[sccIndex];
  const sccNodes = new Set(scc.nodes);
  const body = new Set([header, tail]);
  if (tail === header) return body;
  const stack = [tail];

  while (stack.length > 0) {
    const nodeId = stack.pop();
    const predecessors = topology.predecessors.get(nodeId) || [];
    for (const pred of predecessors) {
      if (!sccNodes.has(pred)) continue;
      if (body.has(pred)) continue;
      body.add(pred);
      if (pred !== header) stack.push(pred);
    }
  }
  return body;
}

function collectEntryEdges(edges, body) {
  return edges.filter((edge) => body.has(edge.toBlockInstanceId) && !body.has(edge.fromBlockInstanceId));
}

function collectExitEdges(edges, body) {
  return edges.filter((edge) => body.has(edge.fromBlockInstanceId) && !body.has(edge.toBlockInstanceId));
}

function loopContains(parent, child) {
  if (parent.loopId === child.loopId) return false;
  for (const nodeId of child.bodyBlockInstanceIds) {
    if (!parent.bodyBlockInstanceIdSet.has(nodeId)) return false;
  }
  return true;
}

function assignParents(candidates) {
  for (const candidate of candidates) {
    let best = null;
    for (const possibleParent of candidates) {
      if (!loopContains(possibleParent, candidate)) continue;
      if (!best || possibleParent.bodyBlockInstanceIds.length < best.bodyBlockInstanceIds.length) best = possibleParent;
    }
    candidate.parentLoopId = best ? best.loopId : null;
    if (best) best.childLoopIds.push(candidate.loopId);
  }
}

function computeDepth(candidateById, candidate, visiting = new Set()) {
  if (candidate.depth !== null) return candidate.depth;
  if (!candidate.parentLoopId) {
    candidate.depth = 1;
    return candidate.depth;
  }
  if (visiting.has(candidate.loopId)) {
    candidate.depth = 1;
    return candidate.depth;
  }
  visiting.add(candidate.loopId);
  const parent = candidateById.get(candidate.parentLoopId);
  candidate.depth = parent ? computeDepth(candidateById, parent, visiting) + 1 : 1;
  visiting.delete(candidate.loopId);
  return candidate.depth;
}

export function discoverLoopCandidates({ topology, edges }) {
  requireObject(topology, 'loop candidate topology');
  const allEdges = requireArray(edges, 'loop candidate edges').filter((edge) => isExecutableEdgeKind(edge.kind));
  const byKey = edgeByKey(allEdges);
  const candidates = [];

  const candidateEdgeKeys = new Set(topology.loopReentryEdgeKeys || []);
  for (const edge of allEdges) {
    if (edge.kind !== EDGE_KINDS.BRANCH_TAKEN) continue;
    const fromScc = topology.sccIndexByNodeId.get(edge.fromBlockInstanceId);
    const toScc = topology.sccIndexByNodeId.get(edge.toBlockInstanceId);
    if (fromScc === undefined || fromScc !== toScc) continue;
    const scc = topology.sccs[fromScc];
    if (!scc || !scc.cyclic) continue;
    candidateEdgeKeys.add(edgeKey(edge));
  }

  for (const reentryEdgeKey of candidateEdgeKeys) {
    const edge = byKey.get(reentryEdgeKey);
    if (!edge) continue;
    const body = naturalLoopBodyForEdge(edge, topology);
    if (!body) continue;
    const sccIndex = topology.sccIndexByNodeId.get(edge.toBlockInstanceId);
    const candidate = {
      loopId: `loop:${candidates.length}`,
      sccId: topology.sccs[sccIndex]?.id || `scc:${sccIndex}`,
      headerBlockInstanceId: edge.toBlockInstanceId,
      tailBlockInstanceId: edge.fromBlockInstanceId,
      reentryEdgeKey,
      reentryEdge: edge,
      bodyBlockInstanceIdSet: body,
      bodyBlockInstanceIds: Array.from(body).sort(),
      entryEdges: collectEntryEdges(allEdges, body),
      exitEdges: collectExitEdges(allEdges, body),
      depth: null,
      parentLoopId: null,
      childLoopIds: [],
      bailedReason: null
    };
    candidates.push(candidate);
  }

  assignParents(candidates);
  const byId = new Map(candidates.map((candidate) => [candidate.loopId, candidate]));
  for (const candidate of candidates) computeDepth(byId, candidate);
  return candidates;
}
