import { parseAddressKey } from '../../shared/utils/addressUtils.js';
import { coalesceTypedRanges } from '../../shared/utils/rangeUtils.js';
import { fmtHex } from '../../shared/utils/numberUtils.js';
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

function normalizeAnnotationRange(annotation, prgSize) {
  const range = annotation?.range || null;
  const space = range?.space;
  const start = Number(range?.start);
  const end = Number(range?.end);
  if (!(space === 'zp' || space === 'ram' || space === 'prg')) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;

  if (space === 'zp') {
    if (start < 0 || end > 0xff) return null;
    return {
      range: { space, start: start & 0xff, end: end & 0xff },
      view: { space: 'ram', start: start & 0xff, end: end & 0xff }
    };
  }

  if (space === 'ram') {
    if (start < 0 || end > 0x7ff) return null;
    return {
      range: { space, start: start & 0xffff, end: end & 0xffff },
      view: { space: 'ram', start: start & 0xffff, end: end & 0xffff }
    };
  }

  if (start < 0 || end >= prgSize) return null;
  return {
    range: { space, start: start >>> 0, end: end >>> 0 },
    view: { space: 'prg', start: start >>> 0, end: end >>> 0 }
  };
}

function normalizeAnnotationLink(link, fallbackIndex) {
  if (!link || typeof link !== 'object') return null;
  const romOff = Number(link.romOff);
  const cpuAddr = Number(link.cpuAddr);
  if (!Number.isFinite(romOff) && !Number.isFinite(cpuAddr)) return null;
  const label = typeof link.label === 'string' && link.label
    ? link.label
    : (Number.isFinite(cpuAddr) ? `$${fmtHex(cpuAddr & 0xffff, 4)}` : `$${fmtHex(romOff >>> 0, 6)}`);
  return {
    id: typeof link.id === 'string' && link.id ? link.id : `link:${fallbackIndex}`,
    kind: typeof link.kind === 'string' && link.kind ? link.kind : 'link',
    label,
    romOff: Number.isFinite(romOff) ? (romOff >>> 0) : null,
    cpuAddr: Number.isFinite(cpuAddr) ? (cpuAddr & 0xffff) : null,
    siteKey: typeof link.siteKey === 'string' && link.siteKey ? link.siteKey : null,
    contextKey: typeof link.contextKey === 'string' && link.contextKey ? link.contextKey : null
  };
}

function normalizeAnnotationGroups(annotation) {
  const groups = [];
  for (const group of Array.isArray(annotation?.useGroups) ? annotation.useGroups : []) {
    if (!group || typeof group !== 'object') continue;
    const links = [];
    let linkIndex = 0;
    for (const rawLink of Array.isArray(group.links) ? group.links : []) {
      const link = normalizeAnnotationLink(rawLink, linkIndex);
      linkIndex += 1;
      if (link) links.push(link);
    }
    if (!links.length) continue;
    groups.push({
      kind: typeof group.kind === 'string' && group.kind ? group.kind : 'links',
      label: typeof group.label === 'string' && group.label ? group.label : 'Links',
      links
    });
  }
  return groups;
}

function normalizeRangeAnnotations(rawAnnotations, prgSize) {
  const out = [];
  const seenIds = new Set();

  for (const annotation of Array.isArray(rawAnnotations) ? rawAnnotations : []) {
    const normalizedRange = normalizeAnnotationRange(annotation, prgSize);
    if (!normalizedRange) continue;
    const baseId = typeof annotation?.id === 'string' && annotation.id
      ? annotation.id
      : `rangeAnnotation:${out.length}`;
    let id = baseId;
    let suffix = 2;
    while (seenIds.has(id)) id = `${baseId}:${suffix++}`;
    seenIds.add(id);

    out.push({
      id,
      kind: String(annotation?.kind || 'annotation'),
      subtype: String(annotation?.subtype || ''),
      label: String(annotation?.label || 'Annotation'),
      note: typeof annotation?.note === 'string' && annotation.note ? annotation.note : '',
      occupancy: typeof annotation?.occupancy === 'string' && annotation.occupancy ? annotation.occupancy : null,
      range: normalizedRange.range,
      view: normalizedRange.view,
      useGroups: normalizeAnnotationGroups(annotation)
    });
  }

  return out;
}

function isSemanticOccupancyGroup(group) {
  return group?.semanticOccupancy === true && typeof group?.occupancy === 'string' && group.occupancy;
}

