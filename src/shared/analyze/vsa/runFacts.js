import { constrainBranchEdges } from './constraints.js';
import { makeState, cloneState, makeTracked, joinInto } from './state.js';
import { vUnknown, vConst8, vAnd8, vOr8, vXor8, vShl1, vShr1, vAdd8, vFilterEq, vFilterNe, vFilterLt, vFilterGe, vIsEmpty } from './value.js';
import { bUnknown8, bConst8, bAndImm, bOrImm, bXorImm, bShl1, bShr1 } from './bits.js';
import { pUnknown, pConst8, pConst16, pAdd8, pAnd8, pOr8, pXor8, pShl1, pShr1, pReadRom8, pReadMem8, pJoin, pPtr16FromZp } from './prov.js';

// VSA "facts" pass.
//
// Goal: cheap, strict propagation of constants + known-bits through A/X/Y + memory,
// and emit high-certainty facts (especially memory / IO stores) for later display.
//
// This is intentionally not a full 6502 semantics model; it focuses on constant-preserving
// operations that are common in setup, decompression, and PPU streaming code.

function clamp8(n) {
  return (n & 0xff) >>> 0;
}

function isByteConst(abs) {
  return abs && abs.kind === 'const';
}

function trackedWith(abs, bits, prov, spanStartRomOff) {
  return makeTracked(abs, prov, bits, spanStartRomOff);
}

function setReg(state, r, tracked) {
  state[r] = tracked;
}

function getReg(state, r) {
  return state[r] || makeTracked();
}

function zpAddrFromModeOperand(op8, idxConst) {
  const base = op8 & 0xff;
  if (idxConst == null) return base;
  return (base + (idxConst & 0xff)) & 0xff;
}

function canonicalizeCpuAddr(addr) {
  const a = addr & 0xffff;
  // Internal RAM mirrors.
  if (a < 0x2000) {
    const canon = a & 0x07ff;
    if (canon < 0x0100) return { space: 'zp', addr: canon };
    return { space: 'ram', addr: canon };
  }
  // PRG-RAM window.
  if (a >= 0x6000 && a < 0x8000) return { space: 'prgram', addr: a };
  // IO.
  if (a >= 0x2000 && a < 0x4020) return { space: 'io', addr: a };
  // ROM.
  if (a >= 0x8000) return { space: 'rom', addr: a };
  return { space: 'other', addr: a };
}

function read8(prgBytes, romOff, rel) {
  const i = (romOff + rel) >>> 0;
  if (i < 0 || i >= prgBytes.length) return 0;
  return prgBytes[i] & 0xff;
}

function read16le(prgBytes, romOff, rel) {
  const lo = read8(prgBytes, romOff, rel);
  const hi = read8(prgBytes, romOff, rel + 1);
  return ((lo | (hi << 8)) & 0xffff) >>> 0;
}

function spanEndFromLine(line) {
  const start = typeof line?.romOff === 'number' ? (line.romOff >>> 0) : 0;
  const len = typeof line?.len === 'number' ? (line.len >>> 0) : 0;
  return (start + len) >>> 0;
}

function mkSpan(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const a = start >>> 0;
  const b = end >>> 0;
  if (a > b) return null;
  return { start: a, end: b };
}

function shouldEmitStoreFact(valTracked) {
  if (!valTracked) return false;
  const abs = valTracked.abs;
  if (abs && abs.kind !== 'unknown') {
    // Don't emit empty sets.
    if (!(abs.kind === 'set' && abs.values && abs.values.length === 0)) return true;
  }
  const km = valTracked.bits?.knownMask ?? 0;
  return (km & 0xff) !== 0;
}

function encodeStoreFactKey(f) {
  const sp = f?.basis?.romOffSpan;
  const ss = sp ? `${sp.start}-${sp.end}` : 'nos';
  const dst = f?.dst?.space ? `${f.dst.space}:${f.dst.addr}` : 'nod';
  const av = (f?.value?.abs?.kind === 'const') ? `c${f.value.abs.v}` : (f?.value?.abs?.kind || 'u');
  const bm = f?.value?.bits ? `m${f.value.bits.knownMask}-v${f.value.bits.knownValue}` : 'nb';
  const at = typeof f?.atRomOff === 'number' ? (f.atRomOff >>> 0) : 'na';
  return `${f.kind}:${at}:${ss}:${dst}:${av}:${bm}`;
}

