// Constant recognizers.
//
// These are intentionally strict and local (no full VSA yet): we only recognize
// patterns where values are provably constant based on immediate loads + simple
// constant-preserving ops within the same coalesced display block.

function parseBytesText(bytesText) {
  if (!bytesText || typeof bytesText !== 'string') return [];
  const parts = bytesText.split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const v = Number.parseInt(p, 16);
    if (!Number.isFinite(v)) return [];
    out.push(v & 0xff);
  }
  return out;
}

function u16le(bytes, off) {
  return ((bytes[off] | (bytes[off + 1] << 8)) & 0xffff) >>> 0;
}

function imm8FromLine(ln) {
  if (!ln || ln.mode !== 'imm') return null;
  const bytes = parseBytesText(ln.bytesText);
  if (!bytes || bytes.length < 2) return null;
  return bytes[1] & 0xff;
}

function abs16FromLine(ln) {
  if (!ln || ln.mode !== 'abs') return null;
  const bytes = parseBytesText(ln.bytesText);
  if (!bytes || bytes.length < 3) return null;
  return u16le(bytes, 1);
}

function isStoreMnemonic(m) {
  return m === 'STA' || m === 'STX' || m === 'STY';
}

function isControlFlowLine(ln) {
  const t = ln?.flow?.type;
  return t === 'branch' || t === 'call' || t === 'jump' || t === 'jmp_ind' || t === 'stop' || t === 'illegal';
}

function basisSpanFromLines(lines, iStart, iEndInclusive) {
  const a = lines[iStart];
  const b = lines[iEndInclusive];
  if (!a || !b) return null;
  const start = a.romOff;
  const end = (b.romOff + (b.len || 0)) >>> 0;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start: start >>> 0, end: end >>> 0 };
}

function makePoiId(kind, romOffStart, romOffEnd) {
  return `${kind}:${(romOffStart >>> 0).toString(16)}-${(romOffEnd >>> 0).toString(16)}`;
}

function anchorFromLine(ln) {
  return {
    romOff: typeof ln?.romOff === 'number' ? (ln.romOff >>> 0) : null,
    cpuAddr: typeof ln?.cpuAddr === 'number' ? (ln.cpuAddr & 0xffff) : null
  };
}

function clamp8(n) {
  return (n & 0xff) >>> 0;
}

function constVal(v, originIdx) {
  if (v == null) return null;
  return { v: clamp8(v), originIdx: originIdx | 0 };
}

function minOrigin(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.originIdx <= b.originIdx ? a : b;
}

// Tracks A/X/Y as either:
// - null (unknown / Top)
// - { v, originIdx }
function trackConstRegs(lines) {
  let A = null;
  let X = null;
  let Y = null;

  const stores = []; // { idx, addr, value, originIdx }

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const m = ln?.mnemonic;
    if (!m) {
      A = null; X = null; Y = null;
      continue;
    }

    // Immediate loads.
    if (m === 'LDA' && ln.mode === 'imm') { A = constVal(imm8FromLine(ln), i); continue; }
    if (m === 'LDX' && ln.mode === 'imm') { X = constVal(imm8FromLine(ln), i); continue; }
    if (m === 'LDY' && ln.mode === 'imm') { Y = constVal(imm8FromLine(ln), i); continue; }

    // Transfers.
    if (m === 'TAX') { X = A ? { ...A } : null; continue; }
    if (m === 'TAY') { Y = A ? { ...A } : null; continue; }
    if (m === 'TXA') { A = X ? { ...X } : null; continue; }
    if (m === 'TYA') { A = Y ? { ...Y } : null; continue; }

    // Inc/dec on known values.
    if (m === 'INX') { if (X) X = { v: clamp8(X.v + 1), originIdx: X.originIdx }; continue; }
    if (m === 'DEX') { if (X) X = { v: clamp8(X.v - 1), originIdx: X.originIdx }; continue; }
    if (m === 'INY') { if (Y) Y = { v: clamp8(Y.v + 1), originIdx: Y.originIdx }; continue; }
    if (m === 'DEY') { if (Y) Y = { v: clamp8(Y.v - 1), originIdx: Y.originIdx }; continue; }

    // Small predictable ops on known constants.
    if ((m === 'AND' || m === 'ORA' || m === 'EOR') && ln.mode === 'imm') {
      const k = imm8FromLine(ln);
      if (A && k != null) {
        if (m === 'AND') A = { v: clamp8(A.v & k), originIdx: A.originIdx };
        if (m === 'ORA') A = { v: clamp8(A.v | k), originIdx: A.originIdx };
        if (m === 'EOR') A = { v: clamp8(A.v ^ k), originIdx: A.originIdx };
      } else {
        A = null;
      }
      continue;
    }

    if ((m === 'ASL' || m === 'LSR') && (ln.mode === 'acc' || ln.mode === 'imp')) {
      if (!A) { A = null; continue; }
      if (m === 'ASL') A = { v: clamp8(A.v << 1), originIdx: A.originIdx };
      else A = { v: clamp8(A.v >>> 1), originIdx: A.originIdx };
      continue;
    }

    if ((m === 'ROL' || m === 'ROR') && (ln.mode === 'acc' || ln.mode === 'imp')) {
      // Needs carry; keep strict.
      A = null;
      continue;
    }

    // Stores.
    if (isStoreMnemonic(m) && ln.mode === 'abs') {
      const addr = abs16FromLine(ln);
      if (addr != null) {
        const src = (m === 'STA') ? A : (m === 'STX') ? X : Y;
        if (src) {
          stores.push({ idx: i, addr, value: src.v, originIdx: src.originIdx });
        }
      }
      continue;
    }

    // Clobbers we don't model (keep strict).
    if (m === 'LDA' || m === 'PLA') { A = null; continue; }
    if (m === 'LDX' || m === 'TSX' || m === 'PLX') { X = null; continue; }
    if (m === 'LDY' || m === 'PLY') { Y = null; continue; }
    if (m === 'ADC' || m === 'SBC') { A = null; continue; }
    if (m === 'CMP' || m === 'CPX' || m === 'CPY') { /* no reg clobber */ continue; }

    // Anything else: conservatively drop regs we can't reason about.
    // (This is intentionally over-strict for the "constants-only" pass.)
    if (m !== 'NOP' && m !== 'BIT') {
      A = null;
      X = null;
      Y = null;
    }
  }

  return { stores };
}

