export const FINITE_SET_KIND = Object.freeze({
  BOTTOM: 'bottom',
  SET: 'set',
  TOP: 'top'
});

function normalizeNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function defaultCompare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function defaultKey(value) {
  return String(value);
}

function spec(options = {}) {
  return {
    cap: Number.isFinite(options.cap) ? Math.max(1, options.cap | 0) : 8,
    normalize: typeof options.normalize === 'function' ? options.normalize : ((value) => normalizeNumber(value)),
    compare: typeof options.compare === 'function' ? options.compare : defaultCompare,
    keyForValue: typeof options.keyForValue === 'function' ? options.keyForValue : defaultKey
  };
}

export function bottomFiniteSet() {
  return { kind: FINITE_SET_KIND.BOTTOM };
}

export function topFiniteSet() {
  return { kind: FINITE_SET_KIND.TOP };
}

export function finiteSetOf(values, options = {}) {
  const cfg = spec(options);
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = cfg.normalize(value);
    if (normalized === null || normalized === undefined) continue;
    const key = cfg.keyForValue(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  if (out.length === 0) return bottomFiniteSet();
  if (out.length > cfg.cap) return topFiniteSet();
  out.sort(cfg.compare);
  return { kind: FINITE_SET_KIND.SET, values: out };
}

export function finiteSetFromSerializable(value, options = {}) {
  if (!value || typeof value !== 'object') return topFiniteSet();
  if (value.kind === FINITE_SET_KIND.BOTTOM) return bottomFiniteSet();
  if (value.kind === FINITE_SET_KIND.TOP) return topFiniteSet();
  if (value.kind === FINITE_SET_KIND.SET) return finiteSetOf(value.values || [], options);
  if (value.kind === 'exact') return finiteSetOf([value.value], options);
  return topFiniteSet();
}

export function finiteSetToSerializable(value, options = {}) {
  const normalized = finiteSetFromSerializable(value, options);
  if (normalized.kind !== FINITE_SET_KIND.SET) return { kind: normalized.kind };
  return { kind: FINITE_SET_KIND.SET, values: normalized.values.slice() };
}

export function finiteSetValues(value, options = {}) {
  const normalized = finiteSetFromSerializable(value, options);
  if (normalized.kind !== FINITE_SET_KIND.SET) return null;
  return normalized.values.slice();
}

export function finiteSetIsTop(value) {
  return value?.kind === FINITE_SET_KIND.TOP;
}

export function finiteSetIsBottom(value) {
  return value?.kind === FINITE_SET_KIND.BOTTOM;
}

export function finiteSetEquals(a, b, options = {}) {
  const cfg = spec(options);
  const left = finiteSetFromSerializable(a, options);
  const right = finiteSetFromSerializable(b, options);
  if (left.kind !== right.kind) return false;
  if (left.kind !== FINITE_SET_KIND.SET) return true;
  if (left.values.length !== right.values.length) return false;
  for (let i = 0; i < left.values.length; i += 1) {
    if (cfg.keyForValue(left.values[i]) !== cfg.keyForValue(right.values[i])) return false;
  }
  return true;
}

export function finiteSetSubsetOf(a, b, options = {}) {
  const cfg = spec(options);
  const left = finiteSetFromSerializable(a, options);
  const right = finiteSetFromSerializable(b, options);
  if (left.kind === FINITE_SET_KIND.BOTTOM) return true;
  if (right.kind === FINITE_SET_KIND.TOP) return true;
  if (right.kind === FINITE_SET_KIND.BOTTOM) return left.kind === FINITE_SET_KIND.BOTTOM;
  if (left.kind === FINITE_SET_KIND.TOP) return right.kind === FINITE_SET_KIND.TOP;
  const rightKeys = new Set(right.values.map((value) => cfg.keyForValue(value)));
  return left.values.every((value) => rightKeys.has(cfg.keyForValue(value)));
}

export function joinFiniteSets(a, b, options = {}) {
  const left = finiteSetFromSerializable(a, options);
  const right = finiteSetFromSerializable(b, options);
  if (left.kind === FINITE_SET_KIND.BOTTOM) return right;
  if (right.kind === FINITE_SET_KIND.BOTTOM) return left;
  if (left.kind === FINITE_SET_KIND.TOP || right.kind === FINITE_SET_KIND.TOP) return topFiniteSet();
  return finiteSetOf([...left.values, ...right.values], options);
}

export function widenFiniteSets(a, b, options = {}) {
  return joinFiniteSets(a, b, options);
}

export function finiteSetKey(value, options = {}) {
  const cfg = spec(options);
  const normalized = finiteSetFromSerializable(value, options);
  if (normalized.kind === FINITE_SET_KIND.BOTTOM) return '⊥';
  if (normalized.kind === FINITE_SET_KIND.TOP) return '⊤';
  return `{${normalized.values.map((item) => cfg.keyForValue(item)).join(',')}}`;
}

export function mapFiniteSet(value, mapper, options = {}) {
  const normalized = finiteSetFromSerializable(value, options);
  if (normalized.kind === FINITE_SET_KIND.BOTTOM) return bottomFiniteSet();
  if (normalized.kind === FINITE_SET_KIND.TOP) return topFiniteSet();
  const out = [];
  for (const item of normalized.values) {
    const mapped = mapper(item);
    if (mapped === null || mapped === undefined) return topFiniteSet();
    if (Array.isArray(mapped)) out.push(...mapped);
    else out.push(mapped);
  }
  return finiteSetOf(out, options);
}
