import { hex4 } from '../../cpu6502/fmt.js';
import { extractJumpTableSignals } from './jumpTableSignals.js';
import { scoreJumpTableSignals } from './jumpTableScoring.js';

// Jump-table recognition: look for indirect JMP sites where the pointer bytes were loaded from ROM
// via an indexed addressing shape (a classic dispatch-table pattern). 🤖
//
// This module:
// 1) extracts deterministic "signals" from VSA provenance at each site
// 2) classifies them into decoded vs candidate via a centralized scoring engine
// 3) emits artifacts + (only when decoded) synthetic CFG edges. 🤖

export function recognizeJumpTables({ prgBytes, mapper, unresolvedSites, siteStatesByPc }) {
  const artifacts = [];
  const newEntrypoints = new Set();
  const syntheticEdges = [];

  for (const site of unresolvedSites) {
    const pc = site.pc & 0xffff;
    const s = siteStatesByPc.get(pc);

    const signals = extractJumpTableSignals({ prgBytes, mapper, site, state: s, enumCap: 32 });
    const scored = scoreJumpTableSignals(signals);
    if (!scored.shouldEmit) continue;

    // Build an artifact that always shows what we found, even if we couldn't decode concrete targets. 🤖
    const id = `jt:${hex4(pc)}`;
    const targets = signals.targets || [];

    artifacts.push({
      id,
      kind: 'jumpTable',
      status: scored.status, // 'decoded' | 'candidate' 🤖
      confidence: scored.confidence, // 'certain' | 'probable' | 'weak' 🤖
      score: scored.score,
      sitePc: pc,
      siteBlockId: site.blockId,
      ptrAddr: signals.ptrAddr,
      indexSource: signals.indexSource,
      shape: signals.shape,
      tableBaseLo: signals.baseLo,
      tableBaseHi: signals.baseHi,
      indexSummary: signals.idxInfo?.summary ?? 'unknown',
      decodeBlockedBy: signals.decodeBlockedBy || [],
      evidence: {
        lo: signals.evidence?.lo ?? '—',
        hi: signals.evidence?.hi ?? '—',
        rules: scored.evidence
      },
      targets
    });

    // Only create synthetic CFG edges and new entrypoints when we have concrete, mappable targets. 🤖
    if (scored.status === 'decoded') {
      for (const t of targets) {
        if (t.targetRomOff != null) newEntrypoints.add(t.targetCpu & 0xffff);
        if (!t.targetBlockId) continue;
        syntheticEdges.push({ from: site.blockId, to: t.targetBlockId, kind: 'jump_table' });
      }
    }
  }

  return {
    artifacts,
    newEntrypointsCpuAddrs: Array.from(newEntrypoints),
    syntheticEdges
  };
}
