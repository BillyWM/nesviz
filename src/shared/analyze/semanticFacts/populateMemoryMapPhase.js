import {
  ANALYSIS_PHASE_IDS,
  ANALYSIS_PROGRESS_DETAIL_KINDS
} from '../analysisConstants.js';
import { requireArray, requireObject } from '../dataShape.js';
import { createMemoryAccessCollector } from './memoryAccessCollector.js';
import { createMemoryMapAggregator } from './memoryMapAggregation.js';

const POPULATE_MEMORY_MAP_STEP_MS = 8;
const POPULATE_MEMORY_MAP_PROGRESS_INTERVAL_MS = 100;

function buildGraph(context) {
  return {
    graphKind: 'exactOnly',
    mapper: requireObject(context.mapper, 'populateMemoryMap mapper'),
    prgBytes: context.prgBytes,
    contexts: requireObject(context.contexts, 'populateMemoryMap contexts'),
    instructions: requireArray(context.instructions, 'populateMemoryMap instructions'),
    blocks: requireArray(context.blocks, 'populateMemoryMap blocks'),
    blockInstances: requireArray(context.blockInstances, 'populateMemoryMap blockInstances'),
    instructionExecutions: requireArray(context.instructionExecutions, 'populateMemoryMap instructionExecutions'),
    edges: typeof context.edgesForGraph === 'function'
      ? context.edgesForGraph()
      : requireArray(context.edges, 'populateMemoryMap edges'),
    cfgTopology: context.cfgTopology || null,
    loopSummaries: context.loopSummaries || null,
    loopDetections: context.loopDetections || null,
    abstractInterpretation: requireObject(context.abstractInterpretation, 'populateMemoryMap abstractInterpretation')
  };
}

function mergeDetails(collectorProgress, aggregatorProgress, finalCounters) {
  const collector = collectorProgress && typeof collectorProgress === 'object' ? collectorProgress : {};
  const aggregator = aggregatorProgress && typeof aggregatorProgress === 'object' ? aggregatorProgress : {};
  const final = finalCounters && typeof finalCounters === 'object' ? finalCounters : {};
  return {
    ...collector,
    ...aggregator,
    ...final
  };
}

export function createPopulateMemoryMapPhase(context, options = {}) {
  const phaseOptions = options && typeof options === 'object' ? options : {};
  const stepMilliseconds = Number.isFinite(phaseOptions.stepMilliseconds) && phaseOptions.stepMilliseconds > 0
    ? phaseOptions.stepMilliseconds
    : POPULATE_MEMORY_MAP_STEP_MS;

  let graph = null;
  let collector = null;
  let aggregator = null;
  let collected = null;
  let memoryDiscoveries = null;
  let complete = false;
  let stage = 'setup';
  let lastProgressNowAt = 0;

  function shouldPostProgressNow(force = false) {
    const now = Date.now();
    if (!force && now - lastProgressNowAt < POPULATE_MEMORY_MAP_PROGRESS_INTERVAL_MS) return false;
    lastProgressNowAt = now;
    return true;
  }

  function ensureCollector() {
    if (collector) return collector;
    graph = buildGraph(context);
    collector = createMemoryAccessCollector(graph, phaseOptions);
    stage = 'collectAccessFacts';
    return collector;
  }

  function ensureAggregator() {
    if (aggregator) return aggregator;
    if (!collected) collected = ensureCollector().result();
    aggregator = createMemoryMapAggregator({
      facts: collected.facts,
      counters: collected.counters,
      context
    });
    stage = 'aggregateMemoryMap';
    return aggregator;
  }

  function finalize() {
    if (complete) return;
    if (!memoryDiscoveries) memoryDiscoveries = ensureAggregator().result();
    context.memoryDiscoveries = memoryDiscoveries;
    context.diagnostics.phaseSummaries.push({
      name: ANALYSIS_PHASE_IDS.POPULATE_MEMORY_MAP,
      status: 'complete',
      counters: { ...memoryDiscoveries.counters }
    });
    stage = 'complete';
    complete = true;
  }

  function currentDetails() {
    const collectorProgress = collector ? collector.progress() : {};
    const aggregatorProgress = aggregator ? aggregator.progress() : {};
    const finalCounters = memoryDiscoveries ? memoryDiscoveries.counters : null;
    const details = mergeDetails(collectorProgress, aggregatorProgress, finalCounters);
    return {
      ...details,
      stage
    };
  }

  return {
    name: ANALYSIS_PHASE_IDS.POPULATE_MEMORY_MAP,
    stepOne() {
      if (complete) return { status: 'complete', progress: this.progress() };

      if (stage === 'setup' || stage === 'collectAccessFacts') {
        const currentCollector = ensureCollector();
        const step = currentCollector.step(stepMilliseconds);
        context.memoryDiscoveries = {
          groups: [],
          rangeAnnotations: [],
          oamDmaTransfers: [],
          accessFacts: currentCollector.result().facts,
          counters: currentCollector.progress()
        };
        if (step.status !== 'complete') {
          return {
            status: 'running',
            phase: ANALYSIS_PHASE_IDS.POPULATE_MEMORY_MAP,
            progressNow: shouldPostProgressNow(false)
          };
        }
        collected = currentCollector.result();
        stage = 'aggregateMemoryMap';
      }

      if (stage === 'aggregateMemoryMap') {
        const currentAggregator = ensureAggregator();
        const step = currentAggregator.step(stepMilliseconds);
        if (step.status !== 'complete') {
          return {
            status: 'running',
            phase: ANALYSIS_PHASE_IDS.POPULATE_MEMORY_MAP,
            progressNow: shouldPostProgressNow(false)
          };
        }
        memoryDiscoveries = currentAggregator.result();
      }

      finalize();
      shouldPostProgressNow(true);
      return { status: 'complete', progress: this.progress() };
    },
    progress() {
      const details = currentDetails();
      return {
        phase: ANALYSIS_PHASE_IDS.POPULATE_MEMORY_MAP,
        ...details,
        detailKind: ANALYSIS_PROGRESS_DETAIL_KINDS.POPULATE_MEMORY_MAP,
        details
      };
    }
  };
}
