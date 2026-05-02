const MIN_SCALE = 1e-6;

export function median(values) {
  const sorted = Array.isArray(values) ? values.filter(Number.isFinite).slice().sort((a, b) => a - b) : [];
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  if ((sorted.length % 2) === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values, fraction) {
  const sorted = Array.isArray(values) ? values.filter(Number.isFinite).slice().sort((a, b) => a - b) : [];
  if (!sorted.length) return 0;
  const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
  const index = (sorted.length - 1) * clamped;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  const t = index - lo;
  return sorted[lo] + ((sorted[hi] - sorted[lo]) * t);
}

export function computeRobustScale(values, center) {
  const deviations = values.filter(Number.isFinite).map((value) => Math.abs(value - center));
  const mad = median(deviations) * 1.4826;
  if (Number.isFinite(mad) && mad >= MIN_SCALE) return mad;
  const iqr = percentile(values, 0.75) - percentile(values, 0.25);
  const iqrScale = iqr / 1.349;
  if (Number.isFinite(iqrScale) && iqrScale >= MIN_SCALE) return iqrScale;
  let mean = 0;
  let count = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    mean += value;
    count += 1;
  }
  mean = count ? (mean / count) : 0;
  let variance = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const delta = value - mean;
    variance += delta * delta;
  }
  const std = count > 1 ? Math.sqrt(variance / (count - 1)) : 0;
  if (Number.isFinite(std) && std >= MIN_SCALE) return std;
  return 1;
}
