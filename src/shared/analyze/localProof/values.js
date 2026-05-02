function clamp8(value) {
  return (value & 0xff) >>> 0;
}

export function unknown8() {
  return { kind: 'unknown' };
}

export function const8(value) {
  return { kind: 'const8', value: clamp8(value) };
}

export function set8(values) {
  const normalized = Array.from(new Set((values || [])
    .map((value) => (typeof value === 'number' ? value : Number(value)))
    .filter((value) => Number.isFinite(value))
    .map(clamp8))).sort((a, b) => a - b);
  if (!normalized.length) return unknown8();
  if (normalized.length === 1) return const8(normalized[0]);
  return { kind: 'set8', values: normalized };
}

export function valueSet(value) {
  if (!value || value.kind === 'unknown') return null;
  if (value.kind === 'const8') return [clamp8(value.value)];
  if (value.kind === 'set8') return Array.from(new Set((value.values || []).map(clamp8))).sort((a, b) => a - b);
  return null;
}

function mapValue(value, fn) {
  const vals = valueSet(value);
  if (!vals?.length) return unknown8();
  return set8(vals.map((v) => clamp8(fn(v))));
}

function finiteUnknownAndSet(imm, cap = 32) {
  const mask = imm & 0xff;
  const out = new Set();
  for (let value = 0; value < 256; value++) {
    out.add((value & mask) & 0xff);
    if (out.size > cap) return unknown8();
  }
  return set8(Array.from(out));
}

export function andImm(value, imm) {
  if (!valueSet(value)?.length) return finiteUnknownAndSet(imm);
  return mapValue(value, (v) => v & (imm & 0xff));
}

export function orImm(value, imm) {
  return mapValue(value, (v) => v | (imm & 0xff));
}

export function xorImm(value, imm) {
  return mapValue(value, (v) => v ^ (imm & 0xff));
}

export function shl1(value) {
  return mapValue(value, (v) => (v << 1) & 0xff);
}

export function shr1(value) {
  return mapValue(value, (v) => (v >>> 1) & 0xff);
}

export function addImm(value, imm) {
  return mapValue(value, (v) => (v + imm) & 0xff);
}

export function isKnown(value) {
  return !!valueSet(value)?.length;
}
