import { ANALYSIS_PHASE_IDS } from '../analysisConstants.js';
import { EDGE_KINDS, isExecutableEdgeKind } from '../cfg/constants.js';
import { buildGraphTopology } from '../cfgTopology/graphTopology.js';
import { requireArray, requireObject } from '../dataShape.js';
import { makeEdgeId } from '../identity.js';
import { createAbstractInterpretationWalker } from './cfgWalk.js';
import { discoverExpandCfgFrontiersFromAbstractInterpretation } from './expandCfgFrontiers.js';
import { resolveIndirectJumpsFromAbstractInterpretation } from './indirectJumpResolution.js';
import { resolveRtsTricksFromAbstractInterpretation } from './rtsTrickResolution.js';
import {
  buildAbstractInterpretationOptionsSignature,
  buildAbstractInterpretationSignatures
} from './signatures.js';
import {
  createAbstractInterpretationCache,
  createAbstractInterpretationCachePlan
} from './cachePlan.js';

function buildExactOnlyGraph(context) {
  requireObject(context, 'abstract interpretation context');
  return {
    graphKind: 'exactOnly',
    mapper: requireObject(context.mapper, 'abstract interpretation mapper'),
    prgBytes: context.prgBytes,
    contexts: requireObject(context.contexts, 'abstract interpretation contexts'),
    seedSites: requireArray(context.seedSites, 'abstract interpretation seedSites'),
    instructions: requireArray(context.instructions, 'abstract interpretation instructions'),
    blocks: requireArray(context.blocks, 'abstract interpretation blocks'),
    blockInstances: requireArray(context.blockInstances, 'abstract interpretation blockInstances'),
    instructionExecutions: requireArray(context.instructionExecutions, 'abstract interpretation instructionExecutions'),
    edges: typeof context.edgesForGraph === 'function' ? context.edgesForGraph() : requireArray(context.edges, 'abstract interpretation edges'),
    frontiers: requireArray(context.frontiers, 'abstract interpretation frontiers')
  };
}

function indexBy(items, keyName) {
  return new Map(requireArray(items, `normal return ${keyName} items`).map((item) => [item[keyName], item]));
}

function blockTerminatorInstruction(block, instructionById) {
  const ids = Array.isArray(block?.instructionIds) ? block.instructionIds : [];
  if (!ids.length) return null;
  return instructionById.get(Number(ids[ids.length - 1]) >>> 0) || null;
}

function blockTerminatorForInstance(blockInstanceId, blockInstanceById, blockById, instructionById) {
  const instance = blockInstanceById.get(blockInstanceId);
  if (!instance) return null;
  const block = blockById.get(instance.blockId);
  if (!block) return null;
  return blockTerminatorInstruction(block, instructionById);
}

function isJsrTerminatedBlock(blockInstanceId, blockInstanceById, blockById, instructionById) {
  const instruction = blockTerminatorForInstance(blockInstanceId, blockInstanceById, blockById, instructionById);
  return instruction?.flow?.type === 'call' && instruction?.flow?.fallthrough !== undefined;
}

function isRtsTerminatedBlock(blockInstanceId, blockInstanceById, blockById, instructionById) {
  const instruction = blockTerminatorForInstance(blockInstanceId, blockInstanceById, blockById, instructionById);
  return instruction?.flow?.type === 'stop' && instruction?.flow?.reason === 'rts';
}

function returnSiteForFallthrough(graph, fallthroughEdge, blockInstanceById) {
  const returnInstance = blockInstanceById.get(fallthroughEdge.toBlockInstanceId);
  if (!returnInstance) return null;
  return {
    returnBlockInstanceId: returnInstance.blockInstanceId,
    returnSiteKey: returnInstance.siteKey,
    returnContextKey: returnInstance.contextKey,
    returnCpuAddr: fallthroughEdge.targetCpuAddr & 0xffff,
    returnRomOff: fallthroughEdge.targetRomOff >>> 0
  };
}

function summaryForCallTarget(functionSummarization, entryBlockInstanceId) {
  const byEntry = functionSummarization?.byEntryBlockInstanceId;
  if (!byEntry || typeof byEntry !== 'object') return null;
  return byEntry[entryBlockInstanceId] || null;
}

function summaryReturnEffects(summary) {
  return summary?.returnEffects || summary?.effects || null;
}

function summaryLocalReturnEffects(summary) {
  return summary?.localReturnEffects || summary?.localEffects || null;
}

