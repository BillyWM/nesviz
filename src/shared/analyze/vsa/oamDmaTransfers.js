import { vEnumerate } from './value.js';

function uniqStrings(values) {
  return Array.from(new Set((values || []).filter((value) => typeof value === 'string' && value))).sort();
}

function uniqNumbers(values) {
  return Array.from(new Set((values || [])
    .map((value) => (typeof value === 'number' ? value : Number(value)))
    .filter((value) => Number.isFinite(value))
    .map((value) => value >>> 0))).sort((a, b) => a - b);
}

function canonicalizeCpuAddr(addr) {
  const a = addr & 0xffff;
  if (a < 0x2000) {
    const canon = a & 0x07ff;
    if (canon < 0x0100) return { space: 'zp', addr: canon };
    return { space: 'ram', addr: canon };
  }
  if (a >= 0x6000 && a < 0x8000) return { space: 'prgram', addr: a };
  if (a >= 0x2000 && a < 0x4020) return { space: 'io', addr: a };
  if (a >= 0x8000) return { space: 'rom', addr: a };
  return { space: 'other', addr: a };
}

function describeBacking(canonicalSpace, canonicalStart) {
  if (canonicalSpace === 'zp') {
    return { backingKind: 'internalRam', internalSection: 'zeroPage' };
  }
  if (canonicalSpace === 'ram') {
    if ((canonicalStart & 0xffff) >= 0x0100 && (canonicalStart & 0xffff) < 0x0200) {
      return { backingKind: 'internalRam', internalSection: 'stack' };
    }
    return { backingKind: 'internalRam', internalSection: 'ram' };
  }
  if (canonicalSpace === 'prgram') return { backingKind: 'prgRam', internalSection: null };
  if (canonicalSpace === 'rom') return { backingKind: 'rom', internalSection: null };
  if (canonicalSpace === 'io') return { backingKind: 'io', internalSection: null };
  return { backingKind: 'other', internalSection: null };
}

function pageBytesFromAbs(abs) {
  if (!abs || typeof abs !== 'object') return { kind: 'unknown', pageBytes: [] };
  if (abs.kind === 'const') {
    return { kind: 'exact', pageBytes: [abs.v & 0xff] };
  }
  if (abs.kind === 'set') {
    const pageBytes = uniqNumbers(abs.values || []).map((value) => value & 0xff);
    if (!pageBytes.length) return { kind: 'unknown', pageBytes: [] };
    return { kind: pageBytes.length === 1 ? 'exact' : 'set', pageBytes };
  }
  if (abs.kind === 'range') {
    const values = vEnumerate(abs, 8);
    if (!values || !values.length) return { kind: 'bounded', pageBytes: [] };
    const pageBytes = uniqNumbers(values).map((value) => value & 0xff);
    return { kind: pageBytes.length === 1 ? 'exact' : 'set', pageBytes };
  }
  return { kind: 'unknown', pageBytes: [] };
}

function buildPageResolution(pageByte) {
  const cpuStart = (pageByte & 0xff) << 8;
  const cpuEndExclusive = cpuStart + 0x100;
  const startCanon = canonicalizeCpuAddr(cpuStart);
  const endCanon = canonicalizeCpuAddr(cpuEndExclusive - 1);
  const canonicalSpace = startCanon.space;
  const canonicalStart = startCanon.addr >>> 0;
  const canonicalEndExclusive = (endCanon.addr + 1) >>> 0;
  const { backingKind, internalSection } = describeBacking(canonicalSpace, canonicalStart);
  const isMirror = (cpuStart & 0xffff) !== (canonicalStart & 0xffff) || canonicalSpace !== canonicalizeCpuAddr(cpuStart).space;
  const notes = [];
  if (isMirror && backingKind === 'internalRam') {
    notes.push('CPU source page is an internal RAM mirror.');
  }
  return {
    pageByte: pageByte & 0xff,
    cpuStart: cpuStart & 0xffff,
    cpuEndExclusive,
    canonicalSpace,
    canonicalStart,
    canonicalEndExclusive,
    backingKind,
    internalSection,
    isMirror,
    notes,
    qualifiesForMemoryMap: backingKind === 'internalRam'
  };
}

