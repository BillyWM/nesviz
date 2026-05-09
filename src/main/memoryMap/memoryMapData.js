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

function buildBlockIndexes(analysis) {
  const blocks = Array.isArray(analysis?.blocks) ? analysis.blocks : [];
  const blockById = new Map();
  const rawToDisplayBlockId = new Map();
  const rawToDisplay = analysis?.rawToDisplayBlockIds && typeof analysis.rawToDisplayBlockIds === 'object'
    ? analysis.rawToDisplayBlockIds
    : {};

  for (const block of blocks) {
    if (typeof block?.id === 'string' && block.id) blockById.set(block.id, block);
    for (const rawBlockId of block?.rawBlockIds || []) {
      if (typeof rawBlockId === 'string' && rawBlockId) rawToDisplayBlockId.set(rawBlockId, block.id);
    }
  }

  for (const [rawBlockId, displayBlockId] of Object.entries(rawToDisplay)) {
    if (typeof rawBlockId === 'string' && rawBlockId && typeof displayBlockId === 'string' && displayBlockId) {
      rawToDisplayBlockId.set(rawBlockId, displayBlockId);
    }
  }

  return { blockById, rawToDisplayBlockId };
}

function blockRomStart(block) {
  if (typeof block?.romStart === 'number' && Number.isFinite(block.romStart)) return block.romStart >>> 0;
  const lineOffsets = (Array.isArray(block?.lines) ? block.lines : [])
    .map((line) => (typeof line?.romOff === 'number' && Number.isFinite(line.romOff)) ? (line.romOff >>> 0) : null)
    .filter((value) => value !== null);
  if (lineOffsets.length) return Math.min(...lineOffsets) >>> 0;
  return null;
}

function displayBlockIdForRawBlock(rawBlockId, indexes, context) {
  if (!(typeof rawBlockId === 'string' && rawBlockId)) {
    throw new Error(`Memory map annotation ${context} is missing a raw block id`);
  }
  const mapped = indexes.rawToDisplayBlockId.get(rawBlockId);
  if (mapped && indexes.blockById.has(mapped)) return mapped;
  if (indexes.blockById.has(rawBlockId)) return rawBlockId;
  throw new Error(`Memory map annotation ${context} raw block ${rawBlockId} could not be mapped to a display block`);
}

function requireDisplayBlockRomStart(displayBlockId, indexes, context) {
  const block = indexes.blockById.get(displayBlockId);
  const romStart = blockRomStart(block);
  if (romStart === null) {
    throw new Error(`Memory map annotation ${context} display block ${displayBlockId} is missing a ROM-absolute start`);
  }
  return romStart >>> 0;
}

function romLabel(romOff) {
  const value = romOff >>> 0;
  const width = Math.max(4, value.toString(16).length);
  return `$${fmtHex(value, width)}`;
}

