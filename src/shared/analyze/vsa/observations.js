import { clamp8 } from '../../utils/numberUtils.js';
import { normalizeNumberList, normalizeStringList, normalizeTokenList } from '../../utils/listNormalizeUtils.js';
import { addressKey } from '../../utils/addressUtils.js';
import { normalizePhysicalRom, physicalRomKey } from '../../utils/romIdentityUtils.js';

function mkSpan(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const a = start >>> 0;
  const b = end >>> 0;
  if (a > b) return null;
  return { start: a, end: b };
}

function spanEndFromLine(line) {
  const start = typeof line?.romOff === 'number' ? (line.romOff >>> 0) : 0;
  const len = typeof line?.len === 'number' ? (line.len >>> 0) : 0;
  return (start + len) >>> 0;
}

function hasMeaningfulProvenance(prov) {
  let meaningful = false;
  walkProv(prov, (node) => {
    if (node?.kind && node.kind !== 'Unknown') meaningful = true;
  });
  return meaningful;
}

function shouldEmitStoreObservation(valTracked) {
  if (!valTracked) return false;
  const abs = valTracked.abs;
  if (abs && abs.kind !== 'unknown') {
    if (!(abs.kind === 'set' && abs.values && abs.values.length === 0)) return true;
  }
  const km = valTracked.bits?.knownMask ?? 0;
  if ((km & 0xff) !== 0) return true;
  return hasMeaningfulProvenance(valTracked.prov);
}

function walkProv(prov, visit, seen = null) {
  if (!prov || typeof prov !== 'object') return;
  const localSeen = seen || new Set();
  const id = typeof prov.id === 'number' ? prov.id : null;
  const dedupeKey = id != null ? `p:${id}` : null;
  if (dedupeKey && localSeen.has(dedupeKey)) return;
  if (dedupeKey) localSeen.add(dedupeKey);
  visit(prov);
  switch (prov.kind) {
    case 'Add16':
      walkProv(prov.a, visit, localSeen);
      walkProv(prov.b, visit, localSeen);
      return;
    case 'Add8':
    case 'And8':
    case 'Or8':
    case 'Xor8':
    case 'Shl1':
    case 'Shr1':
      walkProv(prov.a, visit, localSeen);
      return;
    case 'ReadRom8':
      walkProv(prov.addrExpr, visit, localSeen);
      return;
    case 'ReadMem8':
      walkProv(prov.base, visit, localSeen);
      return;
    case 'Ptr16FromZp':
      walkProv(prov.loBase, visit, localSeen);
      walkProv(prov.hiBase, visit, localSeen);
      return;
    case 'Join':
      for (const option of prov.options || []) walkProv(option, visit, localSeen);
      return;
    case 'Filter':
      walkProv(prov.base, visit, localSeen);
      return;
    default:
      return;
  }
}

function provIdsFrom(...provs) {
  const out = new Set();
  for (const prov of provs) {
    walkProv(prov, (node) => {
      if (typeof node?.id === 'number') out.add(node.id >>> 0);
    });
  }
  return Array.from(out).sort((a, b) => a - b);
}

function regToken(reg) {
  return (typeof reg === 'string' && reg) ? `reg:${reg}` : null;
}

function memToken(space, addr) {
  if (typeof space !== 'string' || typeof addr !== 'number') return null;
  return `mem:${space}:${space === 'rom' ? (addr >>> 0) : (addr & 0xffff)}`;
}

function addTokens(list, ...tokens) {
  for (const token of tokens.flat()) {
    if (typeof token === 'string' && token) list.push(token);
  }
}

