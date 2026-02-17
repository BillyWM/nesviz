// Convert kept "probable code" chunks (physical PRG offsets) into CPU entrypoints for CFG discovery. 🤖
// We intentionally keep this logic mapper-aware: the mapper decides which CPU addresses could correspond to a PRG offset. 🤖

export function deriveProbableSeedItems({ keptChunks, mapper, maxChunks }) {
  const lim = typeof maxChunks === 'number' ? Math.max(0, maxChunks | 0) : keptChunks.length;
  const seeds = [];
  const seen = new Set();

  for (let i = 0; i < keptChunks.length && seeds.length < lim * 2; i++) {
    if (i >= lim) break;
    const k = keptChunks[i];
    const romStart = k?.romStart;
    if (typeof romStart !== 'number') continue;

    // For NROM-16KiB we will get two mirrored CPU addresses; for NROM-32KiB we get one. 🤖
    const cpuAddrs = mapper.romOffToCpuAddrs(romStart);
    for (const cpuAddr of cpuAddrs) {
      const a = cpuAddr & 0xffff;
      const key = a;
      if (seen.has(key)) continue;
      seen.add(key);
      seeds.push({ cpuAddr: a, confidence: 'probable' });
    }
  }

  return seeds;
}
