import { describe, expect, it } from 'vitest';

import { formatBytes, formatKiB, formatMb } from '../../src/shared/utils/byteUtils.js';
import { bufferToHex, fmtHex, fmtHexRange } from '../../src/shared/utils/numberUtils.js';
import { fmtMetric, fmtPercent } from '../../src/shared/utils/numberUtils.js';
import {
  fmtCpuAddr,
  hex2 as cpuHex2,
  hex4 as cpuHex4,
  hexN as cpuHexN
} from '../../src/shared/cpu6502/fmt.js';
import {
  hex4 as rendererHex4,
  hex6 as rendererHex6,
  hexN as rendererHexN
} from '../../src/renderer/src/util/hex.js';
import { formatHexDump } from '../../src/renderer/src/utils/hexDumpUtils.js';

describe('hex formatting utilities', () => {
  it('formats finite values as uppercase hex with minimum width', () => {
    expect(fmtHex(0x2a, 4)).toBe('002A');
    expect(fmtHex(0xffff, 4)).toBe('FFFF');
    expect(fmtHex(0x10000, 4)).toBe('10000');
    expect(fmtHex(0x2a, 0)).toBe('2A');
  });

  it('normalizes invalid and negative values', () => {
    expect(fmtHex(-5, 4)).toBe('0000');
    expect(fmtHex(Number.NaN, 4)).toBe('????');
    expect(fmtHex(Infinity, 2)).toBe('??');
  });

  it('locks down direct fmtHex coercion and width behavior', () => {
    expect(fmtHex(15.9, 2)).toBe('0F');
    expect(fmtHex('15', 2)).toBe('0F');
    expect(fmtHex(null, 2)).toBe('00');
    expect(fmtHex(undefined, 2)).toBe('??');
    expect(fmtHex(15, -2)).toBe('F');
    expect(fmtHex(Number.NaN, -2)).toBe('');
  });

  it('formats exclusive-end ranges', () => {
    expect(fmtHexRange(0x10, 0x20, 4)).toBe('0010-001F');
    expect(fmtHexRange(0, 1, 2)).toBe('00-00');
  });

  it('locks down fmtHexRange endpoint normalization', () => {
    expect(fmtHexRange(0x10, Number.NaN, 4)).toBe('0010-0000');
    expect(fmtHexRange(0x20, 0x10, 4)).toBe('0020-000F');
    expect(fmtHexRange(16.9, 32.9, 4)).toBe('0010-001F');
  });

  it('formats buffers as lowercase byte hex and truncates long output', () => {
    expect(bufferToHex(Uint8Array.from([0x00, 0x0a, 0xff]))).toBe('00 0a ff');
    expect(bufferToHex(Uint8Array.from([0x00, 0x0a, 0xff]), 2)).toBe('00 0a …(+1 bytes)');
    expect(bufferToHex(Uint8Array.from([]))).toBe('');
    expect(bufferToHex(null)).toBe('');
  });

  it('locks down bufferToHex boundary and maxBytes behavior', () => {
    expect(bufferToHex([0x00, 0x0a, 0xff])).toBe('00 0a ff');
    expect(bufferToHex(Uint8Array.from([0x01, 0x02]), 2)).toBe('01 02');
    expect(bufferToHex(Uint8Array.from([0x01, 0x02]), 1)).toBe('01 …(+1 bytes)');
    expect(bufferToHex(Uint8Array.from([0x01, 0x02]), Number.NaN)).toBe('01 02');
  });
});

describe('byte formatting utilities', () => {
  it('formats byte counts without raw values', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KiB');
    expect(formatBytes(2048)).toBe('2 KiB');
    expect(formatBytes(1536)).toBe('1536 B');
  });

  it('locks down byte-count coercion without raw values', () => {
    expect(formatBytes(-1024)).toBe('-1 KiB');
    expect(formatBytes(-1536)).toBe('-1536 B');
    expect(formatBytes('1024')).toBe('1 KiB');
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
    expect(formatBytes(1.5)).toBe('1.5 B');
    expect(formatBytes(1024, null)).toBe('1 KiB');
  });

  it('formats invalid byte counts according to options', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.NaN, { emptyOnInvalid: true })).toBe('');
  });

  it('formats byte counts with raw values', () => {
    expect(formatBytes(512, { includeRaw: true })).toBe('512');
    expect(formatBytes(1024, { includeRaw: true })).toBe('1024 (1.0 KiB)');
    expect(formatBytes(1024 * 1024, { includeRaw: true })).toBe('1048576 (1.0 MiB)');
    expect(formatBytes(1024, { includeRaw: true, precision: 2 })).toBe('1024 (1.00 KiB)');
    expect(formatBytes(-1024, { includeRaw: true })).toBe('-1024 (-1.0 KiB)');
  });

  it('formats megabytes and kibibytes', () => {
    expect(formatMb(1.234)).toBe('1.2 MB');
    expect(formatMb(Number.NaN)).toBe('0.0 MB');
    expect(formatKiB(2048)).toBe('2 KiB');
    expect(formatKiB(1536)).toBe('1.50 KiB');
    expect(formatKiB(null)).toBe('');
    expect(formatKiB(Number.NaN)).toBe('');
  });

  it('locks down megabyte and kibibyte coercion behavior', () => {
    expect(formatMb(-1.234)).toBe('-1.2 MB');
    expect(formatMb('1.25')).toBe('1.3 MB');
    expect(formatMb(0)).toBe('0.0 MB');
    expect(formatKiB(0)).toBe('0 KiB');
    expect(formatKiB(-1024)).toBe('-1 KiB');
    expect(formatKiB('2048')).toBe('');
  });
});

