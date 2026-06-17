import { ANALYSIS_PHASE_IDS } from '../analysisConstants.js';
import { requireObject } from '../dataShape.js';
import { discoverLoopCandidates } from './loopCandidates.js';
import { buildLoopRecognizerIndexes, summarizeCounterLoopCandidate } from './counterLoopRecognizer.js';

function makeCounters(graphKind, maxDepth) {
  return {
    graphKind,
    maxDepth,
    candidateLoopCount: 0,
    summarizedLoopCount: 0,
    constantCounterLoopCount: 0,
    parametricCounterLoopCount: 0,
    parametricInitializerCount: 0,
    bailedLoopCount: 0,
    maxDepthObserved: 0,
    depthCapBails: 0,
    unsupportedShapeBails: 0,
    unknownInitializerBails: 0,
    ambiguousEntryBails: 0,
    ambiguousBackedgeBails: 0,
    counterClobberBails: 0,
    childLoopBails: 0,
    mapperWriteBails: 0,
    callBails: 0,
    wrappingBails: 0,
    unsupportedBranchPredicateBails: 0,
    unsupportedFlagSourceBails: 0,
    unsupportedPredicateBails: 0,
    noCounterUpdateBails: 0
  };
}

function incrementBailCounter(counters, reason) {
  counters.bailedLoopCount += 1;
  if (reason === 'depthCap') counters.depthCapBails += 1;
  else if (reason === 'unknownInitializer') counters.unknownInitializerBails += 1;
  else if (reason === 'ambiguousEntry') counters.ambiguousEntryBails += 1;
  else if (reason === 'ambiguousBackedge') counters.ambiguousBackedgeBails += 1;
  else if (reason === 'counterClobber' || reason === 'childClobbersCounter') counters.counterClobberBails += 1;
  else if (reason === 'childLoopBail') counters.childLoopBails += 1;
  else if (reason === 'mapperWriteInLoop' || reason === 'mapperWriteInChildLoop') counters.mapperWriteBails += 1;
  else if (reason === 'callInLoop') counters.callBails += 1;
  else if (reason === 'unsupportedBranchPredicate' || reason === 'ambiguousTailBranch') counters.unsupportedBranchPredicateBails += 1;
  else if (reason === 'unsupportedFlagSource') counters.unsupportedFlagSourceBails += 1;
  else if (reason === 'unsupportedPredicateForUpdate' || reason === 'unsupportedPredicateForCompare') counters.unsupportedPredicateBails += 1;
  else if (reason === 'noCounterUpdate') counters.noCounterUpdateBails += 1;
  else if (String(reason || '').includes('Wrapping') || String(reason || '').includes('wraparound') || String(reason || '').includes('OneTrip') || reason === 'oneTripOrEmptyLoop') counters.wrappingBails += 1;
  else counters.unsupportedShapeBails += 1;
}

function buildSummaryIndexes(summaries) {
  return {
    byHeaderBlockInstanceId: new Map(summaries.map((summary) => [summary.headerBlockInstanceId, summary])),
    byReentryEdgeKey: new Map(summaries.map((summary) => [summary.reentryEdgeKey, summary])),
    byExitEdgeKey: new Map(summaries.filter((summary) => summary.exitEdgeKey).map((summary) => [summary.exitEdgeKey, summary])),
    byLoopId: new Map(summaries.map((summary) => [summary.loopId, summary]))
  };
}

export function createLoopSummarizationPhase(context, options = null) {
  const opts = options === null || options === undefined ? {} : requireObject(options, 'loopSummarization options');
  const graphKind = typeof opts.graphKind === 'string' ? opts.graphKind : 'exactOnly';
  const maxDepth = Number.isFinite(opts.maxDepth) ? Math.max(1, opts.maxDepth | 0) : 3;

  return {
    name: ANALYSIS_PHASE_IDS.LOOP_SUMMARIZATION,
    stepOne() {
      const topology = requireObject(context.cfgTopology, 'loopSummarization cfgTopology');
      if (topology.graphKind !== graphKind) {
        throw new Error(`loopSummarization graphKind ${graphKind} does not match cfgTopology graphKind ${topology.graphKind}`);
      }

      const counters = makeCounters(graphKind, maxDepth);
      const candidates = discoverLoopCandidates({ topology, edges: context.edges });
      const candidateById = new Map(candidates.map((candidate) => [candidate.loopId, candidate]));
      const indexes = buildLoopRecognizerIndexes(context);
      const summaries = [];
      const summaryByLoopId = new Map();

      counters.candidateLoopCount = candidates.length;
      counters.maxDepthObserved = candidates.reduce((max, candidate) => Math.max(max, candidate.depth || 0), 0);

      const ordered = [...candidates].sort((a, b) => (b.depth || 0) - (a.depth || 0) || a.bodyBlockInstanceIds.length - b.bodyBlockInstanceIds.length || a.loopId.localeCompare(b.loopId));
      for (const candidate of ordered) {
        if ((candidate.depth || 1) > maxDepth) {
          candidate.bailedReason = 'depthCap';
          incrementBailCounter(counters, candidate.bailedReason);
          continue;
        }
        const result = summarizeCounterLoopCandidate({
          candidate,
          context,
          indexes,
          candidateById,
          childSummaryByLoopId: summaryByLoopId
        });
        if (!result.ok) {
          candidate.bailedReason = result.reason || 'unsupportedShape';
          incrementBailCounter(counters, candidate.bailedReason);
          continue;
        }
        summaries.push(result.summary);
        if (result.summary.counter?.initialSource?.kind === 'entryRamByte') {
          counters.parametricCounterLoopCount += 1;
          counters.parametricInitializerCount += 1;
        } else {
          counters.constantCounterLoopCount += 1;
        }
        summaryByLoopId.set(result.summary.loopId, result.summary);
      }

      counters.summarizedLoopCount = summaries.length;
      console.log(`[analyze2] loopSummarization summarized ${counters.summarizedLoopCount} of ${counters.candidateLoopCount} candidate loops`);
      const summaryIndexes = buildSummaryIndexes(summaries);
      context.loopSummaries = {
        producedBy: ANALYSIS_PHASE_IDS.LOOP_SUMMARIZATION,
        graphKind,
        maxDepth,
        summaries,
        byHeaderBlockInstanceId: summaryIndexes.byHeaderBlockInstanceId,
        byReentryEdgeKey: summaryIndexes.byReentryEdgeKey,
        byExitEdgeKey: summaryIndexes.byExitEdgeKey,
        byLoopId: summaryIndexes.byLoopId,
        counters
      };
      context.diagnostics.phaseSummaries.push({
        name: ANALYSIS_PHASE_IDS.LOOP_SUMMARIZATION,
        status: 'complete',
        counters: { ...counters }
      });
      return { status: 'complete' };
    },
    progress() {
      const counters = context.loopSummaries ? context.loopSummaries.counters : null;
      return { phase: ANALYSIS_PHASE_IDS.LOOP_SUMMARIZATION, graphKind, ...(counters || {}) };
    }
  };
}