function normalizeAddrFlow(addrInfo, src) {
  const physicalRom = normalizePhysicalRom(
    addrInfo?.physicalRom
    || src?.physicalRom
    || (typeof src?.romOff === 'number' ? { kind: 'exact', romOffsets: [src.romOff >>> 0] } : null)
  );
  const cpuAddr = typeof src?.addr === 'number' ? (src.addr & 0xffff) : null;
  const cpuAddrSet = normalizeNumberList(src?.addrSet || addrInfo?.cpuAddrs || []);
  const ptrZp = typeof addrInfo?.ptrZp === 'number' ? (addrInfo.ptrZp & 0xff) : (typeof src?.ptrZp === 'number' ? (src.ptrZp & 0xff) : null);
  const baseCpuAddr = typeof addrInfo?.baseCpuAddr === 'number'
    ? (addrInfo.baseCpuAddr & 0xffff)
    : (typeof src?.baseCpuAddr === 'number' ? (src.baseCpuAddr & 0xffff) : null);
  const indexReg = typeof addrInfo?.indexSource === 'string'
    ? addrInfo.indexSource
    : (typeof src?.indexSource === 'string' ? src.indexSource : null);
  const indexValues = normalizeNumberList(addrInfo?.indexValues || src?.indexValues || []);
  const indexValueSource = typeof addrInfo?.indexValueSource === 'string'
    ? addrInfo.indexValueSource
    : (typeof src?.indexValueSource === 'string' ? src.indexValueSource : null);
  const addrProvIds = provIdsFrom(addrInfo?.addrProv);
  return {
    cpuAddr,
    cpuAddrSet,
    baseCpuAddr,
    ptrZp,
    indexReg,
    indexValues,
    indexValueSource,
    physicalRom,
    addrProvIds
  };
}

function buildReadUsesDefs(dstReg, src, addrInfo) {
  const uses = [];
  const defs = [];
  addTokens(defs, regToken(dstReg));
  const indexReg = addrInfo?.indexReg || src?.indexSource || null;
  addTokens(uses, regToken(indexReg));
  const ptrZp = addrInfo?.ptrZp;
  if (typeof ptrZp === 'number') {
    addTokens(uses, memToken('zp', ptrZp), memToken('zp', (ptrZp + 1) & 0xff));
  }
  return {
    uses: normalizeTokenList(uses),
    defs: normalizeTokenList(defs)
  };
}

function buildValueFlowUsesDefs({ dstReg, dst, srcRegs }) {
  const uses = [];
  const defs = [];
  addTokens(uses, (srcRegs || []).map((reg) => regToken(reg)));
  addTokens(defs, regToken(dstReg), dst?.space ? memToken(dst.space, dst.addr) : null);
  return {
    uses: normalizeTokenList(uses),
    defs: normalizeTokenList(defs)
  };
}

function buildStoreUsesDefs(srcReg, dst) {
  return {
    uses: normalizeTokenList([regToken(srcReg)]),
    defs: normalizeTokenList([dst?.space ? memToken(dst.space, dst.addr) : null])
  };
}

function buildCompareUsesDefs(reg, rhs) {
  const uses = [];
  addTokens(uses, regToken(reg));
  if (rhs?.kind === 'mem' && rhs?.src) {
    if (rhs.src.space && typeof rhs.src.addr === 'number') addTokens(uses, memToken(rhs.src.space, rhs.src.addr));
    if (typeof rhs.src.ptrZp === 'number') addTokens(uses, memToken('zp', rhs.src.ptrZp), memToken('zp', (rhs.src.ptrZp + 1) & 0xff));
    if (typeof rhs.src.indexSource === 'string') addTokens(uses, regToken(rhs.src.indexSource));
  }
  return { uses: normalizeTokenList(uses), defs: [] };
}

function buildZpPtrUsesDefs(zpAddr) {
  return {
    uses: normalizeTokenList([memToken('zp', zpAddr), memToken('zp', (zpAddr + 1) & 0xff)]),
    defs: normalizeTokenList([`ptr:zp:${zpAddr & 0xff}`])
  };
}

function encodeStoreObservationKey(f) {
  const sp = f?.basis?.romOffSpan;
  const ss = sp ? `${sp.start}-${sp.end}` : 'nos';
  const dst = f?.dst?.space ? `${f.dst.space}:${f.dst.addr}` : 'nod';
  const av = (f?.value?.abs?.kind === 'const') ? `c${f.value.abs.v}` : (f?.value?.abs?.kind || 'u');
  const bm = f?.value?.bits ? `m${f.value.bits.knownMask}-v${f.value.bits.knownValue}` : 'nb';
  const at = typeof f?.atRomOff === 'number' ? (f.atRomOff >>> 0) : 'na';
  return `${f.kind}:${at}:${ss}:${dst}:${av}:${bm}`;
}