function hasControlFlowBetween(lines, iStart, iEndInclusive) {
  for (let i = iStart; i <= iEndInclusive; i++) {
    if (isControlFlowLine(lines[i])) return true;
  }
  return false;
}

function recognizeConstStorePairs(lines, stores, addr, maxGap) {
  const hits = stores.filter((s) => s.addr === addr);
  if (hits.length < 2) return [];
  const pairs = [];
  for (let i = 0; i < hits.length - 1; i++) {
    const a = hits[i];
    const b = hits[i + 1];
    if ((b.idx - a.idx) > maxGap) continue;
    // Keep strict: no control flow between the two stores.
    if (hasControlFlowBetween(lines, a.idx, b.idx)) continue;
    pairs.push({
      storeA: a,
      storeB: b,
      originA: a.originIdx,
      originB: b.originIdx,
      startIdx: Math.min(a.originIdx, b.originIdx, a.idx, b.idx),
      endIdx: Math.max(a.idx, b.idx)
    });
  }
  return pairs;
}

function chooseNearestMerge(scrollPair, addrPairs, maxDistance) {
  if (!addrPairs || addrPairs.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const ap of addrPairs) {
    const left = Math.min(scrollPair.storeA.idx, scrollPair.storeB.idx);
    const right = Math.max(scrollPair.storeA.idx, scrollPair.storeB.idx);
    const aLeft = Math.min(ap.storeA.idx, ap.storeB.idx);
    const aRight = Math.max(ap.storeA.idx, ap.storeB.idx);
    const dist = (aLeft > right) ? (aLeft - right) : (left > aRight) ? (left - aRight) : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = ap;
    }
  }
  if (bestDist > maxDistance) return null;
  return best;
}