function encodeReadFactKey(f) {
  const at = typeof f?.atRomOff === 'number' ? (f.atRomOff >>> 0) : 'na';
  const src = f?.src?.space ? `${f.src.space}:${f.src.addr}` : 'nosrc';
  const dst = f?.dstReg || 'nodst';
  const av = (f?.value?.abs?.kind === 'const') ? `c${f.value.abs.v}` : (f?.value?.abs?.kind || 'u');
  return `read8:${at}:${dst}:${src}:${av}`;
}

function encodeCmpFactKey(f) {
  const at = typeof f?.atRomOff === 'number' ? (f.atRomOff >>> 0) : 'na';
  const reg = f?.reg || 'noreg';
  const rhs = f?.rhs?.kind === 'imm' ? `imm:${f.rhs.imm}` : (f?.rhs?.src ? `${f.rhs.src.space}:${f.rhs.src.addr}` : 'rhs');
  return `cmp8:${at}:${reg}:${rhs}`;
}

function maybeOutcomeFlagsForImmCompare(abs, imm) {
  const x = imm & 0xff;
  const v = abs || vUnknown();

  const mayEq = (v.kind === 'unknown') ? true : !vIsEmpty(vFilterEq(v, x));
  const mustEq = (v.kind !== 'unknown') ? vIsEmpty(vFilterNe(v, x)) : false;
  const mayNe = (v.kind === 'unknown') ? true : !vIsEmpty(vFilterNe(v, x));
  const mustNe = (v.kind !== 'unknown') ? vIsEmpty(vFilterEq(v, x)) : false;

  const mayLt = (v.kind === 'unknown') ? true : !vIsEmpty(vFilterLt(v, x));
  const mustLt = (v.kind !== 'unknown') ? vIsEmpty(vFilterGe(v, x)) : false;
  const mayGe = (v.kind === 'unknown') ? true : !vIsEmpty(vFilterGe(v, x));
  const mustGe = (v.kind !== 'unknown') ? vIsEmpty(vFilterLt(v, x)) : false;

  return {
    eq: { may: !!mayEq, must: !!mustEq },
    ne: { may: !!mayNe, must: !!mustNe },
    lt: { may: !!mayLt, must: !!mustLt },
    ge: { may: !!mayGe, must: !!mustGe }
  };
}

function setMem8(state, canon, tracked) {
  if (canon.space === 'zp') {
    state.zp.set(canon.addr & 0xff, tracked);
    return;
  }
  if (canon.space === 'ram' || canon.space === 'prgram') {
    if (!state.ram) state.ram = new Map();
    state.ram.set(canon.addr & 0xffff, tracked);
  }
}

function getMem8(state, canon) {
  if (canon.space === 'zp') {
    return state.zp.get(canon.addr & 0xff) || makeTracked();
  }
  if (canon.space === 'ram' || canon.space === 'prgram') {
    return state.ram?.get(canon.addr & 0xffff) || makeTracked();
  }
  return makeTracked(vUnknown(), pUnknown(), bUnknown8(), null);
}

function resolveAbsAddr(line, { prgBytes }) {
  const base = read16le(prgBytes, line.romOff >>> 0, 1);
  const mode = line.mode;
  if (mode === 'abs') return base;
  if (mode === 'abs_x') return base; // indexed handled by caller
  if (mode === 'abs_y') return base;
  return base;
}

