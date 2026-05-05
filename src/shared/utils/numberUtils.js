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

export function parseLeadingInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = String(value ?? '').trim().match(/^-?\d+/);
  if (!match) return null;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function fmtHex(value, width = 4) {
  const normalizedWidth = Math.max(0, width | 0);
  const n = Number(value);
  if (!Number.isFinite(n)) return '?'.repeat(normalizedWidth);
  const safe = Math.max(0, Math.trunc(n));
  return safe.toString(16).toUpperCase().padStart(normalizedWidth, '0');
}

export function fmtHexRange(start, end, width = 6) {
  const hi = Number.isFinite(Number(end)) ? (Math.trunc(Number(end)) - 1) : 0;
  return `${fmtHex(start, width)}-${fmtHex(hi, width)}`;
}

export function bufferToHex(buf, maxBytes = 256) {
  if (!buf || !buf.length) return '';
  const slice = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  const hex = Array.from(slice).map((b) => fmtHex(b & 0xff, 2).toLowerCase()).join(' ');
  return buf.length > maxBytes ? `${hex} …(+${buf.length - maxBytes} bytes)` : hex;
}
