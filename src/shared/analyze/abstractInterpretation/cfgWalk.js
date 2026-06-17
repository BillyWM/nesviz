import { requireArray, requireObject, requireString } from '../dataShape.js';
import { ANALYSIS_PHASE_IDS, ANALYSIS_PROGRESS_DETAIL_KINDS } from '../analysisConstants.js';
import { EDGE_KINDS, isExecutableEdgeKind } from '../cfg/constants.js';
import { edgeKey } from '../cfgTopology/graphTopology.js';
import { applyEdgeTransfer, transferInstruction } from './transfer.js';
import { abstractByteFromSerializable } from './abstractByteDomain.js';
import {
  instantiateParametricLoopSummary,
  mergeParametricLoopInstantiation
} from './parametricLoopSummaries.js';
import { rootBlockInstanceIdsForGraph } from './signatures.js';
import {
  abstractStateFromSerializable,
  abstractStateToSerializable,
  bottomState,
  cloneState,
  isBottomState,
  joinStates,
  narrowStates,
  setRegister,
  statesEqual,
  unknownEntryStateForMapperContext,
  widenStates
} from './state.js';

function indexBy(items, keyName, label) {
  const out = new Map();
  for (const item of requireArray(items, label)) {
    requireObject(item, `${label} item`);
    const key = requireString(item[keyName], `${label} item.${keyName}`);
    if (out.has(key)) throw new Error(`Duplicate ${label} ${key}`);
    out.set(key, item);
  }
  return out;
}

function indexInstructions(instructions) {
  const out = new Map();
  for (const instruction of requireArray(instructions, 'abstract interpretation instructions')) {
    requireObject(instruction, 'abstract interpretation instruction');
    const id = Number(instruction.instructionId) >>> 0;
    if (out.has(id)) throw new Error(`Duplicate instruction ${id}`);
    out.set(id, instruction);
  }
  return out;
}

function groupBy(items, keyName, label) {
  const out = new Map();
  for (const item of requireArray(items, label)) {
    requireObject(item, `${label} item`);
    const key = requireString(item[keyName], `${label} item.${keyName}`);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(item);
  }
  return out;
}

function instructionExecutionsForBlockInstance(instance, indexes) {
  const block = indexes.blockById.get(instance.blockId);
  if (!block) throw new Error(`Missing block ${instance.blockId} for abstract interpretation block instance ${instance.blockInstanceId}`);
  const executions = indexes.executionsByBlockInstanceId.get(instance.blockInstanceId) || [];
  const executionByInstructionId = new Map();
  for (const execution of executions) executionByInstructionId.set(Number(execution.instructionId) >>> 0, execution);

  return requireArray(block.instructionIds, `${block.blockId}.instructionIds`).map((instructionId) => {
    const normalized = Number(instructionId) >>> 0;
    const execution = executionByInstructionId.get(normalized);
    if (!execution) throw new Error(`Missing execution for instruction ${normalized} in block instance ${instance.blockInstanceId}`);
    const instruction = indexes.instructionById.get(normalized);
    if (!instruction) throw new Error(`Missing instruction ${normalized} for abstract interpretation`);
    return { execution, instruction };
  });
}

function makeIndexes(graph) {
  const executableEdges = graph.edges.filter((edge) => isExecutableEdgeKind(edge.kind));
  return {
    blockById: indexBy(graph.blocks, 'blockId', 'abstract interpretation blocks'),
    blockInstanceById: indexBy(graph.blockInstances, 'blockInstanceId', 'abstract interpretation blockInstances'),
    instructionById: indexInstructions(graph.instructions),
    executionsByBlockInstanceId: groupBy(graph.instructionExecutions, 'blockInstanceId', 'abstract interpretation instructionExecutions'),
    outEdgesByBlockInstanceId: groupBy(executableEdges, 'fromBlockInstanceId', 'abstract interpretation executable edges'),
    executableEdges
  };
}

function loopSummaryIndexes(loopSummaries) {
  const summaries = Array.isArray(loopSummaries?.summaries) ? loopSummaries.summaries : [];
  const byHeader = loopSummaries?.byHeaderBlockInstanceId instanceof Map
    ? loopSummaries.byHeaderBlockInstanceId
    : new Map(summaries.map((summary) => [summary.headerBlockInstanceId, summary]));
  const byReentry = loopSummaries?.byReentryEdgeKey instanceof Map
    ? loopSummaries.byReentryEdgeKey
    : new Map(summaries.map((summary) => [summary.reentryEdgeKey, summary]));
  const byExit = loopSummaries?.byExitEdgeKey instanceof Map
    ? loopSummaries.byExitEdgeKey
    : new Map(summaries.filter((summary) => summary.exitEdgeKey).map((summary) => [summary.exitEdgeKey, summary]));
  return { summaries, byHeader, byReentry, byExit };
}

function applyLoopSummaryRegister(state, summary, byteField, instantiation, options) {
  if (!summary || !summary.counter) return { state, applied: false };
  const byte = summary.counter[byteField] || instantiation?.[byteField] || null;
  if (!byte) return { state, applied: false };
  return {
    state: setRegister(state, summary.counter.registerName, abstractByteFromSerializable(byte), options),
    applied: true
  };
}

function mapToPlainObject(map) {
  const out = {};
  for (const [key, value] of map.entries()) out[key] = value;
  return out;
}

function normalizeReturnContexts(values) {
  return Array.from(new Set(Array.isArray(values) ? values.filter((item) => typeof item === 'string') : [])).sort();
}

function returnContextSet(values = []) {
  return new Set(normalizeReturnContexts(values));
}

function cloneReturnContextSet(set) {
  return returnContextSet(Array.from(set || []));
}