function normalizeUseSites(functionUse, indexes) {
  const byKey = new Map();
  for (const site of Array.isArray(functionUse?.useSites) ? functionUse.useSites : []) {
    if (typeof site?.romOff !== 'number') {
      throw new Error(`Memory map annotation function ${functionUse?.functionId || '<unknown>'} has a use site without a ROM-absolute address`);
    }
    const romOff = site.romOff >>> 0;
    const rawBlockId = typeof site?.rawBlockId === 'string' && site.rawBlockId ? site.rawBlockId : null;
    const displayBlockId = displayBlockIdForRawBlock(rawBlockId, indexes, `function ${functionUse?.functionId || '<unknown>'} use site ${romLabel(romOff)}`);
    const traceId = typeof site?.traceId === 'string' && site.traceId ? site.traceId : null;
    const observationId = typeof site?.observationId === 'string' && site.observationId ? site.observationId : null;
    const key = [romOff.toString(16), rawBlockId || '', displayBlockId || '', traceId || '', observationId || ''].join(':');
    if (!byKey.has(key)) {
      byKey.set(key, { romOff, rawBlockId, displayBlockId, traceId, observationId });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => (a.romOff - b.romOff)
    || String(a.rawBlockId || '').localeCompare(String(b.rawBlockId || ''))
    || String(a.displayBlockId || '').localeCompare(String(b.displayBlockId || ''))
    || String(a.traceId || '').localeCompare(String(b.traceId || ''))
    || String(a.observationId || '').localeCompare(String(b.observationId || '')));
}

function mergeUseSites(a, b) {
  const byKey = new Map();
  for (const site of [...(a || []), ...(b || [])]) {
    const key = [
      (site.romOff >>> 0).toString(16),
      site.rawBlockId || '',
      site.traceId || '',
      site.observationId || ''
    ].join(':');
    if (!byKey.has(key)) byKey.set(key, site);
  }
  return Array.from(byKey.values()).sort((x, y) => (x.romOff - y.romOff)
    || String(x.rawBlockId || '').localeCompare(String(y.rawBlockId || ''))
    || String(x.traceId || '').localeCompare(String(y.traceId || ''))
    || String(x.observationId || '').localeCompare(String(y.observationId || '')));
}

function requireFunctionRomStart(functionUse) {
  if (typeof functionUse?.functionRomStart !== 'number') {
    throw new Error(`Memory map annotation function ${functionUse?.functionId || '<unknown>'} is missing a carried ROM-absolute function start`);
  }
  return functionUse.functionRomStart >>> 0;
}

function normalizeFunctions(annotation, indexes) {
  const rawFunctionUses = Array.isArray(annotation?.functionUses) ? annotation.functionUses : [];
  const byDisplayBlock = new Map();

  for (const functionUse of rawFunctionUses) {
    const carriedRomStart = requireFunctionRomStart(functionUse);
    const useSites = normalizeUseSites(functionUse, indexes);
    if (!useSites.length) {
      throw new Error(`Memory map annotation function ${functionUse?.functionId || '<unknown>'} has no ROM-absolute use sites`);
    }

    const useSitesByDisplayBlock = new Map();
    for (const site of useSites) {
      let list = useSitesByDisplayBlock.get(site.displayBlockId);
      if (!list) {
        list = [];
        useSitesByDisplayBlock.set(site.displayBlockId, list);
      }
      list.push(site);
    }

    for (const [displayBlockId, displayUseSites] of useSitesByDisplayBlock.entries()) {
      const displayRomStart = requireDisplayBlockRomStart(displayBlockId, indexes, `function ${functionUse?.functionId || '<unknown>'}`);
      const prev = byDisplayBlock.get(displayBlockId);
      if (prev) {
        prev.functionIds = Array.from(new Set([...prev.functionIds, functionUse?.functionId].filter(Boolean))).sort();
        prev.rootBlockIds = Array.from(new Set([...prev.rootBlockIds, functionUse?.functionRootRawBlockId].filter(Boolean))).sort();
        prev.carriedFunctionRomStarts = Array.from(new Set([...prev.carriedFunctionRomStarts, carriedRomStart])).sort((a, b) => a - b);
        prev.useSites = mergeUseSites(prev.useSites, displayUseSites);
        prev.primaryUseSiteRomOff = prev.useSites[0]?.romOff ?? null;
        continue;
      }
      const mergedUseSites = mergeUseSites([], displayUseSites);
      byDisplayBlock.set(displayBlockId, {
        id: displayBlockId,
        functionIds: Array.from(new Set([functionUse?.functionId].filter(Boolean))).sort(),
        rootBlockIds: Array.from(new Set([functionUse?.functionRootRawBlockId].filter(Boolean))).sort(),
        carriedFunctionRomStarts: [carriedRomStart],
        displayBlockId,
        romStart: displayRomStart,
        label: romLabel(displayRomStart),
        useSites: mergedUseSites,
        primaryUseSiteRomOff: mergedUseSites[0]?.romOff ?? null
      });
    }
  }

  return Array.from(byDisplayBlock.values()).sort((a, b) => (a.romStart - b.romStart)
    || String(a.displayBlockId || '').localeCompare(String(b.displayBlockId || '')));
}

function normalizeAnnotationRange(annotation, prgSize) {
  const range = annotation?.range || null;
  const space = range?.space;
  const start = Number(range?.start);
  const end = Number(range?.end);
  if (!(space === 'zp' || space === 'ram' || space === 'rom')) return null;
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

function normalizeMapAnnotations(rawAnnotations, analysis, prgSize) {
  const indexes = buildBlockIndexes(analysis);
  const out = [];
  const seenIds = new Set();

  for (const annotation of Array.isArray(rawAnnotations) ? rawAnnotations : []) {
    const normalizedRange = normalizeAnnotationRange(annotation, prgSize);
    if (!normalizedRange) continue;
    const baseId = typeof annotation?.id === 'string' && annotation.id
      ? annotation.id
      : `annotation:${out.length}`;
    let id = baseId;
    let suffix = 2;
    while (seenIds.has(id)) id = `${baseId}:${suffix++}`;
    seenIds.add(id);

    out.push({
      id,
      kind: String(annotation?.kind || 'annotation'),
      source: String(annotation?.source || 'analysis'),
      label: String(annotation?.label || 'Annotation'),
      range: normalizedRange.range,
      view: normalizedRange.view,
      functions: normalizeFunctions(annotation, indexes)
    });
  }

  return out;
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
      mapAnnotations: []
    };
  }

  const rowWidthBytes = 64;
  const cellSizePx = 16;
  const prgBytes = s.ines.prg;
  const prgSize = prgBytes?.length | 0;
  const analysis = s.displayAnalysis || null;
  const groups = Array.isArray(analysis?.memoryDiscoveries?.groups) ? analysis.memoryDiscoveries.groups : [];
  const oamDmaTransfers = Array.isArray(analysis?.memoryDiscoveries?.oamDmaTransfers) ? analysis.memoryDiscoveries.oamDmaTransfers : [];
  const rawMapAnnotations = Array.isArray(analysis?.memoryDiscoveries?.mapAnnotations) ? analysis.memoryDiscoveries.mapAnnotations : [];
  const mapAnnotations = normalizeMapAnnotations(rawMapAnnotations, analysis, prgSize);
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
  for (const annotation of mapAnnotations) {
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
    mapAnnotations,
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