function buildSetsScrollPoi({ block, lines, scrollPair, addrPair }) {
  const parts = [scrollPair];
  if (addrPair) parts.push(addrPair);

  let startIdx = Infinity;
  let endIdx = -Infinity;
  let anchorIdx = Infinity;

  for (const p of parts) {
    startIdx = Math.min(startIdx, p.startIdx);
    endIdx = Math.max(endIdx, p.endIdx);
    anchorIdx = Math.min(anchorIdx, p.startIdx);
  }

  if (!Number.isFinite(startIdx) || !Number.isFinite(endIdx) || startIdx > endIdx) return null;

  // If the instruction immediately preceding the recognized span is a contiguous
  // `LDA $2002`, include it as part of the span. This is a common prelude used
  // to reset the shared write toggle for $2005/$2006 sequences.
  //
  // Keep it intentionally strict: only the directly-adjacent `LDA $2002` is
  // included, so other $2002 reads elsewhere won't be accidentally folded in.
  if (startIdx > 0) {
    const prev = lines[startIdx - 1];
    if (
      prev?.mnemonic === 'LDA' &&
      prev?.mode === 'abs' &&
      abs16FromLine(prev) === 0x2002 &&
      !isControlFlowLine(prev)
    ) {
      startIdx = startIdx - 1;
      anchorIdx = Math.min(anchorIdx, startIdx);
    }
  }

  if (hasControlFlowBetween(lines, startIdx, endIdx)) return null;

  const basis = basisSpanFromLines(lines, startIdx, endIdx);
  if (!basis) return null;

  // Anchor / display at the beginning of the recognized span.
  const spanStartLine = lines[startIdx];
  const anchor = anchorFromLine(spanStartLine);
  if (anchor.romOff == null) return null;

  const meta = {
    scrollX: scrollPair.storeA.value,
    scrollY: scrollPair.storeB.value
  };

  if (addrPair) {
    const hi = addrPair.storeA.value;
    const lo = addrPair.storeB.value;
    meta.ppuAddrHi = hi;
    meta.ppuAddrLo = lo;
    meta.ppuAddr = ((hi << 8) | lo) & 0xffff;
  }

  const id = makePoiId('setsScroll', basis.start, basis.end);

  return {
    id,
    kind: 'setsScroll',
    label: 'Sets scroll',
    pill: 'sets scroll',
    anchorRomOff: basis.start,
    anchorCpuAddr: anchor.cpuAddr,
    // Link to the containing display block, then zoom to anchorRomOff.
    anchorBlockId: block.id,
    basis: { romOffSpan: basis },
    meta
  };
}

function buildAlignmentNopsPoi({ block, lines, startIdx, endIdx, nextIdx }) {
  const basis = basisSpanFromLines(lines, startIdx, endIdx);
  if (!basis) return null;

  const anchor = anchorFromLine(lines[startIdx]);
  if (anchor.romOff == null) return null;

  const next = lines[nextIdx];
  const meta = {
    nopCount: (endIdx - startIdx + 1) | 0,
    nextCpuAddr: typeof next?.cpuAddr === 'number' ? (next.cpuAddr & 0xffff) : null
  };

  const id = makePoiId('alignmentNops', basis.start, basis.end);

  return {
    id,
    kind: 'alignmentNops',
    label: 'Alignment NOPs',
    pill: 'alignment NOPs',
    // Anchor at the beginning of the NOP run.
    anchorRomOff: basis.start,
    anchorCpuAddr: anchor.cpuAddr,
    // Link to the containing display block, then zoom to anchorRomOff.
    anchorBlockId: block.id,
    basis: { romOffSpan: basis },
    meta
  };
}

function recognizeAlignmentNops({ block, lines, maxRunLen = 64 }) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln?.mnemonic !== 'NOP') continue;

    let j = i;
    while (j < lines.length && lines[j]?.mnemonic === 'NOP' && (j - i) < maxRunLen) j++;
    const startIdx = i;
    const endIdx = j - 1;

    // Must have a following instruction to be considered alignment padding.
    if (j >= lines.length) {
      i = endIdx;
      continue;
    }

    const next = lines[j];
    const nextCpuAddr = typeof next?.cpuAddr === 'number' ? (next.cpuAddr & 0xffff) : null;
    if (nextCpuAddr == null || (nextCpuAddr & 0xff) !== 0x00) {
      i = endIdx;
      continue;
    }

    const poi = buildAlignmentNopsPoi({ block, lines, startIdx, endIdx, nextIdx: j });
    if (poi) out.push(poi);

    i = endIdx;
  }
  return out;
}

// Recognize constant writes to PPUSCROLL ($2005) and (optionally) PPUADDR ($2006)
// as says "sets scroll".
export function runConstantRecognizersForBlock(block) {
  const lines = Array.isArray(block?.lines) ? block.lines : [];
  if (!lines.length) return [];

  const { stores } = trackConstRegs(lines);

  const scrollPairs = recognizeConstStorePairs(lines, stores, 0x2005, 12);

  const addrPairs = recognizeConstStorePairs(lines, stores, 0x2006, 12);

  const pois = [];
  const mergeDistance = 18;

  for (const sp of scrollPairs) {
    const ap = chooseNearestMerge(sp, addrPairs, mergeDistance);
    const poi = buildSetsScrollPoi({ block, lines, scrollPair: sp, addrPair: ap });
    if (poi) pois.push(poi);
  }

  // Alignment NOP runs (NOP padding that leaves the following instruction on a CPU page boundary).
  pois.push(...recognizeAlignmentNops({ block, lines }));

  return pois;
}
