// Recognize "scroll reset" sequences:
// two successive *constant* writes to PPUSCROLL ($2005).
//
// Notes:
// - We do NOT require 00/00. Some games write e.g. 08 then 00 to clip the
//   leftmost tile (with a corresponding PPUCTRL setting / scroll behavior).
//
// We intentionally avoid full VSA here. Instead we do tiny local constant tracking
// (immediate loads + a handful of transfers) within each decoded block.

function parseBytesText(bytesText) {
  if (!bytesText || typeof bytesText !== 'string') return null;
  const parts = bytesText.trim().split(/\s+/g).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const p of parts) {
    const v = parseInt(p, 16);
    if (!Number.isFinite(v)) return null;
    out.push(v & 0xff);
  }
  return out;
}

function imm8(ln) {
  if (!ln || ln.mode !== 'imm') return null;
  const bytes = parseBytesText(ln.bytesText);
  if (!bytes || bytes.length < 2) return null;
  return bytes[1] & 0xff;
}

function abs16(ln) {
  if (!ln || ln.mode !== 'abs') return null;
  const bytes = parseBytesText(ln.bytesText);
  if (!bytes || bytes.length < 3) return null;
  return (bytes[1] | (bytes[2] << 8)) & 0xffff;
}

function isStoreMnemonic(m) {
  return m === 'STA' || m === 'STX' || m === 'STY';
}

export function recognizeScrollResets({ blocks }) {
  const pointsOfInterest = [];
  const pillsByBlockId = {};

  for (const b of blocks || []) {
    if (!b?.id || !Array.isArray(b.lines) || b.lines.length === 0) continue;
    const r = recognizeScrollResetInBlock(b);
    if (!r) continue;

    // Pill on the containing block/function.
    pillsByBlockId[b.id] = pillsByBlockId[b.id] || [];
    if (!pillsByBlockId[b.id].includes('sets scroll')) pillsByBlockId[b.id].push('sets scroll');

    pointsOfInterest.push({
      kind: 'scrollReset',
      label: 'Sets scroll',
      pill: 'sets scroll',
      blockId: b.id,
      ctxId: b.instances?.[0]?.ctxId || 'nrom',
      pc: r.pc,
      // Optional metadata (not shown yet in UI): the constant scroll pair.
      x: r.x,
      y: r.y
    });
  }

  return { pointsOfInterest, pillsByBlockId };
}

function recognizeScrollResetInBlock(block) {
  const lines = block.lines || [];

  // Trivial constant tracking for A/X/Y.
  let A = null;
  let X = null;
  let Y = null;

  // Track each "write of constant" to PPUSCROLL.
  const writes = [];

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const m = ln?.mnemonic;
    if (!m) {
      A = null; X = null; Y = null;
      continue;
    }

    // Immediate loads.
    if (m === 'LDA' && ln.mode === 'imm') {
      A = imm8(ln);
      continue;
    }
    if (m === 'LDX' && ln.mode === 'imm') {
      X = imm8(ln);
      continue;
    }
    if (m === 'LDY' && ln.mode === 'imm') {
      Y = imm8(ln);
      continue;
    }

    // Transfers.
    if (m === 'TAX') { X = A; continue; }
    if (m === 'TAY') { Y = A; continue; }
    if (m === 'TXA') { A = X; continue; }
    if (m === 'TYA') { A = Y; continue; }

    // Small mutations.
    if (m === 'INX') { X = (X == null) ? null : ((X + 1) & 0xff); continue; }
    if (m === 'DEX') { X = (X == null) ? null : ((X - 1) & 0xff); continue; }
    if (m === 'INY') { Y = (Y == null) ? null : ((Y + 1) & 0xff); continue; }
    if (m === 'DEY') { Y = (Y == null) ? null : ((Y - 1) & 0xff); continue; }

    // Stores.
    if (isStoreMnemonic(m) && ln.mode === 'abs') {
      const addr = abs16(ln);
      if (addr === 0x2005) {
        const value = (m === 'STA') ? A : (m === 'STX') ? X : Y;
        if (value != null) {
          writes.push({ idx: i, pc: ln.cpuAddr, value });
        }
      }
      continue;
    }

    // If an instruction overwrites a register in a way we don't model, drop it.
    // We only need a tiny slice for the scroll reset recognizer.
    if (m === 'LDA') { A = null; continue; }
    if (m === 'LDX') { X = null; continue; }
    if (m === 'LDY') { Y = null; continue; }
    if (m === 'PLA') { A = null; continue; }
    if (m === 'TSX') { X = null; continue; }

    // Arithmetic/logic ops clobber A.
    if (m === 'ADC' || m === 'SBC' || m === 'AND' || m === 'ORA' || m === 'EOR' || m === 'ASL' || m === 'LSR' || m === 'ROL' || m === 'ROR') {
      A = null;
      continue;
    }
  }

  if (writes.length < 2) return null;

  // Find two successive constant writes to $2005.
  //
  // We keep a small gap budget to avoid flagging widely separated stores that
  // just happen to occur in the same basic block.
  const maxGap = 10;
  for (let i = 0; i < writes.length - 1; i++) {
    const a = writes[i];
    const b = writes[i + 1];
    if (!a || !b) continue;
    if ((b.idx - a.idx) > maxGap) continue;

    // a.value = X scroll, b.value = Y scroll (as written).
    return {
      pc: (typeof a.pc === 'number' ? (a.pc & 0xffff) : null),
      x: a.value & 0xff,
      y: b.value & 0xff
    };
  }

  return null;
}
