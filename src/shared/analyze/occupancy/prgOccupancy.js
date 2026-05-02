import { decodePrgCdlByte, isPrgDataObserved, NES_CDL_FORMAT_MESEN2 } from '../cdl/nesCdl.js';

export const PRG_OCCUPANCY_UNKNOWN = 0;
export const PRG_OCCUPANCY_CODE = 1;
export const PRG_OCCUPANCY_DATA = 2;

export const PRG_OCC_SOURCE_NONE = 0;
export const PRG_OCC_SOURCE_ANALYSIS_DATA = 1;
export const PRG_OCC_SOURCE_ANALYSIS_CODE = 2;
export const PRG_OCC_SOURCE_CDL_DATA = 3;
export const PRG_OCC_SOURCE_CDL_CODE = 4;

export function buildPrgOccupancy({
  prgSize,
  blocks,
  memoryDiscoveries,
  cdlPrg = null,
  cdlFormat = NES_CDL_FORMAT_MESEN2
}) {
  const size = Math.max(0, prgSize | 0);
  const analysisData = new Uint8Array(size);
  const analysisCode = new Uint8Array(size);
  const cdlData = new Uint8Array(size);
  const cdlCode = new Uint8Array(size);
  const byteTypes = new Uint8Array(size);
  const sourceTypes = new Uint8Array(size);
  const overlapBits = new Uint8Array(size);

  for (const group of memoryDiscoveries?.groups || []) {
    if (group?.space !== 'rom') continue;
    for (const span of group?.spans || []) {
      const start = Math.max(0, Math.min(size, Number(span?.start) | 0));
      const end = Math.max(start, Math.min(size, (Number(span?.end) | 0) + 1));
      for (let i = start; i < end; i++) analysisData[i] = 1;
    }
  }

  for (const block of Array.isArray(blocks) ? blocks : []) {
    const romStart = Number(block?.romStart);
    const romEnd = Number(block?.romEnd);
    if (!Number.isFinite(romStart) || !Number.isFinite(romEnd)) continue;
    const start = Math.max(0, Math.min(size, romStart | 0));
    const end = Math.max(start, Math.min(size, romEnd | 0));
    for (let i = start; i < end; i++) analysisCode[i] = 1;
  }

  if (cdlPrg) {
    const limit = Math.min(size, cdlPrg.length | 0);
    for (let i = 0; i < limit; i++) {
      const flags = decodePrgCdlByte(cdlPrg[i], cdlFormat);
      if (flags?.exec) cdlCode[i] = 1;
      if (isPrgDataObserved(flags, cdlFormat)) cdlData[i] = 1;
    }
  }

  let codeBytes = 0;
  let dataBytes = 0;
  let unknownBytes = 0;
  let overlapByteCount = 0;

  for (let i = 0; i < size; i++) {
    const anyCode = !!(analysisCode[i] || cdlCode[i]);
    const anyData = !!(analysisData[i] || cdlData[i]);
    if (anyCode && anyData) {
      overlapBits[i] = 1;
      overlapByteCount++;
    }

    if (cdlCode[i] || cdlData[i]) {
      if (cdlCode[i]) {
        byteTypes[i] = PRG_OCCUPANCY_CODE;
        sourceTypes[i] = PRG_OCC_SOURCE_CDL_CODE;
        codeBytes++;
      } else {
        byteTypes[i] = PRG_OCCUPANCY_DATA;
        sourceTypes[i] = PRG_OCC_SOURCE_CDL_DATA;
        dataBytes++;
      }
      continue;
    }

    if (analysisCode[i] || analysisData[i]) {
      if (analysisCode[i]) {
        byteTypes[i] = PRG_OCCUPANCY_CODE;
        sourceTypes[i] = PRG_OCC_SOURCE_ANALYSIS_CODE;
        codeBytes++;
      } else {
        byteTypes[i] = PRG_OCCUPANCY_DATA;
        sourceTypes[i] = PRG_OCC_SOURCE_ANALYSIS_DATA;
        dataBytes++;
      }
      continue;
    }

    byteTypes[i] = PRG_OCCUPANCY_UNKNOWN;
    sourceTypes[i] = PRG_OCC_SOURCE_NONE;
    unknownBytes++;
  }

  const totalBytes = codeBytes + dataBytes;
  return {
    byteTypes,
    sourceTypes,
    overlapBits,
    stats: {
      codeBytes,
      dataBytes,
      unknownBytes,
      totalBytes,
      overlapByteCount,
      codePct: size ? (codeBytes * 100) / size : 0,
      dataPct: size ? (dataBytes * 100) / size : 0,
      unknownPct: size ? (unknownBytes * 100) / size : 0,
      totalPct: size ? (totalBytes * 100) / size : 0
    }
  };
}

export function coalescePrgOccupancyRanges(byteTypes, start = 0, end = null) {
  const arr = byteTypes instanceof Uint8Array ? byteTypes : new Uint8Array(0);
  const limit = arr.length;
  const rangeStart = Math.max(0, Math.min(limit, start | 0));
  const rangeEnd = end == null ? limit : Math.max(rangeStart, Math.min(limit, end | 0));
  const out = [];
  let runType = PRG_OCCUPANCY_UNKNOWN;
  let runStart = -1;

  for (let i = rangeStart; i < rangeEnd; i++) {
    const type = arr[i] | 0;
    if (type === PRG_OCCUPANCY_UNKNOWN) {
      if (runStart >= 0) {
        out.push({ type: runType, start: runStart, end: i });
        runStart = -1;
        runType = PRG_OCCUPANCY_UNKNOWN;
      }
      continue;
    }
    if (runStart < 0) {
      runStart = i;
      runType = type;
      continue;
    }
    if (type !== runType) {
      out.push({ type: runType, start: runStart, end: i });
      runStart = i;
      runType = type;
    }
  }

  if (runStart >= 0) out.push({ type: runType, start: runStart, end: rangeEnd });
  return out;
}

export function occupancyTypeToLabel(type) {
  if ((type | 0) === PRG_OCCUPANCY_CODE) return 'code';
  if ((type | 0) === PRG_OCCUPANCY_DATA) return 'data';
  return 'unknown';
}
