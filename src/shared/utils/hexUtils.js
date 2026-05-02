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
