import { cloneState } from './state.js';
import { runVsaEngine } from './engine.js';

export async function runVsa({
  prgBytes,
  mapper,
  blocks,
  edges,
  entryBlockIds,
  unresolvedSites,
  yieldEveryMs = 0,
  onProgress = null,
  progressEveryMs = 0
}) {
  const trackedZp = new Set();
  for (const s of unresolvedSites || []) {
    const ptr = s.ptrAddr & 0xffff;
    if (ptr <= 0x00ff) {
      trackedZp.add(ptr & 0xff);
      trackedZp.add((ptr + 1) & 0xff);
    }
  }

  const siteStatesBySiteKey = new Map();
  const hooks = {
    onInstructionStart({ line, state }) {
      if (line?.flow?.type === 'jmp_ind') {
        const snap = cloneState(state);
        if (line.siteKey) siteStatesBySiteKey.set(String(line.siteKey), snap);
      }
    }
  };

  const engine = await runVsaEngine({
    prgBytes,
    mapper,
    blocks,
    edges,
    entryBlockIds,
    trackedZpAddrs: trackedZp,
    trackRam: false,
    strictBranchAdjacencyFacts: true,
    hooks,
    yieldEveryMs,
    onProgress,
    progressEveryMs
  });

  return {
    siteStatesBySiteKey,
    inStatesByRawBlockId: engine.inStatesByRawBlockId
  };
}