function summarizeExactResolution(resolution) {
  if (!resolution) return null;
  return {
    pageByte: resolution.pageByte,
    cpuStart: resolution.cpuStart,
    cpuEndExclusive: resolution.cpuEndExclusive,
    canonicalSpace: resolution.canonicalSpace,
    canonicalStart: resolution.canonicalStart,
    canonicalEndExclusive: resolution.canonicalEndExclusive,
    backingKind: resolution.backingKind,
    internalSection: resolution.internalSection,
    isMirror: resolution.isMirror,
    notes: Array.isArray(resolution.notes) ? [...resolution.notes] : [],
    qualifiesForMemoryMap: !!resolution.qualifiesForMemoryMap
  };
}

function entryFamiliesForObservation(obs, blockContextIndex) {
  if (Array.isArray(obs?.entryFamilies) && obs.entryFamilies.length) return uniqStrings(obs.entryFamilies);
  const rawBlockId = typeof obs?.rawBlockId === 'string' ? obs.rawBlockId : null;
  if (!rawBlockId) return [];
  const familySet = blockContextIndex?.rawBlockFamiliesById?.get?.(rawBlockId);
  return familySet ? Array.from(familySet).sort() : [];
}

function functionIdsForObservation(obs, blockContextIndex) {
  if (Array.isArray(obs?.functionIds) && obs.functionIds.length) return uniqStrings(obs.functionIds);
  const rawBlockId = typeof obs?.rawBlockId === 'string' ? obs.rawBlockId : null;
  if (!rawBlockId) return [];
  const functionSet = blockContextIndex?.rawBlockFunctionIdsById?.get?.(rawBlockId);
  return functionSet ? Array.from(functionSet).sort() : [];
}

export function buildOamDmaTransfers({ observationsResult, blockContextIndex = null }) {
  const observations = Array.isArray(observationsResult?.observations) ? observationsResult.observations : [];
  const transfers = [];
  let exactCount = 0;
  let exactInternalRamCount = 0;
  let mirrorCount = 0;

  for (const obs of observations) {
    if (obs?.kind !== 'store8') continue;
    if (obs?.dst?.space !== 'io' || ((obs?.dst?.addr ?? -1) & 0xffff) !== 0x4014) continue;

    const pageInfo = pageBytesFromAbs(obs?.value?.abs || null);
    const exactResolution = pageInfo.kind === 'exact' && pageInfo.pageBytes.length === 1
      ? buildPageResolution(pageInfo.pageBytes[0])
      : null;
    const notes = [];
    if (exactResolution?.isMirror) notes.push(...exactResolution.notes);
    const candidatePageBytes = pageInfo.pageBytes.length ? [...pageInfo.pageBytes] : [];

    transfers.push({
      id: `oamDma:${String(obs.id)}`,
      kind: 'oamDmaTransfer',
      observationId: String(obs.id),
      rawBlockId: typeof obs?.rawBlockId === 'string' ? obs.rawBlockId : null,
      touchingRawBlockIds: typeof obs?.rawBlockId === 'string' && obs.rawBlockId ? [obs.rawBlockId] : [],
      atRomOff: typeof obs?.atRomOff === 'number' ? (obs.atRomOff >>> 0) : null,
      cpuAddr: typeof obs?.cpuAddr === 'number' ? (obs.cpuAddr & 0xffff) : null,
      basis: obs?.basis && typeof obs.basis === 'object'
        ? { ...obs.basis }
        : { romOffSpan: (typeof obs?.atRomOff === 'number' ? { start: (obs.atRomOff >>> 0), end: ((obs.atRomOff >>> 0) + 1) } : null) },
      entryFamilies: entryFamiliesForObservation(obs, blockContextIndex),
      functionIds: functionIdsForObservation(obs, blockContextIndex),
      srcReg: typeof obs?.srcReg === 'string' ? obs.srcReg : null,
      pageEvidenceKind: pageInfo.kind,
      pageByte: exactResolution ? exactResolution.pageByte : null,
      candidatePageBytes,
      exactSource: summarizeExactResolution(exactResolution),
      notes: uniqStrings(notes)
    });

    if (exactResolution) {
      exactCount++;
      if (exactResolution.qualifiesForMemoryMap) exactInternalRamCount++;
      if (exactResolution.isMirror) mirrorCount++;
    }
  }

  return {
    transfers,
    stats: {
      oamDmaTransferCount: transfers.length,
      oamDmaExactSourceCount: exactCount,
      oamDmaExactInternalRamCount: exactInternalRamCount,
      oamDmaMirrorCount: mirrorCount
    }
  };
}
