import { runVsaEngine } from './engine.js';

export async function runVsaFacts({
  prgBytes,
  mapper,
  blocks,
  edges,
  entryBlockIds,
  blockContextIndex = null,
  yieldEveryMs = 0,
  onProgress = null,
  progressEveryMs = 0
}) {
  const allZp = new Set();
  for (let i = 0; i < 0x100; i++) allZp.add(i);

  const engine = await runVsaEngine({
    prgBytes,
    mapper,
    blocks,
    edges,
    entryBlockIds,
    trackedZpAddrs: allZp,
    trackRam: true,
    strictBranchAdjacencyFacts: true,
    collectObservations: true,
    blockContextIndex,
    yieldEveryMs,
    onProgress,
    progressEveryMs
  });

  return engine.observations;
}

export async function runVsaObservations(args) {
  return runVsaFacts(args);
}
