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