function classifyGroupType(group, blockConfidenceById) {
  if (isSemanticOccupancyGroup(group)) return group.occupancy;
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

function applySemanticTypedRange(types, start, end, type) {
  const limit = Math.min(types.length, end | 0);
  for (let i = Math.max(0, start | 0); i < limit; i++) types[i] = type;
}

function applyGroupTypedRange(types, start, end, type, group) {
  if (isSemanticOccupancyGroup(group)) {
    applySemanticTypedRange(types, start, end, type);
    return;
  }
  applyTypedRange(types, start, end, type);
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

function createAnnotationCells(size) {
  return Array.from({ length: Math.max(0, size | 0) }, () => null);
}

function addAnnotationToCells(cells, start, end, annotationId) {
  const lo = Math.max(0, start | 0);
  const hi = Math.min(cells.length - 1, end | 0);
  if (hi < lo) return;
  for (let i = lo; i <= hi; i++) {
    if (!cells[i]) cells[i] = new Set();
    cells[i].add(annotationId);
  }
}

function annotationCellKey(set) {
  if (!set || !set.size) return '';
  return Array.from(set).sort().join('|');
}

function coalesceAnnotationCells(cells, start = 0, end = cells?.length || 0) {
  const ranges = [];
  let idx = Math.max(0, start | 0);
  const limit = Math.max(idx, Math.min(cells?.length || 0, end | 0));
  while (idx < limit) {
    while (idx < limit && !annotationCellKey(cells[idx])) idx++;
    if (idx >= limit) break;
    const rangeStart = idx;
    const key = annotationCellKey(cells[idx]);
    idx++;
    while (idx < limit && annotationCellKey(cells[idx]) === key) idx++;
    ranges.push({
      start: rangeStart - start,
      end: idx - start - 1,
      annotationIds: key.split('|')
    });
  }
  return ranges;
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
      mapper: null,
      rangeAnnotations: []
    };
  }

  const rowWidthBytes = 64;
  const cellSizePx = 16;
  const prgBytes = s.ines.prg;
  const prgSize = prgBytes?.length | 0;
  const analysis = s.displayAnalysis || null;
  const groups = Array.isArray(analysis?.memoryDiscoveries?.groups) ? analysis.memoryDiscoveries.groups : [];
  const oamDmaTransfers = Array.isArray(analysis?.memoryDiscoveries?.oamDmaTransfers) ? analysis.memoryDiscoveries.oamDmaTransfers : [];
  const rawRangeAnnotations = Array.isArray(analysis?.memoryDiscoveries?.rangeAnnotations) ? analysis.memoryDiscoveries.rangeAnnotations : [];
  const rangeAnnotations = normalizeRangeAnnotations(rawRangeAnnotations, prgSize);
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

  const ramAnnotationCells = createAnnotationCells(0x800);
  const prgAnnotationCells = createAnnotationCells(prgSize);
  for (const annotation of rangeAnnotations) {
    if (annotation.view.space === 'ram') addAnnotationToCells(ramAnnotationCells, annotation.view.start, annotation.view.end, annotation.id);
    if (annotation.view.space === 'prg') addAnnotationToCells(prgAnnotationCells, annotation.view.start, annotation.view.end, annotation.id);
  }

  const ramOccupiedRanges = coalesceTypedRanges(ramTypes, 0, ramTypes.length);
  const ramAnnotationRanges = coalesceAnnotationCells(ramAnnotationCells, 0, ramAnnotationCells.length);

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
        applyGroupTypedRange(prgTypes, start, end, groupType, group);
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

  for (const group of groups) {
    if (group?.space !== 'rom') continue;
    const groupType = classifyGroupType(group, blockConfidenceById);
    for (const span of group?.spans || []) {
      const start = Math.max(0, Math.min(prgTypes.length, Number(span?.start) | 0));
      const end = Math.max(start, Math.min(prgTypes.length, (Number(span?.end) | 0) + 1));
      applyGroupTypedRange(prgTypes, start, end, groupType, group);
    }
  }

  const analysisMapper = s.ines.analysisMapper || analysis?.mapper?.meta || null;
  const regionSizeBytes = getPrgRegionSizeBytes(analysisMapper, prgSize);
  const regions = [];
  for (let start = 0, index = 0; start < prgSize; start += regionSizeBytes, index++) {
    const endExclusive = Math.min(prgSize, start + regionSizeBytes);
    regions.push({
      index,
      start,
      end: endExclusive - 1,
      occupiedRanges: coalesceTypedRanges(prgTypes, start, endExclusive),
      annotationRanges: coalesceAnnotationCells(prgAnnotationCells, start, endExclusive)
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
    rangeAnnotations,
    ram: {
      sizeBytes: 0x800,
      occupiedRanges: ramOccupiedRanges,
      annotationRanges: ramAnnotationRanges
    },
    prg: {
      sizeBytes: prgSize,
      regionSizeBytes,
      regions
    }
  };
}
