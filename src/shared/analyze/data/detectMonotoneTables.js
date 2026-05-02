import { hexN } from '../../cpu6502/fmt.js';

function u16le(prgBytes, off) {
  return (prgBytes[off] | (prgBytes[off + 1] << 8)) & 0xffff;
}

function findNonCodeRanges(codeBitmap, minBytes) {
  const bm = codeBitmap || new Uint8Array(0);
  const ranges = [];
  let i = 0;
  while (i < bm.length) {
    while (i < bm.length && bm[i] !== 0) i++;
    const start = i;
    while (i < bm.length && bm[i] === 0) i++;
    const end = i;
    if ((end - start) >= minBytes) ranges.push({ start, end });
  }
  return ranges;
}

function flushRun(out, prgBytes, runStart, runWordOffsets, minEntries) {
  if (runStart == null || !Array.isArray(runWordOffsets) || runWordOffsets.length < minEntries) return;
  const values = runWordOffsets.map((off) => u16le(prgBytes, off));
  const deltas = [];
  for (let i = 1; i < values.length; i++) deltas.push((values[i] - values[i - 1]) & 0xffff);
  const romStart = runStart >>> 0;
  const romEnd = (runWordOffsets[runWordOffsets.length - 1] + 2) >>> 0;
  out.push({
    id: `monotoneTable:${hexN(romStart, 6)}`,
    kind: 'monotoneTable',
    romStart,
    romEnd,
    entryCount: values.length,
    values,
    deltas,
    interpretationKinds: ['raw16', 'offsetFromUnknownBase'],
    readers: [],
    promotedToPointerTable: false
  });
}

export function detectMonotoneTables({ prgBytes, codeBitmap, minEntries = 4 }) {
  const minCount = Math.max(2, minEntries | 0);
  const minBytes = Math.max(4, minCount * 2);
  const ranges = findNonCodeRanges(codeBitmap, minBytes);
  const out = [];

  for (const range of ranges) {
    for (let parity = 0; parity < 2; parity++) {
      let off = range.start + (((parity - (range.start & 1)) + 2) & 1);
      let runStart = null;
      let runWordOffsets = [];
      let prev = null;

      while ((off + 1) < range.end) {
        const value = u16le(prgBytes, off);
        if (prev == null || value > prev) {
          if (runStart == null) runStart = off;
          runWordOffsets.push(off);
        } else {
          flushRun(out, prgBytes, runStart, runWordOffsets, minCount);
          runStart = off;
          runWordOffsets = [off];
        }
        prev = value;
        off += 2;
      }

      flushRun(out, prgBytes, runStart, runWordOffsets, minCount);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const table of out.sort((a, b) => a.romStart - b.romStart || a.romEnd - b.romEnd)) {
    const key = `${table.romStart}:${table.romEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(table);
  }
  return deduped;
}