function canUseSummaryReturn(summary) {
  const effects = summaryReturnEffects(summary);
  return Boolean(summary) &&
    effects?.mayReturnNormally === true &&
    effects?.alwaysReturnsNormally === true &&
    effects?.stackReturnSafe === true &&
    effects?.hasIndirectControl !== true &&
    effects?.callsUnknownTarget !== true &&
    effects?.hasRtsTrickOrUnknownReturn !== true;
}

function emptySummaryReturnRejectReasons() {
  return {
    noSummary: 0,
    noEffects: 0,
    noNormalReturn: 0,
    stackUnsafe: 0,
    unknownReturn: 0,
    indirectControl: 0,
    unknownCall: 0,
    notAlwaysNormal: 0,
    unsummarizedStatus: 0,
    other: 0
  };
}

function emptySummaryReturnStackRejectReasons() {
  return {
    writeRange: 0,
    readCaller: 0,
    writeCaller: 0,
    unbalancedReturn: 0,
    unknownDepth: 0,
    tsx: 0,
    txs: 0,
    transitiveCallee: 0,
    normalCallReturn: 0,
    other: 0
  };
}

function emptySummaryReturnNoNormalRejectReasons() {
  return {
    noLocalRts: 0,
    tailJump: 0,
    tailJumpToNormalReturn: 0,
    tailJumpMissingSummary: 0,
    indirectControl: 0,
    unknownCall: 0,
    unknownReturn: 0,
    localMayNotReturn: 0,
    other: 0
  };
}

function emptySummaryReturnNoLocalRtsDetails() {
  return {
    stoppedAtEntry: 0,
    stoppedEntryWithReachableRts: 0,
    stoppedEntryWithSummaryNormal: 0,
    exhaustedNoRts: 0
  };
}

function emptySummaryReturnNotAlwaysRejectReasons() {
  return {
    localMayNotReturn: 0,
    tailJump: 0,
    tailJumpToNormalReturn: 0,
    transitiveCallee: 0,
    indirectControl: 0,
    unknownCall: 0,
    unknownReturn: 0,
    other: 0
  };
}

function emptyDirectTransitiveReasons(localLabel = 'local') {
  return {
    [localLabel]: 0,
    transitive: 0,
    other: 0
  };
}

function summaryReturnRejectReason(summary) {
  const effects = summaryReturnEffects(summary);
  if (!summary) return 'noSummary';
  if (!effects || typeof effects !== 'object') return 'noEffects';
  if (effects.mayReturnNormally !== true) return 'noNormalReturn';
  if (effects.stackReturnSafe !== true) return 'stackUnsafe';
  if (effects.hasRtsTrickOrUnknownReturn === true) return 'unknownReturn';
  if (effects.hasIndirectControl === true) return 'indirectControl';
  if (effects.callsUnknownTarget === true) return 'unknownCall';
  if (effects.alwaysReturnsNormally !== true) return 'notAlwaysNormal';
  if (summary.summaryStatus !== 'summarized') return 'unsummarizedStatus';
  return 'other';
}

function summaryReturnNoNormalRejectReason(summary) {
  const effects = summaryReturnEffects(summary);
  const localEffects = summaryLocalReturnEffects(summary);
  if (!effects || effects.mayReturnNormally === true) return 'other';
  const source = localEffects && typeof localEffects === 'object' ? localEffects : effects;
  const tailJumpTargets = summary?.tailJumpTargetSummary || {};
  if (tailJumpTargets.composableReturnCount > 0) return 'tailJumpToNormalReturn';
  if (tailJumpTargets.missingSummaryCount > 0) return 'tailJumpMissingSummary';
  if (source.mayTailJump === true || (summary?.tailJumpInstructionIds || []).length > 0) return 'tailJump';
  if (source.hasIndirectControl === true) return 'indirectControl';
  if (source.callsUnknownTarget === true) return 'unknownCall';
  if (source.hasRtsTrickOrUnknownReturn === true) return 'unknownReturn';
  if (source.mayReturnNormally !== true) return 'noLocalRts';
  if (source.mayNotReturn === true) return 'localMayNotReturn';
  return 'other';
}

