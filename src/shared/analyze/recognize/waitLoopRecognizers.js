import { parseBytesText } from '../../utils/byteTextUtils.js';
import { u16le } from '../../utils/binaryReadUtils.js';

// Wait-loop recognizers.
//
// POIs expose ROM spans; the renderer resolves the current display target lazily.

// Wait-loop recognizers.
//
// These are intentionally strict patterns that don't rely on value analysis:
// - 2-instruction tight loops that can only be escaped if some external agent
//   (interrupt/NMI, DMA, etc.) changes the tested state.

const BRANCH_MNEMONICS = new Set(['BPL', 'BMI', 'BVC', 'BVS', 'BCC', 'BCS', 'BNE', 'BEQ']);

function makePoiId(kind, romOffStart, romOffEnd) {
  return `${kind}:${(romOffStart >>> 0).toString(16)}-${(romOffEnd >>> 0).toString(16)}`;
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


function operandZp(line) {
  if (!line || line.mode !== 'zp') return null;
  const bytes = parseBytesText(line.bytesText);
  if (bytes.length < 2) return null;
  return bytes[1] & 0xff;
}

function operandAbs(line) {
  if (!line || line.mode !== 'abs') return null;
  const bytes = parseBytesText(line.bytesText);
  if (bytes.length < 3) return null;
  return u16le(bytes, 1);
}

function isTwoInstrBackedge(lines, i) {
  const a = lines[i];
  const b = lines[i + 1];
  if (!a || !b) return false;
  const f = b.flow;
  if (!f || f.type !== 'branch') return false;
  if (!BRANCH_MNEMONICS.has(b.mnemonic)) return false;
  return typeof f.target === 'number' && (f.target & 0xffff) === (a.cpuAddr & 0xffff);
}

// Recognize: BIT/LDA $2002; Bxx back
function recognizePpuStatusPolling(lines, i) {
  if (!isTwoInstrBackedge(lines, i)) return null;
  const read = lines[i];
  const br = lines[i + 1];

  if (!read || !br) return null;
  if (read.mnemonic !== 'BIT' && read.mnemonic !== 'LDA') return null;
  const addr = operandAbs(read);
  if (addr !== 0x2002) return null;

  // Only accept branches whose tested flag is known to be affected by the preceding read.
  // - BIT sets N (bit7) and V (bit6)
  // - LDA sets N (bit7) and Z (zero)
  // For vblank/sprite0 we only handle N/V here.
  if (br.mnemonic === 'BVC' || br.mnemonic === 'BVS') {
    if (read.mnemonic !== 'BIT') return null;
    const waitsForSet = br.mnemonic === 'BVC'; // loop while V=0, exit when V=1
    return {
      kind: 'waitsForSprite0Hit',
      pill: 'waits for sprite 0 hit',
      meta: {
        ppuReg: 0x2002,
        flag: 'V',
        condition: waitsForSet ? 'wait_set' : 'wait_clear'
      }
    };
  }

  if (br.mnemonic === 'BPL' || br.mnemonic === 'BMI') {
    const waitsForSet = br.mnemonic === 'BPL'; // loop while N=0, exit when N=1
    return {
      kind: 'waitsForVblank',
      pill: 'waits for vblank',
      meta: {
        ppuReg: 0x2002,
        flag: 'N',
        condition: waitsForSet ? 'wait_set' : 'wait_clear'
      }
    };
  }

  return null;
}

// Recognize: LDA/LDX/LDY zp; Bxx back  (2-instr)
function recognizeTwoInstrZpWait(lines, i) {
  if (!isTwoInstrBackedge(lines, i)) return null;
  const read = lines[i];
  const br = lines[i + 1];
  if (!read || !br) return null;

  if (read.mnemonic !== 'LDA' && read.mnemonic !== 'LDX' && read.mnemonic !== 'LDY') return null;
  const zpAddr = operandZp(read);
  if (zpAddr == null) return null;

  // If the branch is BEQ/BNE, we can state the waited value precisely (0 vs nonzero).
  if (br.mnemonic === 'BNE' || br.mnemonic === 'BEQ') {
    const wantZero = br.mnemonic === 'BNE'; // loop while nonzero, exit when zero
    return {
      kind: 'waitsForZpValue',
      pill: 'waits for ZP value',
      meta: {
        zpAddr,
        op: 'Z',
        condition: wantZero ? 'wait_zero' : 'wait_nonzero',
        value: 0
      }
    };
  }

  // Other branches are still a strict "busy wait" with no side effects; label per project convention.
  return {
    kind: 'waitsForInterrupt',
    pill: 'waits for interrupt',
    meta: {
      zpAddr,
      branch: br.mnemonic
    }
  };
}

// Recognize: LDA zp; CMP #imm; BNE/BEQ back  (3-instr)
function recognizeZpCmpImmWait(lines, i) {
  const a = lines[i];
  const b = lines[i + 1];
  const c = lines[i + 2];
  if (!a || !b || !c) return null;
  if (!c.flow || c.flow.type !== 'branch') return null;
  if (c.mnemonic !== 'BNE' && c.mnemonic !== 'BEQ') return null;
  if (typeof c.flow.target !== 'number' || (c.flow.target & 0xffff) !== (a.cpuAddr & 0xffff)) return null;

  if (a.mnemonic !== 'LDA') return null;
  const zpAddr = operandZp(a);
  if (zpAddr == null) return null;

  if (b.mnemonic !== 'CMP' || b.mode !== 'imm') return null;
  const bytes = parseBytesText(b.bytesText);
  if (bytes.length < 2) return null;
  const imm = bytes[1] & 0xff;

  const waitEq = c.mnemonic === 'BNE'; // loop while not equal, exit when equal
  return {
    kind: 'waitsForZpValue',
    pill: 'waits for ZP value',
    meta: {
      zpAddr,
      condition: waitEq ? 'wait_eq' : 'wait_neq',
      value: imm
    }
  };
}

export function runWaitLoopRecognizersForBlock(block) {
  const lines = Array.isArray(block?.lines) ? block.lines : [];
  if (!lines.length) return [];

  const pois = [];

  for (let i = 0; i < lines.length; i++) {
    // 3-instr ZP compare loop (must be checked before 2-instr)
    if (i + 2 < lines.length) {
      const m = recognizeZpCmpImmWait(lines, i);
      if (m) {
        const basis = basisSpanFromLines(lines, i, i + 2);
        if (basis) {
          const id = makePoiId(m.kind, basis.start, basis.end);
          pois.push({
            id,
            kind: m.kind,
            label: m.pill,
            pill: m.pill,
            basis: { romOffSpan: basis },
            meta: m.meta
          });
        }
      }
    }

    // 2-instr loops
    if (i + 1 < lines.length) {
      const ppu = recognizePpuStatusPolling(lines, i);
      if (ppu) {
        const basis = basisSpanFromLines(lines, i, i + 1);
        if (basis) {
          const id = makePoiId(ppu.kind, basis.start, basis.end);
          pois.push({
            id,
            kind: ppu.kind,
            label: ppu.pill,
            pill: ppu.pill,
            basis: { romOffSpan: basis },
            meta: ppu.meta
          });
        }
      }

      const zp = recognizeTwoInstrZpWait(lines, i);
      if (zp) {
        const basis = basisSpanFromLines(lines, i, i + 1);
        if (basis) {
          const id = makePoiId(zp.kind, basis.start, basis.end);
          pois.push({
            id,
            kind: zp.kind,
            label: zp.pill,
            pill: zp.pill,
            basis: { romOffSpan: basis },
            meta: zp.meta
          });
        }
      }
    }
  }

  return pois;
}
