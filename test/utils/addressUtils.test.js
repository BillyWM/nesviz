import { describe, expect, it } from 'vitest';

import {
  addressKey,
  canonicalizeCpuAddr,
  memKey,
  normalizeAddr,
  normalizeCpuAddr,
  normalizeCpuAddrSet,
  normalizeRomOff,
  parseAddressKey
} from '../../src/shared/utils/addressUtils.js';

describe('address normalization utilities', () => {
  it('normalizes ROM offsets as non-negative unsigned values', () => {
    expect(normalizeRomOff(0)).toBe(0);
    expect(normalizeRomOff('123')).toBe(123);
    expect(normalizeRomOff(0xffffffff + 1)).toBe(0);
    expect(normalizeRomOff(-1)).toBeNull();
    expect(normalizeRomOff(Number.NaN)).toBeNull();
    expect(normalizeRomOff(undefined)).toBeNull();
  });

  it('normalizes CPU addresses as non-negative 16-bit values', () => {
    expect(normalizeCpuAddr(0)).toBe(0);
    expect(normalizeCpuAddr('65535')).toBe(0xffff);
    expect(normalizeCpuAddr(0x10000)).toBe(0);
    expect(normalizeCpuAddr(0x12345)).toBe(0x2345);
    expect(normalizeCpuAddr(-1)).toBeNull();
    expect(normalizeCpuAddr(Number.NaN)).toBeNull();
  });

  it('canonicalizes CPU address spaces and RAM mirrors', () => {
    expect(canonicalizeCpuAddr(0x0000)).toEqual({ space: 'zp', addr: 0x0000 });
    expect(canonicalizeCpuAddr(0x00ff)).toEqual({ space: 'zp', addr: 0x00ff });
    expect(canonicalizeCpuAddr(0x0100)).toEqual({ space: 'ram', addr: 0x0100 });
    expect(canonicalizeCpuAddr(0x07ff)).toEqual({ space: 'ram', addr: 0x07ff });
    expect(canonicalizeCpuAddr(0x0800)).toEqual({ space: 'zp', addr: 0x0000 });
    expect(canonicalizeCpuAddr(0x17ff)).toEqual({ space: 'ram', addr: 0x07ff });
    expect(canonicalizeCpuAddr(0x2000)).toEqual({ space: 'io', addr: 0x2000 });
    expect(canonicalizeCpuAddr(0x401f)).toEqual({ space: 'io', addr: 0x401f });
    expect(canonicalizeCpuAddr(0x4020)).toEqual({ space: 'other', addr: 0x4020 });
    expect(canonicalizeCpuAddr(0x6000)).toEqual({ space: 'prgram', addr: 0x6000 });
    expect(canonicalizeCpuAddr(0x7fff)).toEqual({ space: 'prgram', addr: 0x7fff });
    expect(canonicalizeCpuAddr(0x8000)).toEqual({ space: 'rom', addr: 0x8000 });
    expect(canonicalizeCpuAddr(-1)).toEqual({ space: 'rom', addr: 0xffff });
  });

  it('dedupes, sorts, wraps, and bounds CPU address sets', () => {
    expect(normalizeCpuAddrSet([0x10000, '1', 0xffff, 1, Number.NaN])).toEqual([0x0000, 0x0001, 0xffff]);
    expect(normalizeCpuAddrSet([])).toBeNull();
    expect(normalizeCpuAddrSet(null)).toBeNull();
    expect(normalizeCpuAddrSet([1, 2], 1)).toBeNull();
    expect(normalizeCpuAddrSet([1, 2], 0)).toBeNull();
    expect(normalizeCpuAddrSet([1], 0)).toEqual([1]);
  });

  it('normalizes addresses by space using current wrapping behavior', () => {
    expect(normalizeAddr('rom', -1)).toBe(0xffffffff);
    expect(normalizeAddr('rom', 0xffffffff + 1)).toBe(0);
    expect(normalizeAddr('cpu', -1)).toBe(0xffff);
    expect(normalizeAddr('ram', 0x12345)).toBe(0x2345);
  });
});

describe('address key utilities', () => {
  it('parses decimal address keys using ROM unsigned and non-ROM 16-bit wrapping', () => {
    expect(parseAddressKey('rom:123')).toEqual({ space: 'rom', addr: 123 });
    expect(parseAddressKey('rom:-1')).toEqual({ space: 'rom', addr: 0xffffffff });
    expect(parseAddressKey('cpu:-1')).toEqual({ space: 'cpu', addr: 0xffff });
    expect(parseAddressKey('zp:65536')).toEqual({ space: 'zp', addr: 0 });
  });

  it('locks down permissive parseInt key parsing', () => {
    expect(parseAddressKey('rom:12x')).toEqual({ space: 'rom', addr: 12 });
    expect(parseAddressKey('rom:0x10')).toEqual({ space: 'rom', addr: 0 });
  });

  it('rejects invalid address keys', () => {
    expect(parseAddressKey('')).toBeNull();
    expect(parseAddressKey('rom')).toBeNull();
    expect(parseAddressKey(':123')).toBeNull();
    expect(parseAddressKey('rom:abc')).toBeNull();
    expect(parseAddressKey(null)).toBeNull();
  });

  it('formats validated address keys', () => {
    expect(addressKey('rom', -1)).toBe('rom:4294967295');
    expect(addressKey('rom', 0xffffffff + 1)).toBe('rom:0');
    expect(addressKey('cpu', -1)).toBe('cpu:65535');
    expect(addressKey('zp', 0x10000)).toBe('zp:0');
    expect(addressKey('', 1)).toBeNull();
    expect(addressKey('rom', Number.NaN)).toBeNull();
    expect(addressKey('rom', '123')).toBeNull();
  });

  it('formats memory keys without validating space or finite numeric input first', () => {
    expect(memKey('rom', -1)).toBe('rom:4294967295');
    expect(memKey('cpu', -1)).toBe('cpu:65535');
    expect(memKey('', 1)).toBe(':1');
    expect(memKey('cpu', Number.NaN)).toBe('cpu:0');
  });
});