function summaryReturnNoLocalRtsDetail(summary, reachableRtsBlocks, functionSummarization) {
  const boundaryIds = Array.isArray(summary?.boundaryEntryBlockInstanceIds)
    ? summary.boundaryEntryBlockInstanceIds
    : [];
  if (!boundaryIds.length) return 'exhaustedNoRts';

  for (const boundaryId of boundaryIds) {
    const boundarySummary = summaryForCallTarget(functionSummarization, boundaryId);
    if (summaryReturnEffects(boundarySummary)?.mayReturnNormally === true) return 'stoppedEntryWithSummaryNormal';
  }

  for (const boundaryId of boundaryIds) {
    if (reachableRtsBlocks(boundaryId).length > 0) return 'stoppedEntryWithReachableRts';
  }

  return 'stoppedAtEntry';
}

function summaryReturnNotAlwaysRejectReason(summary) {
  const effects = summaryReturnEffects(summary);
  const localEffects = summaryLocalReturnEffects(summary);
  if (!effects || effects.alwaysReturnsNormally === true) return 'other';
  const tailJumpTargets = summary?.tailJumpTargetSummary || {};
  if (tailJumpTargets.composableReturnCount > 0) return 'tailJumpToNormalReturn';
  if (effects.hasIndirectControl === true) return 'indirectControl';
  if (effects.callsUnknownTarget === true) return 'unknownCall';
  if (effects.hasRtsTrickOrUnknownReturn === true) return 'unknownReturn';
  if (effects.mayTailJump === true) return 'tailJump';
  if (localEffects?.alwaysReturnsNormally === true) return 'transitiveCallee';
  if (effects.mayNotReturn === true || localEffects?.mayNotReturn === true) return 'localMayNotReturn';
  return 'other';
}

function summaryReturnStackRejectReason(summary) {
  const effects = summaryReturnEffects(summary);
  if (!effects || effects.stackReturnSafe === true) return 'other';

  const localEffects = summaryLocalReturnEffects(summary);
  const localStackSafe = localEffects && typeof localEffects === 'object' && localEffects.stackReturnSafe === true;
  const source = localStackSafe ? effects : (localEffects || effects);
  if (localStackSafe) return 'transitiveCallee';
  if (source.mayWriteStackRange === true) return 'writeRange';
  if (source.mayReadCallerStack === true || source.explicitStackMinDepth < 0) return 'readCaller';
  if (source.mayWriteCallerStack === true) return 'writeCaller';
  if (source.explicitStackDeltaKnown === false) {
    if (source.usesTxs === true) return 'txs';
    if (source.usesTsx === true) return 'tsx';
    return 'unknownDepth';
  }
  if (source.explicitStackUnbalancedReturn === true || source.explicitStackBalanced === false) return 'unbalancedReturn';
  if (source.normalCallReturnOnly !== true) return 'normalCallReturn';
  return 'other';
}

function summaryReturnIndirectRejectReason(summary) {
  const effects = summaryReturnEffects(summary);
  if (!effects || effects.hasIndirectControl !== true) return 'other';
  const localEffects = summaryLocalReturnEffects(summary);
  return localEffects?.hasIndirectControl === true ? 'direct' : 'transitive';
}

function summaryReturnUnknownCallRejectReason(summary) {
  const effects = summaryReturnEffects(summary);
  if (!effects || effects.callsUnknownTarget !== true) return 'other';
  const localEffects = summaryLocalReturnEffects(summary);
  return localEffects?.callsUnknownTarget === true ? 'local' : 'transitive';
}

function summaryReturnUnknownReturnRejectReason(summary) {
  const effects = summaryReturnEffects(summary);
  if (!effects || effects.hasRtsTrickOrUnknownReturn !== true) return 'other';
  const localEffects = summaryLocalReturnEffects(summary);
  return localEffects?.hasRtsTrickOrUnknownReturn === true ? 'local' : 'transitive';
}

function returnEdgeSummaryRejectDetail(summary, rejectReason) {
  if (rejectReason === 'stackUnsafe') return summaryReturnStackRejectReason(summary);
  if (rejectReason === 'noNormalReturn') return summaryReturnNoNormalRejectReason(summary);
  if (rejectReason === 'notAlwaysNormal') return summaryReturnNotAlwaysRejectReason(summary);
  if (rejectReason === 'indirectControl') return summaryReturnIndirectRejectReason(summary);
  if (rejectReason === 'unknownCall') return summaryReturnUnknownCallRejectReason(summary);
  if (rejectReason === 'unknownReturn') return summaryReturnUnknownReturnRejectReason(summary);
  return rejectReason || 'other';
}

function incrementCounter(counters, key) {
  const safeKey = Object.prototype.hasOwnProperty.call(counters, key) ? key : 'other';
  counters[safeKey] += 1;
}

