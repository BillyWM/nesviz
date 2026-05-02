export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function clampSigned(value, maxMagnitude) {
  const n = Number(value);
  const max = Math.max(0, Number(maxMagnitude) || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-max, Math.min(max, n));
}

export function clamp8(n) {
  return (n & 0xff) >>> 0;
}
