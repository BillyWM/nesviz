import { ANALYSIS_PHASE_IDS } from '../analysisConstants.js';
import { requireArray, requireObject } from '../dataShape.js';
import { buildGraphTopology } from './graphTopology.js';

function buildExactOnlyGraph(context) {
  requireObject(context, 'cfgTopology context');
  return {
    graphKind: 'exactOnly',
    seedSites: requireArray(context.seedSites, 'cfgTopology seedSites'),
    blocks: requireArray(context.blocks, 'cfgTopology blocks'),
    blockInstances: requireArray(context.blockInstances, 'cfgTopology blockInstances'),
    instructionExecutions: requireArray(context.instructionExecutions, 'cfgTopology instructionExecutions'),
    edges: typeof context.edgesForGraph === 'function' ? context.edgesForGraph() : requireArray(context.edges, 'cfgTopology edges')
  };
}

export function createCfgTopologyPhase(context, options = null) {
  const opts = options === null || options === undefined ? {} : requireObject(options, 'cfgTopology options');
  const graphKind = typeof opts.graphKind === 'string' ? opts.graphKind : 'exactOnly';

  return {
    name: ANALYSIS_PHASE_IDS.CFG_TOPOLOGY,
    stepOne() {
      if (graphKind !== 'exactOnly') throw new Error(`Unsupported cfgTopology graphKind: ${graphKind}`);
      const topology = buildGraphTopology(buildExactOnlyGraph(context));
      context.cfgTopology = topology;
      context.diagnostics.phaseSummaries.push({
        name: ANALYSIS_PHASE_IDS.CFG_TOPOLOGY,
        status: 'complete',
        counters: { ...topology.counters }
      });
      return { status: 'complete' };
    },
    progress() {
      const counters = context.cfgTopology ? context.cfgTopology.counters : null;
      return { phase: ANALYSIS_PHASE_IDS.CFG_TOPOLOGY, graphKind, ...(counters || {}) };
    }
  };
}