function topReturnEdgeSummaryRejectSources(sourceMap, limit = 8) {
  return Array.from(sourceMap.values())
    .sort((a, b) => b.count - a.count ||
      a.reason.localeCompare(b.reason) ||
      a.detail.localeCompare(b.detail) ||
      String(a.entryBlockInstanceId).localeCompare(String(b.entryBlockInstanceId)))
    .slice(0, limit);
}

function classifyReturnEdgesBySummary(edges, edgeById, functionSummarization) {
  const counters = {
    total: 0,
    summaryUsable: 0,
    summaryRejected: 0,
    missingCallEdge: 0,
    missingCallTarget: 0,
    rejectReasons: emptySummaryReturnRejectReasons(),
    stackRejectReasons: emptySummaryReturnStackRejectReasons(),
    noNormalRejectReasons: emptySummaryReturnNoNormalRejectReasons(),
    notAlwaysRejectReasons: emptySummaryReturnNotAlwaysRejectReasons(),
    indirectRejectReasons: emptyDirectTransitiveReasons('direct'),
    unknownCallRejectReasons: emptyDirectTransitiveReasons('local'),
    unknownReturnRejectReasons: emptyDirectTransitiveReasons('local'),
    rejectedDistinctCalleeCount: 0,
    topRejectSources: []
  };
  const rejectedCalleeIds = new Set();
  const rejectSources = new Map();

  for (const edge of edges) {
    if (edge.kind !== EDGE_KINDS.RETURN) continue;
    counters.total += 1;
    const callEdge = edgeById.get(edge.returnForCallEdgeId);
    if (!callEdge) {
      counters.missingCallEdge += 1;
      continue;
    }
    if (!callEdge.toBlockInstanceId) {
      counters.missingCallTarget += 1;
      continue;
    }
    const summary = summaryForCallTarget(functionSummarization, callEdge.toBlockInstanceId);
    if (canUseSummaryReturn(summary)) {
      counters.summaryUsable += 1;
      continue;
    }
    counters.summaryRejected += 1;
    rejectedCalleeIds.add(callEdge.toBlockInstanceId);
    const rejectReason = summaryReturnRejectReason(summary);
    incrementCounter(counters.rejectReasons, rejectReason);
    const detail = returnEdgeSummaryRejectDetail(summary, rejectReason);
    if (rejectReason === 'stackUnsafe') incrementCounter(counters.stackRejectReasons, detail);
    else if (rejectReason === 'noNormalReturn') incrementCounter(counters.noNormalRejectReasons, detail);
    else if (rejectReason === 'notAlwaysNormal') incrementCounter(counters.notAlwaysRejectReasons, detail);
    else if (rejectReason === 'indirectControl') incrementCounter(counters.indirectRejectReasons, detail);
    else if (rejectReason === 'unknownCall') incrementCounter(counters.unknownCallRejectReasons, detail);
    else if (rejectReason === 'unknownReturn') incrementCounter(counters.unknownReturnRejectReasons, detail);

    const entryBlockInstanceId = summary?.entryBlockInstanceId || callEdge.toBlockInstanceId;
    const sourceKey = `${rejectReason}:${detail}:${entryBlockInstanceId}`;
    const source = rejectSources.get(sourceKey) || {
      reason: rejectReason,
      detail,
      entryBlockInstanceId,
      entryRomOff: Number.isFinite(summary?.entryRomOff) ? summary.entryRomOff >>> 0 : null,
      cpuStart: Number.isFinite(summary?.cpuStart) ? summary.cpuStart & 0xffff : null,
      count: 0
    };
    source.count += 1;
    rejectSources.set(sourceKey, source);
  }

  counters.rejectedDistinctCalleeCount = rejectedCalleeIds.size;
  counters.topRejectSources = topReturnEdgeSummaryRejectSources(rejectSources);
  return counters;
}

