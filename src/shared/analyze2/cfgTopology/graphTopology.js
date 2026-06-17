import { requireArray, requireString } from '../dataShape.js';
import { isExecutableEdgeKind } from '../cfg/constants.js';

export function edgeKey(edge) {
  return `${edge.fromBlockInstanceId}->${edge.toBlockInstanceId}:${edge.kind || ''}`;
}

function signatureFromParts(parts) {
  return JSON.stringify(parts);
}

function sortedUnique(items) {
  return Array.from(new Set(items)).sort();
}

export function buildGraphTopology(graph) {
  const graphKind = requireString(graph.graphKind, 'cfgTopology graph.graphKind');
  const nodeIds = requireArray(graph.blockInstances, 'cfgTopology blockInstances')
    .map((instance) => requireString(instance.blockInstanceId, 'cfgTopology blockInstanceId'));
  const nodeSet = new Set(nodeIds);
  const edgeKeys = [];
  const executableEdges = [];
  const successors = new Map(nodeIds.map((id) => [id, []]));
  const predecessors = new Map(nodeIds.map((id) => [id, []]));

  for (const edge of requireArray(graph.edges, 'cfgTopology edges')) {
    if (!isExecutableEdgeKind(edge.kind)) continue;
    const from = requireString(edge.fromBlockInstanceId, 'cfgTopology edge.fromBlockInstanceId');
    const to = requireString(edge.toBlockInstanceId, 'cfgTopology edge.toBlockInstanceId');
    if (!nodeSet.has(from) || !nodeSet.has(to)) continue;
    successors.get(from).push(to);
    predecessors.get(to).push(from);
    edgeKeys.push(edgeKey(edge));
    executableEdges.push(edge);
  }

  for (const list of successors.values()) list.sort();
  for (const list of predecessors.values()) list.sort();
  edgeKeys.sort();

  const sccs = stronglyConnectedComponents(nodeIds, successors);
  const sccIndexByNodeId = new Map();
  sccs.forEach((scc, index) => {
    scc.id = `scc:${index}`;
    for (const nodeId of scc.nodes) sccIndexByNodeId.set(nodeId, index);
  });

  const loopHeaderIds = new Set();
  const loopReentryEdgeKeys = new Set();
  let cyclicSccCount = 0;

  for (const [index, scc] of sccs.entries()) {
    const cyclic = scc.nodes.length > 1 || scc.nodes.some((nodeId) => successors.get(nodeId).includes(nodeId));
    scc.cyclic = cyclic;
    const sccNodeSet = new Set(scc.nodes);
    const headers = [];
    if (cyclic) {
      cyclicSccCount += 1;
      for (const nodeId of scc.nodes) {
        const hasOutsideIncoming = predecessors.get(nodeId).some((pred) => !sccNodeSet.has(pred));
        if (hasOutsideIncoming) headers.push(nodeId);
      }
      if (headers.length === 0) headers.push([...scc.nodes].sort()[0]);
    }
    scc.headers = headers.sort();
    for (const header of scc.headers) loopHeaderIds.add(header);

    for (const edge of executableEdges) {
      const from = edge.fromBlockInstanceId;
      const to = edge.toBlockInstanceId;
      if (sccIndexByNodeId.get(from) !== index || sccIndexByNodeId.get(to) !== index) continue;
      if (!loopHeaderIds.has(to)) continue;
      loopReentryEdgeKeys.add(edgeKey(edge));
    }
  }

  const sccSuccessors = new Map(sccs.map((scc) => [scc.id, []]));
  const sccPredecessors = new Map(sccs.map((scc) => [scc.id, []]));
  const internalEdgeKeysBySccId = new Map(sccs.map((scc) => [scc.id, []]));
  const incomingEdgeKeysBySccId = new Map(sccs.map((scc) => [scc.id, []]));
  const outgoingEdgeKeysBySccId = new Map(sccs.map((scc) => [scc.id, []]));
  const edgeKeysBySccId = new Map(sccs.map((scc) => [scc.id, []]));

  for (const edge of executableEdges) {
    const fromIndex = sccIndexByNodeId.get(edge.fromBlockInstanceId);
    const toIndex = sccIndexByNodeId.get(edge.toBlockInstanceId);
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) continue;
    const fromSccId = sccs[fromIndex].id;
    const toSccId = sccs[toIndex].id;
    const key = edgeKey(edge);
    if (fromSccId === toSccId) {
      internalEdgeKeysBySccId.get(fromSccId).push(key);
      edgeKeysBySccId.get(fromSccId).push(key);
      continue;
    }
    sccSuccessors.get(fromSccId).push(toSccId);
    sccPredecessors.get(toSccId).push(fromSccId);
    outgoingEdgeKeysBySccId.get(fromSccId).push(key);
    incomingEdgeKeysBySccId.get(toSccId).push(key);
    edgeKeysBySccId.get(fromSccId).push(key);
    edgeKeysBySccId.get(toSccId).push(key);
  }

  for (const map of [sccSuccessors, sccPredecessors, internalEdgeKeysBySccId, incomingEdgeKeysBySccId, outgoingEdgeKeysBySccId, edgeKeysBySccId]) {
    for (const [key, values] of map.entries()) map.set(key, sortedUnique(values));
  }

  for (const scc of sccs) {
    scc.nodeSetSignature = signatureFromParts(['nodes', scc.nodes]);
    scc.internalEdgeSignature = signatureFromParts(['internalEdges', internalEdgeKeysBySccId.get(scc.id) || []]);
    scc.headerSignature = signatureFromParts(['headers', scc.headers || []]);
    scc.sccSignature = signatureFromParts([
      'scc',
      scc.nodes,
      scc.cyclic ? 1 : 0,
      scc.headers || [],
      internalEdgeKeysBySccId.get(scc.id) || []
    ]);
  }

  const sccTopoOrder = topologicalSortSccs(sccs.map((scc) => scc.id), sccSuccessors);
  const topologySignature = signatureFromParts([
    graphKind,
    nodeIds.slice().sort(),
    edgeKeys,
    sccs.map((scc) => scc.sccSignature).sort(),
    sccs.map((scc) => [scc.id, sccSuccessors.get(scc.id) || []]).sort((a, b) => a[0].localeCompare(b[0]))
  ]);

  return {
    producedBy: 'cfgTopology',
    graphKind,
    nodeIds,
    edgeKeys,
    predecessors,
    successors,
    sccs,
    sccIndexByNodeId,
    sccIdByNodeId: new Map(Array.from(sccIndexByNodeId.entries()).map(([nodeId, index]) => [nodeId, sccs[index].id])),
    sccSuccessors,
    sccPredecessors,
    sccTopoOrder,
    edgeKeysBySccId,
    internalEdgeKeysBySccId,
    incomingEdgeKeysBySccId,
    outgoingEdgeKeysBySccId,
    loopHeaderIds,
    loopReentryEdgeKeys,
    topologySignature,
    counters: {
      graphKind,
      nodeCount: nodeIds.length,
      edgeCount: edgeKeys.length,
      sccCount: sccs.length,
      cyclicSccCount,
      loopHeaderCount: loopHeaderIds.size,
      loopReentryEdgeCount: loopReentryEdgeKeys.size
    },
    isLoopReentryEdge(edge) {
      return loopReentryEdgeKeys.has(edgeKey(edge));
    }
  };
}

