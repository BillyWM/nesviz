export const BYTE_SCALAR_KIND = Object.freeze({
  BOTTOM: 'bottom',
  SET: 'set',
  RANGE: 'range',
  TOP: 'top'
});

const BYTE_MIN = 0x00;
const BYTE_MAX = 0xff;
const DEFAULT_SET_CAP = 16;
const TOP_SCALAR = Object.freeze({ kind: BYTE_SCALAR_KIND.TOP });
const BOTTOM_SCALAR = Object.freeze({ kind: BYTE_SCALAR_KIND.BOTTOM });

function clampByte(value) {
  return Number(value) & 0xff;
}

function gcd(a, b) {
  let left = Math.abs(a | 0);
  let right = Math.abs(b | 0);
  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left || 1;
}

function uniqueSortedBytes(values) {
  return Array.from(new Set(values.map(clampByte))).sort((a, b) => a - b);
}

function normalizeRange(min, max, step = 1) {
  const lo = clampByte(Math.min(Number(min), Number(max)));
  const hi = clampByte(Math.max(Number(min), Number(max)));
  const normalizedStep = Math.max(1, Math.min(255, Number(step) | 0));
  return {
    kind: BYTE_SCALAR_KIND.RANGE,
    min: lo,
    max: hi,
    step: normalizedStep
  };
}

function normalizeSet(values) {
  const setValues = uniqueSortedBytes(Array.isArray(values) ? values : []);
  if (setValues.length === 0) return bottomScalar();
  return { kind: BYTE_SCALAR_KIND.SET, values: setValues };
}

export function bottomScalar() {
  return BOTTOM_SCALAR;
}

export function topScalar() {
  return TOP_SCALAR;
}

export function exactScalar(value) {
  return { kind: BYTE_SCALAR_KIND.SET, values: [clampByte(value)] };
}

export function setScalar(values, options = {}) {
  return summarizeValues(values, options);
}

export function rangeScalar(min, max, step = 1) {
  return normalizeRange(min, max, step);
}

export function scalarFromSerializable(value) {
  if (!value || value.kind === BYTE_SCALAR_KIND.TOP) return topScalar();
  if (value.kind === BYTE_SCALAR_KIND.BOTTOM) return bottomScalar();
  if (value.kind === BYTE_SCALAR_KIND.SET) return normalizeSet(value.values);
  if (value.kind === BYTE_SCALAR_KIND.RANGE) return normalizeRange(value.min, value.max, value.step || 1);
  return topScalar();
}

export function scalarToSerializable(value) {
  const normalized = scalarFromSerializable(value);
  if (normalized.kind === BYTE_SCALAR_KIND.BOTTOM) return { kind: BYTE_SCALAR_KIND.BOTTOM };
  if (normalized.kind === BYTE_SCALAR_KIND.TOP) return { kind: BYTE_SCALAR_KIND.TOP };
  if (normalized.kind === BYTE_SCALAR_KIND.SET) return { kind: BYTE_SCALAR_KIND.SET, values: [...normalized.values] };
  return {
    kind: BYTE_SCALAR_KIND.RANGE,
    min: normalized.min,
    max: normalized.max,
    step: normalized.step
  };
}

export function isBottomScalar(value) {
  return scalarFromSerializable(value).kind === BYTE_SCALAR_KIND.BOTTOM;
}

export function isTopScalar(value) {
  return scalarFromSerializable(value).kind === BYTE_SCALAR_KIND.TOP;
}

export function scalarEqual(a, b) {
  const left = scalarFromSerializable(a);
  const right = scalarFromSerializable(b);
  if (left.kind !== right.kind) return false;
  if (left.kind === BYTE_SCALAR_KIND.BOTTOM || left.kind === BYTE_SCALAR_KIND.TOP) return true;
  if (left.kind === BYTE_SCALAR_KIND.RANGE) return left.min === right.min && left.max === right.max && left.step === right.step;
  if (left.values.length !== right.values.length) return false;
  return left.values.every((value, index) => value === right.values[index]);
}

