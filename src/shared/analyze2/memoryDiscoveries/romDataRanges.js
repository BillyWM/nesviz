function numericRange(startValue, endExclusiveValue, limitValue) {
  const start = Number(startValue);
  const endExclusive = Number(endExclusiveValue);
  const limit = Number(limitValue);
  if (!Number.isInteger(start) || !Number.isInteger(endExclusive) || !Number.isInteger(limit)) return null;
  if (limit <= 0) return null;
  const clampedStart = Math.max(0, Math.min(limit, start));
  const clampedEnd = Math.max(0, Math.min(limit, endExclusive));
  if (clampedEnd <= clampedStart) return null;
  return { start: clampedStart >>> 0, end: clampedEnd >>> 0 };
}

export function mergeRanges(ranges) {
  const sorted = (Array.isArray(ranges) ? ranges : [])
    .map((range) => {
      const start = Number(range?.start);
      const end = Number(range?.end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;
      return { start: start >>> 0, end: end >>> 0 };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out = [];
  for (const range of sorted) {
    const last = out[out.length - 1] || null;
    if (last && range.start <= last.end) {
      if (range.end > last.end) last.end = range.end;
      continue;
    }
    out.push({ ...range });
  }
  return out;
}

export function subtractRanges(ranges, blockers) {
  const source = mergeRanges(ranges);
  const blockRanges = mergeRanges(blockers);
  const out = [];

  for (const range of source) {
    let cursor = range.start;
    for (const blocker of blockRanges) {
      if (blocker.end <= cursor) continue;
      if (blocker.start >= range.end) break;
      if (blocker.start > cursor) out.push({ start: cursor, end: Math.min(blocker.start, range.end) });
      cursor = Math.max(cursor, blocker.end);
      if (cursor >= range.end) break;
    }
    if (cursor < range.end) out.push({ start: cursor, end: range.end });
  }

  return out;
}

export function countRangeBytes(ranges) {
  return mergeRanges(ranges).reduce((total, range) => total + Math.max(0, range.end - range.start), 0);
}

export function extractRomReadDataRanges(memoryDiscoveries, prgSize) {
  const limit = Number(prgSize);
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const groups = Array.isArray(memoryDiscoveries?.groups) ? memoryDiscoveries.groups : [];
  const ranges = [];

  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    if (group.space !== 'rom') continue;
    if (group.access !== 'read') continue;
    const spans = Array.isArray(group.spans) ? group.spans : [];
    for (const span of spans) {
      const start = Number(span?.start);
      const inclusiveEnd = Number(span?.end);
      if (!Number.isInteger(start) || !Number.isInteger(inclusiveEnd)) continue;
      const range = numericRange(start, inclusiveEnd + 1, limit);
      if (range) ranges.push(range);
    }
  }

  return mergeRanges(ranges);
}
