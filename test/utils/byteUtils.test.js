import { describe, expect, it } from 'vitest';

import {
  computeShannonEntropyByte,
  formatBytes,
  formatKiB,
  formatMb,
  parseBytesText,
  read8,
  read16le,
  readLenString,
  readUint32Le,
  s8,
  u16le
} from '../../src/shared/utils/byteUtils.js';

describe('byte utilities', () => {
  it('reads byte and little-endian integer values with existing bounds behavior', () => {
    const bytes = Uint8Array.from([0x12, 0x34, 0x56, 0x78]);

    expect(read8(bytes, 0)).toBe(0x12);
    expect(read8(bytes, 1, 1)).toBe(0x56);
    expect(read8(bytes, 99)).toBe(0);
    expect(read8(null, 0)).toBe(0);

    expect(read16le(bytes, 0)).toBe(0x3412);
    expect(read16le(bytes, 2)).toBe(0x7856);
    expect(read16le(bytes, 3)).toBe(0x0078);
    expect(u16le(bytes, 1)).toBe(0x5634);
  });

  it('converts signed bytes and reads unsigned 32-bit little-endian values', () => {
    expect(s8(0x00)).toBe(0);
    expect(s8(0x7f)).toBe(127);
    expect(s8(0x80)).toBe(-128);
    expect(s8(0xff)).toBe(-1);
    expect(s8(0x1ff)).toBe(-1);

    expect(readUint32Le(Uint8Array.from([0x78, 0x56, 0x34, 0x12]), 0)).toBe(0x12345678);
    expect(readUint32Le(Uint8Array.from([0xff, 0xff, 0xff, 0xff]), 0)).toBe(0xffffffff);
    expect(readUint32Le(Uint8Array.from([0x00, 0x01, 0x02]), 0)).toBe(null);
  });

  it('reads length-prefixed strings from Buffer values', () => {
    const buf = Buffer.concat([
      Buffer.from([0x03, 0x00]),
      Buffer.from('abc'),
      Buffer.from([0x02, 0x00]),
      Buffer.from('xy')
    ]);

    expect(readLenString(buf, 0)).toEqual({ value: 'abc', offset: 5 });
    expect(readLenString(buf, 5)).toEqual({ value: 'xy', offset: 9 });
    expect(() => readLenString(Buffer.from([0x03, 0x00, 0x61]), 0)).toThrow('Truncated string bytes');
  });

  it('formats byte counts and sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KiB');
    expect(formatBytes(1536)).toBe('1536 B');
    expect(formatBytes(1024, { includeRaw: true, precision: 2 })).toBe('1024 (1.00 KiB)');
    expect(formatBytes(Number.NaN, { emptyOnInvalid: true })).toBe('');

    expect(formatMb(1.234)).toBe('1.2 MB');
    expect(formatMb(Number.NaN)).toBe('0.0 MB');
    expect(formatKiB(2048)).toBe('2 KiB');
    expect(formatKiB(1536)).toBe('1.50 KiB');
    expect(formatKiB(null)).toBe('');
  });

  it('computes quantized byte entropy', () => {
    expect(computeShannonEntropyByte(Uint8Array.from([]), 0, 0)).toBe(0);
    expect(computeShannonEntropyByte(Uint8Array.from([0, 0, 0, 0]), 0, 4)).toBe(0);
    expect(computeShannonEntropyByte(Uint8Array.from([0, 1]), 0, 2)).toBe(32);
    expect(computeShannonEntropyByte(Uint8Array.from([0, 1, 2, 3]), 1, 3)).toBe(32);
  });

  it('parses byte text', () => {
    expect(parseBytesText('00 0a FF')).toEqual([0x00, 0x0a, 0xff]);
    expect(parseBytesText('100')).toEqual([0x00]);
    expect(parseBytesText('00 zz 02')).toEqual([]);
    expect(parseBytesText('00 zz 02', { strict: false })).toEqual([0x00, 0x02]);
    expect(parseBytesText(null)).toEqual([]);
  });
});
