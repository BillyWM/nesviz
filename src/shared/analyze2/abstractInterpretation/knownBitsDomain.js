import { FLAG_VALUE, boolFlag, flagFromBit, bitFromFlag } from '../domains/flagsDomain.js';

export const KNOWN_BITS_KIND = Object.freeze({
  BOTTOM: 'bottom',
  BITS: 'bits'
});

const TOP_BITS = Object.freeze({ kind: KNOWN_BITS_KIND.BITS, knownMask: 0x00, knownValue: 0x00 });
const BOTTOM_BITS = Object.freeze({ kind: KNOWN_BITS_KIND.BOTTOM });

function normalizeBits(bits) {
  if (!bits || bits.kind === KNOWN_BITS_KIND.BOTTOM) return BOTTOM_BITS;
  return {
    kind: KNOWN_BITS_KIND.BITS,
    knownMask: bits.knownMask & 0xff,
    knownValue: bits.knownValue & bits.knownMask & 0xff
  };
}

function exactValue(bits) {
  const normalized = normalizeBits(bits);
  if (normalized.kind === KNOWN_BITS_KIND.BOTTOM) return null;
  return normalized.knownMask === 0xff ? normalized.knownValue & 0xff : null;
}

function bitKnown(bits, mask) {
  const normalized = normalizeBits(bits);
  if (normalized.kind === KNOWN_BITS_KIND.BOTTOM) return null;
  if ((normalized.knownMask & mask) === 0) return null;
  return (normalized.knownValue & mask) !== 0 ? 1 : 0;
}

export function bottomKnownBits() {
  return BOTTOM_BITS;
}

export function topKnownBits() {
  return TOP_BITS;
}

export function exactKnownBits(value) {
  return {
    kind: KNOWN_BITS_KIND.BITS,
    knownMask: 0xff,
    knownValue: value & 0xff
  };
}

export function isBottomKnownBits(bits) {
  return normalizeBits(bits).kind === KNOWN_BITS_KIND.BOTTOM;
}

export function isTopKnownBits(bits) {
  const normalized = normalizeBits(bits);
  return normalized.kind === KNOWN_BITS_KIND.BITS && normalized.knownMask === 0x00;
}

export function knownBitsEqual(a, b) {
  const left = normalizeBits(a);
  const right = normalizeBits(b);
  if (left.kind !== right.kind) return false;
  if (left.kind === KNOWN_BITS_KIND.BOTTOM) return true;
  return left.knownMask === right.knownMask && left.knownValue === right.knownValue;
}

export function joinKnownBits(a, b) {
  const left = normalizeBits(a);
  const right = normalizeBits(b);
  if (left.kind === KNOWN_BITS_KIND.BOTTOM) return right;
  if (right.kind === KNOWN_BITS_KIND.BOTTOM) return left;
  const agreeMask = ~(left.knownValue ^ right.knownValue) & 0xff;
  const knownMask = left.knownMask & right.knownMask & agreeMask;
  return {
    kind: KNOWN_BITS_KIND.BITS,
    knownMask,
    knownValue: left.knownValue & knownMask
  };
}


export function meetKnownBits(a, b) {
  const left = normalizeBits(a);
  const right = normalizeBits(b);
  if (left.kind === KNOWN_BITS_KIND.BOTTOM || right.kind === KNOWN_BITS_KIND.BOTTOM) return bottomKnownBits();
  let knownMask = left.knownMask | right.knownMask;
  let knownValue = (left.knownValue & left.knownMask) | (right.knownValue & right.knownMask);
  const bothKnown = left.knownMask & right.knownMask;
  const disagreement = (left.knownValue ^ right.knownValue) & bothKnown;
  if (disagreement !== 0) return bottomKnownBits();
  return {
    kind: KNOWN_BITS_KIND.BITS,
    knownMask: knownMask & 0xff,
    knownValue: knownValue & knownMask & 0xff
  };
}

export function knownBitsFromValues(values) {
  if (!Array.isArray(values) || values.length === 0) return bottomKnownBits();
  const normalizedValues = values.map((value) => Number(value) & 0xff);
  let knownMask = 0xff;
  let knownValue = normalizedValues[0] & 0xff;
  for (const value of normalizedValues.slice(1)) {
    knownMask &= ~(knownValue ^ value) & 0xff;
    knownValue &= knownMask;
  }
  return {
    kind: KNOWN_BITS_KIND.BITS,
    knownMask: knownMask & 0xff,
    knownValue: knownValue & knownMask & 0xff
  };
}

export function knownBitsAndImmediate(bits, imm) {
  const normalized = normalizeBits(bits);
  if (normalized.kind === KNOWN_BITS_KIND.BOTTOM) return normalized;
  const mask = imm & 0xff;
  return {
    kind: KNOWN_BITS_KIND.BITS,
    knownMask: (normalized.knownMask | (~mask & 0xff)) & 0xff,
    knownValue: normalized.knownValue & mask
  };
}

export function knownBitsOrImmediate(bits, imm) {
  const normalized = normalizeBits(bits);
  if (normalized.kind === KNOWN_BITS_KIND.BOTTOM) return normalized;
  const mask = imm & 0xff;
  return {
    kind: KNOWN_BITS_KIND.BITS,
    knownMask: (normalized.knownMask | mask) & 0xff,
    knownValue: (normalized.knownValue | mask) & 0xff
  };
}

