import { sizeClass } from '../model.js';

// The timeline is a physical (ROM-offset) view that stitches together discovered code blocks with "unknown" / "data" gaps. 🤖
// We intentionally only show the span that is "near" inferred information: from the first discovered block to the last. 🤖

export function buildTimeline({ prgSize, blocks, bitmap }) {
  // If no blocks were discovered but we have a bitmap (e.g. from a CDL import),
  // still show the observed span so the user can see what was touched. 🤖
  if (!blocks.length) {
    if (!bitmap || bitmap.length === 0) return [];
    let first = -1;
    let last = -1;
    for (let i = 0; i < Math.min(prgSize, bitmap.length); i++) {
      if (bitmap[i] !== 0) {
        first = i;
        break;
      }
    }
    for (let i = Math.min(prgSize, bitmap.length) - 1; i >= 0; i--) {
      if (bitmap[i] !== 0) {
        last = i;
        break;
      }
    }
    if (first === -1 || last === -1) return [];
    const items = [];
    let runStart = first;
    let cur = bitmap[runStart] ?? 0;
    for (let i = first + 1; i <= last; i++) {
      const v = bitmap[i] ?? 0;
      if (v !== cur) {
        const len = i - runStart;
        items.push(makeGapItem(cur, runStart, len));
        runStart = i;
        cur = v;
      }
    }
    const finalLen = (last + 1) - runStart;
    if (finalLen > 0) items.push(makeGapItem(cur, runStart, finalLen));
    return items;
  }

  const sorted = [...blocks].sort((a, b) => a.romStart - b.romStart);
  const byStart = new Map(sorted.map((b) => [b.romStart, b]));

  // Extend the visible span to include any observed data bytes (bitmap != 0), not just decoded blocks. 🤖
  let minOff = sorted[0].romStart;
  let maxOff = sorted.reduce((m, b) => Math.max(m, b.romEnd), 0);
  if (bitmap && bitmap.length) {
    for (let i = 0; i < Math.min(prgSize, bitmap.length); i++) {
      if (bitmap[i] !== 0) {
        minOff = Math.min(minOff, i);
        break;
      }
    }
    for (let i = Math.min(prgSize, bitmap.length) - 1; i >= 0; i--) {
      if (bitmap[i] !== 0) {
        maxOff = Math.max(maxOff, i + 1);
        break;
      }
    }
  }

  const items = [];
  let off = minOff;

  while (off < maxOff) {
    const b = byStart.get(off);
    if (b) {
      items.push({
        type: 'code',
        blockId: b.id,
        romStart: b.romStart,
        romEnd: b.romEnd,
        byteLen: (b.romEnd - b.romStart) | 0
      });
      off = b.romEnd;
      continue;
    }

    // Between blocks: emit runs of unknown/data derived from the byte bitmap. 🤖
    const nextBlockStart = (() => {
      for (const blk of sorted) {
        if (blk.romStart > off) return blk.romStart;
      }
      return maxOff;
    })();

    let runStart = off;
    let cur = bitmap?.[runStart] ?? 0;
    for (let i = runStart + 1; i < nextBlockStart; i++) {
      const v = bitmap?.[i] ?? 0;
      if (v !== cur) {
        const len = i - runStart;
        items.push(makeGapItem(cur, runStart, len));
        runStart = i;
        cur = v;
      }
    }

    const finalLen = nextBlockStart - runStart;
    if (finalLen > 0) items.push(makeGapItem(cur, runStart, finalLen));

    off = nextBlockStart;
  }

  return items;
}

function makeGapItem(bitmapVal, romStart, len) {
  const isData = bitmapVal === 2;
  return {
    type: isData ? 'data' : 'unknown',
    romStart,
    romEnd: romStart + len,
    byteLen: len,
    sizeClass: sizeClass(len)
  };
}
