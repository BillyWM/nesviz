import { canonicalizeCpuAddr } from '../../utils/addressUtils.js';
import { fmtHex } from '../../utils/numberUtils.js';

function hexCpu(addr) {
  if (!Number.isFinite(addr)) return '$????';
  return `$${fmtHex(addr & 0xffff, 4)}`;
}

function hexRom(addr) {
  if (!Number.isFinite(addr)) return '$??????';
  return `$${fmtHex(addr >>> 0, 6)}`;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function rangeLength(range) {
  if (!range) return 0;
  return ((range.end >>> 0) - (range.start >>> 0) + 1) >>> 0;
}

function blockIndexes(context) {
  const blockInstanceById = new Map();
  for (const blockInstance of arrayOrEmpty(context?.blockInstances)) {
    if (typeof blockInstance?.blockInstanceId === 'string' && blockInstance.blockInstanceId) {
      blockInstanceById.set(blockInstance.blockInstanceId, blockInstance);
    }
  }

  const blockById = new Map();
  for (const block of arrayOrEmpty(context?.blocks)) {
    if (typeof block?.blockId === 'string' && block.blockId) blockById.set(block.blockId, block);
  }

  return { blockInstanceById, blockById };
}

function makeFunctionLink(kind, blockInstance, block, fallbackRomOff = null) {
  if (!blockInstance || typeof blockInstance !== 'object') {
    if (!block || typeof block !== 'object') return null;
    const romOff = Number(block.romStart ?? fallbackRomOff);
    if (!Number.isFinite(romOff)) return null;
    return {
      kind,
      label: hexRom(romOff),
      romOff: romOff >>> 0,
      cpuAddr: null,
      siteKey: null,
      contextKey: null
    };
  }

  const romOff = Number(block?.romStart ?? fallbackRomOff);
  const cpuAddr = Number(blockInstance.cpuStart);
  if (!Number.isFinite(romOff) && !Number.isFinite(cpuAddr)) return null;
  return {
    kind,
    label: Number.isFinite(cpuAddr) ? hexCpu(cpuAddr) : hexRom(romOff),
    romOff: Number.isFinite(romOff) ? (romOff >>> 0) : null,
    cpuAddr: Number.isFinite(cpuAddr) ? (cpuAddr & 0xffff) : null,
    siteKey: typeof blockInstance.siteKey === 'string' && blockInstance.siteKey ? blockInstance.siteKey : null,
    contextKey: typeof blockInstance.contextKey === 'string' && blockInstance.contextKey ? blockInstance.contextKey : null
  };
}

function linkKey(link) {
  if (Number.isFinite(link?.romOff)) return `rom:${link.romOff >>> 0}`;
  if (Number.isFinite(link?.cpuAddr)) return `cpu:${link.cpuAddr & 0xffff}`;
  return null;
}

function linkSort(a, b) {
  const ar = Number.isFinite(a.romOff) ? a.romOff >>> 0 : Number.MAX_SAFE_INTEGER;
  const br = Number.isFinite(b.romOff) ? b.romOff >>> 0 : Number.MAX_SAFE_INTEGER;
  return (ar - br)
    || String(a.label || '').localeCompare(String(b.label || ''))
    || String(a.siteKey || '').localeCompare(String(b.siteKey || ''));
}

function factFunctionLink(kind, fact, indexes) {
  const blockInstanceId = typeof fact?.blockInstanceId === 'string' ? fact.blockInstanceId : '';
  const blockInstance = blockInstanceId ? indexes.blockInstanceById.get(blockInstanceId) : null;
  const block = indexes.blockById.get(String(blockInstance?.blockId || fact?.blockId || '')) || null;
  return makeFunctionLink(kind, blockInstance, block, Number(fact?.romOff));
}

function addressSetValues(addressSet) {
  if (Array.isArray(addressSet?.values) && addressSet.values.length) {
    return addressSet.values.map((value) => Number(value) >>> 0);
  }
  const start = Number(addressSet?.start);
  const end = Number(addressSet?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return [];
  const out = [];
  for (let value = start; value <= end; value += 1) out.push(value >>> 0);
  return out;
}

function factIntersectsRange(fact, range) {
  if (!fact || !range) return false;
  if (fact.space !== 'ram') return false;
  if (fact.access !== 'write' && fact.access !== 'readWrite') return false;
  const start = range.start >>> 0;
  const end = range.end >>> 0;
  for (const value of addressSetValues(fact.addressSet)) {
    const addr = value & 0x07ff;
    if (addr >= start && addr <= end) return true;
  }
  return false;
}

function projectRamPage(cpuStart, cpuEnd) {
  const canonicalStart = cpuStart & 0x07ff;
  const canonicalEnd = cpuEnd & 0x07ff;
  if (canonicalEnd < canonicalStart) return null;
  return {
    range: {
      space: canonicalEnd <= 0xff ? 'zp' : 'ram',
      start: canonicalStart >>> 0,
      end: canonicalEnd >>> 0
    },
    occupancy: 'group'
  };
}

function projectPrgPage(context, fact, cpuStart, cpuEnd) {
  const blockInstance = typeof fact?.blockInstanceId === 'string'
    ? blockIndexes(context).blockInstanceById.get(fact.blockInstanceId)
    : null;
  const contextKey = typeof blockInstance?.contextKey === 'string' ? blockInstance.contextKey : null;
  const mapperContext = contextKey ? context?.contexts?.[contextKey] : null;
  if (!mapperContext || !context?.mapper || typeof context.mapper.resolveCpuAddress !== 'function') return null;

  const romOffs = [];
  for (let cpuAddr = cpuStart & 0xffff; cpuAddr <= (cpuEnd & 0xffff); cpuAddr += 1) {
    const resolved = context.mapper.resolveCpuAddress(mapperContext, cpuAddr & 0xffff, { purpose: 'oamDmaSourcePage' });
    if (!resolved?.ok || resolved?.backing?.kind !== 'exact') return null;
    romOffs.push(resolved.backing.romOff >>> 0);
  }
  romOffs.sort((a, b) => a - b);
  for (let i = 1; i < romOffs.length; i += 1) {
    if (romOffs[i] !== romOffs[i - 1] + 1) return null;
  }
  return {
    range: {
      space: 'prg',
      start: romOffs[0] >>> 0,
      end: romOffs[romOffs.length - 1] >>> 0
    },
    occupancy: 'romData'
  };
}

function projectOamSource(context, fact) {
  const cpuStart = Number(fact?.sourceCpuStart);
  const cpuEnd = Number(fact?.sourceCpuEnd);
  if (!Number.isInteger(cpuStart) || !Number.isInteger(cpuEnd)) return null;
  const canonicalStart = canonicalizeCpuAddr(cpuStart & 0xffff);
  const canonicalEnd = canonicalizeCpuAddr(cpuEnd & 0xffff);
  if ((canonicalStart.space === 'zp' || canonicalStart.space === 'ram')
    && (canonicalEnd.space === 'zp' || canonicalEnd.space === 'ram')) {
    return projectRamPage(cpuStart & 0xffff, cpuEnd & 0xffff);
  }
  if (canonicalStart.space === 'rom' && canonicalEnd.space === 'rom') {
    return projectPrgPage(context, fact, cpuStart & 0xffff, cpuEnd & 0xffff);
  }
  return null;
}

function annotationKey(projected) {
  const range = projected?.range;
  if (!range) return '';
  return `${range.space}:${range.start >>> 0}:${range.end >>> 0}:${projected.occupancy || ''}`;
}

class OamBufferAccumulator {
  constructor(projected) {
    this.range = { ...projected.range };
    this.occupancy = projected.occupancy || null;
    this.dmaLinks = new Map();
    this.writerLinks = new Map();
    this.sourceCpuRanges = new Map();
    this.pages = new Set();
  }

  addDmaFact(fact, indexes) {
    const page = Number(fact?.page);
    if (Number.isInteger(page)) this.pages.add(page & 0xff);
    const cpuStart = Number(fact?.sourceCpuStart);
    const cpuEnd = Number(fact?.sourceCpuEnd);
    if (Number.isInteger(cpuStart) && Number.isInteger(cpuEnd)) {
      this.sourceCpuRanges.set(`${cpuStart & 0xffff}:${cpuEnd & 0xffff}`, {
        start: cpuStart & 0xffff,
        end: cpuEnd & 0xffff
      });
    }
    const link = factFunctionLink('dmaTrigger', fact, indexes);
    const key = linkKey(link);
    if (key && !this.dmaLinks.has(key)) this.dmaLinks.set(key, link);
  }

  addWriterFact(fact, indexes) {
    const link = factFunctionLink('writer', fact, indexes);
    const key = linkKey(link);
    if (key && !this.writerLinks.has(key)) this.writerLinks.set(key, link);
  }

  note() {
    const ranges = Array.from(this.sourceCpuRanges.values()).sort((a, b) => a.start - b.start || a.end - b.end);
    if (ranges.length === 1) return `Copied by OAM DMA from CPU ${hexCpu(ranges[0].start)}-${hexCpu(ranges[0].end)}`;
    if (ranges.length > 1) return 'Copied by OAM DMA from multiple CPU pages';
    return 'Copied by OAM DMA';
  }

  useGroups() {
    const groups = [];
    const dmaLinks = Array.from(this.dmaLinks.values()).sort(linkSort);
    const writerLinks = Array.from(this.writerLinks.values()).sort(linkSort);
    if (dmaLinks.length) {
      groups.push({
        kind: 'dmaTriggers',
        label: 'DMA by',
        links: dmaLinks
      });
    }
    if (writerLinks.length) {
      groups.push({
        kind: 'writers',
        label: 'Written by',
        links: writerLinks
      });
    }
    return groups;
  }

  toAnnotation(index) {
    return {
      id: `rangeAnnotation:oamBuffer:${this.range.space}:${fmtHex(this.range.start >>> 0, this.range.space === 'prg' ? 6 : 4)}-${fmtHex(this.range.end >>> 0, this.range.space === 'prg' ? 6 : 4)}:${index}`,
      kind: 'oamBuffer',
      subtype: 'dmaSource',
      occupancy: this.occupancy,
      range: { ...this.range },
      label: 'OAM buffer',
      note: this.note(),
      useGroups: this.useGroups(),
      pages: Array.from(this.pages).sort((a, b) => a - b),
      byteLength: rangeLength(this.range)
    };
  }
}

export function buildMemoryMapOamBufferAnnotations(context, options = {}) {
  const facts = arrayOrEmpty(options?.facts);
  const indexes = blockIndexes(context);
  const accumulators = new Map();
  const oamFacts = facts.filter((fact) => fact?.kind === 'oamDma');
  const writeFacts = facts.filter((fact) => fact?.kind === 'memoryAccess'
    && fact.space === 'ram'
    && (fact.access === 'write' || fact.access === 'readWrite'));

  for (const fact of oamFacts) {
    const projected = projectOamSource(context, fact);
    const key = annotationKey(projected);
    if (!key) continue;
    let accumulator = accumulators.get(key);
    if (!accumulator) {
      accumulator = new OamBufferAccumulator(projected);
      accumulators.set(key, accumulator);
    }
    accumulator.addDmaFact(fact, indexes);
  }

  for (const accumulator of accumulators.values()) {
    if (accumulator.range.space !== 'zp' && accumulator.range.space !== 'ram') continue;
    for (const fact of writeFacts) {
      if (factIntersectsRange(fact, accumulator.range)) accumulator.addWriterFact(fact, indexes);
    }
  }

  return Array.from(accumulators.values())
    .sort((a, b) => String(a.range.space).localeCompare(String(b.range.space))
      || (a.range.start - b.range.start)
      || (a.range.end - b.range.end))
    .map((annotation, index) => annotation.toAnnotation(index));
}
