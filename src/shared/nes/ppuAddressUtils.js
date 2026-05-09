export function normalizePpuAddr(addr) {
  if (!Number.isFinite(addr)) return null;
  return addr & 0x3fff;
}

export function normalizePpuNametableMirror(addr) {
  const normalized = normalizePpuAddr(addr);
  if (normalized == null) return null;
  if (normalized >= 0x3000 && normalized <= 0x3eff) return normalized - 0x1000;
  return normalized;
}

export function normalizePpuPaletteMirror(addr) {
  const normalized = normalizePpuAddr(addr);
  if (normalized == null) return null;
  if (normalized < 0x3f00) return normalized;
  return 0x3f00 + ((normalized - 0x3f00) & 0x1f);
}

export function classifyPpuDataDestination(addr) {
  const normalized = normalizePpuAddr(addr);
  if (normalized == null) return { class: 'unknown', normalizedAddr: null };

  if (normalized >= 0x3f00) {
    return {
      class: 'palettes',
      normalizedAddr: normalizePpuPaletteMirror(normalized)
    };
  }

  const nametableAddr = normalizePpuNametableMirror(normalized);
  if (nametableAddr != null && nametableAddr >= 0x2000 && nametableAddr <= 0x2fff) {
    const pageOffset = nametableAddr & 0x03ff;
    if (pageOffset >= 0x03c0 && pageOffset <= 0x03ff) {
      return { class: 'attributes', normalizedAddr: nametableAddr };
    }
  }

  return { class: 'unknown', normalizedAddr: nametableAddr };
}

export function classifyPpuDataDestinations(addrs) {
  const candidates = Array.isArray(addrs)
    ? Array.from(new Set(addrs
        .map((addr) => (typeof addr === 'number' ? addr : Number(addr)))
        .filter((addr) => Number.isFinite(addr))
        .map((addr) => addr & 0x3fff)))
        .sort((a, b) => a - b)
    : [];

  if (!candidates.length) {
    return { class: 'unknown', candidates: [], normalizedCandidates: [] };
  }

  const normalizedCandidates = [];
  let currentClass = null;
  for (const candidate of candidates) {
    const classified = classifyPpuDataDestination(candidate);
    if (classified.class === 'unknown') {
      return { class: 'unknown', candidates, normalizedCandidates };
    }
    if (currentClass == null) currentClass = classified.class;
    if (currentClass !== classified.class) {
      return { class: 'unknown', candidates, normalizedCandidates };
    }
    if (typeof classified.normalizedAddr === 'number') normalizedCandidates.push(classified.normalizedAddr & 0x3fff);
  }

  return {
    class: currentClass || 'unknown',
    candidates,
    normalizedCandidates: Array.from(new Set(normalizedCandidates)).sort((a, b) => a - b)
  };
}
