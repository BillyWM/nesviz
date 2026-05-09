import { cloneState } from './state.js';
import { runVsaEngine } from './engine.js';
import { buildIndirectControlFacts } from './indirectControlFacts.js';

export async function runVsaFacts({
  prgBytes,
  mapper,
  blocks,
  edges,
  entryBlockIds,
  unresolvedSites = [],
  blockContextIndex = null,
  yieldEveryMs = 0,
  onProgress = null,
  progressEveryMs = 0
}) {
  const allZp = new Set();
  for (let i = 0; i < 0x100; i++) allZp.add(i);

  const blockRolesByRawBlockId = new Map();
  for (const block of blocks || []) {
    const role = block?.vsaRole === 'candidate' || block?.confidence === 'probable' ? 'candidate' : 'confirmed';
    if (typeof block?.id === 'string') blockRolesByRawBlockId.set(block.id, role);
    for (const rawId of block?.rawBlockIds || []) {
      if (typeof rawId === 'string') blockRolesByRawBlockId.set(rawId, role);
    }
  }

  const siteStatesBySiteKey = new Map();
  const hooks = {
    onInstructionStart({ line, state }) {
      if (line?.flow?.type !== 'jmp_ind') return;
      if (!line.siteKey) return;
      siteStatesBySiteKey.set(String(line.siteKey), cloneState(state));
    }
  };

  const engine = await runVsaEngine({
    prgBytes,
    mapper,
    blocks,
    edges,
    entryBlockIds,
    blockRolesByRawBlockId,
    trackedZpAddrs: allZp,
    trackRam: true,
    strictBranchAdjacencyFacts: true,
    collectObservations: true,
    blockContextIndex,
    hooks,
    yieldEveryMs,
    onProgress,
    progressEveryMs
  });

  const observations = engine.observations;
  observations.candidateControlFlowFacts = buildIndirectControlFacts({
    mapper,
    blocks,
    unresolvedSites,
    siteStatesBySiteKey,
    blockRolesByRawBlockId
  });

  return observations;
}

export async function runVsaObservations(args) {
  return runVsaFacts(args);
}