function topologicalSortSccs(sccIds, sccSuccessors) {
  const indegree = new Map(sccIds.map((id) => [id, 0]));
  for (const from of sccIds) {
    for (const to of sccSuccessors.get(from) || []) indegree.set(to, (indegree.get(to) || 0) + 1);
  }
  const ready = sccIds.filter((id) => indegree.get(id) === 0).sort();
  const out = [];
  while (ready.length > 0) {
    const id = ready.shift();
    out.push(id);
    for (const to of sccSuccessors.get(id) || []) {
      const next = (indegree.get(to) || 0) - 1;
      indegree.set(to, next);
      if (next === 0) {
        ready.push(to);
        ready.sort();
      }
    }
  }
  if (out.length !== sccIds.length) return [...sccIds].sort();
  return out;
}

function stronglyConnectedComponents(nodeIds, successors) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indexes = new Map();
  const lowlinks = new Map();
  const components = [];

  function connect(nodeId) {
    indexes.set(nodeId, index);
    lowlinks.set(nodeId, index);
    index += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const successor of successors.get(nodeId) || []) {
      if (!indexes.has(successor)) {
        connect(successor);
        lowlinks.set(nodeId, Math.min(lowlinks.get(nodeId), lowlinks.get(successor)));
      } else if (onStack.has(successor)) {
        lowlinks.set(nodeId, Math.min(lowlinks.get(nodeId), indexes.get(successor)));
      }
    }

    if (lowlinks.get(nodeId) === indexes.get(nodeId)) {
      const nodes = [];
      while (stack.length > 0) {
        const next = stack.pop();
        onStack.delete(next);
        nodes.push(next);
        if (next === nodeId) break;
      }
      components.push({ id: '', nodes: nodes.sort(), cyclic: false, headers: [] });
    }
  }

  for (const nodeId of nodeIds) {
    if (!indexes.has(nodeId)) connect(nodeId);
  }
  return components;
}
