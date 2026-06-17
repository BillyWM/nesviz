import {
  bottomScalar,
  intersectScalar,
  scalarFromSerializable,
  scalarToValues,
  summarizeValues,
  topScalar
} from './byteScalarDomain.js';
import {
  knownBitsFromSerializable,
  knownBitsFromValues,
  meetKnownBits,
  topKnownBits
} from './knownBitsDomain.js';

function scalarFromBits(bits, options = {}) {
  const normalized = knownBitsFromSerializable(bits);
  if (normalized.kind === 'bottom') return bottomScalar();
  if (normalized.knownMask === 0x00) return topScalar();
  const values = [];
  for (let value = 0; value <= 0xff; value += 1) {
    if ((value & normalized.knownMask) === normalized.knownValue) values.push(value);
  }
  return summarizeValues(values, options);
}

function bitsFromScalar(scalar) {
  const values = scalarToValues(scalarFromSerializable(scalar), 256);
  if (!values) return topKnownBits();
  return knownBitsFromValues(values);
}

export function reduceByte(byte, options = {}) {
  const source = byte || {};
  let scalar = source.scalar ? scalarFromSerializable(source.scalar) : topScalar();
  let bits = source.bits ? knownBitsFromSerializable(source.bits) : topKnownBits();

  const bitsImpliedByScalar = bitsFromScalar(scalar);
  bits = meetKnownBits(bits, bitsImpliedByScalar);
  if (bits.kind === 'bottom') return { scalar: bottomScalar(), bits };

  const scalarImpliedByBits = scalarFromBits(bits, options);
  scalar = intersectScalar(scalar, scalarImpliedByBits, options);
  if (scalar.kind === 'bottom') return { scalar, bits: knownBitsFromValues([]) };

  bits = meetKnownBits(bits, bitsFromScalar(scalar));
  return { scalar, bits };
}

export function reduceRegisters(registers, options = {}) {
  return {
    a: reduceByte(registers.a, options),
    x: reduceByte(registers.x, options),
    y: reduceByte(registers.y, options),
    s: reduceByte(registers.s, options)
  };
}

export function reduceState(state, options = {}) {
  if (!state || state.kind === 'bottom') return state;
  return {
    ...state,
    registers: reduceRegisters(state.registers, options),
    ramBytes: state.ramBytes && state.ramBytes.entries
      ? {
          entries: new Map(Array.from(state.ramBytes.entries.entries()).map(([addr, byte]) => [addr, reduceByte(byte, options)]))
        }
      : state.ramBytes
  };
}
