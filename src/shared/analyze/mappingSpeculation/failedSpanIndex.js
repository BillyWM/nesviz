import { requireInteger, requireObject } from '../dataShape.js';

export function makeFailedSpanBucketKey(value) {
  requireObject(value, 'failed span bucket value');
  const bankSize = requireInteger(value.bankSize, 'failed span bucket bankSize') >>> 0;
  const bankIndex = requireInteger(value.bankIndex, 'failed span bucket bankIndex') >>> 0;
  return `${bankSize}:${bankIndex}`;
}

export function createFailedSpanIndex() {
  return new Map();
}

export function addFailedSpan(index, span) {
  if (!(index instanceof Map)) throw new Error('failed span index must be a Map');
  requireObject(span, 'failed span');
  const romStart = requireInteger(span.romStart, 'failed span.romStart') >>> 0;
  const romEnd = requireInteger(span.romEnd, 'failed span.romEnd') >>> 0;
  if (romEnd <= romStart) throw new Error('failed span.romEnd must be greater than failed span.romStart');

  const key = makeFailedSpanBucketKey(span);
  const list = index.get(key) || [];
  list.push(span);
  list.sort((a, b) => (a.romStart >>> 0) - (b.romStart >>> 0));
  index.set(key, list);
  return span;
}

export function findFailedSpanContainingStart(index, candidate) {
  if (!(index instanceof Map)) throw new Error('failed span index must be a Map');
  requireObject(candidate, 'failed span candidate');
  const key = makeFailedSpanBucketKey(candidate);
  const startRomOff = requireInteger(candidate.startRomOff, 'failed span candidate.startRomOff') >>> 0;
  const spans = index.get(key);
  if (!spans) return null;

  for (const span of spans) {
    const romStart = requireInteger(span.romStart, 'indexed failed span.romStart') >>> 0;
    const romEnd = requireInteger(span.romEnd, 'indexed failed span.romEnd') >>> 0;
    if (startRomOff >= romStart && startRomOff < romEnd) return span;
  }
  return null;
}