function resolveAddressForLine(state, line, { prgBytes, mapper }) {
  const mode = line.mode;
  const romOff = line.romOff >>> 0;

  if (mode === 'zp') {
    const op = read8(prgBytes, romOff, 1);
    return { kind: 'cpu', cpuAddr: op & 0xff };
  }
  if (mode === 'zp_x') {
    const op = read8(prgBytes, romOff, 1);
    const x = getReg(state, 'X');
    if (!isByteConst(x.abs)) return null;
    return { kind: 'cpu', cpuAddr: zpAddrFromModeOperand(op, x.abs.v) };
  }
  if (mode === 'zp_y') {
    const op = read8(prgBytes, romOff, 1);
    const y = getReg(state, 'Y');
    if (!isByteConst(y.abs)) return null;
    return { kind: 'cpu', cpuAddr: zpAddrFromModeOperand(op, y.abs.v) };
  }

  if (mode === 'abs' || mode === 'abs_x' || mode === 'abs_y') {
    const base = read16le(prgBytes, romOff, 1);
    if (mode === 'abs') return { kind: 'cpu', cpuAddr: base };
    const idxReg = mode === 'abs_x' ? 'X' : 'Y';
    const idx = getReg(state, idxReg);
    if (!isByteConst(idx.abs)) return null;
    return { kind: 'cpu', cpuAddr: (base + idx.abs.v) & 0xffff };
  }

  if (mode === 'ind_y') {
    // (zp),Y
    const ptrZp = read8(prgBytes, romOff, 1) & 0xff;
    const y = getReg(state, 'Y');
    if (!isByteConst(y.abs)) return null;
    const lo = state.zp.get(ptrZp) || makeTracked();
    const hi = state.zp.get((ptrZp + 1) & 0xff) || makeTracked();
    if (!isByteConst(lo.abs) || !isByteConst(hi.abs)) return null;
    const base = ((hi.abs.v << 8) | lo.abs.v) & 0xffff;
    return { kind: 'cpu', cpuAddr: (base + y.abs.v) & 0xffff, ptrZp, lo, hi, index: y };
  }

  if (mode === 'ind_x') {
    // (zp,X)
    const zpBase = read8(prgBytes, romOff, 1) & 0xff;
    const x = getReg(state, 'X');
    if (!isByteConst(x.abs)) return null;
    const ptrZp = (zpBase + x.abs.v) & 0xff;
    const lo = state.zp.get(ptrZp) || makeTracked();
    const hi = state.zp.get((ptrZp + 1) & 0xff) || makeTracked();
    if (!isByteConst(lo.abs) || !isByteConst(hi.abs)) return null;
    const base = ((hi.abs.v << 8) | lo.abs.v) & 0xffff;
    return { kind: 'cpu', cpuAddr: base, ptrZp, lo, hi, index: x };
  }

  // We intentionally don't model stack/relative/acc/imm here.
  return null;
}

function emitStoreFact({ factsByKey, factsOut }, f) {
  const key = encodeStoreFactKey(f);
  if (factsByKey.has(key)) return;
  factsByKey.add(key);
  factsOut.push(f);
}

function emitReadFact({ factsByKey, factsOut }, f) {
  const key = encodeReadFactKey(f);
  if (factsByKey.has(key)) return;
  factsByKey.add(key);
  factsOut.push(f);
}

function emitCmpFact({ factsByKey, factsOut }, f) {
  const key = encodeCmpFactKey(f);
  if (factsByKey.has(key)) return;
  factsByKey.add(key);
  factsOut.push(f);
}

function maybeEmitZpPtr16({ factsByKey, factsOut }, state, zpAddr, curLine) {
  const a = zpAddr & 0xff;
  const lo = state.zp.get(a) || makeTracked();
  const hi = state.zp.get((a + 1) & 0xff) || makeTracked();
  if (!isByteConst(lo.abs) || !isByteConst(hi.abs)) return;

  const v16 = ((hi.abs.v << 8) | lo.abs.v) & 0xffff;

  const sa = (typeof lo.spanStartRomOff === 'number') ? lo.spanStartRomOff : null;
  const sb = (typeof hi.spanStartRomOff === 'number') ? hi.spanStartRomOff : null;
  const spanStart = (sa != null && sb != null) ? Math.min(sa, sb) : (sa != null ? sa : sb);
  if (spanStart == null) return;
  const spanEnd = spanEndFromLine(curLine);
  const span = mkSpan(spanStart, spanEnd);
  if (!span) return;

  const prov = pPtr16FromZp(a, lo.prov, hi.prov);
  const f = {
    kind: 'zpPtr16',
    label: 'ZP ptr16',
    atRomOff: span.start,
    zpAddr: a,
    value16: v16,
    basis: { romOffSpan: span },
    prov
  };
  const key = `zpPtr16:${span.start}:${a}:${v16}:${span.start}-${span.end}`;
  if (factsByKey.has(key)) return;
  factsByKey.add(key);
  factsOut.push(f);
}

