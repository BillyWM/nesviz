import { cpuToRomOffWithMapper } from '../analyze/map/cpuToRomOff.js';

export function normalizeRomOffsets(romOffsets, maxSet = 32) {
  const unique = Array.from(new Set((romOffsets || [])
    .map((off) => (typeof off === 'number' ? off : Number(off)))
    .filter((off) => Number.isFinite(off) && off >= 0)
    .map((off) => off >>> 0))).sort((a, b) => a - b);
  if (!unique.length) return null;
  if (unique.length > Math.max(1, maxSet | 0)) return null;
  return unique;
}

export function resolvePhysicalRomIdentity(mapper, cpuAddr, fetchCtx = null, maxSet = 32) {
  const a = cpuAddr & 0xffff;
  if (!mapper) return { kind: 'unknown', romOffsets: [] };
  if (typeof mapper.resolveCodeFetch === 'function') {
    const resolved = mapper.resolveCodeFetch(fetchCtx, a);
    const backing = resolved?.backing || null;
    if (backing?.kind === 'exact' && typeof backing.romOff === 'number') {
      return { kind: 'exact', romOffsets: [backing.romOff >>> 0] };
    }
    const setVals = normalizeRomOffsets(backing?.romOffs || backing?.romOffsets, maxSet);
    if (setVals) {
      return { kind: setVals.length === 1 ? 'exact' : 'set', romOffsets: setVals };
    }
    if (backing?.kind === 'unknown') return { kind: 'unknown', romOffsets: [] };
  }
  const romOff = cpuToRomOffWithMapper(mapper, a, fetchCtx);
  if (romOff == null) return { kind: 'unknown', romOffsets: [] };
  return { kind: 'exact', romOffsets: [romOff >>> 0] };
}

export function readRomCandidates(prgBytes, mapper, cpuAddr, fetchCtx = null, maxSet = 32) {
  const physicalRom = resolvePhysicalRomIdentity(mapper, cpuAddr, fetchCtx, maxSet);
  if (physicalRom.kind === 'unknown' || !Array.isArray(physicalRom.romOffsets) || !physicalRom.romOffsets.length) {
    return { kind: 'unknown', physicalRom, bytes: [] };
  }
  const bytes = [];
  for (const romOff of physicalRom.romOffsets) {
    if (romOff < 0 || romOff >= prgBytes.length) return { kind: 'unknown', physicalRom: { kind: 'unknown', romOffsets: [] }, bytes: [] };
    bytes.push(prgBytes[romOff] & 0xff);
  }
  return { kind: physicalRom.kind, physicalRom, bytes };
}

export function readPrgAtCpu(prgBytes, mapper, cpuAddr, fetchCtx = null) {
  const read = readRomCandidates(prgBytes, mapper, cpuAddr, fetchCtx, 1);
  if (read.kind !== 'exact' || !read.bytes.length) return null;
  return read.bytes[0] & 0xff;
}
