import { constrainBranchEdges } from './constraints.js';
import { makeState, cloneState, makeTracked, joinInto } from './state.js';
import { vUnknown, vConst8, vSet8, vEnumerate, vAnd8, vOr8, vXor8, vShl1, vShr1, vAdd8, vFilterEq, vFilterNe, vFilterLt, vFilterGe, vIsEmpty } from './value.js';
import { bUnknown8, bConst8, bJoin, bAndImm, bOrImm, bXorImm, bShl1, bShr1 } from './bits.js';
import { enumerateTrackedByteValues } from './trackedValue.js';
import { pUnknown, pConst8, pConst16, pAdd16, pAdd8, pAnd8, pOr8, pXor8, pShl1, pShr1, pReadRom8, pReadMem8, pPtr16FromZp, pJoin } from './prov.js';
import { createObservationCollector } from './observations.js';
import { branchTakenWhen, flagKnownValue, flagReadByBranchMnemonic, makeFlagSource, setFlag, writeAluFlags, writeBitFlags, writeCompareFlags, writeExplicitFlag, writeNZFromResult, writeShiftFlags } from './flags.js';
import { clamp8 } from '../../utils/numberUtils.js';
import { read8, read16le } from '../../utils/byteUtils.js';
import { canonicalizeCpuAddr, normalizeCpuAddrSet } from '../../utils/addressUtils.js';
import { normalizeRomOffsets, readRomCandidates } from '../../utils/romReadUtils.js';
import { cpuToRomOffWithMapper } from '../map/cpuToRomOff.js';
import { applyPpuAddrWrite, applyPpuCtrlWrite, applyPpuScrollWrite, advancePpuAddrAfterPpudata, classifyPpuDataWrite, observePpuCtrlWrite, resetPpuAddressLatch } from './ppuState.js';

function isByteConst(abs) {
  return abs && abs.kind === 'const';
}