function applyInstruction(state, line, ctx, sinks) {
  const { prgBytes, mapper } = ctx;
  const m = line.mnemonic;
  const mode = line.mode;
  const romOff = line.romOff >>> 0;

  // Loads (immediate)
  if ((m === 'LDA' || m === 'LDX' || m === 'LDY') && mode === 'imm') {
    const imm = read8(prgBytes, romOff, 1);
    const abs = vConst8(imm);
    const bits = bConst8(imm);
    const prov = pConst8(imm);
    const tracked = trackedWith(abs, bits, prov, romOff);
    setReg(state, m === 'LDA' ? 'A' : m === 'LDX' ? 'X' : 'Y', tracked);
    state.lastNZ = { reg: m === 'LDA' ? 'A' : m === 'LDX' ? 'X' : 'Y' };
    return;
  }

  // Transfers
  if (m === 'TAX') {
    const a = getReg(state, 'A');
    setReg(state, 'X', { ...a });
    state.lastNZ = { reg: 'X' };
    return;
  }
  if (m === 'TAY') {
    const a = getReg(state, 'A');
    setReg(state, 'Y', { ...a });
    state.lastNZ = { reg: 'Y' };
    return;
  }
  if (m === 'TXA') {
    const x = getReg(state, 'X');
    setReg(state, 'A', { ...x });
    state.lastNZ = { reg: 'A' };
    return;
  }
  if (m === 'TYA') {
    const y = getReg(state, 'Y');
    setReg(state, 'A', { ...y });
    state.lastNZ = { reg: 'A' };
    return;
  }

  // Flags (limited)
  if (m === 'CLC') {
    state.C = 0;
    return;
  }
  if (m === 'SEC') {
    state.C = 1;
    return;
  }

  // Simple ALU with immediate
  if (m === 'AND' && mode === 'imm') {
    const imm = read8(prgBytes, romOff, 1);
    const a = getReg(state, 'A');
    const abs = vAnd8(a.abs, imm);
    const bits = bAndImm(a.bits, imm);
    const prov = pAnd8(a.prov, imm);
    setReg(state, 'A', trackedWith(abs, bits, prov, a.spanStartRomOff));
    state.lastNZ = { reg: 'A' };
    return;
  }
  if (m === 'ORA' && mode === 'imm') {
    const imm = read8(prgBytes, romOff, 1);
    const a = getReg(state, 'A');
    const abs = vOr8(a.abs, imm);
    const bits = bOrImm(a.bits, imm);
    const prov = pOr8(a.prov, imm);
    setReg(state, 'A', trackedWith(abs, bits, prov, a.spanStartRomOff));
    state.lastNZ = { reg: 'A' };
    return;
  }
  if (m === 'EOR' && mode === 'imm') {
    const imm = read8(prgBytes, romOff, 1);
    const a = getReg(state, 'A');
    const abs = vXor8(a.abs, imm);
    const bits = bXorImm(a.bits, imm);
    const prov = pXor8(a.prov, imm);
    setReg(state, 'A', trackedWith(abs, bits, prov, a.spanStartRomOff));
    state.lastNZ = { reg: 'A' };
    return;
  }

  // ADC #imm: only precise when carry-in is known.
  if (m === 'ADC' && mode === 'imm') {
    const imm = read8(prgBytes, romOff, 1);
    const a = getReg(state, 'A');
    const carryIn = (state.C === 0 || state.C === 1) ? state.C : null;

    let abs = vUnknown();
    let bits = bUnknown8();
    let prov = pUnknown();
    if (carryIn != null) {
      const delta = (imm + carryIn) | 0;
      abs = vAdd8(a.abs, delta);
      prov = pAdd8(a.prov, delta);
      if (isByteConst(a.abs)) {
        const v = clamp8(a.abs.v + delta);
        abs = vConst8(v);
        bits = bConst8(v);
      }
    }

    setReg(state, 'A', trackedWith(abs, bits, prov, a.spanStartRomOff));
    state.lastNZ = { reg: 'A' };
    // Carry-out is not tracked (would require a full flags model).
    state.C = null;
    return;
  }

  // Shifts
  if (m === 'ASL' && mode === 'acc') {
    const a = getReg(state, 'A');
    const abs = vShl1(a.abs);
    const bits = bShl1(a.bits);
    const prov = pShl1(a.prov);
    setReg(state, 'A', trackedWith(abs, bits, prov, a.spanStartRomOff));
    state.lastNZ = { reg: 'A' };
    state.C = null;
    return;
  }
  if (m === 'LSR' && mode === 'acc') {
    const a = getReg(state, 'A');
    const abs = vShr1(a.abs);
    const bits = bShr1(a.bits);
    const prov = pShr1(a.prov);
    setReg(state, 'A', trackedWith(abs, bits, prov, a.spanStartRomOff));
    state.lastNZ = { reg: 'A' };
    state.C = null;
    return;
  }

  // Inc/Dec (only precise for const inputs; otherwise we keep scalar domain but drop known-bits).
  if (m === 'INX' || m === 'DEX' || m === 'INY' || m === 'DEY') {
    const reg = (m === 'INX' || m === 'DEX') ? 'X' : 'Y';
    const delta = (m === 'INX' || m === 'INY') ? 1 : -1;
    const base = getReg(state, reg);
    let abs = vAdd8(base.abs, delta);
    let bits = bUnknown8();
    if (isByteConst(base.abs)) {
      const v = clamp8(base.abs.v + delta);
      abs = vConst8(v);
      bits = bConst8(v);
    }
    const prov = pAdd8(base.prov, delta);
    setReg(state, reg, trackedWith(abs, bits, prov, base.spanStartRomOff));
    state.lastNZ = { reg };
    return;
  }

  // INC/DEC memory (ZP / RAM / PRG-RAM). Useful for pointer-walking idioms.
  if ((m === 'INC' || m === 'DEC') && mode !== 'imm' && mode !== 'acc') {
    const addrInfo = resolveAddressForLine(state, line, ctx);
    if (!addrInfo) {
      state.lastNZ = null;
      return;
    }
    const canon = canonicalizeCpuAddr(addrInfo.cpuAddr);
    if (canon.space === 'zp' || canon.space === 'ram' || canon.space === 'prgram') {
      const cell = getMem8(state, canon);
      const delta = (m === 'INC') ? 1 : -1;
      let abs = vAdd8(cell.abs, delta);
      let bits = bUnknown8();
      if (isByteConst(cell.abs)) {
        const v = clamp8(cell.abs.v + delta);
        abs = vConst8(v);
        bits = bConst8(v);
      }
      const prov = pAdd8(cell.prov, delta);
      const spanStart = (typeof cell.spanStartRomOff === 'number') ? cell.spanStartRomOff : romOff;
      setMem8(state, canon, trackedWith(abs, bits, prov, spanStart));
      // INC/DEC do not affect carry, but do set N/Z; we don't model flags precisely, so we don't set lastNZ.
    }
    return;
  }

  // Loads from memory (limited)
  if ((m === 'LDA' || m === 'LDX' || m === 'LDY') && mode !== 'imm') {
    const addrInfo = resolveAddressForLine(state, line, ctx);
    if (!addrInfo) {
      // Unknown address -> clobber.
      setReg(state, m === 'LDA' ? 'A' : m === 'LDX' ? 'X' : 'Y', makeTracked());
      state.lastNZ = { reg: m === 'LDA' ? 'A' : m === 'LDX' ? 'X' : 'Y' };
      return;
    }

    const canon = canonicalizeCpuAddr(addrInfo.cpuAddr);

    // ROM reads: when the address is proven constant, we can read the byte directly from PRG.
    if (canon.space === 'rom') {
      const romOffData = mapper.cpuToRomOff(canon.addr & 0xffff);
      if (romOffData != null && romOffData >= 0 && romOffData < prgBytes.length) {
        const b = prgBytes[romOffData] & 0xff;
        const abs = vConst8(b);
        const bits = bConst8(b);
        const prov = pReadRom8(pConst16(romOffData));
        const regName = m === 'LDA' ? 'A' : m === 'LDX' ? 'X' : 'Y';
        setReg(state, regName, trackedWith(abs, bits, prov, romOff));
        state.lastNZ = { reg: regName };

        emitReadFact(sinks, {
          kind: 'read8',
          label: 'Read8',
          atRomOff: romOff,
          dstReg: regName,
          src: {
            space: 'rom',
            addr: canon.addr & 0xffff,
            romOff: romOffData >>> 0,
            ptrZp: typeof addrInfo.ptrZp === 'number' ? (addrInfo.ptrZp & 0xff) : null
          },
          value: { abs, bits: { knownMask: 0xff, knownValue: b & 0xff } },
          basis: { romOffSpan: mkSpan(romOff, spanEndFromLine(line)) },
          prov
        });
        return;
      }
    }

    const cell = getMem8(state, canon);
    const prov = pReadMem8(canon.space, canon.addr, cell.prov);
    const regName = m === 'LDA' ? 'A' : m === 'LDX' ? 'X' : 'Y';
    // Span start follows the value origin; the load itself doesn't add certainty.
    setReg(state, regName, trackedWith(cell.abs, cell.bits, prov, cell.spanStartRomOff));
    state.lastNZ = { reg: regName };

    const km = clamp8(cell.bits?.knownMask ?? 0);
    if (canon.space === 'io' || (cell.abs && cell.abs.kind !== 'unknown') || km !== 0) {
      emitReadFact(sinks, {
        kind: 'read8',
        label: 'Read8',
        atRomOff: romOff,
        dstReg: regName,
        src: {
          space: canon.space,
          addr: canon.addr & 0xffff,
          ptrZp: typeof addrInfo.ptrZp === 'number' ? (addrInfo.ptrZp & 0xff) : null
        },
        value: {
          abs: cell.abs,
          bits: { knownMask: km, knownValue: clamp8(cell.bits?.knownValue ?? 0) }
        },
        basis: { romOffSpan: mkSpan(romOff, spanEndFromLine(line)) },
        prov
      });
    }
    return;
  }

  // Stores to memory
  if ((m === 'STA' || m === 'STX' || m === 'STY') && mode !== 'imm') {
    const addrInfo = resolveAddressForLine(state, line, ctx);
    if (!addrInfo) return;
    const canon = canonicalizeCpuAddr(addrInfo.cpuAddr);
    const srcReg = m === 'STA' ? 'A' : m === 'STX' ? 'X' : 'Y';
    const v = getReg(state, srcReg);

    // Strong update to our tracked memory (for zp/ram/prgram). IO/ROM aren't modeled as memory.
    if (canon.space === 'zp' || canon.space === 'ram' || canon.space === 'prgram') {
      setMem8(state, canon, { ...v });
      // If we just wrote one half of a ZP pointer pair, see if the pair is now constant.
      if (canon.space === 'zp') {
        const a = canon.addr & 0xff;
        maybeEmitZpPtr16(sinks, state, a, line);
        if ((a & 0xff) !== 0xff) maybeEmitZpPtr16(sinks, state, (a - 1) & 0xff, line);
      }
    }

    if (!shouldEmitStoreFact(v)) return;

    const spanStart = (typeof v.spanStartRomOff === 'number') ? (v.spanStartRomOff >>> 0) : romOff;
    const spanEnd = spanEndFromLine(line);
    const span = mkSpan(spanStart, spanEnd);
    if (!span) return;

    const fact = {
      kind: 'store8',
      label: 'Store8',
      atRomOff: romOff,
      cpuAddr: typeof line.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null,
      dst: { space: canon.space, addr: canon.addr & 0xffff },
      value: {
        abs: v.abs,
        bits: { knownMask: clamp8(v.bits?.knownMask ?? 0), knownValue: clamp8(v.bits?.knownValue ?? 0) }
      },
      basis: { romOffSpan: span },
      prov: v.prov
    };
    emitStoreFact(sinks, fact);
    return;
  }

  // Compare (CMP/CPX/CPY). We primarily use these to refine branches when the RHS is proven constant.
  if (m === 'CMP' || m === 'CPX' || m === 'CPY') {
    const reg = m === 'CMP' ? 'A' : m === 'CPX' ? 'X' : 'Y';
    const lhs = getReg(state, reg);

    // Immediate compare: always constant.
    if (mode === 'imm') {
      const imm = read8(prgBytes, romOff, 1);
      state.lastCmp = { reg, imm };
      state.lastNZ = null;
      state.C = null; // CMP affects carry.

      emitCmpFact(sinks, {
        kind: 'cmp8',
        label: 'Compare8',
        atRomOff: romOff,
        reg,
        lhs: {
          abs: lhs.abs,
          bits: { knownMask: clamp8(lhs.bits?.knownMask ?? 0), knownValue: clamp8(lhs.bits?.knownValue ?? 0) }
        },
        rhs: { kind: 'imm', imm: imm & 0xff },
        rhsValue: { abs: vConst8(imm), bits: bConst8(imm) },
        outcomes: maybeOutcomeFlagsForImmCompare(lhs.abs, imm),
        basis: { romOffSpan: mkSpan(romOff, spanEndFromLine(line)) },
        prov: lhs.prov
      });
      return;
    }

    // Memory compare: we only use it for branch refinement when the RHS resolves to a constant
    // (typically a ROM byte).
    const addrInfo = resolveAddressForLine(state, line, ctx);
    if (!addrInfo) {
      state.lastCmp = null;
      state.lastNZ = null;
      state.C = null;
      return;
    }
    const canon = canonicalizeCpuAddr(addrInfo.cpuAddr);
    let rhsTracked = null;
    let rhsConst = null;

    if (canon.space === 'rom') {
      const romOffData = mapper.cpuToRomOff(canon.addr & 0xffff);
      if (romOffData != null && romOffData >= 0 && romOffData < prgBytes.length) {
        const b = prgBytes[romOffData] & 0xff;
        rhsConst = b;
        rhsTracked = trackedWith(vConst8(b), bConst8(b), pReadRom8(pConst16(romOffData)), romOff);
      }
    }

    if (!rhsTracked) {
      rhsTracked = getMem8(state, canon);
      if (isByteConst(rhsTracked.abs)) rhsConst = rhsTracked.abs.v & 0xff;
    }

    state.lastCmp = (rhsConst != null) ? { reg, imm: rhsConst } : null;
    state.lastNZ = null;
    state.C = null;

    const km = clamp8(rhsTracked.bits?.knownMask ?? 0);
    if (rhsConst != null || canon.space === 'rom' || canon.space === 'io' || km !== 0) {
      const rhsAbs = rhsConst != null ? vConst8(rhsConst) : rhsTracked.abs;
      emitCmpFact(sinks, {
        kind: 'cmp8',
        label: 'Compare8',
        atRomOff: romOff,
        reg,
        lhs: {
          abs: lhs.abs,
          bits: { knownMask: clamp8(lhs.bits?.knownMask ?? 0), knownValue: clamp8(lhs.bits?.knownValue ?? 0) }
        },
        rhs: {
          kind: 'mem',
          src: {
            space: canon.space,
            addr: canon.addr & 0xffff,
            romOff: (canon.space === 'rom' && rhsConst != null) ? (mapper.cpuToRomOff(canon.addr & 0xffff) >>> 0) : null,
            ptrZp: typeof addrInfo.ptrZp === 'number' ? (addrInfo.ptrZp & 0xff) : null
          }
        },
        rhsValue: {
          abs: rhsAbs,
          bits: { knownMask: km, knownValue: clamp8(rhsTracked.bits?.knownValue ?? 0) }
        },
        outcomes: (rhsConst != null) ? maybeOutcomeFlagsForImmCompare(lhs.abs, rhsConst) : null,
        basis: { romOffSpan: mkSpan(romOff, spanEndFromLine(line)) },
        prov: lhs.prov
      });
    }
    return;
  }

  // Anything else: if it writes a tracked register, conservatively forget it.
  // We intentionally keep this list small to avoid accidentally becoming "too clever".
  if (m === 'LDA') setReg(state, 'A', makeTracked());
  if (m === 'LDX') setReg(state, 'X', makeTracked());
  if (m === 'LDY') setReg(state, 'Y', makeTracked());
}

