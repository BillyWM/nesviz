export function normalizeStringList(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((v) => String(v || '').trim()).filter(Boolean))).sort();
}

export function normalizeNumberList(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .map((v) => v >>> 0))).sort((a, b) => a - b);
}

export function normalizeTokenList(values) {
  return normalizeStringList(values);
}