function normalizeMode(mode) {
  if (typeof mode !== 'string') return mode;
  switch (mode) {
    case 'absX': return 'abs_x';
    case 'absY': return 'abs_y';
    case 'zpX': return 'zp_x';
    case 'zpY': return 'zp_y';
    case 'indX': return 'ind_x';
    case 'indY': return 'ind_y';
    default: return mode;
  }
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

function trackedFromRomRead(read, prov, spanStartRomOff) {
  if (!read || read.kind === 'unknown' || !Array.isArray(read.bytes) || !read.bytes.length) {
    return trackedWith(vUnknown(), bUnknown8(), prov, spanStartRomOff);
  }
  const uniqueBytes = Array.from(new Set(read.bytes.map((b) => b & 0xff))).sort((a, b) => a - b);
  const abs = uniqueBytes.length === 1 ? vConst8(uniqueBytes[0]) : vSet8(uniqueBytes);
  const bits = joinBitsForConstBytes(uniqueBytes);
  return trackedWith(abs, bits, prov, spanStartRomOff);
}

function spanEndFromLine(line) {
  const start = typeof line?.romOff === 'number' ? (line.romOff >>> 0) : 0;
  const len = typeof line?.len === 'number' ? (line.len >>> 0) : 0;
  return (start + len) >>> 0;
}

function maybeEmit(hooks, name, payload) {
  const fn = hooks && hooks[name];
  if (typeof fn === 'function') fn(payload);
}

function maybeRecord(observationCollector, methodName, payload) {
  const fn = observationCollector && observationCollector[methodName];
  if (typeof fn === 'function') fn(payload);
}

function withObservationContext(payload, observationContext) {
  if (!observationContext) return payload;
  return { ...payload, ...observationContext };
}

function emitRead(observationCollector, hooks, payload, observationContext = null) {
  const enriched = withObservationContext(payload, observationContext);
  maybeRecord(observationCollector, 'recordRead', enriched);
  maybeEmit(hooks, 'onRead', enriched);
}

function emitWrite(observationCollector, hooks, payload, observationContext = null) {
  const enriched = withObservationContext(payload, observationContext);
  maybeRecord(observationCollector, 'recordWrite', enriched);
  maybeEmit(hooks, 'onWrite', enriched);
}

function emitCompare(observationCollector, hooks, payload, observationContext = null) {
  const enriched = withObservationContext(payload, observationContext);
  maybeRecord(observationCollector, 'recordCompare', enriched);
  maybeEmit(hooks, 'onCompare', enriched);
}

function emitZpPtr16(observationCollector, hooks, payload, observationContext = null) {
  const enriched = withObservationContext(payload, observationContext);
  maybeRecord(observationCollector, 'recordZpPtr16', enriched);
  maybeEmit(hooks, 'onZpPtr16', enriched);
}

function emitValueFlow(observationCollector, hooks, payload, observationContext = null) {
  const enriched = withObservationContext(payload, observationContext);
  maybeRecord(observationCollector, 'recordValueFlow', enriched);
  maybeEmit(hooks, 'onValueFlow', enriched);
}

function emitBranchFlagUse(observationCollector, hooks, payload, observationContext = null) {
  const enriched = withObservationContext(payload, observationContext);
  maybeRecord(observationCollector, 'recordBranchFlagUse', enriched);
  maybeEmit(hooks, 'onBranchFlagUse', enriched);
}

function observationContextForRawBlock(rawBlockId, blockContextIndex, vsaRole = 'confirmed') {
  if (!blockContextIndex || typeof rawBlockId !== 'string') return { rawBlockId, vsaRole, entryFamilies: [], functionIds: [] };
  const familySet = blockContextIndex.rawBlockFamiliesById?.get(rawBlockId) || new Set();
  const functionSet = blockContextIndex.rawBlockFunctionIdsById?.get(rawBlockId) || new Set();
  return {
    rawBlockId,
    vsaRole,
    entryFamilies: Array.from(familySet).sort(),
    functionIds: Array.from(functionSet).sort()
  };
}

function zpAddrFromModeOperand(op8, idxConst) {
  const base = op8 & 0xff;
  if (idxConst == null) return base;
  return (base + (idxConst & 0xff)) & 0xff;
}

function setMem8(state, canon, tracked) {
  if (canon.space === 'zp') {
    if (state.zp.has(canon.addr & 0xff)) state.zp.set(canon.addr & 0xff, tracked);
    return;
  }
  if (canon.space === 'ram' || canon.space === 'prgram') {
    if (!state.ram) return;
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

function joinBitsForConstBytes(values) {
  if (!Array.isArray(values) || !values.length) return bUnknown8();
  let bits = bConst8(values[0]);
  for (let i = 1; i < values.length; i++) bits = bJoin(bits, bConst8(values[i]));
  return bits;
}

function ptrProvFromZp(ptrZp, lo, hi) {
  return pPtr16FromZp(ptrZp & 0xff, lo?.prov || pUnknown(), hi?.prov || pUnknown());
}

function buildAddrProv(baseCpuAddr, indexTracked = null, indexSource = null) {
  if (indexTracked?.prov && indexSource) return pAdd16(pConst16(baseCpuAddr & 0xffff), indexTracked.prov);
  return pConst16(baseCpuAddr & 0xffff);
}

function joinProvList(provs) {
  const list = (provs || []).filter(Boolean);
  if (!list.length) return pUnknown();
  let out = list[0];
  for (let i = 1; i < list.length; i++) out = pJoin(out, list[i]);
  return out;
}

function enumerateTrackedValues(tracked, cap = 16) {
  return enumerateTrackedByteValues(tracked, cap)?.values || null;
}

function trackedValueEnumerationSource(tracked, cap = 16) {
  return enumerateTrackedByteValues(tracked, cap)?.source || null;
}

function normalizeIoRegisterAddr(addr) {
  const a = addr & 0xffff;
  if (a >= 0x2000 && a <= 0x3fff) return 0x2000 + ((a - 0x2000) & 0x0007);
  return a;
}

function exactIoAddrFromAddrInfo(addrInfo) {
  if (!addrInfo) return null;
  const cpuAddrs = Array.isArray(addrInfo.cpuAddrs)
    ? addrInfo.cpuAddrs
    : (typeof addrInfo.cpuAddr === 'number' ? [addrInfo.cpuAddr] : []);
  if (cpuAddrs.length !== 1) return null;
  const canon = canonicalizeCpuAddr(cpuAddrs[0]);
  return canon.space === 'io' ? normalizeIoRegisterAddr(canon.addr) : null;
}

const READ_ADDRESS_SET_CAP = 32;

function resolveExactAddressForLine(state, line, { prgBytes }) {
  const mode = normalizeMode(line.mode);
  const romOff = line.romOff >>> 0;

  if (mode === 'zp') {
    const op = read8(prgBytes, romOff, 1) & 0xff;
    return { kind: 'cpu', cpuAddr: op, addrProv: pConst16(op) };
  }

  if (mode === 'zp_x' || mode === 'zp_y') {
    const op = read8(prgBytes, romOff, 1) & 0xff;
    const idxReg = mode === 'zp_x' ? 'X' : 'Y';
    const idx = getReg(state, idxReg);
    if (!isByteConst(idx.abs)) return null;
    const cpuAddr = zpAddrFromModeOperand(op, idx.abs.v);
    return { kind: 'cpu', cpuAddr, addrProv: buildAddrProv(op, idx, idxReg) };
  }

  if (mode === 'abs' || mode === 'abs_x' || mode === 'abs_y') {
    const base = read16le(prgBytes, romOff, 1);
    if (mode === 'abs') return { kind: 'cpu', cpuAddr: base, baseCpuAddr: base, addrProv: pConst16(base) };
    const idxReg = mode === 'abs_x' ? 'X' : 'Y';
    const idx = getReg(state, idxReg);
    if (!isByteConst(idx.abs)) return null;
    const cpuAddr = (base + idx.abs.v) & 0xffff;
    return { kind: 'cpu', cpuAddr, baseCpuAddr: base, indexSource: idxReg, indexTracked: idx, addrProv: buildAddrProv(base, idx, idxReg) };
  }

  if (mode === 'ind_y') {
    const ptrZp = read8(prgBytes, romOff, 1) & 0xff;
    const y = getReg(state, 'Y');
    if (!isByteConst(y.abs)) return null;
    const lo = state.zp.get(ptrZp) || makeTracked();
    const hi = state.zp.get((ptrZp + 1) & 0xff) || makeTracked();
    if (!isByteConst(lo.abs) || !isByteConst(hi.abs)) return null;
    const baseCpuAddr = ((hi.abs.v << 8) | lo.abs.v) & 0xffff;
    return {
      kind: 'cpu',
      cpuAddr: (baseCpuAddr + y.abs.v) & 0xffff,
      baseCpuAddr,
      ptrZp,
      lo,
      hi,
      indexTracked: y,
      indexSource: 'Y',
      addrProv: pAdd16(ptrProvFromZp(ptrZp, lo, hi), y.prov)
    };
  }

  if (mode === 'ind_x') {
    const zpBase = read8(prgBytes, romOff, 1) & 0xff;
    const x = getReg(state, 'X');
    if (!isByteConst(x.abs)) return null;
    const ptrZp = (zpBase + x.abs.v) & 0xff;
    const lo = state.zp.get(ptrZp) || makeTracked();
    const hi = state.zp.get((ptrZp + 1) & 0xff) || makeTracked();
    if (!isByteConst(lo.abs) || !isByteConst(hi.abs)) return null;
    const baseCpuAddr = ((hi.abs.v << 8) | lo.abs.v) & 0xffff;
    return {
      kind: 'cpu',
      cpuAddr: baseCpuAddr,
      baseCpuAddr,
      ptrZp,
      lo,
      hi,
      indexTracked: x,
      indexSource: 'X',
      addrProv: ptrProvFromZp(ptrZp, lo, hi)
    };
  }

  return null;
}


function resolveAddressSetForLine(state, line, { prgBytes }, maxSet = 16) {
  const exact = resolveExactAddressForLine(state, line, { prgBytes });
  if (exact) return { ...exact, kind: 'cpu_set', cpuAddrs: [exact.cpuAddr & 0xffff] };

  const mode = normalizeMode(line.mode);
  const romOff = line.romOff >>> 0;

  if (mode === 'zp_x' || mode === 'zp_y') {
    const op = read8(prgBytes, romOff, 1) & 0xff;
    const idxReg = mode === 'zp_x' ? 'X' : 'Y';
    const idx = getReg(state, idxReg);
    const idxVals = enumerateTrackedValues(idx, maxSet);
    if (!idxVals?.length) return null;
    const cpuAddrs = normalizeCpuAddrSet(idxVals.map((v) => zpAddrFromModeOperand(op, v)), maxSet);
    if (!cpuAddrs) return null;
    return { kind: 'cpu_set', cpuAddrs, baseCpuAddr: op & 0xff, indexSource: idxReg, indexTracked: idx, indexValues: idxVals.map((value) => value & 0xff), indexValueSource: trackedValueEnumerationSource(idx, maxSet), addrProv: buildAddrProv(op, idx, idxReg) };
  }

  if (mode === 'abs_x' || mode === 'abs_y') {
    const base = read16le(prgBytes, romOff, 1);
    const idxReg = mode === 'abs_x' ? 'X' : 'Y';
    const idx = getReg(state, idxReg);
    const idxVals = enumerateTrackedValues(idx, maxSet);
    if (!idxVals?.length) return null;
    const cpuAddrs = normalizeCpuAddrSet(idxVals.map((v) => (base + v) & 0xffff), maxSet);
    if (!cpuAddrs) return null;
    return { kind: 'cpu_set', cpuAddrs, baseCpuAddr: base, indexSource: idxReg, indexTracked: idx, indexValues: idxVals.map((value) => value & 0xff), indexValueSource: trackedValueEnumerationSource(idx, maxSet), addrProv: buildAddrProv(base, idx, idxReg) };
  }

  if (mode === 'ind_y') {
    const ptrZp = read8(prgBytes, romOff, 1) & 0xff;
    const y = getReg(state, 'Y');
    const yVals = enumerateTrackedValues(y, maxSet);
    if (!yVals?.length) return null;
    const lo = state.zp.get(ptrZp) || makeTracked();
    const hi = state.zp.get((ptrZp + 1) & 0xff) || makeTracked();
    const loVals = enumerateTrackedValues(lo, maxSet);
    const hiVals = enumerateTrackedValues(hi, maxSet);
    if (!loVals?.length || !hiVals?.length) return null;
    if ((loVals.length * hiVals.length * yVals.length) > maxSet) return null;
    const cpuAddrs = [];
    for (const loByte of loVals) {
      for (const hiByte of hiVals) {
        const base = ((hiByte << 8) | loByte) & 0xffff;
        for (const yByte of yVals) cpuAddrs.push((base + yByte) & 0xffff);
      }
    }
    const normalized = normalizeCpuAddrSet(cpuAddrs, maxSet);
    if (!normalized) return null;
    return {
      kind: 'cpu_set',
      cpuAddrs: normalized,
      ptrZp,
      indexSource: 'Y',
      indexTracked: y,
      indexValues: yVals.map((value) => value & 0xff),
      indexValueSource: trackedValueEnumerationSource(y, maxSet),
      addrProv: pAdd16(ptrProvFromZp(ptrZp, lo, hi), y.prov || pUnknown())
    };
  }

  if (mode === 'ind_x') {
    const zpBase = read8(prgBytes, romOff, 1) & 0xff;
    const x = getReg(state, 'X');
    const xVals = enumerateTrackedValues(x, maxSet);
    if (!xVals?.length) return null;
    if (xVals.length > maxSet) return null;
    const cpuAddrs = [];
    const provs = [];
    for (const xByte of xVals) {
      const ptrZp = (zpBase + xByte) & 0xff;
      const lo = state.zp.get(ptrZp) || makeTracked();
      const hi = state.zp.get((ptrZp + 1) & 0xff) || makeTracked();
      const loVals = enumerateTrackedValues(lo, maxSet);
      const hiVals = enumerateTrackedValues(hi, maxSet);
      if (!loVals?.length || !hiVals?.length) return null;
      if ((cpuAddrs.length + (loVals.length * hiVals.length)) > maxSet) return null;
      for (const loByte of loVals) {
        for (const hiByte of hiVals) cpuAddrs.push(((hiByte << 8) | loByte) & 0xffff);
      }
      provs.push(ptrProvFromZp(ptrZp, lo, hi));
    }
    const normalized = normalizeCpuAddrSet(cpuAddrs, maxSet);
    if (!normalized) return null;
    return {
      kind: 'cpu_set',
      cpuAddrs: normalized,
      ptrZp: null,
      indexSource: 'X',
      indexTracked: x,
      indexValues: xVals.map((value) => value & 0xff),
      indexValueSource: trackedValueEnumerationSource(x, maxSet),
      addrProv: provs.length === 1 ? provs[0] : joinProvList(provs)
    };
  }

  return null;
}

function readRomCandidatesForAddrSet(prgBytes, mapper, cpuAddrs, fetchCtx = null, maxSet = 32) {
  const normalized = normalizeCpuAddrSet(cpuAddrs, maxSet);
  if (!normalized) return { kind: 'unknown', physicalRom: { kind: 'unknown', romOffsets: [] }, cpuAddrs: [], bytes: [] };
  const romOffsets = [];
  const bytes = [];
  const outCpuAddrs = [];
  for (const cpuAddr of normalized) {
    const read = readRomCandidates(prgBytes, mapper, cpuAddr, fetchCtx, maxSet);
    if (read.kind === 'unknown') return { kind: 'unknown', physicalRom: { kind: 'unknown', romOffsets: [] }, cpuAddrs: [], bytes: [] };
    outCpuAddrs.push(cpuAddr & 0xffff);
    for (const off of read.physicalRom.romOffsets || []) romOffsets.push(off >>> 0);
    for (const b of read.bytes || []) bytes.push(b & 0xff);
  }
  const physicalRomOffsets = normalizeRomOffsets(romOffsets, maxSet);
  if (!physicalRomOffsets) return { kind: 'unknown', physicalRom: { kind: 'unknown', romOffsets: [] }, cpuAddrs: [], bytes: [] };
  return {
    kind: physicalRomOffsets.length === 1 ? 'exact' : 'set',
    physicalRom: { kind: physicalRomOffsets.length === 1 ? 'exact' : 'set', romOffsets: physicalRomOffsets },
    cpuAddrs: outCpuAddrs,
    bytes
  };
}

function readTrackedFromAddressSet(state, addrInfo, spanStartRomOff = null) {
  const rawCpuAddrs = Array.isArray(addrInfo?.cpuAddrs) && addrInfo.cpuAddrs.length
    ? addrInfo.cpuAddrs
    : (typeof addrInfo?.cpuAddr === 'number' ? [addrInfo.cpuAddr] : []);
  const cpuAddrs = normalizeCpuAddrSet(rawCpuAddrs, READ_ADDRESS_SET_CAP);
  if (!cpuAddrs?.length) return null;

  const canonList = [];
  for (const cpuAddr of cpuAddrs) {
    const canon = canonicalizeCpuAddr(cpuAddr);
    if (!(canon.space === 'zp' || canon.space === 'ram' || canon.space === 'prgram')) return null;
    canonList.push(canon);
  }

  const absVals = [];
  const provs = [];
  const spanStarts = [];
  let bits = null;
  let allCellsEnumerable = true;

  for (const canon of canonList) {
    const cell = getMem8(state, canon);
    const vals = enumerateTrackedValues(cell, 16);
    if (vals?.length) {
      absVals.push(...vals);
    } else {
      allCellsEnumerable = false;
    }

    provs.push(pReadMem8(canon.space, canon.addr, cell.prov || pUnknown()));
    spanStarts.push((typeof cell.spanStartRomOff === 'number')
      ? (cell.spanStartRomOff >>> 0)
      : (typeof spanStartRomOff === 'number' ? (spanStartRomOff >>> 0) : null));
    bits = bits ? bJoin(bits, cell.bits || bUnknown8()) : (cell.bits || bUnknown8());
  }

  const abs = allCellsEnumerable ? vSet8(absVals) : vUnknown();
  const cleanSpanStarts = spanStarts.filter((value) => typeof value === 'number');
  return {
    tracked: trackedWith(abs, bits || bUnknown8(), joinProvList(provs), cleanSpanStarts.length ? Math.min(...cleanSpanStarts) : null),
    canonList
  };
}

function tryReadIndexedRom(prgBytes, mapper, fetchCtx, baseCpuAddr, indexTracked, indexSource, spanStartRomOff) {
  const idxEnumeration = enumerateTrackedByteValues(indexTracked, 32);
  const idxVals = idxEnumeration?.values || null;
  const addrProv = buildAddrProv(baseCpuAddr, indexTracked, indexSource);
  const prov = pReadRom8(addrProv, indexSource || null);
  if (!idxVals || idxVals.length === 0) {
    return {
      tracked: trackedWith(vUnknown(), bUnknown8(), prov, spanStartRomOff),
      cpuAddrs: [],
      exactCpuAddr: null,
      indexSource,
      indexValues: [],
      indexValueSource: null,
      addrProv,
      physicalRom: { kind: 'unknown', romOffsets: [] },
      unresolvedIndex: true
    };
  }

  const bytes = [];
  const cpuAddrs = [];
  const romOffsets = [];
  for (const idx of idxVals) {
    const cpuAddr = (baseCpuAddr + (idx & 0xff)) & 0xffff;
    const read = readRomCandidates(prgBytes, mapper, cpuAddr, fetchCtx, 32);
    if (read.kind === 'unknown') {
      return {
        tracked: trackedWith(vUnknown(), bUnknown8(), prov, spanStartRomOff),
        cpuAddrs: [],
        exactCpuAddr: null,
        indexSource,
        indexValues: idxVals.map((value) => value & 0xff),
        indexValueSource: idxEnumeration?.source || null,
        addrProv,
        physicalRom: { kind: 'unknown', romOffsets: [] }
      };
    }
    cpuAddrs.push(cpuAddr);
    for (const off of read.physicalRom.romOffsets || []) romOffsets.push(off >>> 0);
    for (const b of read.bytes || []) bytes.push(b & 0xff);
  }

  const physicalRomOffsets = normalizeRomOffsets(romOffsets, 32);
  if (!physicalRomOffsets) {
    return {
      tracked: trackedWith(vUnknown(), bUnknown8(), prov, spanStartRomOff),
      cpuAddrs: [],
      exactCpuAddr: null,
      indexSource,
      indexValues: idxVals.map((value) => value & 0xff),
      indexValueSource: idxEnumeration?.source || null,
      addrProv,
      physicalRom: { kind: 'unknown', romOffsets: [] }
    };
  }
  const physicalRom = { kind: physicalRomOffsets.length === 1 ? 'exact' : 'set', romOffsets: physicalRomOffsets };
  const tracked = trackedFromRomRead({ kind: physicalRom.kind, physicalRom, bytes }, prov, spanStartRomOff);
  return {
    tracked,
    cpuAddrs,
    exactCpuAddr: cpuAddrs.length === 1 ? cpuAddrs[0] : null,
    indexSource,
    indexValues: idxVals.map((value) => value & 0xff),
    indexValueSource: idxEnumeration?.source || null,
    addrProv,
    physicalRom
  };
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

function regSubject(reg) {
  return { kind: 'reg', reg };
}

function memSubject(canon = null) {
  if (!canon?.space) return { kind: 'mem', space: null, addr: null };
  return { kind: 'mem', space: canon.space, addr: canon.addr & 0xffff };
}

function aluSubject(reg = 'A') {
  return { kind: 'aluResult', reg };
}


function writeRegisterResultFlags(state, line, reg, tracked) {
  writeNZFromResult(state.flags, line, tracked, { subject: regSubject(reg) });
}

function writeMemoryResultFlags(state, line, canon, tracked) {
  writeNZFromResult(state.flags, line, tracked, { subject: memSubject(canon) });
}

function writeUnknownMemoryResultFlags(state, line) {
  writeNZFromResult(state.flags, line, makeTracked(), { subject: { kind: 'mem', space: null, addr: null } });
}

function branchRomTargetFromLine(line, mapper, fetchCtx) {
  if (typeof line?.flow?.targetRomOff === 'number') return line.flow.targetRomOff >>> 0;
  if (typeof line?.flow?.target !== 'number') return null;
  const resolved = cpuToRomOffWithMapper(mapper, line.flow.target & 0xffff, fetchCtx || null);
  return typeof resolved === 'number' ? (resolved >>> 0) : null;
}

function branchFallthroughRomFromLine(line, mapper, fetchCtx) {
  if (typeof line?.flow?.fallthroughRomOff === 'number') return line.flow.fallthroughRomOff >>> 0;
  if (typeof line?.flow?.fallthrough !== 'number') return null;
  const resolved = cpuToRomOffWithMapper(mapper, line.flow.fallthrough & 0xffff, fetchCtx || null);
  return typeof resolved === 'number' ? (resolved >>> 0) : null;
}

function recordBranchFlagUseForLine(state, line, ctx, observationCollector, hooks, observationContext) {
  const flag = flagReadByBranchMnemonic(line?.mnemonic);
  const takenWhen = branchTakenWhen(line?.mnemonic);
  if (!flag || !(takenWhen === 0 || takenWhen === 1)) return;
  const knownFlagValue = flagKnownValue(state.flags, flag);
  emitBranchFlagUse(observationCollector, hooks, {
    line,
    branch: {
      mnemonic: line.mnemonic,
      flag,
      takenWhen,
      targetRomOff: branchRomTargetFromLine(line, ctx.mapper, ctx.fetchCtx || null),
      fallthroughRomOff: branchFallthroughRomFromLine(line, ctx.mapper, ctx.fetchCtx || null),
      targetCpuAddr: typeof line?.flow?.target === 'number' ? (line.flow.target & 0xffff) : null,
      fallthroughCpuAddr: typeof line?.flow?.fallthrough === 'number' ? (line.flow.fallthrough & 0xffff) : null
    },
    source: state.flags?.[flag]?.source || null,
    valueProof: {
      knownFlagValue,
      knownTaken: knownFlagValue == null ? null : knownFlagValue === takenWhen
    }
  }, observationContext);
}

function maybeEmitZpPtr16(observationCollector, hooks, state, zpAddr, curLine, observationContext = null) {
  const a = zpAddr & 0xff;
  const lo = state.zp.get(a) || makeTracked();
  const hi = state.zp.get((a + 1) & 0xff) || makeTracked();
  if (!isByteConst(lo.abs) || !isByteConst(hi.abs)) return;

  const v16 = ((hi.abs.v << 8) | lo.abs.v) & 0xffff;
  const sa = (typeof lo.spanStartRomOff === 'number') ? lo.spanStartRomOff : null;
  const sb = (typeof hi.spanStartRomOff === 'number') ? hi.spanStartRomOff : null;
  const spanStart = (sa != null && sb != null) ? Math.min(sa, sb) : (sa != null ? sa : sb);
  if (spanStart == null) return;

  emitZpPtr16(observationCollector, hooks, {
    line: curLine,
    zpAddr: a,
    value16: v16,
    spanStartRomOff: spanStart,
    spanEndRomOff: spanEndFromLine(curLine),
    lo,
    hi,
    prov: ptrProvFromZp(a, lo, hi)
  }, observationContext);
}

function applyInstruction(state, line, ctx, observationCollector, hooks, options) {
  const { prgBytes, mapper } = ctx;
  const m = line.mnemonic;
  const mode = normalizeMode(line.mode);
  const romOff = line.romOff >>> 0;
  const observationContext = observationContextForRawBlock(options?.rawBlockId || null, options?.blockContextIndex || null, options?.vsaRole === 'candidate' ? 'candidate' : 'confirmed');

  if (line?.flow?.type === 'branch') {
    recordBranchFlagUseForLine(state, line, ctx, observationCollector, hooks, observationContext);
    return;
  }

  if ((m === 'LDA' || m === 'LDX' || m === 'LDY') && mode === 'imm') {
    const imm = read8(prgBytes, romOff, 1);
    const abs = vConst8(imm);
    const bits = bConst8(imm);
    const prov = pConst8(imm);
    const tracked = trackedWith(abs, bits, prov, romOff);
    const regName = m === 'LDA' ? 'A' : m === 'LDX' ? 'X' : 'Y';
    setReg(state, regName, tracked);
    emitValueFlow(observationCollector, hooks, { line, opKind: 'immLoad', dstReg: regName, imm, value: tracked, prov, inputProvs: [] }, observationContext);
    writeRegisterResultFlags(state, line, regName, tracked);
    return;
  }

  if (m === 'TAX' || m === 'TAY' || m === 'TXA' || m === 'TYA') {
    const srcReg = (m === 'TAX' || m === 'TAY') ? 'A' : (m === 'TXA' ? 'X' : 'Y');
    const dstReg = (m === 'TAX' || m === 'TXA') ? (m === 'TAX' ? 'X' : 'A') : (m === 'TAY' ? 'Y' : 'A');
    const src = getReg(state, srcReg);
    const tracked = { ...src };
    setReg(state, dstReg, tracked);
    emitValueFlow(observationCollector, hooks, { line, opKind: 'regTransfer', dstReg, srcRegs: [srcReg], value: tracked, prov: tracked.prov, inputProvs: [src.prov] }, observationContext);
    writeRegisterResultFlags(state, line, dstReg, tracked);
    return;
  }

  if (m === 'TSX') {
    const tracked = makeTracked();
    setReg(state, 'X', tracked);
    writeRegisterResultFlags(state, line, 'X', tracked);
    return;
  }

  if (m === 'CLC') {
    writeExplicitFlag(state.flags, line, 'C', 0, 'explicitClear');
    return;
  }
  if (m === 'SEC') {
    writeExplicitFlag(state.flags, line, 'C', 1, 'explicitSet');
    return;
  }
  if (m === 'CLV') {
    writeExplicitFlag(state.flags, line, 'V', 0, 'explicitClear');
    return;
  }

  if ((m === 'AND' || m === 'ORA' || m === 'EOR') && mode === 'imm') {
    const imm = read8(prgBytes, romOff, 1);
    const a = getReg(state, 'A');
    const abs = m === 'AND' ? vAnd8(a.abs, imm) : (m === 'ORA' ? vOr8(a.abs, imm) : vXor8(a.abs, imm));
    const bits = m === 'AND' ? bAndImm(a.bits, imm) : (m === 'ORA' ? bOrImm(a.bits, imm) : bXorImm(a.bits, imm));
    const prov = m === 'AND' ? pAnd8(a.prov, imm) : (m === 'ORA' ? pOr8(a.prov, imm) : pXor8(a.prov, imm));
    const tracked = trackedWith(abs, bits, prov, a.spanStartRomOff);
    setReg(state, 'A', tracked);
    emitValueFlow(observationCollector, hooks, { line, opKind: 'immTransform', dstReg: 'A', srcRegs: ['A'], imm, value: tracked, prov: tracked.prov, inputProvs: [a.prov] }, observationContext);
    writeRegisterResultFlags(state, line, 'A', tracked);
    return;
  }

  if ((m === 'ADC' || m === 'SBC') && mode === 'imm') {
    const imm = read8(prgBytes, romOff, 1);
    const a = getReg(state, 'A');
    const carryIn = flagKnownValue(state.flags, 'C');

    let abs = vUnknown();
    let bits = bUnknown8();
    let prov = pUnknown();
    if (m === 'ADC' && carryIn != null) {
      const delta = (imm + carryIn) | 0;
      abs = vAdd8(a.abs, delta);
      prov = pAdd8(a.prov, delta);
      if (isByteConst(a.abs)) {
        const v = clamp8(a.abs.v + delta);
        abs = vConst8(v);
        bits = bConst8(v);
      }
    }

    const tracked = trackedWith(abs, bits, prov, a.spanStartRomOff);
    setReg(state, 'A', tracked);
    emitValueFlow(observationCollector, hooks, { line, opKind: 'immTransform', dstReg: 'A', srcRegs: ['A'], imm, value: tracked, prov, inputProvs: [a.prov] }, observationContext);
    writeAluFlags(state.flags, line, tracked, { subject: aluSubject('A') });
    return;
  }

  if ((m === 'ASL' || m === 'LSR' || m === 'ROL' || m === 'ROR') && mode === 'acc') {
    const a = getReg(state, 'A');
    const direction = (m === 'ASL' || m === 'ROL') ? 'left' : 'right';
    const rotate = m === 'ROL' || m === 'ROR';
    let tracked;
    if (m === 'ASL') tracked = trackedWith(vShl1(a.abs), bShl1(a.bits), pShl1(a.prov), a.spanStartRomOff);
    else if (m === 'LSR') tracked = trackedWith(vShr1(a.abs), bShr1(a.bits), pShr1(a.prov), a.spanStartRomOff);
    else tracked = trackedWith(vUnknown(), bUnknown8(), pUnknown(), a.spanStartRomOff);
    setReg(state, 'A', tracked);
    emitValueFlow(observationCollector, hooks, { line, opKind: 'accTransform', dstReg: 'A', srcRegs: ['A'], value: tracked, prov: tracked.prov, inputProvs: [a.prov] }, observationContext);
    writeShiftFlags(state.flags, line, a, tracked, { subject: regSubject('A'), direction, rotate });
    return;
  }

  if ((m === 'ASL' || m === 'LSR' || m === 'ROL' || m === 'ROR') && mode !== 'imm' && mode !== 'acc') {
    const addrInfo = resolveExactAddressForLine(state, line, ctx);
    if (!addrInfo) {
      writeUnknownMemoryResultFlags(state, line);
      setFlag(state.flags, 'C', null, makeFlagSource(line, { effect: (m === 'ASL' || m === 'ROL') ? 'carryOutBit7' : 'carryOutBit0', subject: { kind: 'mem', space: null, addr: null } }));
      return;
    }
    const canon = canonicalizeCpuAddr(addrInfo.cpuAddr);
    const cell = getMem8(state, canon);
    const direction = (m === 'ASL' || m === 'ROL') ? 'left' : 'right';
    const rotate = m === 'ROL' || m === 'ROR';
    let tracked;
    if (m === 'ASL') tracked = trackedWith(vShl1(cell.abs), bShl1(cell.bits), pShl1(cell.prov), cell.spanStartRomOff);
    else if (m === 'LSR') tracked = trackedWith(vShr1(cell.abs), bShr1(cell.bits), pShr1(cell.prov), cell.spanStartRomOff);
    else tracked = trackedWith(vUnknown(), bUnknown8(), pUnknown(), cell.spanStartRomOff);
    if (canon.space === 'zp' || canon.space === 'ram' || canon.space === 'prgram') setMem8(state, canon, tracked);
    emitValueFlow(observationCollector, hooks, { line, opKind: 'memTransform', dst: canon, value: tracked, prov: tracked.prov, inputProvs: [cell.prov] }, observationContext);
    writeShiftFlags(state.flags, line, cell, tracked, { subject: memSubject(canon), direction, rotate });
    return;
  }

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
    const tracked = trackedWith(abs, bits, pAdd8(base.prov, delta), base.spanStartRomOff);
    setReg(state, reg, tracked);
    emitValueFlow(observationCollector, hooks, { line, opKind: 'regDelta', dstReg: reg, srcRegs: [reg], imm: delta & 0xff, value: tracked, prov: tracked.prov, inputProvs: [base.prov] }, observationContext);
    writeRegisterResultFlags(state, line, reg, tracked);
    return;
  }

  if ((m === 'INC' || m === 'DEC') && mode !== 'imm' && mode !== 'acc') {
    const addrInfo = resolveExactAddressForLine(state, line, ctx);
    if (!addrInfo) {
      writeUnknownMemoryResultFlags(state, line);
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
      const spanStart = (typeof cell.spanStartRomOff === 'number') ? cell.spanStartRomOff : romOff;
      const tracked = trackedWith(abs, bits, pAdd8(cell.prov, delta), spanStart);
      setMem8(state, canon, tracked);
      emitValueFlow(observationCollector, hooks, { line, opKind: 'memDelta', dst: canon, imm: delta & 0xff, value: tracked, prov: tracked.prov, inputProvs: [cell.prov] }, observationContext);
      writeMemoryResultFlags(state, line, canon, tracked);
      return;
    }
    writeUnknownMemoryResultFlags(state, line);
    return;
  }

  if ((m === 'LDA' || m === 'LDX' || m === 'LDY') && mode !== 'imm') {
    const regName = m === 'LDA' ? 'A' : m === 'LDX' ? 'X' : 'Y';

    if (mode === 'abs_x' || mode === 'abs_y') {
      const baseCpuAddr = read16le(prgBytes, romOff, 1);
      const idxReg = mode === 'abs_x' ? 'X' : 'Y';
      const idxTracked = getReg(state, idxReg);
      const indexedRom = tryReadIndexedRom(prgBytes, mapper, ctx.fetchCtx || null, baseCpuAddr, idxTracked, idxReg, romOff);
      if (indexedRom) {
        setReg(state, regName, indexedRom.tracked);
        writeRegisterResultFlags(state, line, regName, indexedRom.tracked);
        const src = {
          space: 'rom',
          addr: (indexedRom.exactCpuAddr != null ? indexedRom.exactCpuAddr : baseCpuAddr) & 0xffff,
          romOff: indexedRom.physicalRom?.kind === 'exact' ? (indexedRom.physicalRom.romOffsets?.[0] ?? null) : null,
          physicalRom: indexedRom.physicalRom || { kind: 'unknown', romOffsets: [] },
          ptrZp: null,
          indexSource: idxReg,
          baseCpuAddr: baseCpuAddr & 0xffff,
          unresolvedIndex: !!indexedRom.unresolvedIndex
        };
        emitRead(observationCollector, hooks, {
          line,
          dstReg: regName,
          src,
          value: indexedRom.tracked,
          prov: indexedRom.tracked.prov,
          addrInfo: {
            baseCpuAddr,
            indexSource: idxReg,
            indexTracked: idxTracked,
            indexValues: indexedRom.indexValues,
            indexValueSource: indexedRom.indexValueSource,
            addrProv: indexedRom.addrProv,
            physicalRom: indexedRom.physicalRom || { kind: 'unknown', romOffsets: [] },
            unresolvedIndex: !!indexedRom.unresolvedIndex
          }
        }, observationContext);
        return;
      }
    }

    let addrInfo = resolveExactAddressForLine(state, line, ctx);
    if (!addrInfo) addrInfo = resolveAddressSetForLine(state, line, ctx, READ_ADDRESS_SET_CAP);
    if (!addrInfo) {
      const tracked = makeTracked();
      setReg(state, regName, tracked);
      writeRegisterResultFlags(state, line, regName, tracked);
      return;
    }

    if (exactIoAddrFromAddrInfo(addrInfo) === 0x2002) resetPpuAddressLatch(state.ppu);

    const cpuAddrs = normalizeCpuAddrSet(addrInfo.cpuAddrs || [addrInfo.cpuAddr], 16) || [];
    const canon = cpuAddrs.length === 1 ? canonicalizeCpuAddr(cpuAddrs[0]) : null;
    const allCanon = canon ? [canon] : cpuAddrs.map((cpuAddr) => canonicalizeCpuAddr(cpuAddr));

    if (allCanon.length && allCanon.every((c) => c.space === 'rom')) {
      const prov = pReadRom8(addrInfo.addrProv || pConst16((cpuAddrs[0] || 0) & 0xffff), addrInfo.indexSource || null);
      const romRead = readRomCandidatesForAddrSet(prgBytes, mapper, cpuAddrs, ctx.fetchCtx || null, 32);
      if (romRead.kind !== 'unknown') {
        const tracked = trackedFromRomRead(romRead, prov, romOff);
        setReg(state, regName, tracked);
        writeRegisterResultFlags(state, line, regName, tracked);
        emitRead(observationCollector, hooks, {
          line,
          dstReg: regName,
          src: {
            space: 'rom',
            addr: cpuAddrs.length === 1 ? (cpuAddrs[0] & 0xffff) : null,
            addrSet: cpuAddrs.length > 1 ? cpuAddrs : null,
            romOff: romRead.kind === 'exact' ? (romRead.physicalRom.romOffsets?.[0] ?? null) : null,
            physicalRom: romRead.physicalRom,
            ptrZp: typeof addrInfo.ptrZp === 'number' ? (addrInfo.ptrZp & 0xff) : null,
            indexSource: addrInfo.indexSource || null,
            baseCpuAddr: typeof addrInfo.baseCpuAddr === 'number' ? (addrInfo.baseCpuAddr & 0xffff) : null
          },
          value: tracked,
          prov,
          addrInfo: { ...addrInfo, physicalRom: romRead.physicalRom }
        }, observationContext);
        return;
      }
    }

    const memRead = readTrackedFromAddressSet(state, addrInfo, romOff);
    if (memRead) {
      const tracked = memRead.tracked;
      setReg(state, regName, tracked);
      writeRegisterResultFlags(state, line, regName, tracked);
      emitRead(observationCollector, hooks, {
        line,
        dstReg: regName,
        src: {
          space: memRead.canonList.length === 1 ? memRead.canonList[0].space : 'memset',
          addr: memRead.canonList.length === 1 ? (memRead.canonList[0].addr & 0xffff) : null,
          addrSet: memRead.canonList.length > 1 ? memRead.canonList.map((c) => c.addr & 0xffff) : null,
          ptrZp: typeof addrInfo.ptrZp === 'number' ? (addrInfo.ptrZp & 0xff) : null,
          indexSource: addrInfo.indexSource || null,
          baseCpuAddr: typeof addrInfo.baseCpuAddr === 'number' ? (addrInfo.baseCpuAddr & 0xffff) : null
        },
        value: tracked,
        prov: tracked.prov,
        addrInfo
      }, observationContext);
      return;
    }

    const tracked = makeTracked();
    setReg(state, regName, tracked);
    writeRegisterResultFlags(state, line, regName, tracked);
    return;
  }

  if ((m === 'AND' || m === 'ORA' || m === 'EOR') && mode !== 'imm') {
    const a = getReg(state, 'A');
    const tracked = makeTracked();
    setReg(state, 'A', tracked);
    emitValueFlow(observationCollector, hooks, { line, opKind: 'memTransform', dstReg: 'A', srcRegs: ['A'], value: tracked, prov: tracked.prov, inputProvs: [a.prov] }, observationContext);
    writeRegisterResultFlags(state, line, 'A', tracked);
    return;
  }

  if ((m === 'ADC' || m === 'SBC') && mode !== 'imm') {
    const a = getReg(state, 'A');
    const tracked = makeTracked();
    setReg(state, 'A', tracked);
    emitValueFlow(observationCollector, hooks, { line, opKind: 'memTransform', dstReg: 'A', srcRegs: ['A'], value: tracked, prov: tracked.prov, inputProvs: [a.prov] }, observationContext);
    writeAluFlags(state.flags, line, tracked, { subject: aluSubject('A') });
    return;
  }

  if ((m === 'STA' || m === 'STX' || m === 'STY') && mode !== 'imm') {
    const addrInfo = resolveExactAddressForLine(state, line, ctx);
    if (!addrInfo) return;
    const canon = canonicalizeCpuAddr(addrInfo.cpuAddr);
    const srcReg = m === 'STA' ? 'A' : m === 'STX' ? 'X' : 'Y';
    const v = getReg(state, srcReg);

    let ppuDest = null;
    let ppuCtrl = null;
    if (canon.space === 'io') {
      const ioAddr = normalizeIoRegisterAddr(canon.addr);
      if (ioAddr === 0x2000) ppuCtrl = observePpuCtrlWrite(state.ppu, v);
      if (ioAddr === 0x2007) ppuDest = classifyPpuDataWrite(state.ppu);
    }

    if (canon.space === 'zp' || canon.space === 'ram' || canon.space === 'prgram') {
      setMem8(state, canon, { ...v });
      if (canon.space === 'zp') {
        const a = canon.addr & 0xff;
        maybeEmitZpPtr16(observationCollector, hooks, state, a, line, observationContext);
        if (a !== 0xff) maybeEmitZpPtr16(observationCollector, hooks, state, (a - 1) & 0xff, line, observationContext);
      }
    }

    emitWrite(observationCollector, hooks, {
      line,
      cpuAddr: typeof line.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null,
      srcReg,
      dst: { space: canon.space, addr: canon.addr & 0xffff },
      value: v,
      prov: v.prov,
      addrInfo,
      ppuDest,
      ppuCtrl
    }, observationContext);

    if (canon.space === 'io') {
      const ioAddr = normalizeIoRegisterAddr(canon.addr);
      if (ioAddr === 0x2000) applyPpuCtrlWrite(state.ppu, v);
      else if (ioAddr === 0x2005) applyPpuScrollWrite(state.ppu);
      else if (ioAddr === 0x2006) applyPpuAddrWrite(state.ppu, v);
      else if (ioAddr === 0x2007) advancePpuAddrAfterPpudata(state.ppu);
    }
    return;
  }

  if (m === 'CMP' || m === 'CPX' || m === 'CPY') {
    const reg = m === 'CMP' ? 'A' : m === 'CPX' ? 'X' : 'Y';
    const lhs = getReg(state, reg);

    if (mode === 'imm') {
      const imm = read8(prgBytes, romOff, 1);
      const rhsValue = trackedWith(vConst8(imm), bConst8(imm), pConst8(imm), romOff);
      writeCompareFlags(state.flags, line, lhs, rhsValue, { reg, rhs: { kind: 'imm', imm: imm & 0xff } });
      emitCompare(observationCollector, hooks, {
        line,
        reg,
        lhs,
        rhs: { kind: 'imm', imm: imm & 0xff },
        rhsValue,
        outcomes: maybeOutcomeFlagsForImmCompare(lhs.abs, imm),
        prov: lhs.prov,
        addrInfo: null
      }, observationContext);
      return;
    }

    let addrInfo = resolveExactAddressForLine(state, line, ctx);
    if (!addrInfo) addrInfo = resolveAddressSetForLine(state, line, ctx, READ_ADDRESS_SET_CAP);
    if (!addrInfo) {
      writeCompareFlags(state.flags, line, lhs, makeTracked(), { reg, rhs: { kind: 'unknown' } });
      return;
    }

    const cpuAddrs = normalizeCpuAddrSet(addrInfo.cpuAddrs || [addrInfo.cpuAddr], 16) || [];
    const canon = cpuAddrs.length === 1 ? canonicalizeCpuAddr(cpuAddrs[0]) : null;
    const allCanon = canon ? [canon] : cpuAddrs.map((cpuAddr) => canonicalizeCpuAddr(cpuAddr));
    let rhsTracked = null;
    let rhsConst = null;
    let comparePhysicalRom = null;

    if (allCanon.length && allCanon.every((c) => c.space === 'rom')) {
      const romRead = readRomCandidatesForAddrSet(prgBytes, mapper, cpuAddrs, ctx.fetchCtx || null, 32);
      if (romRead.kind !== 'unknown') {
        const uniqueBytes = Array.from(new Set((romRead.bytes || []).map((b) => b & 0xff))).sort((a, b) => a - b);
        if (uniqueBytes.length === 1) rhsConst = uniqueBytes[0];
        comparePhysicalRom = romRead.physicalRom;
        rhsTracked = trackedFromRomRead(romRead, pReadRom8(addrInfo.addrProv || pConst16((cpuAddrs[0] || 0) & 0xffff), addrInfo.indexSource || null), romOff);
      }
    }

    if (!rhsTracked) {
      const memRead = readTrackedFromAddressSet(state, addrInfo, romOff);
      if (memRead) {
        rhsTracked = memRead.tracked;
        const vals = vEnumerate(rhsTracked.abs, 16);
        if (vals && vals.length === 1) rhsConst = vals[0] & 0xff;
      }
    }

    if (!rhsTracked) {
      writeCompareFlags(state.flags, line, lhs, makeTracked(), { reg, rhs: { kind: 'unknown' } });
      return;
    }

    const rhs = {
      kind: 'mem',
      src: {
        space: canon ? canon.space : (allCanon.every((c) => c.space === 'rom') ? 'rom' : 'memset'),
        addr: canon ? (canon.addr & 0xffff) : null,
        addrSet: cpuAddrs.length > 1 ? cpuAddrs : null,
        romOff: comparePhysicalRom?.kind === 'exact' ? (comparePhysicalRom.romOffsets?.[0] ?? null) : null,
        physicalRom: comparePhysicalRom,
        ptrZp: typeof addrInfo.ptrZp === 'number' ? (addrInfo.ptrZp & 0xff) : null,
        indexSource: addrInfo.indexSource || null,
        baseCpuAddr: typeof addrInfo.baseCpuAddr === 'number' ? (addrInfo.baseCpuAddr & 0xffff) : null
      }
    };
    writeCompareFlags(state.flags, line, lhs, rhsTracked, { reg, rhs: rhsConst != null ? { kind: 'imm', imm: rhsConst } : rhs });
    emitCompare(observationCollector, hooks, {
      line,
      reg,
      lhs,
      rhs,
      rhsValue: rhsTracked,
      outcomes: (rhsConst != null) ? maybeOutcomeFlagsForImmCompare(lhs.abs, rhsConst) : null,
      prov: lhs.prov,
      addrInfo
    }, observationContext);
    return;
  }

  if (m === 'BIT') {
    const a = getReg(state, 'A');
    let addrInfo = resolveExactAddressForLine(state, line, ctx);
    if (!addrInfo) addrInfo = resolveAddressSetForLine(state, line, ctx, READ_ADDRESS_SET_CAP);
    let operand = null;
    let subject = { kind: 'mem', space: null, addr: null };
    if (addrInfo) {
      const cpuAddrs = normalizeCpuAddrSet(addrInfo.cpuAddrs || [addrInfo.cpuAddr], 16) || [];
      const canon = cpuAddrs.length === 1 ? canonicalizeCpuAddr(cpuAddrs[0]) : null;
      const allCanon = canon ? [canon] : cpuAddrs.map((cpuAddr) => canonicalizeCpuAddr(cpuAddr));
      subject = canon ? memSubject(canon) : { kind: 'memset' };
      if (allCanon.length && allCanon.every((c) => c.space === 'rom')) {
        const romRead = readRomCandidatesForAddrSet(prgBytes, mapper, cpuAddrs, ctx.fetchCtx || null, 32);
        if (romRead.kind !== 'unknown') operand = trackedFromRomRead(romRead, pReadRom8(addrInfo.addrProv || pConst16((cpuAddrs[0] || 0) & 0xffff), addrInfo.indexSource || null), romOff);
      }
      if (!operand) {
        const memRead = readTrackedFromAddressSet(state, addrInfo, romOff);
        if (memRead) operand = memRead.tracked;
      }
    }
    writeBitFlags(state.flags, line, a, operand || makeTracked(), { subject });
    return;
  }

  if (m === 'PLA') {
    const tracked = makeTracked();
    setReg(state, 'A', tracked);
    writeRegisterResultFlags(state, line, 'A', tracked);
    return;
  }

  if (m === 'PLP' || m === 'RTI') {
    for (const flag of ['N', 'V', 'Z', 'C']) {
      setFlag(state.flags, flag, null, makeFlagSource(line, { effect: 'statusRestore', subject: { kind: 'status', flag } }));
    }
    return;
  }

  if (m === 'LDA' || m === 'LDX' || m === 'LDY') {
    const reg = m === 'LDA' ? 'A' : m === 'LDX' ? 'X' : 'Y';
    const tracked = makeTracked();
    setReg(state, reg, tracked);
    writeRegisterResultFlags(state, line, reg, tracked);
  }
}

async function yieldToEventLoop() {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export async function runVsaEngine({
  prgBytes,
  mapper,
  blocks,
  edges,
  entryBlockIds,
  trackedZpAddrs,
  trackRam = false,
  strictBranchAdjacencyFacts = true,
  collectObservations = false,
  hooks = null,
  blockContextIndex = null,
  yieldEveryMs = 0,
  onProgress = null,
  progressEveryMs = 0,
  blockRolesByRawBlockId = null
}) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const succs = new Map();
  for (const e of edges) {
    if (!e.to) continue;
    if (!succs.has(e.from)) succs.set(e.from, []);
    succs.get(e.from).push(e);
  }

  const observationCollector = collectObservations ? createObservationCollector() : null;

  const inStates = new Map();
  const work = [];
  for (const bid of new Set(entryBlockIds || [])) {
    inStates.set(bid, makeState(trackedZpAddrs || [], { trackRam }));
    work.push(bid);
  }

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
    if (dirty.delete(bid) && seen.has(bid)) dirtySeenCount--;
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
        maybeReportProgress();
      }

      const blockFetchCtx = block.fetchCtx || mapper.initialFetchCtx();
      const blockVsaRole = blockRolesByRawBlockId?.get(bid) || (block?.vsaRole === 'candidate' || block?.confidence === 'probable' ? 'candidate' : 'confirmed');
      maybeEmit(hooks, 'onInstructionStart', { line, rawBlockId: bid, vsaRole: blockVsaRole, state: cur, ctx: { prgBytes, mapper, fetchCtx: blockFetchCtx } });
      const wantsInstructionEnd = typeof hooks?.onInstructionEnd === 'function';
      const beforeState = wantsInstructionEnd ? cloneState(cur) : null;
      applyInstruction(cur, line, { prgBytes, mapper, fetchCtx: blockFetchCtx }, observationCollector, hooks, { strictBranchAdjacencyFacts, rawBlockId: bid, blockContextIndex, vsaRole: blockVsaRole });
      if (wantsInstructionEnd) {
        hooks.onInstructionEnd({ line, rawBlockId: bid, vsaRole: blockVsaRole, beforeState, afterState: cloneState(cur), ctx: { prgBytes, mapper, fetchCtx: blockFetchCtx } });
      }
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

    markProcessed(bid);
  }

  if (typeof onProgress === 'function' && (progressEveryMs > 0)) {
    onProgress({ stableBlocks: totalBlocks, totalBlocks });
  }

  return {
    inStatesByRawBlockId: inStates,
    observations: observationCollector ? observationCollector.getResult() : null
  };
}
