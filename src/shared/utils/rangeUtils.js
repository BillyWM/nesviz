export function coalesceOccupiedRanges(bits, start = 0, end = bits?.length || 0) {
  const ranges = [];
  let idx = Math.max(0, start | 0);
  const limit = Math.max(idx, Math.min(bits?.length || 0, end | 0));
  while (idx < limit) {
    while (idx < limit && !bits[idx]) idx++;
    if (idx >= limit) break;
    const rangeStart = idx;
    idx++;
    while (idx < limit && bits[idx]) idx++;
    ranges.push({ start: rangeStart - start, end: idx - start - 1, type: 'group' });
  }
  return ranges;
}

export function coalesceTypedRanges(types, start = 0, end = types?.length || 0) {
  const ranges = [];
  let idx = Math.max(0, start | 0);
  const limit = Math.max(idx, Math.min(types?.length || 0, end | 0));
  while (idx < limit) {
    const type = types[idx] || 'empty';
    const rangeStart = idx;
    idx++;
    while (idx < limit && (types[idx] || 'empty') === type) idx++;
    ranges.push({ start: rangeStart - start, end: idx - start - 1, type });
  }
  return ranges;
}

export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(aStart | 0, bStart | 0) < Math.min(aEnd | 0, bEnd | 0);
}

export function rangeFromOffsets(offsets) {
  const vals = Array.isArray(offsets) ? offsets.filter(Number.isFinite).slice().sort((a, b) => a - b) : [];
  if (!vals.length) return null;
  return { start: vals[0], end: vals[vals.length - 1] };
}