function encodeReadObservationKey(f) {
  const at = typeof f?.atRomOff === 'number' ? (f.atRomOff >>> 0) : 'na';
  const src = f?.src?.space ? `${f.src.space}:${f.src.addr}` : 'nosrc';
  const physical = (f?.src?.space === 'rom') ? `:${physicalRomKey(f.src.physicalRom || (typeof f.src.romOff === 'number' ? { kind: 'exact', romOffsets: [f.src.romOff >>> 0] } : null))}` : '';
  const dst = f?.dstReg || 'nodst';
  const av = (f?.value?.abs?.kind === 'const') ? `c${f.value.abs.v}` : (f?.value?.abs?.kind || 'u');
  return `read8:${at}:${dst}:${src}${physical}:${av}`;
}

function encodeCmpObservationKey(f) {
  const at = typeof f?.atRomOff === 'number' ? (f.atRomOff >>> 0) : 'na';
  const reg = f?.reg || 'noreg';
  const rhs = f?.rhs?.kind === 'imm' ? `imm:${f.rhs.imm}` : (f?.rhs?.src ? `${f.rhs.src.space}:${f.rhs.src.addr}` : 'rhs');
  return `cmp8:${at}:${reg}:${rhs}`;
}

function encodeValueFlowObservationKey(f) {
  const at = typeof f?.atRomOff === 'number' ? (f.atRomOff >>> 0) : 'na';
  const op = f?.opKind || 'noop';
  const dst = f?.dstReg
    ? `reg:${f.dstReg}`
    : (f?.dst?.space ? `${f.dst.space}:${f.dst.addr}` : 'nodst');
  const srcRegs = Array.isArray(f?.srcRegs) && f.srcRegs.length ? f.srcRegs.join(',') : 'nosrc';
  const imm = typeof f?.imm === 'number' ? `imm:${f.imm & 0xff}` : 'noimm';
  const sp = f?.basis?.romOffSpan;
  const ss = sp ? `${sp.start}-${sp.end}` : 'nos';
  const av = (f?.value?.abs?.kind === 'const') ? `c${f.value.abs.v}` : (f?.value?.abs?.kind || 'u');
  const bm = f?.value?.bits ? `m${f.value.bits.knownMask}-v${f.value.bits.knownValue}` : 'nb';
  return `valueFlow8:${at}:${op}:${dst}:${srcRegs}:${imm}:${ss}:${av}:${bm}`;
}

function mergeObservationContext(target, source) {
  target.entryFamilies = normalizeStringList([...(target.entryFamilies || []), ...(source.entryFamilies || [])]);
  target.functionIds = normalizeStringList([...(target.functionIds || []), ...(source.functionIds || [])]);
  if (typeof target.rawBlockId !== 'string' && typeof source.rawBlockId === 'string') target.rawBlockId = source.rawBlockId;
}

function emitObservation({ observationsByKey, observationsOut }, key, observation, nextObservationId) {
  const existing = observationsByKey.get(key);
  if (existing) {
    mergeObservationContext(existing, observation);
    return false;
  }
  observation.id = `obs:${nextObservationId}`;
  observationsByKey.set(key, observation);
  observationsOut.push(observation);
  return true;
}

function baseObservationFields(payload) {
  return {
    rawBlockId: typeof payload?.rawBlockId === 'string' ? payload.rawBlockId : null,
    entryFamilies: normalizeStringList(payload?.entryFamilies),
    functionIds: normalizeStringList(payload?.functionIds)
  };
}