export function knownBitsEorImmediate(bits, imm) {
  const normalized = normalizeBits(bits);
  if (normalized.kind === KNOWN_BITS_KIND.BOTTOM) return normalized;
  const mask = normalized.knownMask & 0xff;
  return {
    kind: KNOWN_BITS_KIND.BITS,
    knownMask: mask,
    knownValue: (normalized.knownValue ^ (imm & 0xff)) & mask
  };
}

export function knownBitsAsl(bits) {
  const normalized = normalizeBits(bits);
  if (normalized.kind === KNOWN_BITS_KIND.BOTTOM) return { result: normalized, carry: FLAG_VALUE.BOTTOM };
  const carry = flagFromBit(bitKnown(normalized, 0x80));
  return {
    result: {
      kind: KNOWN_BITS_KIND.BITS,
      knownMask: ((normalized.knownMask << 1) | 0x01) & 0xff,
      knownValue: (normalized.knownValue << 1) & 0xff
    },
    carry
  };
}

export function knownBitsLsr(bits) {
  const normalized = normalizeBits(bits);
  if (normalized.kind === KNOWN_BITS_KIND.BOTTOM) return { result: normalized, carry: FLAG_VALUE.BOTTOM };
  const carry = flagFromBit(bitKnown(normalized, 0x01));
  return {
    result: {
      kind: KNOWN_BITS_KIND.BITS,
      knownMask: ((normalized.knownMask >>> 1) | 0x80) & 0xff,
      knownValue: (normalized.knownValue >>> 1) & 0xff
    },
    carry
  };
}

export function knownBitsRol(bits, carryFlag) {
  const normalized = normalizeBits(bits);
  if (normalized.kind === KNOWN_BITS_KIND.BOTTOM) return { result: normalized, carry: FLAG_VALUE.BOTTOM };
  const carryIn = bitFromFlag(carryFlag);
  const carryKnownMask = carryIn === null ? 0x00 : 0x01;
  const carryKnownValue = carryIn === 1 ? 0x01 : 0x00;
  return {
    result: {
      kind: KNOWN_BITS_KIND.BITS,
      knownMask: ((normalized.knownMask << 1) | carryKnownMask) & 0xff,
      knownValue: ((normalized.knownValue << 1) | carryKnownValue) & 0xff
    },
    carry: flagFromBit(bitKnown(normalized, 0x80))
  };
}

export function knownBitsRor(bits, carryFlag) {
  const normalized = normalizeBits(bits);
  if (normalized.kind === KNOWN_BITS_KIND.BOTTOM) return { result: normalized, carry: FLAG_VALUE.BOTTOM };
  const carryIn = bitFromFlag(carryFlag);
  const carryKnownMask = carryIn === null ? 0x00 : 0x80;
  const carryKnownValue = carryIn === 1 ? 0x80 : 0x00;
  return {
    result: {
      kind: KNOWN_BITS_KIND.BITS,
      knownMask: ((normalized.knownMask >>> 1) | carryKnownMask) & 0xff,
      knownValue: ((normalized.knownValue >>> 1) | carryKnownValue) & 0xff
    },
    carry: flagFromBit(bitKnown(normalized, 0x01))
  };
}

export function knownBitsInc(bits) {
  const value = exactValue(bits);
  return value === null ? topKnownBits() : exactKnownBits((value + 1) & 0xff);
}

export function knownBitsDec(bits) {
  const value = exactValue(bits);
  return value === null ? topKnownBits() : exactKnownBits((value - 1) & 0xff);
}

export function exactByteFromKnownBits(bits) {
  return exactValue(bits);
}

export function nzFlagsFromKnownBits(bits) {
  const normalized = normalizeBits(bits);
  if (normalized.kind === KNOWN_BITS_KIND.BOTTOM) {
    return { n: FLAG_VALUE.BOTTOM, z: FLAG_VALUE.BOTTOM };
  }

  const exact = exactValue(normalized);
  if (exact !== null) {
    return {
      n: boolFlag((exact & 0x80) !== 0),
      z: boolFlag(exact === 0)
    };
  }

  const nBit = bitKnown(normalized, 0x80);
  const allKnownZero = normalized.knownMask === 0xff && normalized.knownValue === 0x00;
  const anyKnownOne = (normalized.knownMask & normalized.knownValue) !== 0;
  return {
    n: flagFromBit(nBit),
    z: allKnownZero ? FLAG_VALUE.TRUE : (anyKnownOne ? FLAG_VALUE.FALSE : FLAG_VALUE.UNKNOWN)
  };
}

export function knownBitsToSerializable(bits) {
  const normalized = normalizeBits(bits);
  if (normalized.kind === KNOWN_BITS_KIND.BOTTOM) return { kind: KNOWN_BITS_KIND.BOTTOM };
  return {
    kind: KNOWN_BITS_KIND.BITS,
    knownMask: normalized.knownMask & 0xff,
    knownValue: normalized.knownValue & 0xff
  };
}


export function knownBitsFromSerializable(value) {
  if (!value) return topKnownBits();
  if (value.kind === KNOWN_BITS_KIND.BOTTOM) return bottomKnownBits();
  return normalizeBits(value);
}