function returnContextSetsEqual(a, b) {
  const left = normalizeReturnContexts(Array.from(a || []));
  const right = normalizeReturnContexts(Array.from(b || []));
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function emptyEdgeKindCounts() {
  return {
    fallthrough: 0,
    branchTaken: 0,
    branchNotTaken: 0,
    jump: 0,
    call: 0,
    return: 0,
    rtsTrick: 0,
    other: 0,
    total: 0
  };
}

function countEdgeKind(out, kind) {
  if (Object.prototype.hasOwnProperty.call(out, kind)) out[kind] += 1;
  else out.other += 1;
  out.total += 1;
}

function emptyReturnSchedulingStats() {
  return {
    forward: 0,
    backward: 0,
    sameScc: 0,
    missingScc: 0
  };
}

export function createAbstractInterpretationWalker(graph, options = {}) {
  requireObject(graph, 'abstract interpretation graph');
  const indexes = makeIndexes(graph);
  const topology = requireObject(options.topology, 'abstract interpretation cfgTopology');
  if (topology.graphKind !== graph.graphKind) {
    throw new Error(`abstractInterpretation graphKind ${graph.graphKind} does not match cfgTopology graphKind ${topology.graphKind}`);
  }
  if (typeof topology.isLoopReentryEdge !== 'function') throw new Error('abstract interpretation cfgTopology must provide isLoopReentryEdge(edge)');

  const blockInstanceIds = graph.blockInstances.map((instance) => requireString(instance.blockInstanceId, 'abstract interpretation blockInstance.blockInstanceId'));
  const inStateByBlockInstanceId = new Map(blockInstanceIds.map((id) => [id, bottomState()]));
  const outStateByBlockInstanceId = new Map(blockInstanceIds.map((id) => [id, bottomState()]));
  const inReturnContextsByBlockInstanceId = new Map(blockInstanceIds.map((id) => [id, returnContextSet()]));
  const outReturnContextsByBlockInstanceId = new Map(blockInstanceIds.map((id) => [id, returnContextSet()]));
  const rootIds = rootBlockInstanceIdsForGraph(graph);
  const rootIdSet = new Set(rootIds);
  const maxBlockStepsPerCrank = options.maxBlockStepsPerCrank || 128;
  const widenDelay = Number.isFinite(options.widenDelay) ? Math.max(0, options.widenDelay | 0) : 3;
  const maxNarrowingRounds = Number.isFinite(options.maxNarrowingRounds) ? Math.max(0, options.maxNarrowingRounds | 0) : 3;
  const mergeCountsByEdgeKey = new Map();
  const loopSummaryIndex = loopSummaryIndexes(options.loopSummaries);
  const parametricLoopInstantiationsByLoopId = new Map();
  const cachePlan = options.cachePlan || null;
  const sccById = new Map(topology.sccs.map((scc) => [scc.id, scc]));
  const sccTopoOrder = Array.isArray(topology.sccTopoOrder) && topology.sccTopoOrder.length
    ? topology.sccTopoOrder
    : topology.sccs.map((scc) => scc.id);
  const sccTopoIndexById = new Map(sccTopoOrder.map((sccId, index) => [sccId, index]));
  const sccSizeStats = topology.sccs.reduce((acc, scc) => {
    const size = Array.isArray(scc.nodes) ? scc.nodes.length : 0;
    if (size > acc.largestSccBlockCount) {
      acc.largestSccBlockCount = size;
      acc.largestSccId = scc.id;
    }
    if (scc.cyclic && size > acc.largestCyclicSccBlockCount) {
      acc.largestCyclicSccBlockCount = size;
      acc.largestCyclicSccId = scc.id;
    }
    return acc;
  }, {
    largestSccBlockCount: 0,
    largestSccId: null,
    largestCyclicSccBlockCount: 0,
    largestCyclicSccId: null
  });

  function schedulingDirectionForEdge(edge) {
    const fromSccId = topology.sccIdByNodeId.get(edge.fromBlockInstanceId);
    const toSccId = topology.sccIdByNodeId.get(edge.toBlockInstanceId);
    if (!fromSccId || !toSccId) return 'missingScc';
    if (fromSccId === toSccId) return 'sameScc';
    const fromIndex = sccTopoIndexById.get(fromSccId);
    const toIndex = sccTopoIndexById.get(toSccId);
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return 'missingScc';
    return fromIndex < toIndex ? 'forward' : 'backward';
  }

  const returnSchedulingStats = indexes.executableEdges.reduce((acc, edge) => {
    if (edge.kind !== EDGE_KINDS.RETURN) return acc;
    acc[schedulingDirectionForEdge(edge)] += 1;
    return acc;
  }, emptyReturnSchedulingStats());

  let mode = 'widening';
  let currentSccOrderIndex = 0;
  let activeScc = null;
  const pendingReprocessSccIds = [];
  const pendingReprocessSccIdSet = new Set();

  const counters = {
    graphKind: graph.graphKind,
    blockInstanceCount: blockInstanceIds.length,
    edgeCount: indexes.executableEdges.length,
    normalReturnEdgeCount: Number.isFinite(graph.normalReturnEdgeCount) ? graph.normalReturnEdgeCount : 0,
    schedulingExcludedReturnEdgeCount: Number.isFinite(graph.schedulingExcludedReturnEdgeCount) ? graph.schedulingExcludedReturnEdgeCount : 0,
    returnEdgeSummaryCount: Number.isFinite(graph.returnEdgeSummaryCount) ? graph.returnEdgeSummaryCount : 0,
    summaryUsableReturnEdgeCount: Number.isFinite(graph.summaryUsableReturnEdgeCount) ? graph.summaryUsableReturnEdgeCount : 0,
    summaryRejectedReturnEdgeCount: Number.isFinite(graph.summaryRejectedReturnEdgeCount) ? graph.summaryRejectedReturnEdgeCount : 0,
    missingCallEdgeReturnEdgeCount: Number.isFinite(graph.missingCallEdgeReturnEdgeCount) ? graph.missingCallEdgeReturnEdgeCount : 0,
    missingCallTargetReturnEdgeCount: Number.isFinite(graph.missingCallTargetReturnEdgeCount) ? graph.missingCallTargetReturnEdgeCount : 0,
    returnEdgeSummaryRejectReasons: graph.returnEdgeSummaryRejectReasons || {},
    returnEdgeSummaryStackRejectReasons: graph.returnEdgeSummaryStackRejectReasons || {},
    returnEdgeSummaryNoNormalRejectReasons: graph.returnEdgeSummaryNoNormalRejectReasons || {},
    returnEdgeSummaryNotAlwaysRejectReasons: graph.returnEdgeSummaryNotAlwaysRejectReasons || {},
    returnEdgeSummaryIndirectRejectReasons: graph.returnEdgeSummaryIndirectRejectReasons || {},
    returnEdgeSummaryUnknownCallRejectReasons: graph.returnEdgeSummaryUnknownCallRejectReasons || {},
    returnEdgeSummaryUnknownReturnRejectReasons: graph.returnEdgeSummaryUnknownReturnRejectReasons || {},
    returnEdgeSummaryRejectedDistinctCalleeCount: Number.isFinite(graph.returnEdgeSummaryRejectedDistinctCalleeCount) ? graph.returnEdgeSummaryRejectedDistinctCalleeCount : 0,
    returnEdgeSummaryTopRejectSources: Array.isArray(graph.returnEdgeSummaryTopRejectSources) ? graph.returnEdgeSummaryTopRejectSources : [],
    summarizedCallReturnCount: Number.isFinite(graph.summarizedCallReturnCount) ? graph.summarizedCallReturnCount : 0,
    unsummarizedCallReturnCount: Number.isFinite(graph.unsummarizedCallReturnCount) ? graph.unsummarizedCallReturnCount : 0,
    deferredJsrFallthroughCount: Number.isFinite(graph.deferredJsrFallthroughCount) ? graph.deferredJsrFallthroughCount : 0,
    rejectedSummaryNoRtsFallbackCount: Number.isFinite(graph.rejectedSummaryNoRtsFallbackCount) ? graph.rejectedSummaryNoRtsFallbackCount : 0,
    summaryReturnRejectReasons: graph.summaryReturnRejectReasons || {},
    summaryReturnStackRejectReasons: graph.summaryReturnStackRejectReasons || {},
    summaryReturnNoNormalRejectReasons: graph.summaryReturnNoNormalRejectReasons || {},
    summaryReturnNoLocalRtsDetails: graph.summaryReturnNoLocalRtsDetails || {},
    summaryReturnNotAlwaysRejectReasons: graph.summaryReturnNotAlwaysRejectReasons || {},
    rootCount: rootIds.length,
    sccCount: topology.sccs.length,
    cyclicSccCount: topology.sccs.filter((scc) => scc.cyclic).length,
    loopHeaderCount: topology.loopHeaderIds.size,
    loopReentryEdgeCount: topology.loopReentryEdgeKeys.size,
    loopSummaryCount: loopSummaryIndex.summaries.length,
    loopSummaryReentryApplications: 0,
    loopSummaryHeaderApplications: 0,
    loopSummaryExitApplications: 0,
    loopSummaryWidenSuppressions: 0,
    loopSummaryParametricInstantiations: 0,
    loopSummaryParametricSkips: 0,
    iterations: 0,
    stateJoins: 0,
    stateWidens: 0,
    stateWidenAttempts: 0,
    stateNarrows: 0,
    stateNarrowAttempts: 0,
    narrowingStateJoins: 0,
    narrowingLoopSummaryReentryApplications: 0,
    narrowingLoopSummaryHeaderApplications: 0,
    narrowingLoopSummaryExitApplications: 0,
    narrowingRounds: 0,
    narrowingChangedStates: 0,
    changedStates: 0,
    returnContextJoins: 0,
    returnContextChangedStates: 0,
    returnEdgesForwardInSchedule: returnSchedulingStats.forward,
    returnEdgesBackwardInSchedule: returnSchedulingStats.backward,
    returnEdgesSameSchedulingScc: returnSchedulingStats.sameScc,
    returnEdgesMissingSchedulingScc: returnSchedulingStats.missingScc,
    returnBoundaryPropagations: 0,
    returnBoundaryPropagationsForward: 0,
    returnBoundaryPropagationsBackward: 0,
    returnBoundaryPropagationsMissingScc: 0,
    returnBoundaryStateChanges: 0,
    returnBoundaryContextChanges: 0,
    returnBoundaryBackwardStateChanges: 0,
    returnBoundaryBackwardContextChanges: 0,
    returnBoundarySccRequeues: 0,
    returnBoundaryBackwardSccRequeues: 0,
    returnBoundarySccRequeueSkippedAlreadyQueued: 0,
    enqueueAttempts: 0,
    enqueuedBlocks: 0,
    enqueueStateChanges: 0,
    enqueueReturnContextChanges: 0,
    enqueueSeedInputs: 0,
    enqueueOther: 0,
    enqueueSkippedAlreadyQueued: 0,
    maxWorklistSize: 0,
    sccProcessed: 0,
    sccReused: 0,
    sccDirty: cachePlan?.dirtySccIds?.size ?? topology.sccs.length,
    sccCacheHits: cachePlan?.reusableSccIds?.size ?? 0,
    sccCacheMisses: cachePlan?.dirtySccIds?.size ?? topology.sccs.length,
    cachedBlockStates: cachePlan?.counters?.reusedBlockStates ?? 0,
    recomputedBlockStates: cachePlan?.counters?.recomputedBlockStates ?? blockInstanceIds.length,
    cacheInvalidationFallbacks: cachePlan?.counters?.fallback ?? 0,
    boundaryPropagations: 0
  };

  function edgeReturnContextTransfer(outContexts, edge) {
    const next = cloneReturnContextSet(outContexts);
    let edgeSensitiveReturnAllowed = false;
    if (edge.kind === EDGE_KINDS.CALL && typeof edge.returnBlockInstanceId === 'string') {
      next.add(edge.edgeId);
    } else if (edge.kind === EDGE_KINDS.RETURN && typeof edge.returnForCallEdgeId === 'string') {
      edgeSensitiveReturnAllowed = next.has(edge.returnForCallEdgeId);
      next.delete(edge.returnForCallEdgeId);
    }
    return { contexts: next, edgeSensitiveReturnAllowed };
  }

  function joinReturnContextsIntoBlock(blockInstanceId, incomingContexts, enqueue = null) {
    const oldContexts = inReturnContextsByBlockInstanceId.get(blockInstanceId) || returnContextSet();
    const merged = cloneReturnContextSet(oldContexts);
    for (const context of incomingContexts || []) merged.add(context);
    counters.returnContextJoins += 1;
    if (returnContextSetsEqual(oldContexts, merged)) return false;
    inReturnContextsByBlockInstanceId.set(blockInstanceId, merged);
    counters.returnContextChangedStates += 1;
    if (enqueue) enqueue(blockInstanceId, 'returnContext');
    return true;
  }

  function rootEntryState(blockInstanceId) {
    const instance = indexes.blockInstanceById.get(blockInstanceId);
    if (!instance) throw new Error(`Missing root block instance ${blockInstanceId}`);
    const mapperContext = graph.contexts[instance.contextKey];
    if (!mapperContext) throw new Error(`Missing mapper context for root ${blockInstanceId} (${instance.contextKey})`);
    return unknownEntryStateForMapperContext(mapperContext, options);
  }

  function edgeKindCountsForScc(scc) {
    const nodeSet = new Set(scc.nodes || []);
    const internal = emptyEdgeKindCounts();
    const outgoing = emptyEdgeKindCounts();
    const incoming = emptyEdgeKindCounts();

    for (const edge of indexes.executableEdges) {
      const fromInside = nodeSet.has(edge.fromBlockInstanceId);
      const toInside = nodeSet.has(edge.toBlockInstanceId);
      if (fromInside && toInside) countEdgeKind(internal, edge.kind);
      else if (fromInside) countEdgeKind(outgoing, edge.kind);
      else if (toInside) countEdgeKind(incoming, edge.kind);
    }

    return { internal, outgoing, incoming };
  }

  function transferBlock(instance, inState) {
    let state = cloneState(inState, options);
    const executions = instructionExecutionsForBlockInstance(instance, indexes);
    for (const item of executions) {
      state = transferInstruction(state, item.instruction, {
        mapper: graph.mapper,
        prgBytes: graph.prgBytes,
        contexts: graph.contexts,
        contextKey: item.execution.contextKey
      }, options);
    }
    return { state, terminatorInstruction: executions.length ? executions[executions.length - 1].instruction : null };
  }

  function terminatorInstructionForBlockInstance(blockInstanceId) {
    const instance = indexes.blockInstanceById.get(blockInstanceId);
    if (!instance) throw new Error(`Missing abstract interpretation block instance ${blockInstanceId}`);
    const executions = instructionExecutionsForBlockInstance(instance, indexes);
    return executions.length ? executions[executions.length - 1].instruction : null;
  }

  function loopInstantiation(summary) {
    return summary?.loopId ? (parametricLoopInstantiationsByLoopId.get(summary.loopId) || null) : null;
  }

  function loopSummaryHasByte(summary, byteField) {
    if (!summary?.counter) return false;
    return !!(summary.counter[byteField] || loopInstantiation(summary)?.[byteField]);
  }

  function recordParametricLoopEntry(summary, state) {
    if (!summary?.counter?.template || !summary.counter.initialSource) return;
    const instantiated = instantiateParametricLoopSummary(summary, state, options);
    if (!instantiated) {
      counters.loopSummaryParametricSkips += 1;
      return;
    }
    const old = parametricLoopInstantiationsByLoopId.get(summary.loopId) || null;
    parametricLoopInstantiationsByLoopId.set(summary.loopId, mergeParametricLoopInstantiation(old, instantiated, options));
    counters.loopSummaryParametricInstantiations += 1;
  }

  function applyLoopSummaryForEdge(state, edge) {
    const key = edgeKey(edge);
    let out = state;
    const reentrySummary = loopSummaryIndex.byReentry.get(key);
    if (reentrySummary) {
      const applied = applyLoopSummaryRegister(out, reentrySummary, 'reentryByte', loopInstantiation(reentrySummary), options);
      out = applied.state;
      if (applied.applied) {
        counters.loopSummaryReentryApplications += 1;
        if (mode === 'narrowing') counters.narrowingLoopSummaryReentryApplications += 1;
      }
    }

    const exitSummary = loopSummaryIndex.byExit.get(key);
    if (exitSummary) {
      const applied = applyLoopSummaryRegister(out, exitSummary, 'exitByte', loopInstantiation(exitSummary), options);
      out = applied.state;
      if (applied.applied) {
        counters.loopSummaryExitApplications += 1;
        if (mode === 'narrowing') counters.narrowingLoopSummaryExitApplications += 1;
      }
    }

    const headerSummary = loopSummaryIndex.byHeader.get(edge.toBlockInstanceId);
    if (headerSummary) {
      if (headerSummary.reentryEdgeKey !== key) recordParametricLoopEntry(headerSummary, out);
      const applied = applyLoopSummaryRegister(out, headerSummary, 'headerByte', loopInstantiation(headerSummary), options);
      out = applied.state;
      if (applied.applied) {
        counters.loopSummaryHeaderApplications += 1;
        if (mode === 'narrowing') counters.narrowingLoopSummaryHeaderApplications += 1;
      }
    }
    return out;
  }

  function mergeForEdge(oldState, incomingState, edge) {
    if (mode !== 'widening') return joinStates(oldState, incomingState, options);
    const key = edgeKey(edge);
    const reentrySummary = loopSummaryIndex.byReentry.get(key);
    if (reentrySummary && loopSummaryHasByte(reentrySummary, 'reentryByte')) {
      counters.loopSummaryWidenSuppressions += 1;
      return joinStates(oldState, incomingState, options);
    }
    if (!topology.isLoopReentryEdge(edge)) return joinStates(oldState, incomingState, options);

    const count = (mergeCountsByEdgeKey.get(key) || 0) + 1;
    mergeCountsByEdgeKey.set(key, count);
    if (count <= widenDelay) return joinStates(oldState, incomingState, options);
    counters.stateWidenAttempts += 1;
    const widened = widenStates(oldState, incomingState, options);
    if (!statesEqual(oldState, widened, options)) counters.stateWidens += 1;
    return widened;
  }

  function joinIntoBlock(blockInstanceId, incomingState, edge = null, enqueue = null) {
    const oldState = inStateByBlockInstanceId.get(blockInstanceId) || bottomState();
    const merged = edge ? mergeForEdge(oldState, incomingState, edge) : joinStates(oldState, incomingState, options);
    counters.stateJoins += 1;
    if (statesEqual(oldState, merged, options)) return false;
    inStateByBlockInstanceId.set(blockInstanceId, merged);
    counters.changedStates += 1;
    if (enqueue) enqueue(blockInstanceId, 'state');
    return true;
  }

  function edgeOutput(blockInstanceId, outState, edge) {
    const terminatorInstruction = terminatorInstructionForBlockInstance(blockInstanceId);
    const returnTransfer = edgeReturnContextTransfer(outReturnContextsByBlockInstanceId.get(blockInstanceId), edge);
    const transferEdge = returnTransfer.edgeSensitiveReturnAllowed
      ? { ...edge, edgeSensitiveReturnAllowed: true }
      : edge;
    const edgeState = terminatorInstruction
      ? applyEdgeTransfer(outState, transferEdge, terminatorInstruction, options)
      : cloneState(outState, options);
    return {
      state: applyLoopSummaryForEdge(edgeState, edge),
      returnContexts: returnTransfer.contexts
    };
  }

  function propagateOutgoingForScc(scc) {
    const sccNodeSet = new Set(scc.nodes);
    for (const blockInstanceId of scc.nodes) {
      const outState = outStateByBlockInstanceId.get(blockInstanceId) || bottomState();
      if (isBottomState(outState)) continue;
      const outEdges = indexes.outEdgesByBlockInstanceId.get(blockInstanceId) || [];
      for (const edge of outEdges) {
        if (sccNodeSet.has(edge.toBlockInstanceId)) continue;
        const output = edgeOutput(blockInstanceId, outState, edge);
        if (isBottomState(output.state)) continue;
        const stateChanged = joinIntoBlock(edge.toBlockInstanceId, output.state);
        const contextChanged = joinReturnContextsIntoBlock(edge.toBlockInstanceId, output.returnContexts);
        if (edge.kind === EDGE_KINDS.RETURN) recordReturnBoundaryPropagation(edge, stateChanged, contextChanged);
        if (edge.kind === EDGE_KINDS.RETURN) {
          scheduleBoundarySccReprocess(edge.toBlockInstanceId, edge, stateChanged, contextChanged);
        }
        counters.boundaryPropagations += 1;
      }
    }
  }

  function recordReturnBoundaryPropagation(edge, stateChanged, contextChanged) {
    const direction = schedulingDirectionForEdge(edge);
    counters.returnBoundaryPropagations += 1;
    if (direction === 'forward') counters.returnBoundaryPropagationsForward += 1;
    else if (direction === 'backward') counters.returnBoundaryPropagationsBackward += 1;
    else if (direction === 'missingScc') counters.returnBoundaryPropagationsMissingScc += 1;
    if (stateChanged) counters.returnBoundaryStateChanges += 1;
    if (contextChanged) counters.returnBoundaryContextChanges += 1;
    if (direction === 'backward' && stateChanged) counters.returnBoundaryBackwardStateChanges += 1;
    if (direction === 'backward' && contextChanged) counters.returnBoundaryBackwardContextChanges += 1;
  }

  function scheduleBoundarySccReprocess(blockInstanceId, edge, stateChanged, contextChanged) {
    if (!stateChanged && !contextChanged) return;
    const sccId = topology.sccIdByNodeId.get(blockInstanceId);
    if (!sccId || activeScc?.scc?.id === sccId) return;
    const topoIndex = sccTopoIndexById.get(sccId);
    const alreadyProcessed = currentSccOrderIndex >= sccTopoOrder.length ||
      (Number.isInteger(topoIndex) && topoIndex < currentSccOrderIndex);
    if (!alreadyProcessed) return;

    const direction = edge ? schedulingDirectionForEdge(edge) : 'missingScc';
    if (pendingReprocessSccIdSet.has(sccId)) {
      counters.returnBoundarySccRequeueSkippedAlreadyQueued += 1;
      return;
    }
    pendingReprocessSccIdSet.add(sccId);
    pendingReprocessSccIds.push(sccId);
    counters.returnBoundarySccRequeues += 1;
    if (direction === 'backward') counters.returnBoundaryBackwardSccRequeues += 1;
  }

  function incrementEnqueueReason(reason) {
    if (reason === 'state') counters.enqueueStateChanges += 1;
    else if (reason === 'returnContext') counters.enqueueReturnContextChanges += 1;
    else if (reason === 'seed') counters.enqueueSeedInputs += 1;
    else counters.enqueueOther += 1;
  }

  function enqueueActive(blockInstanceId, reason = 'other') {
    if (!activeScc || !activeScc.nodeSet.has(blockInstanceId)) return;
    counters.enqueueAttempts += 1;
    if (activeScc.queued.has(blockInstanceId)) {
      counters.enqueueSkippedAlreadyQueued += 1;
      return;
    }
    activeScc.queued.add(blockInstanceId);
    activeScc.queue.push(blockInstanceId);
    counters.enqueuedBlocks += 1;
    incrementEnqueueReason(reason);
    counters.maxWorklistSize = Math.max(counters.maxWorklistSize, activeScc.queue.length);
  }

  function seedRootInput(blockInstanceId) {
    const oldState = inStateByBlockInstanceId.get(blockInstanceId) || bottomState();
    const merged = joinStates(oldState, rootEntryState(blockInstanceId), options);
    if (!statesEqual(oldState, merged, options)) inStateByBlockInstanceId.set(blockInstanceId, merged);
  }

  function seedDirtySccInputs(scc) {
    activeScc.boundaryInputs = new Map();
    for (const blockInstanceId of scc.nodes) {
      if (rootIdSet.has(blockInstanceId)) seedRootInput(blockInstanceId);
      const seededInput = inStateByBlockInstanceId.get(blockInstanceId) || bottomState();
      activeScc.boundaryInputs.set(blockInstanceId, cloneState(seededInput, options));
      if (!isBottomState(seededInput)) enqueueActive(blockInstanceId, 'seed');
    }
  }

  function beginNextScc() {
    let requeued = false;
    let sccId = null;
    if (currentSccOrderIndex < sccTopoOrder.length) {
      sccId = sccTopoOrder[currentSccOrderIndex];
    } else {
      while (pendingReprocessSccIds.length > 0 && !sccId) {
        const next = pendingReprocessSccIds.shift();
        pendingReprocessSccIdSet.delete(next);
        if (sccById.has(next)) {
          sccId = next;
          requeued = true;
        }
      }
      if (!sccId) return false;
    }
    const scc = sccById.get(sccId);
    if (!scc) throw new Error(`Missing abstract interpretation SCC ${sccId}`);
    const reusable = !!cachePlan?.reusableSccIds?.has(sccId);
    activeScc = {
      scc,
      nodeSet: new Set(scc.nodes),
      reusable,
      requeued,
      stage: reusable ? 'reuse' : (scc.cyclic ? 'widening' : 'acyclic'),
      edgeKindCounts: edgeKindCountsForScc(scc),
      queue: [],
      queued: new Set(),
      narrowingRound: 0,
      narrowingChanged: false,
      narrowingCandidates: null,
      narrowingBlockIndex: 0,
      boundaryInputs: null
    };
    mode = activeScc.stage === 'reuse' || activeScc.stage === 'acyclic' ? 'widening' : activeScc.stage;
    if (!reusable) seedDirtySccInputs(scc);
    return true;
  }

  function finishActiveScc() {
    counters.sccProcessed += 1;
    if (activeScc.reusable) counters.sccReused += 1;
    const requeued = activeScc.requeued === true;
    activeScc = null;
    if (!requeued) currentSccOrderIndex += 1;
    mode = 'widening';
  }

  function installCachedScc() {
    const record = cachePlan?.recordByCurrentSccId?.get(activeScc.scc.id);
    if (!record) throw new Error(`Reusable SCC ${activeScc.scc.id} is missing cached record`);
    for (const blockInstanceId of activeScc.scc.nodes) {
      const blockState = record.blockStates?.[blockInstanceId];
      if (!blockState) throw new Error(`Reusable SCC ${activeScc.scc.id} is missing cached block state ${blockInstanceId}`);
      inStateByBlockInstanceId.set(blockInstanceId, abstractStateFromSerializable(blockState.inState, options));
      outStateByBlockInstanceId.set(blockInstanceId, abstractStateFromSerializable(blockState.outState, options));
      inReturnContextsByBlockInstanceId.set(blockInstanceId, returnContextSet(blockState.inReturnContexts));
      outReturnContextsByBlockInstanceId.set(blockInstanceId, returnContextSet(blockState.outReturnContexts));
    }
    propagateOutgoingForScc(activeScc.scc);
    finishActiveScc();
    return { complete: true, steps: Math.max(1, activeScc?.scc?.nodes?.length || 1) };
  }

  function processAcyclicScc() {
    const blockInstanceId = activeScc.scc.nodes[0];
    if (!blockInstanceId) {
      finishActiveScc();
      return { complete: true, steps: 1 };
    }
    const instance = indexes.blockInstanceById.get(blockInstanceId);
    if (!instance) throw new Error(`Missing abstract interpretation block instance ${blockInstanceId}`);
    const inState = inStateByBlockInstanceId.get(blockInstanceId) || bottomState();
    if (!isBottomState(inState)) {
      const transferred = transferBlock(instance, inState);
      outStateByBlockInstanceId.set(blockInstanceId, transferred.state);
      outReturnContextsByBlockInstanceId.set(blockInstanceId, cloneReturnContextSet(inReturnContextsByBlockInstanceId.get(blockInstanceId)));
    }
    counters.iterations += 1;
    propagateOutgoingForScc(activeScc.scc);
    finishActiveScc();
    return { complete: true, steps: 1 };
  }

  function processOneWideningNode(blockInstanceId) {
    activeScc.queued.delete(blockInstanceId);
    const instance = indexes.blockInstanceById.get(blockInstanceId);
    if (!instance) throw new Error(`Missing abstract interpretation block instance ${blockInstanceId}`);
    const inState = inStateByBlockInstanceId.get(blockInstanceId) || bottomState();
    if (!isBottomState(inState)) {
      const transferred = transferBlock(instance, inState);
      outStateByBlockInstanceId.set(blockInstanceId, transferred.state);
      outReturnContextsByBlockInstanceId.set(blockInstanceId, cloneReturnContextSet(inReturnContextsByBlockInstanceId.get(blockInstanceId)));
      const outEdges = indexes.outEdgesByBlockInstanceId.get(blockInstanceId) || [];
      for (const edge of outEdges) {
        if (!activeScc.nodeSet.has(edge.toBlockInstanceId)) continue;
        const output = edgeOutput(blockInstanceId, transferred.state, edge);
        if (isBottomState(output.state)) continue;
        joinIntoBlock(edge.toBlockInstanceId, output.state, edge, enqueueActive);
        joinReturnContextsIntoBlock(edge.toBlockInstanceId, output.returnContexts, enqueueActive);
      }
    }
    counters.iterations += 1;
  }

  function processWidening(maxSteps) {
    let steps = 0;
    while (activeScc.queue.length > 0 && steps < maxSteps) {
      const blockInstanceId = activeScc.queue.shift();
      processOneWideningNode(blockInstanceId);
      steps += 1;
    }
    if (activeScc.queue.length > 0) return { complete: false, steps };

    if (!activeScc.scc.cyclic || maxNarrowingRounds === 0) {
      propagateOutgoingForScc(activeScc.scc);
      finishActiveScc();
      return { complete: true, steps: Math.max(steps, 1) };
    }

    activeScc.stage = 'prepareNarrowingRound';
    mode = 'narrowing';
    return { complete: false, steps: Math.max(steps, 1) };
  }

  function prepareNarrowingRound() {
    activeScc.narrowingCandidates = new Map();
    for (const blockInstanceId of activeScc.scc.nodes) {
      const boundary = activeScc.boundaryInputs?.get(blockInstanceId) || bottomState();
      activeScc.narrowingCandidates.set(blockInstanceId, cloneState(boundary, options));
    }
    activeScc.narrowingBlockIndex = 0;
    activeScc.narrowingChanged = false;
    activeScc.stage = 'computeNarrowingCandidates';
  }

  function computeOneNarrowingCandidate(blockInstanceId) {
    const instance = indexes.blockInstanceById.get(blockInstanceId);
    const inState = inStateByBlockInstanceId.get(blockInstanceId) || bottomState();
    if (isBottomState(inState)) return;

    const transferred = transferBlock(instance, inState);
    outReturnContextsByBlockInstanceId.set(blockInstanceId, cloneReturnContextSet(inReturnContextsByBlockInstanceId.get(blockInstanceId)));
    const outEdges = indexes.outEdgesByBlockInstanceId.get(blockInstanceId) || [];
    for (const edge of outEdges) {
      if (!activeScc.nodeSet.has(edge.toBlockInstanceId)) continue;
      const output = edgeOutput(blockInstanceId, transferred.state, edge);
      if (isBottomState(output.state)) continue;
      const oldCandidate = activeScc.narrowingCandidates.get(edge.toBlockInstanceId) || bottomState();
      activeScc.narrowingCandidates.set(edge.toBlockInstanceId, joinStates(oldCandidate, output.state, options));
      counters.narrowingStateJoins += 1;
    }
  }

  function applyOneNarrowingCandidate(blockInstanceId) {
    const oldState = inStateByBlockInstanceId.get(blockInstanceId) || bottomState();
    const candidate = activeScc.narrowingCandidates.get(blockInstanceId) || bottomState();
    const narrowed = narrowStates(oldState, candidate, options);
    counters.stateNarrowAttempts += 1;
    if (statesEqual(oldState, narrowed, options)) return;

    counters.stateNarrows += 1;
    inStateByBlockInstanceId.set(blockInstanceId, narrowed);
    activeScc.narrowingChanged = true;
    counters.narrowingChangedStates += 1;
  }

  function recomputeOneNarrowedOutState(blockInstanceId) {
    const instance = indexes.blockInstanceById.get(blockInstanceId);
    const inState = inStateByBlockInstanceId.get(blockInstanceId) || bottomState();
    if (isBottomState(inState)) {
      outStateByBlockInstanceId.set(blockInstanceId, bottomState());
      outReturnContextsByBlockInstanceId.set(blockInstanceId, returnContextSet());
      return;
    }
    outStateByBlockInstanceId.set(blockInstanceId, transferBlock(instance, inState).state);
    outReturnContextsByBlockInstanceId.set(blockInstanceId, cloneReturnContextSet(inReturnContextsByBlockInstanceId.get(blockInstanceId)));
  }

  function processNarrowing(maxSteps) {
    let steps = 0;
    while (steps < maxSteps) {
      if (activeScc.stage === 'prepareNarrowingRound') {
        prepareNarrowingRound();
        continue;
      }

      if (activeScc.stage === 'computeNarrowingCandidates') {
        while (activeScc.narrowingBlockIndex < activeScc.scc.nodes.length && steps < maxSteps) {
          computeOneNarrowingCandidate(activeScc.scc.nodes[activeScc.narrowingBlockIndex]);
          activeScc.narrowingBlockIndex += 1;
          steps += 1;
        }
        if (activeScc.narrowingBlockIndex < activeScc.scc.nodes.length) return { complete: false, steps };
        activeScc.narrowingBlockIndex = 0;
        activeScc.stage = 'applyNarrowingCandidates';
        continue;
      }

      if (activeScc.stage === 'applyNarrowingCandidates') {
        while (activeScc.narrowingBlockIndex < activeScc.scc.nodes.length && steps < maxSteps) {
          applyOneNarrowingCandidate(activeScc.scc.nodes[activeScc.narrowingBlockIndex]);
          activeScc.narrowingBlockIndex += 1;
          steps += 1;
        }
        if (activeScc.narrowingBlockIndex < activeScc.scc.nodes.length) return { complete: false, steps };

        counters.narrowingRounds += 1;
        activeScc.narrowingRound += 1;
        activeScc.narrowingCandidates = null;
        activeScc.narrowingBlockIndex = 0;

        if (activeScc.narrowingChanged && activeScc.narrowingRound < maxNarrowingRounds) {
          activeScc.stage = 'prepareNarrowingRound';
        } else {
          activeScc.stage = 'finalizeNarrowedOutStates';
        }
        continue;
      }

      if (activeScc.stage === 'finalizeNarrowedOutStates') {
        while (activeScc.narrowingBlockIndex < activeScc.scc.nodes.length && steps < maxSteps) {
          recomputeOneNarrowedOutState(activeScc.scc.nodes[activeScc.narrowingBlockIndex]);
          activeScc.narrowingBlockIndex += 1;
          steps += 1;
        }
        if (activeScc.narrowingBlockIndex < activeScc.scc.nodes.length) return { complete: false, steps };
        propagateOutgoingForScc(activeScc.scc);
        finishActiveScc();
        return { complete: true, steps: Math.max(steps, 1) };
      }

      throw new Error(`Unknown abstract interpretation narrowing stage: ${activeScc.stage}`);
    }
    return { complete: false, steps };
  }

  function stepActiveScc(maxSteps) {
    if (activeScc.stage === 'reuse') return installCachedScc();
    if (activeScc.stage === 'acyclic') return processAcyclicScc();
    if (activeScc.stage === 'widening') return processWidening(maxSteps);
    return processNarrowing(maxSteps);
  }

  function stepOne() {
    let steps = 0;
    while (steps < maxBlockStepsPerCrank) {
      if (!activeScc && !beginNextScc()) return { status: 'complete' };
      const result = stepActiveScc(Math.max(1, maxBlockStepsPerCrank - steps));
      steps += Math.max(1, result.steps || 0);
      if (!result.complete) return { status: 'running' };
    }
    return {
      status: currentSccOrderIndex >= sccTopoOrder.length &&
        !activeScc &&
        pendingReprocessSccIds.length === 0
        ? 'complete'
        : 'running'
    };
  }

  function result() {
    const blockStates = blockInstanceIds.map((blockInstanceId) => ({
      blockInstanceId,
      inState: abstractStateToSerializable(inStateByBlockInstanceId.get(blockInstanceId) || bottomState(), options),
      outState: abstractStateToSerializable(outStateByBlockInstanceId.get(blockInstanceId) || bottomState(), options),
      inReturnContexts: normalizeReturnContexts(Array.from(inReturnContextsByBlockInstanceId.get(blockInstanceId) || [])),
      outReturnContexts: normalizeReturnContexts(Array.from(outReturnContextsByBlockInstanceId.get(blockInstanceId) || []))
    }));

    return {
      producedBy: 'abstractInterpretation',
      graphKind: graph.graphKind,
      domains: ['flags', 'knownBits', 'byteScalar', 'reducedBytes', 'mapper', 'provenance', 'shadowStack'],
      options: {
        scalarSetCap: options.scalarSetCap || options.setCap || 16,
        setCap: options.setCap || options.scalarSetCap || 16,
        widenDelay,
        maxNarrowingRounds,
        mapperDomain: graph.mapper.mapperDomain?.id || null
      },
      blockStates,
      counters: { ...counters }
    };
  }

  function progress() {
    const loopSummaryApplications = counters.loopSummaryReentryApplications
      + counters.loopSummaryHeaderApplications
      + counters.loopSummaryExitApplications;
    const narrowingLoopSummaryApplications = counters.narrowingLoopSummaryReentryApplications
      + counters.narrowingLoopSummaryHeaderApplications
      + counters.narrowingLoopSummaryExitApplications;
    const currentScc = activeScc?.scc || null;
    const narrowingStage = activeScc && mode === 'narrowing' ? activeScc.stage : null;
    const narrowingBlockIndex = activeScc && mode === 'narrowing' ? activeScc.narrowingBlockIndex : 0;
    const narrowingRound = activeScc && mode === 'narrowing' ? activeScc.narrowingRound : 0;
    const details = {
      mode,
      queuedBlocks: activeScc?.queue?.length || 0,
      blockInstanceCount: counters.blockInstanceCount,
      edgeCount: counters.edgeCount,
      normalReturnEdgeCount: counters.normalReturnEdgeCount,
      schedulingExcludedReturnEdgeCount: counters.schedulingExcludedReturnEdgeCount,
      returnEdgeSummaryCount: counters.returnEdgeSummaryCount,
      summaryUsableReturnEdgeCount: counters.summaryUsableReturnEdgeCount,
      summaryRejectedReturnEdgeCount: counters.summaryRejectedReturnEdgeCount,
      missingCallEdgeReturnEdgeCount: counters.missingCallEdgeReturnEdgeCount,
      missingCallTargetReturnEdgeCount: counters.missingCallTargetReturnEdgeCount,
      returnEdgeSummaryRejectReasons: counters.returnEdgeSummaryRejectReasons,
      returnEdgeSummaryStackRejectReasons: counters.returnEdgeSummaryStackRejectReasons,
      returnEdgeSummaryNoNormalRejectReasons: counters.returnEdgeSummaryNoNormalRejectReasons,
      returnEdgeSummaryNotAlwaysRejectReasons: counters.returnEdgeSummaryNotAlwaysRejectReasons,
      returnEdgeSummaryIndirectRejectReasons: counters.returnEdgeSummaryIndirectRejectReasons,
      returnEdgeSummaryUnknownCallRejectReasons: counters.returnEdgeSummaryUnknownCallRejectReasons,
      returnEdgeSummaryUnknownReturnRejectReasons: counters.returnEdgeSummaryUnknownReturnRejectReasons,
      returnEdgeSummaryRejectedDistinctCalleeCount: counters.returnEdgeSummaryRejectedDistinctCalleeCount,
      returnEdgeSummaryTopRejectSources: counters.returnEdgeSummaryTopRejectSources,
      summarizedCallReturnCount: counters.summarizedCallReturnCount,
      unsummarizedCallReturnCount: counters.unsummarizedCallReturnCount,
      deferredJsrFallthroughCount: counters.deferredJsrFallthroughCount,
      rejectedSummaryNoRtsFallbackCount: counters.rejectedSummaryNoRtsFallbackCount,
      summaryReturnRejectReasons: counters.summaryReturnRejectReasons,
      summaryReturnStackRejectReasons: counters.summaryReturnStackRejectReasons,
      summaryReturnNoNormalRejectReasons: counters.summaryReturnNoNormalRejectReasons,
      summaryReturnNoLocalRtsDetails: counters.summaryReturnNoLocalRtsDetails,
      summaryReturnNotAlwaysRejectReasons: counters.summaryReturnNotAlwaysRejectReasons,
      rootCount: counters.rootCount,
      sccCount: counters.sccCount,
      cyclicSccCount: counters.cyclicSccCount,
      currentSccIndex: Math.min(currentSccOrderIndex + (activeScc ? 1 : 0), counters.sccCount),
      currentSccId: currentScc?.id || null,
      currentSccBlockCount: currentScc?.nodes?.length || 0,
      currentSccCyclic: !!currentScc?.cyclic,
      currentSccStage: activeScc?.stage || null,
      currentSccInternalEdgesByKind: activeScc?.edgeKindCounts?.internal || emptyEdgeKindCounts(),
      currentSccOutgoingEdgesByKind: activeScc?.edgeKindCounts?.outgoing || emptyEdgeKindCounts(),
      currentSccIncomingEdgesByKind: activeScc?.edgeKindCounts?.incoming || emptyEdgeKindCounts(),
      largestSccId: sccSizeStats.largestSccId,
      largestSccBlockCount: sccSizeStats.largestSccBlockCount,
      largestCyclicSccId: sccSizeStats.largestCyclicSccId,
      largestCyclicSccBlockCount: sccSizeStats.largestCyclicSccBlockCount,
      dirtySccCount: counters.sccDirty,
      reusedSccCount: counters.sccReused,
      reusableSccCount: counters.sccCacheHits,
      cacheMissSccCount: counters.sccCacheMisses,
      cachedBlockStates: counters.cachedBlockStates,
      recomputedBlockStates: counters.recomputedBlockStates,
      loopHeaderCount: counters.loopHeaderCount,
      loopReentryEdgeCount: counters.loopReentryEdgeCount,
      loopSummaryCount: counters.loopSummaryCount,
      loopSummaryApplications,
      loopSummaryReentryApplications: counters.loopSummaryReentryApplications,
      loopSummaryHeaderApplications: counters.loopSummaryHeaderApplications,
      loopSummaryExitApplications: counters.loopSummaryExitApplications,
      loopSummaryWidenSuppressions: counters.loopSummaryWidenSuppressions,
      loopSummaryParametricInstantiations: counters.loopSummaryParametricInstantiations,
      loopSummaryParametricSkips: counters.loopSummaryParametricSkips,
      iterations: counters.iterations,
      stateJoins: counters.stateJoins,
      stateWidens: counters.stateWidens,
      stateWidenAttempts: counters.stateWidenAttempts,
      stateNarrows: counters.stateNarrows,
      stateNarrowAttempts: counters.stateNarrowAttempts,
      narrowingStateJoins: counters.narrowingStateJoins,
      returnContextJoins: counters.returnContextJoins,
      returnContextChangedStates: counters.returnContextChangedStates,
      returnEdgesForwardInSchedule: counters.returnEdgesForwardInSchedule,
      returnEdgesBackwardInSchedule: counters.returnEdgesBackwardInSchedule,
      returnEdgesSameSchedulingScc: counters.returnEdgesSameSchedulingScc,
      returnEdgesMissingSchedulingScc: counters.returnEdgesMissingSchedulingScc,
      returnBoundaryPropagations: counters.returnBoundaryPropagations,
      returnBoundaryPropagationsForward: counters.returnBoundaryPropagationsForward,
      returnBoundaryPropagationsBackward: counters.returnBoundaryPropagationsBackward,
      returnBoundaryPropagationsMissingScc: counters.returnBoundaryPropagationsMissingScc,
      returnBoundaryStateChanges: counters.returnBoundaryStateChanges,
      returnBoundaryContextChanges: counters.returnBoundaryContextChanges,
      returnBoundaryBackwardStateChanges: counters.returnBoundaryBackwardStateChanges,
      returnBoundaryBackwardContextChanges: counters.returnBoundaryBackwardContextChanges,
      returnBoundarySccRequeues: counters.returnBoundarySccRequeues,
      returnBoundaryBackwardSccRequeues: counters.returnBoundaryBackwardSccRequeues,
      returnBoundarySccRequeueSkippedAlreadyQueued: counters.returnBoundarySccRequeueSkippedAlreadyQueued,
      enqueueAttempts: counters.enqueueAttempts,
      enqueuedBlocks: counters.enqueuedBlocks,
      enqueueStateChanges: counters.enqueueStateChanges,
      enqueueReturnContextChanges: counters.enqueueReturnContextChanges,
      enqueueSeedInputs: counters.enqueueSeedInputs,
      enqueueOther: counters.enqueueOther,
      enqueueSkippedAlreadyQueued: counters.enqueueSkippedAlreadyQueued,
      narrowingLoopSummaryApplications,
      narrowingLoopSummaryReentryApplications: counters.narrowingLoopSummaryReentryApplications,
      narrowingLoopSummaryHeaderApplications: counters.narrowingLoopSummaryHeaderApplications,
      narrowingLoopSummaryExitApplications: counters.narrowingLoopSummaryExitApplications,
      narrowingRounds: counters.narrowingRounds,
      narrowingChangedStates: counters.narrowingChangedStates,
      changedStates: counters.changedStates,
      maxWorklistSize: counters.maxWorklistSize
    };

    const out = {
      phase: ANALYSIS_PHASE_IDS.ABSTRACT_INTERPRETATION,
      mode,
      queuedBlocks: details.queuedBlocks,
      ...counters,
      detailKind: ANALYSIS_PROGRESS_DETAIL_KINDS.ABSTRACT_INTERPRETATION,
      details
    };

    if (mode === 'narrowing') {
      out.narrowingStage = narrowingStage;
      out.narrowingRound = narrowingRound;
      out.narrowingMaxRounds = maxNarrowingRounds;
      out.narrowingProcessedBlocks = narrowingBlockIndex;
      out.narrowingTotalBlocks = currentScc?.nodes?.length || 0;
      details.narrowingStage = narrowingStage;
      details.narrowingRound = narrowingRound;
      details.narrowingMaxRounds = maxNarrowingRounds;
      details.narrowingProcessedBlocks = narrowingBlockIndex;
      details.narrowingTotalBlocks = currentScc?.nodes?.length || 0;
    }

    return out;
  }

  return { stepOne, result, progress, debugState: () => ({ inStateByBlockInstanceId: mapToPlainObject(inStateByBlockInstanceId) }) };
}
