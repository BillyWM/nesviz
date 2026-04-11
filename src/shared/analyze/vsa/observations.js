function clamp8(n) {
  return (n & 0xff) >>> 0;
}

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

function shouldEmitStoreObservation(valTracked) {
  if (!valTracked) return false;
  const abs = valTracked.abs;
  if (abs && abs.kind !== 'unknown') {
    if (!(abs.kind === 'set' && abs.values && abs.values.length === 0)) return true;
  }
  const km = valTracked.bits?.knownMask ?? 0;
  return (km & 0xff) !== 0;
}

function normalizeStringList(values) {
  if (!Array.isArray(values) || !values.length) return [];
  return Array.from(new Set(values.filter((value) => typeof value === 'string' && value))).sort();
}


function normalizePhysicalRom(physicalRom) {
  if (!physicalRom || typeof physicalRom !== 'object') return null;
  const vals = Array.isArray(physicalRom.romOffsets)
    ? Array.from(new Set(physicalRom.romOffsets
        .map((off) => (typeof off === 'number' ? off : Number(off)))
        .filter((off) => Number.isFinite(off) && off >= 0)
        .map((off) => off >>> 0))).sort((a, b) => a - b)
    : [];
  if (!vals.length) return { kind: 'unknown', romOffsets: [] };
  return { kind: vals.length === 1 ? 'exact' : (physicalRom.kind === 'set' ? 'set' : 'exact'), romOffsets: vals };
}

function physicalRomKey(physicalRom) {
  const norm = normalizePhysicalRom(physicalRom);
  if (!norm || norm.kind === 'unknown' || !norm.romOffsets.length) return 'phys:unknown';
  return `phys:${norm.kind}:${norm.romOffsets.join(',')}`;
}
function addressKey(space, addr) {
  if (typeof space !== 'string' || typeof addr !== 'number') return null;
  return `${space}:${space === 'rom' ? (addr >>> 0) : (addr & 0xffff)}`;
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

function mergeObservationContext(target, source) {
  target.entryFamilies = normalizeStringList([...(target.entryFamilies || []), ...(source.entryFamilies || [])]);
  target.functionIds = normalizeStringList([...(target.functionIds || []), ...(source.functionIds || [])]);
  if (typeof target.blockId !== 'string' && typeof source.blockId === 'string') target.blockId = source.blockId;
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
    blockId: typeof payload?.blockId === 'string' ? payload.blockId : null,
    entryFamilies: normalizeStringList(payload?.entryFamilies),
    functionIds: normalizeStringList(payload?.functionIds)
  };
}

export function createObservationCollector() {
  const observationsOut = [];
  const observationsByKey = new Map();
  let nextObservationId = 1;

  return {
    recordRead({ line, dstReg, src, value, prov, blockId = null, entryFamilies = [], functionIds = [] }) {
      const km = clamp8(value?.bits?.knownMask ?? 0);
      if (!(src?.space === 'io' || (value?.abs && value.abs.kind !== 'unknown') || km !== 0)) return;
      const observation = {
        kind: 'read8',
        label: 'Read8',
        atRomOff: line.romOff >>> 0,
        dstReg,
        src: src ? {
          ...src,
          physicalRom: src.space === 'rom' ? normalizePhysicalRom(src.physicalRom || (typeof src.romOff === 'number' ? { kind: 'exact', romOffsets: [src.romOff >>> 0] } : null)) : null,
          addressKey: addressKey(src.space, src.addr),
          physicalAddressKey: (src.space === 'rom' && normalizePhysicalRom(src.physicalRom || (typeof src.romOff === 'number' ? { kind: 'exact', romOffsets: [src.romOff >>> 0] } : null))?.kind === 'exact')
            ? addressKey('rom', normalizePhysicalRom(src.physicalRom || { kind: 'exact', romOffsets: [src.romOff >>> 0] }).romOffsets[0])
            : null
        } : null,
        value: {
          abs: value.abs,
          bits: { knownMask: km, knownValue: clamp8(value?.bits?.knownValue ?? 0) }
        },
        basis: { romOffSpan: mkSpan(line.romOff >>> 0, spanEndFromLine(line)) },
        prov,
        ...baseObservationFields({ blockId, entryFamilies, functionIds })
      };
      observation.cpuAddr = typeof line.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null;
      if (emitObservation({ observationsByKey, observationsOut }, encodeReadObservationKey(observation), observation, nextObservationId)) {
        nextObservationId++;
      }
    },

    recordWrite({ line, cpuAddr, dst, value, prov, blockId = null, entryFamilies = [], functionIds = [] }) {
      if (!shouldEmitStoreObservation(value)) return;
      const spanStart = (typeof value?.spanStartRomOff === 'number') ? (value.spanStartRomOff >>> 0) : (line.romOff >>> 0);
      const span = mkSpan(spanStart, spanEndFromLine(line));
      if (!span) return;
      const observation = {
        kind: 'store8',
        label: 'Store8',
        atRomOff: line.romOff >>> 0,
        cpuAddr: typeof cpuAddr === 'number' ? (cpuAddr & 0xffff) : null,
        dst: dst ? { ...dst, addressKey: addressKey(dst.space, dst.addr) } : null,
        value: {
          abs: value.abs,
          bits: { knownMask: clamp8(value?.bits?.knownMask ?? 0), knownValue: clamp8(value?.bits?.knownValue ?? 0) }
        },
        basis: { romOffSpan: span },
        prov,
        ...baseObservationFields({ blockId, entryFamilies, functionIds })
      };
      observation.srcReg = line?.mnemonic === 'STA' ? 'A' : line?.mnemonic === 'STX' ? 'X' : line?.mnemonic === 'STY' ? 'Y' : null;
      if (emitObservation({ observationsByKey, observationsOut }, encodeStoreObservationKey(observation), observation, nextObservationId)) {
        nextObservationId++;
      }
    },

    recordCompare({ line, reg, lhs, rhs, rhsValue, outcomes, prov, blockId = null, entryFamilies = [], functionIds = [] }) {
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
        ...baseObservationFields({ blockId, entryFamilies, functionIds })
      };
      observation.cpuAddr = typeof line.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null;
      if (emitObservation({ observationsByKey, observationsOut }, encodeCmpObservationKey(observation), observation, nextObservationId)) {
        nextObservationId++;
      }
    },

    recordZpPtr16({ zpAddr, value16, spanStartRomOff, spanEndRomOff, prov, blockId = null, entryFamilies = [], functionIds = [] }) {
      const span = mkSpan(spanStartRomOff, spanEndRomOff);
      if (!span) return;
      const observation = {
        kind: 'zpPtr16',
        label: 'ZP ptr16',
        atRomOff: span.start,
        zpAddr: zpAddr & 0xff,
        value16: value16 & 0xffff,
        basis: { romOffSpan: span },
        prov,
        ...baseObservationFields({ blockId, entryFamilies, functionIds })
      };
      observation.addressKey = addressKey('zp', observation.zpAddr);
      const key = `zpPtr16:${span.start}:${observation.zpAddr}:${observation.value16}:${span.start}-${span.end}`;
      if (emitObservation({ observationsByKey, observationsOut }, key, observation, nextObservationId)) {
        nextObservationId++;
      }
    },

    getResult() {
      const counts = { store8: 0, read8: 0, cmp8: 0, zpPtr16: 0 };
      for (const observation of observationsOut) {
        if (counts[observation.kind] != null) counts[observation.kind]++;
      }
      return {
        version: 3,
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
