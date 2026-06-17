import { buildMemoryMapRangeAnnotations } from './memoryMapRangeAnnotations.js';
import { buildMemoryMapOamBufferAnnotations } from './memoryMapOamBufferAnnotations.js';

const DEFAULT_AGGREGATE_STEP_MS = 8;

function uniqueSorted(values, numeric = false) {
  const out = Array.from(new Set(values));
  if (numeric) out.sort((a, b) => a - b);
  else out.sort();
  return out;
}

function rangeKey(prefix, start, end) {
  return `${prefix}:${(start >>> 0).toString(16)}-${(end >>> 0).toString(16)}`;
}

function expandAddressSet(addressSet) {
  if (Array.isArray(addressSet?.values) && addressSet.values.length) return addressSet.values.map((value) => value >>> 0);
  const start = Number(addressSet?.start);
  const end = Number(addressSet?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return [];
  const out = [];
  for (let value = start; value <= end; value += 1) out.push(value >>> 0);
  return out;
}

function addressKeyForRam(canonicalRamAddr) {
  const addr = canonicalRamAddr & 0x07ff;
  return addr < 0x100 ? `zp:${addr}` : `ram:${addr}`;
}

function contiguousSpans(values) {
  const sorted = uniqueSorted(values, true);
  const spans = [];
  let index = 0;
  while (index < sorted.length) {
    const start = sorted[index];
    let end = start;
    index += 1;
    while (index < sorted.length && sorted[index] === end + 1) {
      end = sorted[index];
      index += 1;
    }
    spans.push({ start, end });
  }
  return spans;
}

function addSetItems(target, values) {
  for (const value of values) target.add(value);
}

function makeRamGroups(ramByAccess) {
  const groups = [];
  for (const [access, data] of ramByAccess.entries()) {
    for (const span of contiguousSpans(data.values)) {
      const memberAddressKeys = [];
      for (let addr = span.start; addr <= span.end; addr += 1) memberAddressKeys.push(addressKeyForRam(addr));
      groups.push({
        id: rangeKey(`memoryAccess:ram:${access}`, span.start, span.end),
        kind: 'memoryAccess',
        space: 'ram',
        access,
        memberAddressKeys,
        touchingRawBlockIds: uniqueSorted(Array.from(data.blockIds))
      });
    }
  }
  return groups;
}


function semanticOccupancyGroups(rangeAnnotations) {
  const groups = [];
  for (const annotation of Array.isArray(rangeAnnotations) ? rangeAnnotations : []) {
    const occupancy = typeof annotation?.occupancy === 'string' ? annotation.occupancy : '';
    if (!occupancy) continue;
    const range = annotation.range || null;
    if (!range || (range.space !== 'prg' && range.space !== 'ram' && range.space !== 'zp')) continue;
    const start = Number(range.start);
    const end = Number(range.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) continue;
    if (range.space === 'ram' || range.space === 'zp') {
      const memberAddressKeys = [];
      for (let addr = start; addr <= end; addr += 1) memberAddressKeys.push(addressKeyForRam(addr));
      groups.push({
        id: rangeKey(`semanticOccupancy:${annotation.kind || 'annotation'}:${annotation.subtype || occupancy}`, start, end),
        kind: 'semanticOccupancy',
        sourceAnnotationId: annotation.id || null,
        sourceKind: annotation.kind || null,
        sourceSubtype: annotation.subtype || null,
        space: 'ram',
        access: 'semantic',
        occupancy,
        semanticOccupancy: true,
        memberAddressKeys,
        touchingRawBlockIds: []
      });
      continue;
    }
    groups.push({
      id: rangeKey(`semanticOccupancy:${annotation.kind || 'annotation'}:${annotation.subtype || occupancy}`, start, end),
      kind: 'semanticOccupancy',
      sourceAnnotationId: annotation.id || null,
      sourceKind: annotation.kind || null,
      sourceSubtype: annotation.subtype || null,
      space: 'rom',
      access: occupancy === 'romData' || occupancy === 'romDataLight' ? 'read' : 'semantic',
      occupancy,
      semanticOccupancy: true,
      spans: [{ start: start >>> 0, end: end >>> 0 }],
      touchingRawBlockIds: []
    });
  }
  return groups;
}

function makeRomGroups(romData) {
  return contiguousSpans(romData.values).map((span) => ({
    id: rangeKey('memoryAccess:rom:read', span.start, span.end),
    kind: 'memoryAccess',
    space: 'rom',
    access: 'read',
    spans: [{ start: span.start, end: span.end }],
    touchingRawBlockIds: uniqueSorted(Array.from(romData.blockIds))
  }));
}

export function createMemoryMapAggregator({ facts, counters = {}, context = null }) {
  const allFacts = Array.isArray(facts) ? facts : [];
  const baseCounters = counters && typeof counters === 'object' ? counters : {};
  const ramByAccess = new Map();
  const romData = { values: new Set(), blockIds: new Set() };

  let factIndex = 0;
  let complete = false;
  let memoryDiscoveries = null;

  function ramDataForAccess(access) {
    let data = ramByAccess.get(access);
    if (!data) {
      data = { values: new Set(), blockIds: new Set() };
      ramByAccess.set(access, data);
    }
    return data;
  }

  function consumeFact(fact) {
    if (!fact || fact.kind !== 'memoryAccess') return;
    const values = expandAddressSet(fact.addressSet);
    if (fact.space === 'ram') {
      const data = ramDataForAccess(fact.access);
      addSetItems(data.values, values.map((addr) => addr & 0x07ff));
      data.blockIds.add(fact.blockId);
      return;
    }
    if (fact.space === 'rom') {
      addSetItems(romData.values, values.map((addr) => addr >>> 0));
      romData.blockIds.add(fact.blockId);
    }
  }

  function finalize() {
    if (memoryDiscoveries) return memoryDiscoveries;
    const rangeAnnotations = [
      ...buildMemoryMapRangeAnnotations(context, { facts: allFacts }),
      ...buildMemoryMapOamBufferAnnotations(context, { facts: allFacts })
    ];
    const groups = [
      ...makeRamGroups(ramByAccess),
      ...makeRomGroups(romData),
      ...semanticOccupancyGroups(rangeAnnotations)
    ];
    memoryDiscoveries = {
      groups,
      rangeAnnotations,
      oamDmaTransfers: [],
      accessFacts: allFacts,
      counters: {
        ...baseCounters,
        groups: groups.length,
        annotations: rangeAnnotations.length
      }
    };
    complete = true;
    return memoryDiscoveries;
  }

  function step(maxMilliseconds = DEFAULT_AGGREGATE_STEP_MS) {
    if (complete) return { status: 'complete' };
    const startedAt = Date.now();
    let didWork = false;
    while (factIndex < allFacts.length) {
      consumeFact(allFacts[factIndex]);
      factIndex += 1;
      didWork = true;
      if (didWork && Date.now() - startedAt >= maxMilliseconds) break;
    }
    if (factIndex >= allFacts.length) {
      finalize();
      return { status: 'complete' };
    }
    return { status: 'running' };
  }

  function progress() {
    return {
      stage: complete ? 'aggregateComplete' : 'aggregateMemoryMap',
      factIndex: Math.min(factIndex, allFacts.length),
      factCount: allFacts.length,
      groups: memoryDiscoveries ? memoryDiscoveries.groups.length : 0,
      annotations: memoryDiscoveries ? memoryDiscoveries.rangeAnnotations.length : 0,
      ...baseCounters
    };
  }

  function result() {
    return finalize();
  }

  return { step, progress, result };
}

export function aggregateMemoryMapDiscoveries({ facts, counters = {}, context = null }) {
  const aggregator = createMemoryMapAggregator({ facts, counters, context });
  while (aggregator.step(Number.MAX_SAFE_INTEGER).status !== 'complete') {
    // Intentionally empty: synchronous compatibility wrapper.
  }
  return aggregator.result();
}