export function scalarToValues(value, cap = 256) {
  const normalized = scalarFromSerializable(value);
  if (normalized.kind === BYTE_SCALAR_KIND.BOTTOM) return [];
  if (normalized.kind === BYTE_SCALAR_KIND.TOP) {
    if (cap < 256) return null;
    return Array.from({ length: 256 }, (_, index) => index);
  }
  if (normalized.kind === BYTE_SCALAR_KIND.SET) return normalized.values.length <= cap ? [...normalized.values] : null;

  const out = [];
  for (let valueByte = normalized.min; valueByte <= normalized.max; valueByte += 1) {
    if (((valueByte - normalized.min) % normalized.step) !== 0) continue;
    out.push(valueByte & 0xff);
    if (out.length > cap) return null;
  }
  return out;
}

export function summarizeValues(values, options = {}) {
  const setCap = Number.isFinite(options.setCap) ? Math.max(1, options.setCap | 0) : DEFAULT_SET_CAP;
  const sorted = uniqueSortedBytes(values || []);
  if (sorted.length === 0) return bottomScalar();
  if (sorted.length === 256 && sorted[0] === 0x00 && sorted[255] === 0xff) return topScalar();
  if (sorted.length <= setCap) return { kind: BYTE_SCALAR_KIND.SET, values: sorted };
  return summarizeValuesAsRange(sorted);
}

export function summarizeValuesAsRange(values) {
  const sorted = uniqueSortedBytes(values || []);
  if (sorted.length === 0) return bottomScalar();
  if (sorted.length === 1) return exactScalar(sorted[0]);
  let stride = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    stride = stride === 0 ? sorted[index] - sorted[index - 1] : gcd(stride, sorted[index] - sorted[index - 1]);
  }
  return normalizeRange(sorted[0], sorted[sorted.length - 1], Math.max(1, stride));
}

function allValues(value) {
  return scalarToValues(value, 256);
}

export function joinScalar(a, b, options = {}) {
  const left = scalarFromSerializable(a);
  const right = scalarFromSerializable(b);
  if (left.kind === BYTE_SCALAR_KIND.BOTTOM) return right;
  if (right.kind === BYTE_SCALAR_KIND.BOTTOM) return left;
  if (left.kind === BYTE_SCALAR_KIND.TOP || right.kind === BYTE_SCALAR_KIND.TOP) return topScalar();
  const leftValues = allValues(left);
  const rightValues = allValues(right);
  if (!leftValues || !rightValues) return topScalar();
  return summarizeValues([...leftValues, ...rightValues], options);
}

export function intersectScalar(a, b, options = {}) {
  const left = scalarFromSerializable(a);
  const right = scalarFromSerializable(b);
  if (left.kind === BYTE_SCALAR_KIND.BOTTOM || right.kind === BYTE_SCALAR_KIND.BOTTOM) return bottomScalar();
  if (left.kind === BYTE_SCALAR_KIND.TOP) return right;
  if (right.kind === BYTE_SCALAR_KIND.TOP) return left;
  const rightSet = new Set(allValues(right));
  const common = allValues(left).filter((value) => rightSet.has(value));
  return summarizeValues(common, options);
}

export function scalarSubsetOf(a, b) {
  const left = scalarFromSerializable(a);
  const right = scalarFromSerializable(b);
  if (left.kind === BYTE_SCALAR_KIND.BOTTOM) return true;
  if (right.kind === BYTE_SCALAR_KIND.TOP) return true;
  if (right.kind === BYTE_SCALAR_KIND.BOTTOM) return left.kind === BYTE_SCALAR_KIND.BOTTOM;
  if (left.kind === BYTE_SCALAR_KIND.TOP) return right.kind === BYTE_SCALAR_KIND.TOP;
  const rightValues = new Set(allValues(right));
  return allValues(left).every((value) => rightValues.has(value));
}

