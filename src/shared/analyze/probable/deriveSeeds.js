// Convert kept candidate-code chunks (physical PRG offsets) into contextual entrypoints for CFG discovery.

import { UNKNOWN_FETCH_CTX_KEY } from '../fetchContext.js';
import { compactProbableScore } from './promotionDebug.js';

function candidateReasonForChunk(chunk, source) {
  const c = chunk?.chunk || null;
  return {
    kind: 'candidate_seed',
    source: typeof source === 'string' && source ? source : 'globalScan',
    romStart: typeof chunk?.romStart === 'number' ? (chunk.romStart >>> 0) : null,
    romEnd: typeof chunk?.romEnd === 'number' ? (chunk.romEnd >>> 0) : null,
    decodedBytes: typeof chunk?.score?.decodedBytes === 'number' ? (chunk.score.decodedBytes | 0) : (typeof c?.decodedBytes === 'number' ? (c.decodedBytes | 0) : null),
    terminatorMnemonic: typeof c?.terminatorMnemonic === 'string' ? c.terminatorMnemonic : null,
    endsOnTerminator: !!c?.endsOnTerminator,
    rangeStart: typeof chunk?.rangeStart === 'number' ? (chunk.rangeStart >>> 0) : null,
    rangeEnd: typeof chunk?.rangeEnd === 'number' ? (chunk.rangeEnd >>> 0) : null,
    scoreSummary: compactProbableScore(chunk?.score || null)
  };
}

export function deriveProbableSeedItems({ keptChunks, mapper, maxChunks, source = 'globalScan' }) {
  const lim = typeof maxChunks === 'number' ? Math.max(0, maxChunks | 0) : keptChunks.length;
  const seeds = [];
  const seen = new Set();

  for (let i = 0; i < keptChunks.length && i < lim; i++) {
    const k = keptChunks[i];
    const romStart = k?.romStart;
    if (typeof romStart !== 'number') continue;
    const leaderReason = candidateReasonForChunk(k, source);
    const sites = mapper.seedSitesForRomOff ? mapper.seedSitesForRomOff(romStart) : [];
    for (const site of sites) {
      if (!site || typeof site.cpuAddr !== 'number') continue;
      const ctxKey = mapper.fetchCtxKey ? mapper.fetchCtxKey(site.fetchCtx) : UNKNOWN_FETCH_CTX_KEY;
      const key = `${ctxKey}:${site.cpuAddr & 0xffff}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seeds.push({
        cpuAddr: site.cpuAddr & 0xffff,
        fetchCtx: site.fetchCtx,
        confidence: 'probable',
        leaderKind: 'soft',
        leaderReason
      });
    }
  }

  return seeds;
}