describe('number formatting utilities', () => {
  it('formats metrics with fixed precision or exponential notation for tiny values', () => {
    expect(fmtMetric(1.2345678)).toBe('1.234568');
    expect(fmtMetric(0)).toBe('0.000000');
    expect(fmtMetric(0.000000123)).toBe('1.230e-7');
    expect(fmtMetric(Number.NaN)).toBe('n/a');
  });

  it('locks down metric coercion and edge behavior', () => {
    expect(fmtMetric(-1.2345678)).toBe('-1.234568');
    expect(fmtMetric(-0.000000123)).toBe('-1.230e-7');
    expect(fmtMetric(Infinity)).toBe('n/a');
    expect(fmtMetric('1.2')).toBe('1.200000');
  });

  it('formats percentages', () => {
    expect(fmtPercent(12.3456)).toBe('12.35%');
    expect(fmtPercent(0)).toBe('0.00%');
    expect(fmtPercent(Number.NaN)).toBe('n/a');
  });

  it('locks down percentage coercion and edge behavior', () => {
    expect(fmtPercent(-12.3456)).toBe('-12.35%');
    expect(fmtPercent(Infinity)).toBe('n/a');
    expect(fmtPercent('1.2')).toBe('1.20%');
  });
});

describe('6502 formatting utilities', () => {
  it('formats wrapped CPU-sized hex values', () => {
    expect(cpuHex2(0x123)).toBe('23');
    expect(cpuHex4(0x12345)).toBe('2345');
    expect(cpuHexN(0x123, 6)).toBe('000123');
    expect(fmtCpuAddr(0xc000)).toBe('$C000');
  });

  it('locks down CPU formatter bitmask and coercion behavior', () => {
    expect(cpuHex2(-1)).toBe('FF');
    expect(cpuHex4(-1)).toBe('FFFF');
    expect(cpuHexN(-1, 4)).toBe('FFFFFFFF');
    expect(fmtCpuAddr(-1)).toBe('$FFFF');
    expect(cpuHex2(Number.NaN)).toBe('00');
    expect(cpuHex4(Number.NaN)).toBe('0000');
    expect(cpuHexN(Number.NaN, 4)).toBe('0000');
    expect(cpuHex4('4660')).toBe('1234');
    expect(cpuHexN('4660', 4)).toBe('1234');
  });
});

describe('renderer hex formatting wrappers', () => {
  it('formats wrapped renderer hex values', () => {
    expect(rendererHex4(0x12345)).toBe('2345');
    expect(rendererHex6(0x12345)).toBe('012345');
    expect(rendererHexN(0x2a, 4)).toBe('002A');
  });

  it('locks down renderer formatter bitmask and coercion behavior', () => {
    expect(rendererHex4(-1)).toBe('FFFF');
    expect(rendererHex6(-1)).toBe('FFFFFFFF');
    expect(rendererHexN(-1, 4)).toBe('FFFFFFFF');
    expect(rendererHex4(Number.NaN)).toBe('0000');
    expect(rendererHex6(Number.NaN)).toBe('000000');
    expect(rendererHexN(Number.NaN, 4)).toBe('0000');
    expect(rendererHex4('4660')).toBe('1234');
  });
});

describe('hex dump formatting utility', () => {
  it('returns empty output for non-array or empty input', () => {
    expect(formatHexDump(null)).toBe('');
    expect(formatHexDump(Uint8Array.from([0]))).toBe('');
    expect(formatHexDump([])).toBe('');
  });

  it('formats byte arrays into uppercase 16-byte lines', () => {
    expect(formatHexDump([0, 10, 255])).toBe('00 0A FF');

    const bytes = Array.from({ length: 17 }, (_, i) => i);
    expect(formatHexDump(bytes)).toBe(
      '00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F\n10'
    );
  });

  it('locks down 16-byte line boundaries', () => {
    expect(formatHexDump(Array.from({ length: 16 }, (_, i) => i))).toBe(
      '00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F'
    );

    expect(formatHexDump(Array.from({ length: 32 }, (_, i) => i))).toBe(
      '00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F\n' +
        '10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F'
    );
  });

  it('locks down unmasked value coercion in hex dumps', () => {
    expect(formatHexDump([-1, 256, 1.9, Number.NaN, Infinity, '15', {}])).toBe(
      '00 100 01 ?? ?? 0F ??'
    );
  });
});
