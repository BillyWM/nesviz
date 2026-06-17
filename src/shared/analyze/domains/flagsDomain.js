export const FLAG_VALUE = Object.freeze({
  BOTTOM: 'bottom',
  FALSE: 'false',
  TRUE: 'true',
  UNKNOWN: 'unknown'
});

export const FLAG_NAMES = Object.freeze(['n', 'v', 'd', 'i', 'z', 'c']);

export function bottomFlag() {
  return FLAG_VALUE.BOTTOM;
}

export function unknownFlag() {
  return FLAG_VALUE.UNKNOWN;
}

export function boolFlag(value) {
  return value ? FLAG_VALUE.TRUE : FLAG_VALUE.FALSE;
}

export function flagFromBit(bit) {
  if (bit === 0) return FLAG_VALUE.FALSE;
  if (bit === 1) return FLAG_VALUE.TRUE;
  return FLAG_VALUE.UNKNOWN;
}

export function bitFromFlag(flag) {
  if (flag === FLAG_VALUE.FALSE) return 0;
  if (flag === FLAG_VALUE.TRUE) return 1;
  return null;
}

export function joinFlag(a, b) {
  const left = a || FLAG_VALUE.UNKNOWN;
  const right = b || FLAG_VALUE.UNKNOWN;
  if (left === FLAG_VALUE.BOTTOM) return right;
  if (right === FLAG_VALUE.BOTTOM) return left;
  if (left === right) return left;
  return FLAG_VALUE.UNKNOWN;
}

export function createUnknownFlags() {
  return {
    n: FLAG_VALUE.UNKNOWN,
    v: FLAG_VALUE.UNKNOWN,
    d: FLAG_VALUE.UNKNOWN,
    i: FLAG_VALUE.UNKNOWN,
    z: FLAG_VALUE.UNKNOWN,
    c: FLAG_VALUE.UNKNOWN
  };
}

export function createBottomFlags() {
  return {
    n: FLAG_VALUE.BOTTOM,
    v: FLAG_VALUE.BOTTOM,
    d: FLAG_VALUE.BOTTOM,
    i: FLAG_VALUE.BOTTOM,
    z: FLAG_VALUE.BOTTOM,
    c: FLAG_VALUE.BOTTOM
  };
}

export function joinFlags(a, b) {
  return {
    n: joinFlag(a.n, b.n),
    v: joinFlag(a.v, b.v),
    d: joinFlag(a.d, b.d),
    i: joinFlag(a.i, b.i),
    z: joinFlag(a.z, b.z),
    c: joinFlag(a.c, b.c)
  };
}

export function flagsEqual(a, b) {
  return FLAG_NAMES.every((name) => a[name] === b[name]);
}

export function withFlagUpdates(flags, updates) {
  return {
    n: updates.n || flags.n,
    v: updates.v || flags.v,
    d: updates.d || flags.d,
    i: updates.i || flags.i,
    z: updates.z || flags.z,
    c: updates.c || flags.c
  };
}

export function forceFlag(flags, flagName, value) {
  return withFlagUpdates(flags, { [flagName]: value });
}
