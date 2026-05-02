export function fmtMetric(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  if (n !== 0 && Math.abs(n) < 0.000001) return n.toExponential(3);
  return n.toFixed(6);
}

export function fmtPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return `${n.toFixed(2)}%`;
}
