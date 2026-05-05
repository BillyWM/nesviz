import { parseAddressKey } from '../../shared/utils/addressUtils.js';
import { coalesceTypedRanges } from '../../shared/utils/rangeUtils.js';
import { getPrgRegionSizeBytes } from '../utils/prgRegionUtils.js';

function getBlockConfidenceById(blocks) {
  const map = new Map();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const id = String(block?.id || '');
    if (!id) continue;
    const confidence = block?.confidence === 'probable' ? 'probable' : 'certain';
    const prev = map.get(id);
    if (prev === 'certain') continue;
    map.set(id, confidence);
  }
  return map;
}

function classifyGroupType(group, blockConfidenceById) {
  const baseType = group?.space === 'rom' ? 'romData' : 'group';
  const touching = Array.isArray(group?.touchingRawBlockIds) ? group.touchingRawBlockIds : [];
  if (!touching.length) return baseType;
  let sawProbable = false;
  for (const rawBlockId of touching) {
    const conf = blockConfidenceById.get(String(rawBlockId));
    if (conf === 'certain') return baseType;
    if (conf === 'probable') sawProbable = true;
  }
  return sawProbable ? `${baseType}Light` : baseType;
}

function applyTypedRange(types, start, end, type) {
  const limit = Math.min(types.length, end | 0);
  for (let i = Math.max(0, start | 0); i < limit; i++) {
    const prev = types[i] || 'empty';
    if (prev === 'code') continue;
    if (type === 'code') {
      types[i] = 'code';
      continue;
    }
    if (type === 'codeLight') {
      types[i] = prev === 'empty' ? 'codeLight' : prev;
      continue;
    }
    if (prev === 'codeLight') continue;
    if (type === 'romData' || type === 'group') {
      types[i] = type;
      continue;
    }
    if (type === 'romDataLight') {
      if (prev === 'empty' || prev === 'groupLight') types[i] = 'romDataLight';
      continue;
    }
    if (type === 'groupLight') {
      if (prev === 'empty') types[i] = 'groupLight';
    }
  }
}

export function buildMemoryMapDataForState(s) {
  if (!s?.ines) {
    return {
      ok: true,
      hasRom: false,
      hasAnalysis: false,
      rowWidthBytes: 64,
      cellSizePx: 16,
      ram: null,
      prg: null,
      rom: null,
      mapper: null
    };
  }

  const rowWidthBytes = 64;
  const cellSizePx = 16;
  const prgBytes = s.ines.prg;
  const prgSize = prgBytes?.length | 0;
  const analysis = s.displayAnalysis || null;
  const groups = Array.isArray(analysis?.memoryDiscoveries?.groups) ? analysis.memoryDiscoveries.groups : [];
  const oamDmaTransfers = Array.isArray(analysis?.memoryDiscoveries?.oamDmaTransfers) ? analysis.memoryDiscoveries.oamDmaTransfers : [];
  const blocks = Array.isArray(analysis?.blocks) ? analysis.blocks : [];
  const blockConfidenceById = getBlockConfidenceById(blocks);

  const ramTypes = new Array(0x800).fill('empty');
  for (const group of groups) {
    if (group?.space === 'rom') continue;
    const groupType = classifyGroupType(group, blockConfidenceById);
    for (const key of group?.memberAddressKeys || []) {
      const parsed = parseAddressKey(key);
      if (!parsed) continue;
      if (parsed.space === 'zp') {
        if (parsed.addr >= 0 && parsed.addr < 0x100) applyTypedRange(ramTypes, parsed.addr, parsed.addr + 1, groupType);
      } else if (parsed.space === 'ram') {
        if (parsed.addr >= 0 && parsed.addr < 0x800) applyTypedRange(ramTypes, parsed.addr, parsed.addr + 1, groupType);
      }
    }
  }

  for (const transfer of oamDmaTransfers) {
    const exact = transfer?.exactSource || null;
    if (!exact || !exact.qualifiesForMemoryMap) continue;
    const canonicalSpace = exact.canonicalSpace;
    const canonicalStart = Number(exact.canonicalStart);
    const canonicalEndExclusive = Number(exact.canonicalEndExclusive);
    if (!Number.isFinite(canonicalStart) || !Number.isFinite(canonicalEndExclusive)) continue;
    if (!(canonicalSpace === 'zp' || canonicalSpace === 'ram')) continue;
    if (canonicalStart < 0 || canonicalEndExclusive > 0x800 || canonicalEndExclusive <= canonicalStart) continue;
    const groupType = classifyGroupType({ space: 'ram', touchingRawBlockIds: transfer?.touchingRawBlockIds || [] }, blockConfidenceById);
    applyTypedRange(ramTypes, canonicalStart, canonicalEndExclusive, groupType);
  }

  const ramOccupiedRanges = coalesceTypedRanges(ramTypes, 0, ramTypes.length);

  const prgTypes = new Array(Math.max(0, prgSize)).fill('empty');
  const prgOccupancyTypes = analysis?.prgOccupancy?.byteTypes instanceof Uint8Array
    ? analysis.prgOccupancy.byteTypes
    : null;
  if (prgOccupancyTypes && prgOccupancyTypes.length) {
    const limit = Math.min(prgTypes.length, prgOccupancyTypes.length);
    for (let i = 0; i < limit; i++) {
      const occ = prgOccupancyTypes[i] | 0;
      prgTypes[i] = occ === 1 ? 'code' : occ === 2 ? 'romData' : 'empty';
    }
  } else {
    for (const group of groups) {
      if (group?.space !== 'rom') continue;
      const groupType = classifyGroupType(group, blockConfidenceById);
      for (const span of group?.spans || []) {
        const start = Math.max(0, Math.min(prgTypes.length, Number(span?.start) | 0));
        const end = Math.max(start, Math.min(prgTypes.length, (Number(span?.end) | 0) + 1));
        applyTypedRange(prgTypes, start, end, groupType);
      }
    }

    for (const block of blocks) {
      const romStart = Number(block?.romStart);
      const romEnd = Number(block?.romEnd);
      if (!Number.isFinite(romStart) || !Number.isFinite(romEnd)) continue;
      const start = Math.max(0, Math.min(prgTypes.length, romStart | 0));
      const end = Math.max(start, Math.min(prgTypes.length, romEnd | 0));
      applyTypedRange(prgTypes, start, end, 'code');
    }
  }

  const analysisMapper = s.ines.analysisMapper || analysis?.mapper?.meta || null;
  const regionSizeBytes = getPrgRegionSizeBytes(analysisMapper, prgSize);
  const regions = [];
  for (let start = 0, index = 0; start < prgSize; start += regionSizeBytes, index++) {
    const end = Math.min(prgSize, start + regionSizeBytes);
    regions.push({
      index,
      start,
      end,
      occupiedRanges: coalesceTypedRanges(prgTypes, start, end)
    });
  }

  return {
    ok: true,
    hasRom: true,
    hasAnalysis: !!analysis,
    rowWidthBytes,
    cellSizePx,
    rom: {
      filename: s.filename,
      mapperNumber: s.ines.mapperNumber,
      prgSize
    },
    mapper: analysis?.mapper || { kind: null, meta: analysisMapper },
    ram: {
      sizeBytes: 0x800,
      occupiedRanges: ramOccupiedRanges
    },
    prg: {
      sizeBytes: prgSize,
      regionSizeBytes,
      regions
    }
  };
}
