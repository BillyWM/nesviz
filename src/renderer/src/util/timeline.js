function sizeClass(byteLen) {
  if (byteLen <= 10) return 'small';
  if (byteLen <= 50) return 'medium';
  return 'large';
}

function toNum(x) {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x !== 'string') return null;

  const t = x.trim();
  if (!t) return null;

  // Accept a few common numeric-string forms defensively (IPC can stringify values depending on the source). 🤖
  if (/^0x[0-9a-f]+$/i.test(t)) {
    const n = parseInt(t, 16);
    return Number.isFinite(n) ? n : null;
  }
  if (/^[0-9]+$/.test(t)) {
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (/^[0-9a-f]+$/i.test(t)) {
    const n = parseInt(t, 16);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Build a View-A style timeline (physical PRG offsets) from the blocks index. 🤖
// This intentionally shows only inferred blocks plus the gaps between them. 🤖
export function buildViewATimelineFromBlocks(blocksIndex) {
  const blocks = (blocksIndex || [])
    .filter(Boolean)
    .map((b) => {
      const romStart = toNum(b.romStart);
      const romEnd = toNum(b.romEnd);
      if (romStart === null || romEnd === null) return null;
      return { ...b, romStart, romEnd };
    })
    .filter(Boolean)
    .sort((a, b) => a.romStart - b.romStart);

  if (blocks.length === 0) return [];

  const items = [];
  let off = blocks[0].romStart;

  for (const b of blocks) {
    if (b.romStart > off) {
      const len = b.romStart - off;
      items.push({
        type: 'unknown',
        romStart: off,
        romEnd: b.romStart,
        byteLen: len,
        sizeClass: sizeClass(len)
      });
    }

    items.push({
      type: 'code',
      blockId: b.id,
      romStart: b.romStart,
      romEnd: b.romEnd,
      confidence: b.confidence,
      byteLen: (b.romEnd - b.romStart) | 0
    });

    off = Math.max(off, b.romEnd);
  }

  return items;
}
