import { FLAG_VALUE, boolFlag } from '../domains/flagsDomain.js';
import {
  exactByteFromKnownBits,
  exactKnownBits,
  isBottomKnownBits,
  isTopKnownBits,
  joinKnownBits,
  meetKnownBits,
  knownBitsAndImmediate,
  knownBitsAsl,
  knownBitsDec,
  knownBitsEorImmediate,
  knownBitsEqual,
  knownBitsFromSerializable,
  knownBitsInc,
  knownBitsLsr,
  knownBitsOrImmediate,
  knownBitsRol,
  knownBitsRor,
  knownBitsToSerializable,
  nzFlagsFromKnownBits,
  topKnownBits
} from './knownBitsDomain.js';
import {
  exactScalar,
  intersectScalar,
  isBottomScalar,
  joinScalar,
  mapScalar,
  scalarEqual,
  scalarExactValue,
  scalarFromSerializable,
  scalarToSerializable,
  scalarToValues,
  summarizeValues,
  scalarSubsetOf,
  topScalar,
  widenScalar
} from './byteScalarDomain.js';
import { reduceByte } from './reduction.js';

export function topByte() {
  return { scalar: topScalar(), bits: topKnownBits() };
}

export function exactByte(value) {
  const byte = Number(value) & 0xff;
  return { scalar: exactScalar(byte), bits: exactKnownBits(byte) };
}

export function abstractByteFromParts({ scalar = null, bits = null } = {}) {
  return reduceByte({
    scalar: scalar ? scalarFromSerializable(scalar) : topScalar(),
    bits: bits ? knownBitsFromSerializable(bits) : topKnownBits()
  });
}

export function abstractByteFromSerializable(value) {
  if (!value || typeof value !== 'object') return topByte();
  if (value.scalar || value.bits) return abstractByteFromParts(value);
  return abstractByteFromParts({ bits: value });
}

export function abstractByteToSerializable(value) {
  const normalized = abstractByteFromSerializable(value);
  return {
    scalar: scalarToSerializable(normalized.scalar),
    bits: knownBitsToSerializable(normalized.bits)
  };
}

export function byteEqual(a, b) {
  const left = abstractByteFromSerializable(a);
  const right = abstractByteFromSerializable(b);
  return scalarEqual(left.scalar, right.scalar) && knownBitsEqual(left.bits, right.bits);
}

export function isTopByte(value) {
  const normalized = abstractByteFromSerializable(value);
  return scalarFromSerializable(normalized.scalar).kind === 'top' && isTopKnownBits(normalized.bits);
}


export function isBottomByte(value) {
  const normalized = abstractByteFromSerializable(value);
  return isBottomScalar(normalized.scalar) || isBottomKnownBits(normalized.bits);
}

export function intersectByte(a, b, options = {}) {
  const left = abstractByteFromSerializable(a);
  const right = abstractByteFromSerializable(b);
  return reduceByte({
    scalar: intersectScalar(left.scalar, right.scalar, options),
    bits: meetKnownBits(left.bits, right.bits)
  }, options);
}

export function joinByte(a, b, options = {}) {
  const left = abstractByteFromSerializable(a);
  const right = abstractByteFromSerializable(b);
  return reduceByte({
    scalar: joinScalar(left.scalar, right.scalar, options),
    bits: joinKnownBits(left.bits, right.bits)
  }, options);
}

export function widenByte(oldValue, incomingValue, options = {}) {
  const oldByte = abstractByteFromSerializable(oldValue);
  const incoming = abstractByteFromSerializable(incomingValue);
  return reduceByte({
    scalar: widenScalar(oldByte.scalar, incoming.scalar, options),
    bits: joinKnownBits(oldByte.bits, incoming.bits)
  }, options);
}


function valuesRepresentedByByte(value) {
  const byte = abstractByteFromSerializable(value);
  const values = scalarToValues(byte.scalar, 256);
  if (!values) return null;
  return values.filter((item) => {
    if (byte.bits.kind === 'bottom') return false;
    return (item & byte.bits.knownMask) === byte.bits.knownValue;
  });
}

export function enumerateByteValues(value, maxValues = 64) {
  const values = valuesRepresentedByByte(value);
  if (!values) return null;
  if (values.length > maxValues) return null;
  return Array.from(new Set(values.map((item) => item & 0xff))).sort((a, b) => a - b);
}

