import { sizeClass } from '../model.js';
import { PRG_OCCUPANCY_CODE, PRG_OCCUPANCY_DATA, PRG_OCCUPANCY_UNKNOWN } from '../occupancy/prgOccupancy.js';

// The timeline is a physical (ROM-offset) view that stitches together discovered code blocks with unknown/data gaps.
// Occupancy is the central truth for visible byte classification; blocks provide the code card backing when available. 🤖

export function buildTimeline({ prgSize, blocks, occupancy = null, bitmap = null }) {
  const byteTypes = occupancy?.byteTypes instanceof Uint8Array ? occupancy.byteTypes : null;
  if (!byteTypes || byteTypes.length === 0) {
    return buildTimelineFromBitmapFallback({ prgSize, blocks, bitmap });
  }

  const sorted = [...(Array.isArray(blocks) ? blocks : [])].sort((a, b) => (a.romStart ?? 0) - (b.romStart ?? 0));
  const observed = findObservedSpan(byteTypes, prgSize);
  if (!observed) return [];

  const items = [];
  let off = observed.start;
  let blockIdx = 0;

  while (off < observed.end) {
    const type = byteTypes[off] | 0;
    let runEnd = off + 1;
    while (runEnd < observed.end && (byteTypes[runEnd] | 0) === type) runEnd++;

    if (type === PRG_OCCUPANCY_CODE) {
      blockIdx = advanceBlockIdx(sorted, blockIdx, off);
      let cursor = off;
      while (cursor < runEnd) {
        const block = findCoveringBlock(sorted, blockIdx, cursor);
        if (!block) {
          items.push(makeGapItem(PRG_OCCUPANCY_CODE, cursor, runEnd - cursor));
          cursor = runEnd;
          continue;
        }
        if (block.romStart > cursor) {
          const gapEnd = Math.min(runEnd, block.romStart);
          items.push(makeGapItem(PRG_OCCUPANCY_CODE, cursor, gapEnd - cursor));
          cursor = gapEnd;
          continue;
        }
        const segEnd = Math.min(runEnd, block.romEnd);
        items.push({
          type: 'code',
          blockId: block.id,
          romStart: cursor,
          romEnd: segEnd,
          byteLen: (segEnd - cursor) | 0
        });
        cursor = segEnd;
      }
    } else {
      items.push(makeGapItem(type, off, runEnd - off));
    }

    off = runEnd;
  }

  return items;
}

function buildTimelineFromBitmapFallback({ prgSize, blocks, bitmap }) {
  if (!Array.isArray(blocks) || !blocks.length) {
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
        items.push(makeGapItem(cur === 1 ? PRG_OCCUPANCY_CODE : cur === 2 ? PRG_OCCUPANCY_DATA : PRG_OCCUPANCY_UNKNOWN, runStart, len));
        runStart = i;
        cur = v;
      }
    }
    const finalLen = (last + 1) - runStart;
    if (finalLen > 0) items.push(makeGapItem(cur === 1 ? PRG_OCCUPANCY_CODE : cur === 2 ? PRG_OCCUPANCY_DATA : PRG_OCCUPANCY_UNKNOWN, runStart, finalLen));
    return items;
  }

  const sorted = [...blocks].sort((a, b) => a.romStart - b.romStart);
  const byStart = new Map(sorted.map((b) => [b.romStart, b]));
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
      items.push({ type: 'code', blockId: b.id, romStart: b.romStart, romEnd: b.romEnd, byteLen: (b.romEnd - b.romStart) | 0 });
      off = b.romEnd;
      continue;
    }

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
        items.push(makeGapItem(cur === 1 ? PRG_OCCUPANCY_CODE : cur === 2 ? PRG_OCCUPANCY_DATA : PRG_OCCUPANCY_UNKNOWN, runStart, len));
        runStart = i;
        cur = v;
      }
    }

    const finalLen = nextBlockStart - runStart;
    if (finalLen > 0) items.push(makeGapItem(cur === 1 ? PRG_OCCUPANCY_CODE : cur === 2 ? PRG_OCCUPANCY_DATA : PRG_OCCUPANCY_UNKNOWN, runStart, finalLen));
    off = nextBlockStart;
  }

  return items;
}

function findObservedSpan(byteTypes, prgSize) {
  const limit = Math.min(prgSize | 0, byteTypes.length | 0);
  let first = -1;
  let last = -1;
  for (let i = 0; i < limit; i++) {
    if ((byteTypes[i] | 0) !== PRG_OCCUPANCY_UNKNOWN) {
      first = i;
      break;
    }
  }
  for (let i = limit - 1; i >= 0; i--) {
    if ((byteTypes[i] | 0) !== PRG_OCCUPANCY_UNKNOWN) {
      last = i + 1;
      break;
    }
  }
  return (first >= 0 && last > first) ? { start: first, end: last } : null;
}

function advanceBlockIdx(sorted, blockIdx, off) {
  let idx = Math.max(0, blockIdx | 0);
  while (idx < sorted.length && (sorted[idx]?.romEnd ?? 0) <= off) idx++;
  return idx;
}

function findCoveringBlock(sorted, blockIdx, off) {
  for (let i = Math.max(0, blockIdx | 0); i < sorted.length; i++) {
    const block = sorted[i];
    if ((block?.romStart ?? Infinity) > off) return null;
    if ((block?.romStart ?? Infinity) <= off && (block?.romEnd ?? -1) > off) return block;
  }
  return null;
}

function makeGapItem(type, romStart, len) {
  const normType = type | 0;
  return {
    type: normType === PRG_OCCUPANCY_CODE ? 'code' : normType === PRG_OCCUPANCY_DATA ? 'data' : 'unknown',
    romStart,
    romEnd: romStart + len,
    byteLen: len,
    sizeClass: sizeClass(len)
  };
}
