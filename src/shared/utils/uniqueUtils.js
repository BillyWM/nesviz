export function dedupeSorted(values) {
  return Array.from(new Set((values || []).filter((v) => Number.isFinite(v)).map((v) => v >>> 0))).sort((a, b) => a - b);
}

export function uniqueSortedNumeric(values) {
  return Array.from(new Set(values || [])).sort((a, b) => a - b);
}

export function uniqueSortedNumbers(values) {
  if (!Array.isArray(values) || !values.length) return [];
  return Array.from(new Set(values
    .map((value) => (typeof value === 'number' ? value : Number(value)))
    .filter((value) => Number.isFinite(value))
    .map((value) => value >>> 0))).sort((a, b) => a - b);
}

export function uniqueSortedStrings(values) {
  return Array.from(new Set((values || []).map((v) => String(v)))).sort();
}

export function uniqNums(values) {
  return Array.from(new Set((values || [])
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((v) => Number.isFinite(v))
    .map((v) => v >>> 0)))
    .sort((a, b) => a - b);
}

export function uniqStrings(values) {
  return Array.from(new Set((values || []).filter((v) => typeof v === 'string' && v))).sort();
}

export function uniqObjectsByKey(values, keyFn) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
