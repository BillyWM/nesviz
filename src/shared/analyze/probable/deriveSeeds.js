// Convert kept "probable code" chunks (physical PRG offsets) into contextual entrypoints for CFG discovery.

export function deriveProbableSeedItems({ keptChunks, mapper, maxChunks }) {
  const lim = typeof maxChunks === 'number' ? Math.max(0, maxChunks | 0) : keptChunks.length;
  const seeds = [];
  const seen = new Set();

  for (let i = 0; i < keptChunks.length && i < lim; i++) {
    const k = keptChunks[i];
    const romStart = k?.romStart;
    if (typeof romStart !== 'number') continue;
    const sites = mapper.seedSitesForRomOff ? mapper.seedSitesForRomOff(romStart) : [];
    for (const site of sites) {
      if (!site || typeof site.cpuAddr !== 'number') continue;
      const ctxKey = mapper.fetchCtxKey ? mapper.fetchCtxKey(site.fetchCtx) : 'nrom:fixed';
      const key = `${ctxKey}:${site.cpuAddr & 0xffff}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seeds.push({ cpuAddr: site.cpuAddr & 0xffff, fetchCtx: site.fetchCtx, confidence: 'probable' });
    }
  }

  return seeds;
}