export function createObservationCollector() {
  const observationsOut = [];
  const observationsByKey = new Map();
  let nextObservationId = 1;

  return {
    recordRead({ line, dstReg, src, value, prov, addrInfo = null, rawBlockId = null, entryFamilies = [], functionIds = [] }) {
      const km = clamp8(value?.bits?.knownMask ?? 0);
      if (!src?.space) return;
      const normalizedPhysical = src.space === 'rom'
        ? normalizePhysicalRom(src.physicalRom || (typeof src.romOff === 'number' ? { kind: 'exact', romOffsets: [src.romOff >>> 0] } : null))
        : null;
      const addrFlow = normalizeAddrFlow(addrInfo, { ...src, physicalRom: normalizedPhysical });
      const useDef = buildReadUsesDefs(dstReg, src, addrFlow);
      const observation = {
        kind: 'read8',
        label: 'Read8',
        atRomOff: line.romOff >>> 0,
        dstReg,
        src: src ? {
          ...src,
          physicalRom: normalizedPhysical,
          addressKey: addressKey(src.space, src.addr),
          physicalAddressKey: (src.space === 'rom' && normalizedPhysical?.kind === 'exact')
            ? addressKey('rom', normalizedPhysical.romOffsets[0])
            : null
        } : null,
        addrFlow,
        value: {
          abs: value.abs,
          bits: { knownMask: km, knownValue: clamp8(value?.bits?.knownValue ?? 0) }
        },
        basis: { romOffSpan: mkSpan(line.romOff >>> 0, spanEndFromLine(line)) },
        prov,
        uses: useDef.uses,
        defs: useDef.defs,
        inputProvIds: normalizeNumberList(addrFlow.addrProvIds),
        outputProvIds: provIdsFrom(prov),
        ...baseObservationFields({ rawBlockId, entryFamilies, functionIds })
      };
      observation.cpuAddr = typeof line.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null;
      if (emitObservation({ observationsByKey, observationsOut }, encodeReadObservationKey(observation), observation, nextObservationId)) {
        nextObservationId++;
      }
    },

    recordWrite({ line, cpuAddr, srcReg = null, dst, value, prov, rawBlockId = null, entryFamilies = [], functionIds = [] }) {
      if (!shouldEmitStoreObservation(value)) return;
      const spanStart = (typeof value?.spanStartRomOff === 'number') ? (value.spanStartRomOff >>> 0) : (line.romOff >>> 0);
      const span = mkSpan(spanStart, spanEndFromLine(line));
      if (!span) return;
      const realSrcReg = srcReg || (line?.mnemonic === 'STA' ? 'A' : line?.mnemonic === 'STX' ? 'X' : line?.mnemonic === 'STY' ? 'Y' : null);
      const useDef = buildStoreUsesDefs(realSrcReg, dst);
      const observation = {
        kind: 'store8',
        label: 'Store8',
        atRomOff: line.romOff >>> 0,
        cpuAddr: typeof cpuAddr === 'number' ? (cpuAddr & 0xffff) : null,
        srcReg: realSrcReg,
        dst: dst ? { ...dst, addressKey: addressKey(dst.space, dst.addr) } : null,
        value: {
          abs: value.abs,
          bits: { knownMask: clamp8(value?.bits?.knownMask ?? 0), knownValue: clamp8(value?.bits?.knownValue ?? 0) }
        },
        basis: { romOffSpan: span },
        prov,
        uses: useDef.uses,
        defs: useDef.defs,
        inputProvIds: provIdsFrom(prov),
        outputProvIds: [],
        ...baseObservationFields({ rawBlockId, entryFamilies, functionIds })
      };
      if (emitObservation({ observationsByKey, observationsOut }, encodeStoreObservationKey(observation), observation, nextObservationId)) {
        nextObservationId++;
      }
    },

    recordCompare({ line, reg, lhs, rhs, rhsValue, outcomes, prov, rawBlockId = null, entryFamilies = [], functionIds = [] }) {
      const normalizedRhs = rhs?.kind === 'mem' && rhs?.src
        ? {
            ...rhs,
            src: {
              ...rhs.src,
              physicalRom: rhs.src.space === 'rom' ? normalizePhysicalRom(rhs.src.physicalRom || (typeof rhs.src.romOff === 'number' ? { kind: 'exact', romOffsets: [rhs.src.romOff >>> 0] } : null)) : null,
              addressKey: addressKey(rhs.src.space, rhs.src.addr),
              physicalAddressKey: (rhs.src.space === 'rom' && normalizePhysicalRom(rhs.src.physicalRom || (typeof rhs.src.romOff === 'number' ? { kind: 'exact', romOffsets: [rhs.src.romOff >>> 0] } : null))?.kind === 'exact')
                ? addressKey('rom', normalizePhysicalRom(rhs.src.physicalRom || { kind: 'exact', romOffsets: [rhs.src.romOff >>> 0] }).romOffsets[0])
                : null
            }
          }
        : rhs;
      const useDef = buildCompareUsesDefs(reg, normalizedRhs);
      const observation = {
        kind: 'cmp8',
        label: 'Compare8',
        atRomOff: line.romOff >>> 0,
        reg,
        lhs: {
          abs: lhs.abs,
          bits: { knownMask: clamp8(lhs?.bits?.knownMask ?? 0), knownValue: clamp8(lhs?.bits?.knownValue ?? 0) }
        },
        rhs: normalizedRhs,
        rhsValue: {
          abs: rhsValue.abs,
          bits: { knownMask: clamp8(rhsValue?.bits?.knownMask ?? 0), knownValue: clamp8(rhsValue?.bits?.knownValue ?? 0) }
        },
        outcomes: outcomes || null,
        basis: { romOffSpan: mkSpan(line.romOff >>> 0, spanEndFromLine(line)) },
        prov,
        uses: useDef.uses,
        defs: [],
        inputProvIds: provIdsFrom(lhs?.prov, rhsValue?.prov),
        outputProvIds: [],
        ...baseObservationFields({ rawBlockId, entryFamilies, functionIds })
      };
      observation.cpuAddr = typeof line.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null;
      if (emitObservation({ observationsByKey, observationsOut }, encodeCmpObservationKey(observation), observation, nextObservationId)) {
        nextObservationId++;
      }
    },

    recordValueFlow({ line, opKind, dstReg = null, dst = null, srcRegs = [], imm = null, value, prov, inputProvs = [], rawBlockId = null, entryFamilies = [], functionIds = [] }) {
      if ((!dstReg && !(dst?.space)) || !value) return;
      const spanStart = (typeof value?.spanStartRomOff === 'number') ? (value.spanStartRomOff >>> 0) : (line.romOff >>> 0);
      const span = mkSpan(spanStart, spanEndFromLine(line));
      if (!span) return;
      const useDef = buildValueFlowUsesDefs({ dstReg, dst, srcRegs });
      const observation = {
        kind: 'valueFlow8',
        label: 'Value flow',
        atRomOff: line.romOff >>> 0,
        cpuAddr: typeof line.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null,
        mnemonic: typeof line?.mnemonic === 'string' ? line.mnemonic : null,
        mode: typeof line?.mode === 'string' ? line.mode : null,
        opKind: typeof opKind === 'string' ? opKind : 'transform',
        dstReg: typeof dstReg === 'string' ? dstReg : null,
        dst: dst?.space ? { ...dst, addressKey: addressKey(dst.space, dst.addr) } : null,
        srcRegs: normalizeStringList(srcRegs),
        imm: typeof imm === 'number' ? (imm & 0xff) : null,
        value: {
          abs: value.abs,
          bits: { knownMask: clamp8(value?.bits?.knownMask ?? 0), knownValue: clamp8(value?.bits?.knownValue ?? 0) }
        },
        basis: { romOffSpan: span },
        prov,
        uses: useDef.uses,
        defs: useDef.defs,
        inputProvIds: provIdsFrom(...(Array.isArray(inputProvs) ? inputProvs : [])),
        outputProvIds: provIdsFrom(prov),
        ...baseObservationFields({ rawBlockId, entryFamilies, functionIds })
      };
      if (emitObservation({ observationsByKey, observationsOut }, encodeValueFlowObservationKey(observation), observation, nextObservationId)) {
        nextObservationId++;
      }
    },

    recordZpPtr16({ zpAddr, value16, spanStartRomOff, spanEndRomOff, prov, rawBlockId = null, entryFamilies = [], functionIds = [] }) {
      const span = mkSpan(spanStartRomOff, spanEndRomOff);
      if (!span) return;
      const useDef = buildZpPtrUsesDefs(zpAddr);
      const observation = {
        kind: 'zpPtr16',
        label: 'ZP ptr16',
        atRomOff: span.start,
        zpAddr: zpAddr & 0xff,
        value16: value16 & 0xffff,
        basis: { romOffSpan: span },
        prov,
        addressKey: addressKey('zp', zpAddr & 0xff),
        uses: useDef.uses,
        defs: useDef.defs,
        inputProvIds: provIdsFrom(prov),
        outputProvIds: provIdsFrom(prov),
        ...baseObservationFields({ rawBlockId, entryFamilies, functionIds })
      };
      const key = `zpPtr16:${span.start}:${observation.zpAddr}:${observation.value16}:${span.start}-${span.end}`;
      if (emitObservation({ observationsByKey, observationsOut }, key, observation, nextObservationId)) {
        nextObservationId++;
      }
    },

    getResult() {
      const counts = { store8: 0, read8: 0, cmp8: 0, zpPtr16: 0, valueFlow8: 0 };
      for (const observation of observationsOut) {
        if (counts[observation.kind] != null) counts[observation.kind]++;
      }
      return {
        version: 5,
        observations: observationsOut,
        facts: observationsOut,
        stats: {
          observationCount: observationsOut.length,
          factCount: observationsOut.length,
          ...counts
        }
      };
    }
  };
}
