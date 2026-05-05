export function read8(bytes, offset, rel = 0) {
  const i = ((Number(offset) || 0) + ((Number(rel) || 0))) >>> 0;
  if (!bytes || i >= bytes.length) return 0;
  return bytes[i] & 0xff;
}

export function read16le(bytes, offset, rel = 0) {
  const lo = read8(bytes, offset, rel);
  const hi = read8(bytes, offset, rel + 1);
  return ((lo | (hi << 8)) & 0xffff) >>> 0;
}

export function u16le(bytes, off = 0) {
  return (((bytes?.[off] || 0) | ((bytes?.[off + 1] || 0) << 8)) & 0xffff) >>> 0;
}

export function s8(n) {
  const b = n & 0xff;
  return b < 0x80 ? b : b - 0x100;
}

export function readUint32Le(bytes, offset) {
  if (!bytes || (bytes.length | 0) < ((offset | 0) + 4)) return null;
  return (
    (bytes[offset] & 0xff)
    | ((bytes[offset + 1] & 0xff) << 8)
    | ((bytes[offset + 2] & 0xff) << 16)
    | ((bytes[offset + 3] & 0xff) << 24)
  ) >>> 0;
}

export function readLenString(buf, offset) {
  if (offset + 2 > buf.length) throw new Error('Truncated string length');
  const len = buf.readUInt16LE(offset);
  offset += 2;
  if (offset + len > buf.length) throw new Error('Truncated string bytes');
  const value = buf.subarray(offset, offset + len).toString('utf8');
  offset += len;
  return { value, offset };
}

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

export function computeShannonEntropyByte(bytes, start, end) {
  const lo = Math.max(0, start | 0);
  const hi = Math.max(lo, Math.min(bytes?.length || 0, end | 0));
  const len = hi - lo;
  if (len <= 0 || !bytes?.length) return 0;

  const counts = new Uint16Array(256);
  for (let i = lo; i < hi; i++) counts[bytes[i] & 0xff]++;

  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    const count = counts[i];
    if (!count) continue;
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  const normalized = entropy / 8;
  const quantized = Math.round(Math.max(0, Math.min(1, normalized)) * 255);
  return Math.max(0, Math.min(255, quantized | 0));
}

export function parseBytesText(bytesText, opts = {}) {
  const { strict = true } = opts || {};
  if (!bytesText || typeof bytesText !== 'string') return [];
  const parts = bytesText.split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const v = Number.parseInt(p, 16);
    if (!Number.isFinite(v)) {
      if (strict) return [];
      continue;
    }
    out.push(v & 0xff);
  }
  return out;
}
