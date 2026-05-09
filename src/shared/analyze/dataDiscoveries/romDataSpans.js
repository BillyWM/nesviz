export function normalizeInclusiveRomSpan(span, prgSize = null) {
  const startValue = Number(span?.start);
  const endValue = Number(span?.end);
  if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) return null;

  let start = startValue | 0;
  let end = endValue | 0;
  if (end < start) return null;

  if (Number.isFinite(prgSize)) {
    const size = Math.max(0, prgSize | 0);
    if (size <= 0) return null;
    start = Math.max(0, Math.min(size - 1, start));
    end = Math.max(0, Math.min(size - 1, end));
    if (end < start) return null;
  }

  return { start, end };
}

export function inclusiveRomSpanLength(span) {
  const normalized = normalizeInclusiveRomSpan(span);
  return normalized ? ((normalized.end - normalized.start) + 1) : 0;
}

export function inclusiveRomSpanToSlice(span, prgSize = null) {
  const normalized = normalizeInclusiveRomSpan(span, prgSize);
  if (!normalized) return null;
  return { start: normalized.start, end: normalized.end + 1 };
}

export function mergeInclusiveRomSpans(spans, prgSize = null) {
  const normalized = [];
  for (const span of Array.isArray(spans) ? spans : []) {
    const next = normalizeInclusiveRomSpan(span, prgSize);
    if (next) normalized.push(next);
  }
  normalized.sort((a, b) => (a.start - b.start) || (a.end - b.end));

  const merged = [];
  for (const span of normalized) {
    const prev = merged[merged.length - 1];
    if (prev && span.start <= prev.end + 1) {
      if (span.end > prev.end) prev.end = span.end;
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

export function uniqueCountedBytesForInclusiveRomSpans(spans, prgSize = null) {
  const merged = mergeInclusiveRomSpans(spans, prgSize);
  let total = 0;
  for (const span of merged) total += inclusiveRomSpanLength(span);
  return total;
}


export function normalizeInclusiveRomOffset(offset, prgSize = null) {
  const value = Number(offset);
  if (!Number.isFinite(value)) return null;
  const normalized = value | 0;
  if (Number.isFinite(prgSize)) {
    const size = Math.max(0, prgSize | 0);
    if (size <= 0 || normalized < 0 || normalized >= size) return null;
  }
  return normalized;
}

export function inclusiveRomSpansFromOffsets(offsets, prgSize = null) {
  const normalized = Array.from(new Set((Array.isArray(offsets) ? offsets : [])
    .map((offset) => normalizeInclusiveRomOffset(offset, prgSize))
    .filter((offset) => offset != null)))
    .sort((a, b) => a - b);

  const spans = [];
  for (const offset of normalized) {
    const prev = spans[spans.length - 1];
    if (prev && offset <= prev.end + 1) {
      prev.end = Math.max(prev.end, offset);
      continue;
    }
    spans.push({ start: offset, end: offset });
  }
  return spans;
}