export function byteSubsetOf(a, b) {
  const left = abstractByteFromSerializable(a);
  const right = abstractByteFromSerializable(b);
  if (!scalarSubsetOf(left.scalar, right.scalar)) {
    const leftValues = valuesRepresentedByByte(left);
    const rightValues = valuesRepresentedByByte(right);
    if (!leftValues || !rightValues) return false;
    const rightSet = new Set(rightValues);
    return leftValues.every((value) => rightSet.has(value));
  }
  const leftValues = valuesRepresentedByByte(left);
  const rightValues = valuesRepresentedByByte(right);
  if (!leftValues || !rightValues) return true;
  const rightSet = new Set(rightValues);
  return leftValues.every((value) => rightSet.has(value));
}

export function exactValueFromByte(value) {
  const byte = abstractByteFromSerializable(value);
  const scalarExact = scalarExactValue(byte.scalar);
  if (scalarExact !== null) return scalarExact;
  return exactByteFromKnownBits(byte.bits);
}

export function nzFlagsFromByte(value) {
  const byte = abstractByteFromSerializable(value);
  const exact = exactValueFromByte(byte);
  if (exact !== null) {
    return {
      n: boolFlag((exact & 0x80) !== 0),
      z: boolFlag((exact & 0xff) === 0)
    };
  }
  return nzFlagsFromKnownBits(byte.bits);
}

export function byteAndImmediate(value, imm, options = {}) {
  const byte = abstractByteFromSerializable(value);
  return reduceByte({
    scalar: mapScalar(byte.scalar, (item) => item & (imm & 0xff), options),
    bits: knownBitsAndImmediate(byte.bits, imm)
  }, options);
}

export function byteOrImmediate(value, imm, options = {}) {
  const byte = abstractByteFromSerializable(value);
  return reduceByte({
    scalar: mapScalar(byte.scalar, (item) => item | (imm & 0xff), options),
    bits: knownBitsOrImmediate(byte.bits, imm)
  }, options);
}

export function byteEorImmediate(value, imm, options = {}) {
  const byte = abstractByteFromSerializable(value);
  return reduceByte({
    scalar: mapScalar(byte.scalar, (item) => item ^ (imm & 0xff), options),
    bits: knownBitsEorImmediate(byte.bits, imm)
  }, options);
}

export function byteInc(value, options = {}) {
  const byte = abstractByteFromSerializable(value);
  return reduceByte({
    scalar: mapScalar(byte.scalar, (item) => (item + 1) & 0xff, options),
    bits: knownBitsInc(byte.bits)
  }, options);
}

export function byteDec(value, options = {}) {
  const byte = abstractByteFromSerializable(value);
  return reduceByte({
    scalar: mapScalar(byte.scalar, (item) => (item - 1) & 0xff, options),
    bits: knownBitsDec(byte.bits)
  }, options);
}

export function byteAsl(value, options = {}) {
  const byte = abstractByteFromSerializable(value);
  const shifted = knownBitsAsl(byte.bits);
  return {
    result: reduceByte({
      scalar: mapScalar(byte.scalar, (item) => (item << 1) & 0xff, options),
      bits: shifted.result
    }, options),
    carry: shifted.carry
  };
}

export function byteLsr(value, options = {}) {
  const byte = abstractByteFromSerializable(value);
  const shifted = knownBitsLsr(byte.bits);
  return {
    result: reduceByte({
      scalar: mapScalar(byte.scalar, (item) => item >>> 1, options),
      bits: shifted.result
    }, options),
    carry: shifted.carry
  };
}

function carryValues(carryFlag) {
  if (carryFlag === FLAG_VALUE.FALSE) return [0];
  if (carryFlag === FLAG_VALUE.TRUE) return [1];
  return [0, 1];
}

function mapRotateScalar(scalar, mapper, options = {}) {
  const sourceValues = scalarToValues(scalar, 256);
  if (!sourceValues) return topScalar();
  const out = [];
  for (const value of sourceValues) {
    for (const mapped of mapper(value)) out.push(mapped & 0xff);
  }
  return summarizeValues(out, options);
}

export function byteRol(value, carryFlag, options = {}) {
  const byte = abstractByteFromSerializable(value);
  const shifted = knownBitsRol(byte.bits, carryFlag);
  const carries = carryValues(carryFlag);
  return {
    result: reduceByte({
      scalar: mapRotateScalar(byte.scalar, (item) => carries.map((carry) => ((item << 1) | carry) & 0xff), options),
      bits: shifted.result
    }, options),
    carry: shifted.carry
  };
}

export function byteRor(value, carryFlag, options = {}) {
  const byte = abstractByteFromSerializable(value);
  const shifted = knownBitsRor(byte.bits, carryFlag);
  const carries = carryValues(carryFlag);
  return {
    result: reduceByte({
      scalar: mapRotateScalar(byte.scalar, (item) => carries.map((carry) => ((item >>> 1) | (carry ? 0x80 : 0x00)) & 0xff), options),
      bits: shifted.result
    }, options),
    carry: shifted.carry
  };
}