function augmentGraphWithNormalReturnEdges(graph, functionSummarization = null) {
  const blockById = indexBy(graph.blocks, 'blockId');
  const blockInstanceById = indexBy(graph.blockInstances, 'blockInstanceId');
  const instructionById = new Map(graph.instructions.map((instruction) => [Number(instruction.instructionId) >>> 0, instruction]));
  const edges = graph.edges.map((edge) => ({ ...edge }));
  const edgeById = new Map(edges.map((edge) => [edge.edgeId, edge]));
  const outgoing = new Map(graph.blockInstances.map((instance) => [instance.blockInstanceId, []]));

  for (const edge of edges) {
    if (!isExecutableEdgeKind(edge.kind)) continue;
    if (!outgoing.has(edge.fromBlockInstanceId)) outgoing.set(edge.fromBlockInstanceId, []);
    outgoing.get(edge.fromBlockInstanceId).push(edge);
  }

  const fallthroughByCallSite = new Map();
  for (const edge of edges) {
    if (edge.kind !== EDGE_KINDS.FALLTHROUGH) continue;
    if (!isJsrTerminatedBlock(edge.fromBlockInstanceId, blockInstanceById, blockById, instructionById)) continue;
    fallthroughByCallSite.set(`${edge.fromBlockInstanceId}:${edge.fromInstructionId >>> 0}`, edge);
  }

  const reachableRtsCache = new Map();
  function reachableRtsBlocks(startBlockInstanceId) {
    if (reachableRtsCache.has(startBlockInstanceId)) return reachableRtsCache.get(startBlockInstanceId);
    const visited = new Set();
    const queue = [startBlockInstanceId];
    const rtsBlocks = [];
    while (queue.length) {
      const blockInstanceId = queue.shift();
      if (visited.has(blockInstanceId)) continue;
      visited.add(blockInstanceId);
      if (isRtsTerminatedBlock(blockInstanceId, blockInstanceById, blockById, instructionById)) {
        rtsBlocks.push(blockInstanceId);
        continue;
      }
      for (const edge of outgoing.get(blockInstanceId) || []) {
        if (!isExecutableEdgeKind(edge.kind)) continue;
        if (edge.kind === EDGE_KINDS.CALL || edge.kind === EDGE_KINDS.RETURN || edge.kind === EDGE_KINDS.RTS_TRICK) continue;
        queue.push(edge.toBlockInstanceId);
      }
    }
    const out = rtsBlocks.sort();
    reachableRtsCache.set(startBlockInstanceId, out);
    return out;
  }

  let syntheticReturnEdges = 0;
  let summarizedCallReturns = 0;
  let unsummarizedCallReturns = 0;
  let deferredJsrFallthroughs = 0;
  let rejectedSummaryNoRtsFallback = 0;
  const summaryReturnRejectReasons = emptySummaryReturnRejectReasons();
  const summaryReturnStackRejectReasons = emptySummaryReturnStackRejectReasons();
  const summaryReturnNoNormalRejectReasons = emptySummaryReturnNoNormalRejectReasons();
  const summaryReturnNoLocalRtsDetails = emptySummaryReturnNoLocalRtsDetails();
  const summaryReturnNotAlwaysRejectReasons = emptySummaryReturnNotAlwaysRejectReasons();
  for (const edge of edges.slice()) {
    if (edge.kind !== EDGE_KINDS.CALL) continue;
    const fallthroughEdge = fallthroughByCallSite.get(`${edge.fromBlockInstanceId}:${edge.fromInstructionId >>> 0}`);
    if (!fallthroughEdge) continue;
    const returnSite = returnSiteForFallthrough(graph, fallthroughEdge, blockInstanceById);
    if (!returnSite) continue;

    const summary = summaryForCallTarget(functionSummarization, edge.toBlockInstanceId);
    if (canUseSummaryReturn(summary)) {
      Object.assign(edge, returnSite, {
        usesFunctionSummaryReturn: true,
        functionSummaryEntryBlockInstanceId: summary.entryBlockInstanceId
      });
      Object.assign(fallthroughEdge, {
        functionSummaryReturn: true,
        functionSummaryCallEdgeId: edge.edgeId,
        functionSummaryEntryBlockInstanceId: summary.entryBlockInstanceId,
        functionSummaryEffects: summaryReturnEffects(summary)
      });
      summarizedCallReturns += 1;
      continue;
    }

    const rtsBlocks = reachableRtsBlocks(edge.toBlockInstanceId);
    if (!rtsBlocks.length) {
      rejectedSummaryNoRtsFallback += 1;
      continue;
    }

    Object.assign(edge, returnSite);
    fallthroughEdge.deferToReturnEdges = true;
    unsummarizedCallReturns += 1;
    deferredJsrFallthroughs += 1;
    const rejectReason = summaryReturnRejectReason(summary);
    summaryReturnRejectReasons[rejectReason] += 1;
    if (rejectReason === 'stackUnsafe') {
      summaryReturnStackRejectReasons[summaryReturnStackRejectReason(summary)] += 1;
    } else if (rejectReason === 'noNormalReturn') {
      const noNormalReason = summaryReturnNoNormalRejectReason(summary);
      summaryReturnNoNormalRejectReasons[noNormalReason] += 1;
      if (noNormalReason === 'noLocalRts') {
        summaryReturnNoLocalRtsDetails[summaryReturnNoLocalRtsDetail(summary, reachableRtsBlocks, functionSummarization)] += 1;
      }
    } else if (rejectReason === 'notAlwaysNormal') {
      summaryReturnNotAlwaysRejectReasons[summaryReturnNotAlwaysRejectReason(summary)] += 1;
    }

    for (const rtsBlockInstanceId of rtsBlocks) {
      const rtsInstruction = blockTerminatorForInstance(rtsBlockInstanceId, blockInstanceById, blockById, instructionById);
      if (!rtsInstruction) continue;
      const edgeId = makeEdgeId(rtsBlockInstanceId, fallthroughEdge.toBlockInstanceId, EDGE_KINDS.RETURN);
      if (edgeById.has(edgeId)) continue;
      const returnEdge = {
        edgeId,
        fromBlockInstanceId: rtsBlockInstanceId,
        toBlockInstanceId: fallthroughEdge.toBlockInstanceId,
        kind: EDGE_KINDS.RETURN,
        fromInstructionId: Number(rtsInstruction.instructionId) >>> 0,
        targetCpuAddr: fallthroughEdge.targetCpuAddr & 0xffff,
        targetRomOff: fallthroughEdge.targetRomOff >>> 0,
        returnForCallEdgeId: edge.edgeId,
        ...returnSite
      };
      edgeById.set(edgeId, returnEdge);
      edges.push(returnEdge);
      if (!outgoing.has(rtsBlockInstanceId)) outgoing.set(rtsBlockInstanceId, []);
      outgoing.get(rtsBlockInstanceId).push(returnEdge);
      syntheticReturnEdges += 1;
    }
  }

  const returnEdgeSummaryCounters = classifyReturnEdgesBySummary(edges, edgeById, functionSummarization);

  return {
    ...graph,
    edges,
    normalReturnEdgeCount: syntheticReturnEdges,
    returnEdgeSummaryCount: returnEdgeSummaryCounters.total,
    summaryUsableReturnEdgeCount: returnEdgeSummaryCounters.summaryUsable,
    summaryRejectedReturnEdgeCount: returnEdgeSummaryCounters.summaryRejected,
    missingCallEdgeReturnEdgeCount: returnEdgeSummaryCounters.missingCallEdge,
    missingCallTargetReturnEdgeCount: returnEdgeSummaryCounters.missingCallTarget,
    returnEdgeSummaryRejectReasons: returnEdgeSummaryCounters.rejectReasons,
    returnEdgeSummaryStackRejectReasons: returnEdgeSummaryCounters.stackRejectReasons,
    returnEdgeSummaryNoNormalRejectReasons: returnEdgeSummaryCounters.noNormalRejectReasons,
    returnEdgeSummaryNotAlwaysRejectReasons: returnEdgeSummaryCounters.notAlwaysRejectReasons,
    returnEdgeSummaryIndirectRejectReasons: returnEdgeSummaryCounters.indirectRejectReasons,
    returnEdgeSummaryUnknownCallRejectReasons: returnEdgeSummaryCounters.unknownCallRejectReasons,
    returnEdgeSummaryUnknownReturnRejectReasons: returnEdgeSummaryCounters.unknownReturnRejectReasons,
    returnEdgeSummaryRejectedDistinctCalleeCount: returnEdgeSummaryCounters.rejectedDistinctCalleeCount,
    returnEdgeSummaryTopRejectSources: returnEdgeSummaryCounters.topRejectSources,
    summarizedCallReturnCount: summarizedCallReturns,
    unsummarizedCallReturnCount: unsummarizedCallReturns,
    deferredJsrFallthroughCount: deferredJsrFallthroughs,
    rejectedSummaryNoRtsFallbackCount: rejectedSummaryNoRtsFallback,
    summaryReturnRejectReasons,
    summaryReturnStackRejectReasons,
    summaryReturnNoNormalRejectReasons,
    summaryReturnNoLocalRtsDetails,
    summaryReturnNotAlwaysRejectReasons,
    schedulingExcludedReturnEdgeCount: 0
  };
}

