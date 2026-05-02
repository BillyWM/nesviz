import { extractJumpTableSignals } from './jumpTableSignals.js';
import { scoreJumpTableSignals } from './jumpTableScoring.js';

// Jump-table recognition: look for indirect JMP sites where the pointer bytes were loaded from ROM
// via an indexed addressing shape (a classic dispatch-table pattern). 🤖
//
// This module:
// 1) extracts deterministic "signals" from VSA provenance at each site
// 2) classifies them into decoded vs candidate via a centralized scoring engine
// 3) emits artifacts + (only when decoded) synthetic CFG edges. 🤖

export function recognizeJumpTables({ prgBytes, mapper, unresolvedSites, siteStatesBySiteKey, blocksByStartSite = null }) {
  const artifacts = [];
  const newSeedItems = [];
  const syntheticEdges = [];
  const seenSiteRomOffs = new Set();

  for (const site of unresolvedSites) {
    if (site?.kind !== 'jmp_ind') continue;
    if (!Number.isFinite(site.romOff)) continue;

    const siteRomOff = site.romOff | 0;
    if (seenSiteRomOffs.has(siteRomOff)) continue;
    seenSiteRomOffs.add(siteRomOff);

    const pc = site.pc & 0xffff;
    const s = site?.siteKey ? siteStatesBySiteKey?.get(String(site.siteKey)) : null;

    const signals = extractJumpTableSignals({ prgBytes, mapper, site, state: s, enumCap: 32 });
    const scored = scoreJumpTableSignals(signals);
    if (!scored.shouldEmit) continue;

    // Jump-table artifacts are physical ROM observations. Identity and navigation use the exact site ROM offset.
    const id = `jt:${siteRomOff}`;
    const targets = signals.targets || [];

    artifacts.push({
      id,
      kind: 'jumpTable',
      status: scored.status, // 'decoded' | 'candidate' 🤖
      confidence: scored.confidence, // 'certain' | 'probable' | 'weak' 🤖
      score: scored.score,
      sitePc: pc,
      siteRomOff,
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
        const activeCtx = site.fetchCtx || mapper.initialFetchCtx();
        const resolvedTargets = mapper.targetSitesForCpuAddr
          ? mapper.targetSitesForCpuAddr(activeCtx, t.targetCpu & 0xffff, { maxForks: 4 })
          : { sites: [{ cpuAddr: t.targetCpu & 0xffff, fetchCtx: activeCtx }], ambiguous: false };
        if (resolvedTargets?.sites?.length && !resolvedTargets.ambiguous) {
          for (const seed of resolvedTargets.sites) {
            if (typeof seed?.cpuAddr !== 'number' || !seed.fetchCtx) continue;
            newSeedItems.push({ cpuAddr: seed.cpuAddr & 0xffff, fetchCtx: seed.fetchCtx, confidence: 'certain' });
          }
        }
        if (!blocksByStartSite) continue;
        for (const seed of resolvedTargets?.sites || []) {
          const ctxKey = mapper.fetchCtxKey ? mapper.fetchCtxKey(seed.fetchCtx) : (seed.fetchCtx?.key || 'default');
          const siteKey = `${ctxKey}:${(seed.cpuAddr & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
          const toId = blocksByStartSite.get(siteKey) || null;
          if (toId) syntheticEdges.push({ from: site.rawBlockId, to: toId, kind: 'jump_table' });
        }
      }
    }
  }

  return {
    artifacts,
    newSeedItems,
    syntheticEdges
  };
}