async function yieldToEventLoop() {
  await new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

export async function runVsaFacts({
  prgBytes,
  mapper,
  blocks,
  edges,
  entryBlockIds,
  yieldEveryMs = 0,
  onProgress = null,
  progressEveryMs = 0
}) {
  const allZp = new Set();
  for (let i = 0; i < 0x100; i++) allZp.add(i);

  const byId = new Map(blocks.map((b) => [b.id, b]));
  const succs = new Map();
  for (const e of edges) {
    if (!e.to) continue;
    if (!succs.has(e.from)) succs.set(e.from, []);
    succs.get(e.from).push(e);
  }

  // IMPORTANT: Treat blocks as unreachable until proven reachable from an entry.
  // We start from ⊥ (unreachable) rather than Top (all-unknown), otherwise joins never improve
  // and the worklist would stop after the entry blocks.
  const inStates = new Map();

  const work = [];
  for (const bid of new Set(entryBlockIds || [])) {
    inStates.set(bid, makeState(allZp, { trackRam: true }));
    work.push(bid);
  }

  // Progress metric: blocks that have been processed since their last IN change.
  // Unseen blocks are treated as unstable until first processed.
  const totalBlocks = blocks.length;
  const seen = new Set();
  const dirty = new Set(work);
  let seenCount = 0;
  let dirtySeenCount = 0;

  function markDirty(bid) {
    if (dirty.has(bid)) return;
    dirty.add(bid);
    if (seen.has(bid)) dirtySeenCount++;
  }

  function markProcessed(bid) {
    if (!seen.has(bid)) {
      seen.add(bid);
      seenCount++;
      if (dirty.has(bid)) dirtySeenCount++;
    }
    if (dirty.delete(bid)) {
      if (seen.has(bid)) dirtySeenCount--;
    }
  }

  let lastProgressAt = Date.now();
  function maybeReportProgress(force = false) {
    if (typeof onProgress !== 'function') return;
    if (!(progressEveryMs > 0)) return;
    const now = Date.now();
    if (!force && (now - lastProgressAt) < progressEveryMs) return;
    lastProgressAt = now;
    const stableBlocks = seenCount - dirtySeenCount;
    onProgress({ stableBlocks, totalBlocks });
  }
  const factsOut = [];
  const factsByKey = new Set();
  const sinks = { factsOut, factsByKey };

  let lastYieldAt = Date.now();
  async function maybeYield() {
    if (!(yieldEveryMs > 0)) return;
    const now = Date.now();
    if (now - lastYieldAt >= yieldEveryMs) {
      await yieldToEventLoop();
      lastYieldAt = Date.now();
    }
  }

  while (work.length) {
    await maybeYield();
    maybeReportProgress();
    const bid = work.pop();
    const block = byId.get(bid);
    if (!block) continue;

    const inState = inStates.get(bid);
    if (!inState) continue;
    const cur = cloneState(inState);

    let branchMnemonic = null;

    let lineIdx = 0;
    for (const line of block.lines) {
      if ((lineIdx++ & 63) === 0) {
        await maybeYield();
      }
      applyInstruction(cur, line, { prgBytes, mapper }, sinks);
      if (line.flow.type === 'branch') branchMnemonic = line.mnemonic;
    }

    const { taken, fall } = branchMnemonic ? constrainBranchEdges(cur, branchMnemonic) : { taken: null, fall: null };

    const outs = succs.get(bid) || [];
    for (const e of outs) {
      const outState =
        e.kind === 'branch_taken' && taken ? taken :
        e.kind === 'branch_fallthrough' && fall ? fall :
        cur;

      const next = inStates.get(e.to);
      if (!next) {
        // First time reaching this block: its IN state is exactly the incoming state.
        inStates.set(e.to, cloneState(outState));
        markDirty(e.to);
        work.push(e.to);
        continue;
      }

      const merged = cloneState(next);
      const changed = joinInto(merged, outState);
      if (changed) {
        inStates.set(e.to, merged);
        markDirty(e.to);
        work.push(e.to);
      }
    }

    // This block is now "stable" until/unless some predecessor updates its IN state again.
    markProcessed(bid);
  }

  // Force a final "complete" update so the bar can hit 100% before disappearing.
  if (typeof onProgress === 'function' && (progressEveryMs > 0)) {
    onProgress({ stableBlocks: totalBlocks, totalBlocks });
  }

  const counts = { store8: 0, read8: 0, cmp8: 0, zpPtr16: 0 };
  for (const f of factsOut) {
    if (counts[f.kind] != null) counts[f.kind]++;
  }

  return {
    version: 2,
    facts: factsOut,
    stats: {
      factCount: factsOut.length,
      ...counts
    }
  };
}
