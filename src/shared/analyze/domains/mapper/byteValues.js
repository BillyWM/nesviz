import { abstractByteFromSerializable } from '../../abstractInterpretation/abstractByteDomain.js';
import { scalarToValues } from '../../abstractInterpretation/byteScalarDomain.js';

export function byteValuesUnderCap(byte, cap = 8) {
  const normalized = abstractByteFromSerializable(byte);
  const scalarValues = scalarToValues(normalized.scalar, 256);
  if (!scalarValues) return null;
  const out = [];
  for (const value of scalarValues) {
    if (normalized.bits.kind === 'bottom') return [];
    if ((value & normalized.bits.knownMask) === normalized.bits.knownValue) out.push(value & 0xff);
    if (out.length > cap) return null;
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

export function byteBitValues(byte, bitIndex) {
  const bit = Number(bitIndex) & 7;
  const normalized = abstractByteFromSerializable(byte);
  if (normalized.bits.kind === 'bottom') return [];

  const scalarValues = scalarToValues(normalized.scalar, 256);
  if (scalarValues) {
    const out = new Set();
    for (const value of scalarValues) {
      if ((value & normalized.bits.knownMask) === normalized.bits.knownValue) {
        out.add((value >>> bit) & 1);
      }
    }
    return Array.from(out).sort((a, b) => a - b);
  }

  const mask = 1 << bit;
  if ((normalized.bits.knownMask & mask) !== 0) {
    return [((normalized.bits.knownValue & mask) !== 0) ? 1 : 0];
  }
  return [0, 1];
}
