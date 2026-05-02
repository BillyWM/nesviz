export function formatBytes(bytes, opts = {}) {
  const {
    includeRaw = false,
    precision = 1,
    emptyOnInvalid = false
  } = opts || {};
  const num = Number(bytes);
  if (!Number.isFinite(num)) return emptyOnInvalid ? '' : '0 B';

  if (includeRaw) {
    const abs = Math.abs(num);
    if (abs >= 1024 * 1024) return `${num} (${(num / (1024 * 1024)).toFixed(precision)} MiB)`;
    if (abs >= 1024) return `${num} (${(num / 1024).toFixed(precision)} KiB)`;
    return String(num);
  }

  if (num === 0) return '0 B';
  const kib = num / 1024;
  if (Number.isInteger(kib)) return `${kib} KiB`;
  return `${num} B`;
}

export function formatMb(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.0 MB';
  return `${n.toFixed(1)} MB`;
}

export function formatKiB(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '';
  const kib = bytes / 1024;
  return Number.isInteger(kib) ? `${kib} KiB` : `${kib.toFixed(2)} KiB`;
}