export function createAbstractInterpretationPhase(context, options = null) {
  const opts = options === null || options === undefined ? {} : requireObject(options, 'abstract interpretation options');
  const graphKind = typeof opts.graphKind === 'string' ? opts.graphKind : 'exactOnly';
  const maxBlockStepsPerCrank = Number.isFinite(opts.maxBlockStepsPerCrank) ? Math.max(1, opts.maxBlockStepsPerCrank | 0) : 128;
  const scalarSetCap = Number.isFinite(opts.scalarSetCap) ? Math.max(1, opts.scalarSetCap | 0) : 16;
  const widenDelay = Number.isFinite(opts.widenDelay) ? Math.max(0, opts.widenDelay | 0) : 3;
  const maxNarrowingRounds = Number.isFinite(opts.maxNarrowingRounds) ? Math.max(0, opts.maxNarrowingRounds | 0) : 3;
  let walker = null;
  let graph = null;
  let schedulingGraph = null;
  let topology = null;
  let signatures = null;
  let optionsSignature = null;
  let cachePlan = null;

  function initialize() {
    if (graphKind !== 'exactOnly') throw new Error(`Unsupported abstract interpretation graphKind: ${graphKind}`);
    const augmentedGraph = augmentGraphWithNormalReturnEdges(buildExactOnlyGraph(context), context.functionSummarization);
    const schedulingExcludedReturnEdgeCount = augmentedGraph.edges
      .filter((edge) => edge.kind === EDGE_KINDS.RETURN)
      .length;
    graph = {
      ...augmentedGraph,
      schedulingExcludedReturnEdgeCount
    };
    schedulingGraph = {
      ...graph,
      edges: graph.edges.filter((edge) => edge.kind !== EDGE_KINDS.RETURN)
    };
    topology = buildGraphTopology(schedulingGraph);
    if (topology.graphKind !== graphKind) {
      throw new Error(`abstractInterpretation graphKind ${graphKind} does not match cfgTopology graphKind ${topology.graphKind}`);
    }
    optionsSignature = buildAbstractInterpretationOptionsSignature({
      graphKind,
      scalarSetCap,
      setCap: scalarSetCap,
      widenDelay,
      maxNarrowingRounds,
      mapperDomain: context.mapper.mapperDomain
    });
    signatures = buildAbstractInterpretationSignatures(graph, topology, {
      loopSummaries: context.loopSummaries
    });
    cachePlan = createAbstractInterpretationCachePlan({
      oldCache: null,
      topology,
      signatures,
      optionsSignature
    });
    walker = createAbstractInterpretationWalker(graph, {
      topology,
      maxBlockStepsPerCrank,
      scalarSetCap,
      setCap: scalarSetCap,
      widenDelay,
      maxNarrowingRounds,
      loopSummaries: context.loopSummaries,
      mapperDomain: context.mapper.mapperDomain,
      cachePlan
    });
  }

  function finish() {
    const result = walker.result();
    const indirect = resolveIndirectJumpsFromAbstractInterpretation(graph, result, context);
    result.resolvedIndirectJumps = indirect.resolutions.map((resolution) => {
      const { target, ...rest } = resolution;
      return rest;
    });
    result.indirectJumpResolutionCounters = indirect.counters;

    const expandCfg = discoverExpandCfgFrontiersFromAbstractInterpretation(graph, result, context);
    result.expandCfgFrontierCounters = expandCfg.counters;

    // console.log(`[rtsTrick] abstractInterpretation finish: scanning RTS terminators`);
    const rtsTricks = resolveRtsTricksFromAbstractInterpretation(graph, result, context);
    // console.log(`[rtsTrick] abstractInterpretation finish: scan complete dispatches=${rtsTricks.counters.pairedPointerTables}, entriesResolved=${rtsTricks.counters.entriesResolved}, seeds=${rtsTricks.counters.seedsAdded}, edges=${rtsTricks.counters.syntheticEdgesAdded}`);
    result.rtsTricks = rtsTricks;
    result.rtsTrickCounters = rtsTricks.counters;
    result.counters = {
      ...result.counters,
      schedulingExcludedReturnEdges: graph?.schedulingExcludedReturnEdgeCount || 0,
      returnEdgeSummaryCount: graph?.returnEdgeSummaryCount || 0,
      summaryUsableReturnEdges: graph?.summaryUsableReturnEdgeCount || 0,
      summaryRejectedReturnEdges: graph?.summaryRejectedReturnEdgeCount || 0,
      missingCallEdgeReturnEdges: graph?.missingCallEdgeReturnEdgeCount || 0,
      missingCallTargetReturnEdges: graph?.missingCallTargetReturnEdgeCount || 0,
      returnEdgeSummaryRejectReasons: graph?.returnEdgeSummaryRejectReasons || emptySummaryReturnRejectReasons(),
      returnEdgeSummaryStackRejectReasons: graph?.returnEdgeSummaryStackRejectReasons || emptySummaryReturnStackRejectReasons(),
      returnEdgeSummaryNoNormalRejectReasons: graph?.returnEdgeSummaryNoNormalRejectReasons || emptySummaryReturnNoNormalRejectReasons(),
      returnEdgeSummaryNotAlwaysRejectReasons: graph?.returnEdgeSummaryNotAlwaysRejectReasons || emptySummaryReturnNotAlwaysRejectReasons(),
      returnEdgeSummaryIndirectRejectReasons: graph?.returnEdgeSummaryIndirectRejectReasons || emptyDirectTransitiveReasons('direct'),
      returnEdgeSummaryUnknownCallRejectReasons: graph?.returnEdgeSummaryUnknownCallRejectReasons || emptyDirectTransitiveReasons('local'),
      returnEdgeSummaryUnknownReturnRejectReasons: graph?.returnEdgeSummaryUnknownReturnRejectReasons || emptyDirectTransitiveReasons('local'),
      returnEdgeSummaryRejectedDistinctCalleeCount: graph?.returnEdgeSummaryRejectedDistinctCalleeCount || 0,
      returnEdgeSummaryTopRejectSources: graph?.returnEdgeSummaryTopRejectSources || [],
      summarizedCallReturns: graph?.summarizedCallReturnCount || 0,
      unsummarizedCallReturns: graph?.unsummarizedCallReturnCount || 0,
      deferredJsrFallthroughs: graph?.deferredJsrFallthroughCount || 0,
      rejectedSummaryNoRtsFallback: graph?.rejectedSummaryNoRtsFallbackCount || 0,
      summaryReturnRejectReasons: graph?.summaryReturnRejectReasons || emptySummaryReturnRejectReasons(),
      summaryReturnStackRejectReasons: graph?.summaryReturnStackRejectReasons || emptySummaryReturnStackRejectReasons(),
      summaryReturnNoNormalRejectReasons: graph?.summaryReturnNoNormalRejectReasons || emptySummaryReturnNoNormalRejectReasons(),
      summaryReturnNoLocalRtsDetails: graph?.summaryReturnNoLocalRtsDetails || emptySummaryReturnNoLocalRtsDetails(),
      summaryReturnNotAlwaysRejectReasons: graph?.summaryReturnNotAlwaysRejectReasons || emptySummaryReturnNotAlwaysRejectReasons(),
      resolvedIndirectJumps: indirect.counters.resolved,
      resolvedIndirectJumpSeeds: indirect.counters.addedSeeds,
      expandCfgFrontiers: expandCfg.counters.frontiersAdded,
      rtsTrickDispatches: rtsTricks.counters.pairedPointerTables,
      rtsTrickEntriesResolved: rtsTricks.counters.entriesResolved,
      rtsTrickSeeds: rtsTricks.counters.seedsAdded,
      rtsTrickSyntheticEdges: rtsTricks.counters.syntheticEdgesAdded
    };
    context.abstractInterpretation = result;
    context.abstractInterpretationCache = createAbstractInterpretationCache({
      graph,
      topology,
      signatures,
      optionsSignature,
      result
    });
    context.diagnostics.phaseSummaries.push({
      name: ANALYSIS_PHASE_IDS.ABSTRACT_INTERPRETATION,
      status: 'complete',
      counters: context.abstractInterpretation.counters
    });
  }

  return {
    name: ANALYSIS_PHASE_IDS.ABSTRACT_INTERPRETATION,
    stepOne() {
      if (!walker) initialize();
      const result = walker.stepOne();
      if (result.status === 'complete') finish();
      return { ...result, phase: ANALYSIS_PHASE_IDS.ABSTRACT_INTERPRETATION, progress: this.progress() };
    },
    progress() {
      return walker ? walker.progress() : { phase: ANALYSIS_PHASE_IDS.ABSTRACT_INTERPRETATION, graphKind };
    }
  };
}