export function scalarExactValue(value) {
  const values = scalarToValues(value, 2);
  return values && values.length === 1 ? values[0] : null;
}

export function mapScalar(value, mapper, options = {}) {
  const values = scalarToValues(value, 256);
  if (!values) return topScalar();
  return summarizeValues(values.map((item) => mapper(item) & 0xff), options);
}

export function refineScalarNotZero(value, options = {}) {
  return intersectScalar(value, rangeScalar(0x01, 0xff, 1), options);
}

export function refineScalarZero(value) {
  return intersectScalar(value, exactScalar(0x00));
}

export function refineScalarUnsignedLessThan(value, limit, options = {}) {
  const byte = clampByte(limit);
  if (byte === 0x00) return bottomScalar();
  return intersectScalar(value, rangeScalar(0x00, (byte - 1) & 0xff, 1), options);
}

export function refineScalarUnsignedGreaterEqual(value, limit, options = {}) {
  const byte = clampByte(limit);
  return intersectScalar(value, rangeScalar(byte, 0xff, 1), options);
}

export function refineScalarEquals(value, byteValue) {
  return intersectScalar(value, exactScalar(byteValue));
}

export function refineScalarNotEquals(value, byteValue, options = {}) {
  const values = scalarToValues(value, 256);
  if (!values) return value;
  return summarizeValues(values.filter((item) => item !== (byteValue & 0xff)), options);
}

export function refineScalarNegative(value, options = {}) {
  return intersectScalar(value, rangeScalar(0x80, 0xff, 1), options);
}

export function refineScalarNonNegative(value, options = {}) {
  return intersectScalar(value, rangeScalar(0x00, 0x7f, 1), options);
}

export function widenScalar(oldValue, incomingValue, options = {}) {
  const oldScalar = scalarFromSerializable(oldValue);
  const incoming = scalarFromSerializable(incomingValue);
  if (oldScalar.kind === BYTE_SCALAR_KIND.BOTTOM) return incoming;
  if (incoming.kind === BYTE_SCALAR_KIND.BOTTOM) return oldScalar;
  if (oldScalar.kind === BYTE_SCALAR_KIND.TOP || incoming.kind === BYTE_SCALAR_KIND.TOP) return topScalar();
  if (scalarSubsetOf(incoming, oldScalar)) return oldScalar;

  const oldValues = allValues(oldScalar);
  const incomingValues = allValues(incoming);
  if (!oldValues || !incomingValues) return topScalar();
  const merged = uniqueSortedBytes([...oldValues, ...incomingValues]);
  const setCap = Number.isFinite(options.setCap) ? Math.max(1, options.setCap | 0) : DEFAULT_SET_CAP;
  if (merged.length <= setCap) return { kind: BYTE_SCALAR_KIND.SET, values: merged };

  const oldMin = Math.min(...oldValues);
  const oldMax = Math.max(...oldValues);
  const incomingMin = Math.min(...incomingValues);
  const incomingMax = Math.max(...incomingValues);
  let min = Math.min(oldMin, incomingMin);
  let max = Math.max(oldMax, incomingMax);

  if (incomingMin < oldMin) min = merged.includes(0x00) ? BYTE_MIN : 0x01;
  if (incomingMax > oldMax) max = BYTE_MAX;

  const summarized = summarizeValuesAsRange(merged);
  const step = summarized.kind === BYTE_SCALAR_KIND.RANGE ? summarized.step : 1;
  return normalizeRange(min, max, step);
}

export function narrowScalar(oldValue, candidateValue, options = {}) {
  const oldScalar = scalarFromSerializable(oldValue);
  const candidate = scalarFromSerializable(candidateValue);
  if (scalarSubsetOf(candidate, oldScalar)) return candidate;
  return intersectScalar(oldScalar, candidate, options);
}
