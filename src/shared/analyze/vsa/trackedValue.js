import { vEnumerate } from './value.js';
import { bEnumerate8 } from './bits.js';
import { intersectSorted } from '../../utils/setMathUtils.js';

function normalizeByteValues(values, cap) {
  if (!Array.isArray(values)) return null;
  const unique = Array.from(new Set((values || [])
    .map((value) => (typeof value === 'number' ? value : Number(value)))
    .filter((value) => Number.isFinite(value))
    .map((value) => value & 0xff)))
    .sort((a, b) => a - b);
  if (!unique.length) return [];
  if (unique.length > Math.max(1, cap | 0)) return null;
  return unique;
}

export function enumerateTrackedByteValues(tracked, cap = 32) {
  if (!tracked) return null;
  const limit = Math.max(1, cap | 0);
  const absValues = normalizeByteValues(vEnumerate(tracked.abs, limit), limit);
  const bitsValues = normalizeByteValues(bEnumerate8(tracked.bits, limit), limit);

  if (absValues && bitsValues) {
    const values = intersectSorted(absValues, bitsValues);
    return { values, source: 'abs+bits' };
  }
  if (absValues) return { values: absValues, source: 'abs' };
  if (bitsValues) return { values: bitsValues, source: 'bits' };
  return null;
}

export function trackedByteValues(tracked, cap = 32) {
  return enumerateTrackedByteValues(tracked, cap)?.values || null;
}
