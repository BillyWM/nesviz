import { describe, expect, it } from 'vitest';

import {
  bufferToHex,
  clamp,
  clamp8,
  clampNumber,
  clampSigned,
  fmtHex,
  fmtHexRange,
  fmtMetric,
  fmtPercent,
  parseLeadingInt
} from '../../src/shared/utils/numberUtils.js';

describe('number utilities', () => {
  it('clamps numeric values with existing behavior', () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-1, 1, 10)).toBe(1);
    expect(clamp(99, 1, 10)).toBe(10);

    expect(clampNumber('5', 1, 10)).toBe(5);
    expect(clampNumber(Number.NaN, 1, 10)).toBe(1);
    expect(clampSigned(-99, 10)).toBe(-10);
    expect(clampSigned(99, 10)).toBe(10);
    expect(clamp8(-1)).toBe(0xff);
  });

  it('formats metrics and percentages', () => {
    expect(fmtMetric(1.2345678)).toBe('1.234568');
    expect(fmtMetric(0.000000123)).toBe('1.230e-7');
    expect(fmtMetric(Number.NaN)).toBe('n/a');

    expect(fmtPercent(12.3456)).toBe('12.35%');
    expect(fmtPercent(0)).toBe('0.00%');
    expect(fmtPercent(Infinity)).toBe('n/a');
  });

  it('parses leading integers', () => {
    expect(parseLeadingInt(12)).toBe(12);
    expect(parseLeadingInt(Number.NaN)).toBe(null);
    expect(parseLeadingInt('123abc')).toBe(123);
    expect(parseLeadingInt('  -42 px')).toBe(-42);
    expect(parseLeadingInt('abc123')).toBe(null);
  });

  it('formats hex values and exclusive-end ranges', () => {
    expect(fmtHex(0x2a, 4)).toBe('002A');
    expect(fmtHex(0x10000, 4)).toBe('10000');
    expect(fmtHex(Number.NaN, 4)).toBe('????');
    expect(fmtHex(-5, 4)).toBe('0000');

    expect(fmtHexRange(0x10, 0x20, 4)).toBe('0010-001F');
    expect(fmtHexRange(0x10, Number.NaN, 4)).toBe('0010-0000');
  });

  it('formats buffers as lowercase byte hex', () => {
    expect(bufferToHex(Uint8Array.from([0x00, 0x0a, 0xff]))).toBe('00 0a ff');
    expect(bufferToHex(Uint8Array.from([0x00, 0x0a, 0xff]), 2)).toBe('00 0a …(+1 bytes)');
    expect(bufferToHex(Uint8Array.from([]))).toBe('');
    expect(bufferToHex(null)).toBe('');
  });
});
