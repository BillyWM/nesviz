import { hex2, hex4 } from '../../cpu6502/fmt.js';
import { FLAG_NAMES, FLAG_VALUE } from '../domains/flagsDomain.js';
import {
  abstractByteFromSerializable,
  byteEqual,
  exactValueFromByte,
  isTopByte
} from '../abstractInterpretation/abstractByteDomain.js';
import { scalarToValues } from '../abstractInterpretation/byteScalarDomain.js';
import { readByteAt } from '../abstractInterpretation/byteMemory.js';
import { isBottomState } from '../abstractInterpretation/state.js';
import { formatMapperDeltaDetails, formatMapperState } from './formatMapperState.js';

const REGISTER_NAMES = Object.freeze(['a', 'x', 'y', 's']);
const MAX_RAM_DETAILS = 12;

function flagText(flag) {
  if (flag === FLAG_VALUE.TRUE) return '1';
  if (flag === FLAG_VALUE.FALSE) return '0';
  if (flag === FLAG_VALUE.BOTTOM) return 'bottom';
  return '?';
}

function bitPattern(bits) {
  const normalized = bits || { kind: 'bits', knownMask: 0, knownValue: 0 };
  if (normalized.kind === 'bottom') return 'bottom';
  let out = '';
  for (let bit = 7; bit >= 0; bit -= 1) {
    const mask = 1 << bit;
    if ((normalized.knownMask & mask) === 0) out += '?';
    else out += (normalized.knownValue & mask) !== 0 ? '1' : '0';
  }
  return out;
}

function formatBits(bits) {
  if (!bits || bits.kind === 'bottom') return 'bottom';
  if (bits.knownMask === 0xff) return `$${hex2(bits.knownValue)}`;
  return bitPattern(bits);
}

function formatScalar(scalar) {
  if (!scalar || scalar.kind === 'top') return '?';
  if (scalar.kind === 'bottom') return 'bottom';
  if (scalar.kind === 'set') {
    if (scalar.values.length === 1) return `$${hex2(scalar.values[0])}`;
    if (scalar.values.length <= 6) return `{${scalar.values.map((value) => `$${hex2(value)}`).join(',')}}`;
    return `{${scalar.values.slice(0, 6).map((value) => `$${hex2(value)}`).join(',')}...+${scalar.values.length - 6}}`;
  }
  const stepText = scalar.step && scalar.step !== 1 ? ` step ${scalar.step}` : '';
  return `$${hex2(scalar.min)}..$${hex2(scalar.max)}${stepText}`;
}

export function formatAbstractByte(byte) {
  const normalized = abstractByteFromSerializable(byte);
  const exact = exactValueFromByte(normalized);
  if (exact !== null) return `$${hex2(exact)}`;
  if (isTopByte(normalized)) return '?';
  const scalarText = formatScalar(normalized.scalar);
  const bitsText = formatBits(normalized.bits);
  if (scalarText === '?' && bitsText === '????????') return '?';
  if (scalarText === '?') return bitsText;
  if (bitsText === '????????') return scalarText;

  const values = scalarToValues(normalized.scalar, 256);
  const bitsValues = values?.every((value) => (value & normalized.bits.knownMask) === normalized.bits.knownValue);
  return bitsValues ? scalarText : `${scalarText} bits=${bitsText}`;
}

export function formatFlags(flags) {
  const source = flags || {};
  return FLAG_NAMES.map((name) => `${name.toUpperCase()}=${flagText(source[name])}`).join(' ');
}

export function formatRegisters(registers) {
  const source = registers || {};
  return REGISTER_NAMES.map((name) => `${name.toUpperCase()}=${formatAbstractByte(source[name])}`).join(' ');
}

function formatRamEntry(addr, byte) {
  return `$${hex4(addr & 0x07ff)}=${formatAbstractByte(byte)}`;
}

export function formatRamBytes(memory, limit = MAX_RAM_DETAILS) {
  if (!memory?.entries || memory.entries.size === 0) return 'RAM: none';
  const entries = Array.from(memory.entries.entries()).sort((a, b) => a[0] - b[0]);
  const shown = entries.slice(0, limit).map(([addr, byte]) => formatRamEntry(addr, byte));
  const hidden = entries.length - shown.length;
  return hidden > 0 ? `RAM: ${shown.join(' ')} +${hidden} more` : `RAM: ${shown.join(' ')}`;
}

export function formatAbstractStateSummary(state, options = {}) {
  if (isBottomState(state)) return 'unreachable';
  const mapperText = formatMapperState(state.mapperState, options);
  const baseText = `${formatRegisters(state.registers)} | ${formatFlags(state.flags)}`;
  return mapperText ? `${baseText} | ${mapperText}` : baseText;
}

function flagDeltaDetails(before, after) {
  const out = [];
  const left = before?.flags || {};
  const right = after?.flags || {};
  for (const name of FLAG_NAMES) {
    if (left[name] !== right[name]) out.push(`${name.toUpperCase()}: ${flagText(left[name])} -> ${flagText(right[name])}`);
  }
  return out;
}

function registerDeltaDetails(before, after) {
  const out = [];
  const left = before?.registers || {};
  const right = after?.registers || {};
  for (const name of REGISTER_NAMES) {
    if (!byteEqual(left[name], right[name])) {
      out.push(`${name.toUpperCase()}: ${formatAbstractByte(left[name])} -> ${formatAbstractByte(right[name])}`);
    }
  }
  return out;
}

function memoryKeys(memory) {
  if (!memory?.entries) return [];
  return Array.from(memory.entries.keys()).sort((a, b) => a - b);
}

function memoryDeltaDetails(before, after) {
  const out = [];
  const keys = new Set([...memoryKeys(before?.ramBytes), ...memoryKeys(after?.ramBytes)]);
  const sorted = Array.from(keys).sort((a, b) => a - b);
  for (const addr of sorted) {
    const oldByte = readByteAt(before.ramBytes, addr);
    const newByte = readByteAt(after.ramBytes, addr);
    if (byteEqual(oldByte, newByte)) continue;
    if (out.length >= MAX_RAM_DETAILS) {
      out.push(`+${sorted.length - MAX_RAM_DETAILS} more RAM changes`);
      break;
    }
    const next = isTopByte(newByte) ? '?' : formatAbstractByte(newByte);
    out.push(`RAM $${hex4(addr & 0x07ff)}: ${formatAbstractByte(oldByte)} -> ${next}`);
  }
  return out;
}

export function formatStateDeltaDetails(before, after, options = {}) {
  if (isBottomState(before) || isBottomState(after)) return [];
  return [
    ...registerDeltaDetails(before, after),
    ...flagDeltaDetails(before, after),
    ...memoryDeltaDetails(before, after),
    ...formatMapperDeltaDetails(before, after, options)
  ];
}
