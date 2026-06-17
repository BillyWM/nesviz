import { fmtHex } from '../../utils/numberUtils.js';

const POINTER_INTERPRETATION_LABELS = Object.freeze({
  direct: Object.freeze({
    subtype: 'direct',
    note: 'Used for direct jumps'
  }),
  rtsTrick: Object.freeze({
    subtype: 'rtsTrick',
    note: 'Used with RTS trick'
  })
});

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

function tableRange(table) {
  const start = Number(table?.startRomOff);
  const endRomOff = Number(table?.endRomOff);
  if (!Number.isFinite(start) || !Number.isFinite(endRomOff) || endRomOff <= start) return null;
  return {
    space: 'prg',
    start: start >>> 0,
    end: (endRomOff - 1) >>> 0
  };
}

function rangeFromRtsDispatch(dispatch) {
  const entries = arrayOrEmpty(dispatch?.pointerTable?.entries);
  let start = Number.POSITIVE_INFINITY;
  let end = -1;

  for (const entry of entries) {
    const lowRomOff = Number(entry?.lowRomOff);
    const highRomOff = Number(entry?.highRomOff);
    if (Number.isFinite(lowRomOff)) {
      start = Math.min(start, lowRomOff >>> 0);
      end = Math.max(end, lowRomOff >>> 0);
    }
    if (Number.isFinite(highRomOff)) {
      start = Math.min(start, highRomOff >>> 0);
      end = Math.max(end, highRomOff >>> 0);
    }
  }

  if (!Number.isFinite(start) || end < start) return null;
  return { space: 'prg', start: start >>> 0, end: end >>> 0 };
}

function rangeLength(range) {
  if (!range) return 0;
  return ((range.end >>> 0) - (range.start >>> 0) + 1) >>> 0;
}

function tableById(context) {
  const out = new Map();
  for (const table of arrayOrEmpty(context?.monotoneTables?.tables)) {
    if (typeof table?.tableId === 'string' && table.tableId) out.set(table.tableId, table);
  }
  for (const table of arrayOrEmpty(context?.splitPointerTables?.tables)) {
    if (typeof table?.tableId === 'string' && table.tableId && !out.has(table.tableId)) out.set(table.tableId, table);
  }
  return out;
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

function makeSiteLink(kind, site, fallbackLabel = null) {
  if (!site || typeof site !== 'object') return null;
  const romOff = Number(site.romOff);
  const cpuAddr = Number(site.cpuAddr);
  if (!Number.isFinite(romOff) && !Number.isFinite(cpuAddr)) return null;
  const label = Number.isFinite(cpuAddr)
    ? hexCpu(cpuAddr)
    : (fallbackLabel || hexRom(romOff));
  return {
    kind,
    label,
    romOff: Number.isFinite(romOff) ? (romOff >>> 0) : null,
    cpuAddr: Number.isFinite(cpuAddr) ? (cpuAddr & 0xffff) : null,
    siteKey: typeof site.siteKey === 'string' && site.siteKey ? site.siteKey : null,
    contextKey: typeof site.contextKey === 'string' && site.contextKey ? site.contextKey : null
  };
}

function makeReaderLinkFromBlockInstance(blockInstance, block, fallbackRomOff = null) {
  if (!blockInstance || typeof blockInstance !== 'object') {
    if (!block || typeof block !== 'object') return null;
    const romOff = Number(block.romStart ?? fallbackRomOff);
    if (!Number.isFinite(romOff)) return null;
    return {
      kind: 'reader',
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
    kind: 'reader',
    label: Number.isFinite(cpuAddr) ? hexCpu(cpuAddr) : hexRom(romOff),
    romOff: Number.isFinite(romOff) ? (romOff >>> 0) : null,
    cpuAddr: Number.isFinite(cpuAddr) ? (cpuAddr & 0xffff) : null,
    siteKey: typeof blockInstance.siteKey === 'string' && blockInstance.siteKey ? blockInstance.siteKey : null,
    contextKey: typeof blockInstance.contextKey === 'string' && blockInstance.contextKey ? blockInstance.contextKey : null
  };
}

function makeReaderLinkFromDispatch(dispatch, indexes) {
  const blockInstanceId = typeof dispatch?.sourceBlockInstanceId === 'string' ? dispatch.sourceBlockInstanceId : '';
  const blockInstance = blockInstanceId ? indexes.blockInstanceById.get(blockInstanceId) : null;
  const block = indexes.blockById.get(String(blockInstance?.blockId || dispatch?.sourceBlockId || '')) || null;
  const link = makeReaderLinkFromBlockInstance(blockInstance, block, Number(dispatch?.sourceRomOff));
  if (!link) return null;
  return {
    ...link,
    id: blockInstanceId ? `reader:${blockInstanceId}` : null
  };
}

function makeTargetLinkFromRtsEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const romOff = Number(entry.targetRomOff);
  const cpuAddr = Number(entry.targetCpuAddr);
  if (!Number.isFinite(romOff) && !Number.isFinite(cpuAddr)) return null;
  return {
    kind: 'target',
    label: Number.isFinite(cpuAddr) ? hexCpu(cpuAddr) : hexRom(romOff),
    romOff: Number.isFinite(romOff) ? (romOff >>> 0) : null,
    cpuAddr: Number.isFinite(cpuAddr) ? (cpuAddr & 0xffff) : null,
    siteKey: typeof entry.targetSiteKey === 'string' && entry.targetSiteKey ? entry.targetSiteKey : null,
    contextKey: typeof entry.targetContextKey === 'string' && entry.targetContextKey ? entry.targetContextKey : null
  };
}

function readerKey(link) {
  if (Number.isFinite(link?.romOff)) return `rom:${link.romOff >>> 0}`;
  if (Number.isFinite(link?.cpuAddr)) return `cpu:${link.cpuAddr & 0xffff}`;
  return null;
}

function targetKey(link) {
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

class PointerTableAccumulator {
  constructor({ kind, subtype, occupancy, range, label, note }) {
    this.kind = kind;
    this.subtype = subtype;
    this.occupancy = occupancy || null;
    this.range = { ...range };
    this.label = label;
    this.note = note;
    this.readerLinks = new Map();
    this.targetLinks = new Map();
    this.sourceTableIds = new Set();
    this.sourcePromotionIds = new Set();
    this.entryCountsByKey = new Map();
    this.entryCount = 0;
  }

  absorbRange(range) {
    if (!range) return;
    this.range.start = Math.min(this.range.start >>> 0, range.start >>> 0) >>> 0;
    this.range.end = Math.max(this.range.end >>> 0, range.end >>> 0) >>> 0;
  }

  addReader(link) {
    if (!link) return false;
    const key = readerKey(link);
    if (!key) return false;
    if (this.readerLinks.has(key)) return false;
    this.readerLinks.set(key, link);
    return true;
  }

  addTarget(link) {
    if (!link) return false;
    const key = targetKey(link);
    if (!key) return false;
    if (this.targetLinks.has(key)) return false;
    this.targetLinks.set(key, link);
    return true;
  }

  addSourceTableId(tableId) {
    if (typeof tableId === 'string' && tableId) this.sourceTableIds.add(tableId);
  }

  addSourcePromotionId(promotionId) {
    if (typeof promotionId === 'string' && promotionId) this.sourcePromotionIds.add(promotionId);
  }

  addEntryCount(entryCount, sourceKey = '') {
    if (!Number.isInteger(entryCount) || entryCount <= 0) return;
    const key = sourceKey || `entryCount:${this.entryCountsByKey.size}`;
    if (this.entryCountsByKey.has(key)) return;
    const count = entryCount >>> 0;
    this.entryCountsByKey.set(key, count);
    this.entryCount += count;
  }

  absorb(other) {
    this.absorbRange(other.range);
    for (const link of other.readerLinks.values()) this.addReader(link);
    for (const link of other.targetLinks.values()) this.addTarget(link);
    for (const tableId of other.sourceTableIds) this.sourceTableIds.add(tableId);
    for (const promotionId of other.sourcePromotionIds) this.sourcePromotionIds.add(promotionId);
    for (const [key, count] of other.entryCountsByKey.entries()) {
      if (this.entryCountsByKey.has(key)) continue;
      this.entryCountsByKey.set(key, count >>> 0);
      this.entryCount += count >>> 0;
    }
  }

  useGroups() {
    const groups = [];
    const readers = Array.from(this.readerLinks.values()).sort(linkSort);
    const targets = Array.from(this.targetLinks.values()).sort(linkSort);
    if (readers.length) {
      groups.push({
        kind: 'readers',
        label: 'Read by',
        links: readers
      });
    }
    if (targets.length) {
      groups.push({
        kind: 'targets',
        label: 'Points to',
        links: targets
      });
    }
    return groups;
  }

  toAnnotation(index) {
    return {
      id: `rangeAnnotation:${this.kind}:${this.subtype}:${this.range.space}:${fmtHex(this.range.start >>> 0, 6)}-${fmtHex(this.range.end >>> 0, 6)}:${index}`,
      kind: this.kind,
      subtype: this.subtype,
      occupancy: this.occupancy,
      range: { ...this.range },
      label: this.label,
      note: this.note,
      useGroups: this.useGroups(),
      sourceTableIds: Array.from(this.sourceTableIds).sort(),
      sourcePromotionIds: Array.from(this.sourcePromotionIds).sort(),
      entryCount: this.entryCount >>> 0,
      byteLength: rangeLength(this.range)
    };
  }
}

function accumulatorKey(kind, subtype, range) {
  return `${range.space}:${kind}:${subtype}:${range.start >>> 0}:${range.end >>> 0}`;
}

function getAccumulator(accumulators, { kind, subtype, occupancy = null, range, label, note }) {
  if (!range) return null;
  const key = accumulatorKey(kind, subtype, range);
  let accumulator = accumulators.get(key);
  if (!accumulator) {
    accumulator = new PointerTableAccumulator({ kind, subtype, occupancy, range, label, note });
    accumulators.set(key, accumulator);
  }
  return accumulator;
}

function addPromotion(accumulators, tableIndex, promotion) {
  if (!promotion || promotion.status !== 'promoted') return;
  const promotedReaders = arrayOrEmpty(promotion.promotedReaders);
  if (!promotedReaders.length) return;
  const tableId = typeof promotion.tableId === 'string' ? promotion.tableId : '';
  const table = tableIndex.get(tableId);
  const range = tableRange(table);
  if (!range) return;

  const interpretation = POINTER_INTERPRETATION_LABELS[promotion.pointerInterpretation] || null;
  if (!interpretation) return;

  const accumulator = getAccumulator(accumulators, {
    kind: 'pointerTable',
    subtype: interpretation.subtype,
    occupancy: 'romData',
    range,
    label: 'Pointer table',
    note: interpretation.note
  });
  if (!accumulator) return;

  const promotionId = typeof promotion.interpretationId === 'string' ? promotion.interpretationId : tableId;
  accumulator.addSourceTableId(tableId);
  accumulator.addSourcePromotionId(promotionId);
  accumulator.addEntryCount(Number.isInteger(promotion.entryCount) ? (promotion.entryCount >>> 0) : (Number(table?.entryCount) >>> 0), `promotion:${promotionId}`);

  for (const reader of promotedReaders) {
    const link = makeSiteLink('reader', reader?.reader);
    if (link) accumulator.addReader(link);
  }

  for (const target of arrayOrEmpty(promotion.promotedTargets)) {
    const link = makeSiteLink('target', target?.target);
    if (link) accumulator.addTarget(link);
  }
}

function addPointerPromotions(accumulators, context, tableIndex) {
  for (const promotion of arrayOrEmpty(context?.pointerPromotions?.promotions)) {
    addPromotion(accumulators, tableIndex, promotion);
  }
  for (const table of tableIndex.values()) {
    for (const promotion of arrayOrEmpty(table?.pointerPromotion?.promotedContexts)) {
      addPromotion(accumulators, tableIndex, promotion);
    }
  }
}

function addRtsTrickDispatches(accumulators, context) {
  const indexes = blockIndexes(context);
  const dispatches = [
    ...arrayOrEmpty(context?.rtsTricks?.dispatches),
    ...arrayOrEmpty(context?.abstractInterpretation?.rtsTricks?.dispatches)
  ];
  const seenDispatches = new Set();

  for (const dispatch of dispatches) {
    if (!dispatch || typeof dispatch !== 'object') continue;
    const dispatchId = typeof dispatch.id === 'string' && dispatch.id ? dispatch.id : '';
    if (dispatchId && seenDispatches.has(dispatchId)) continue;
    if (dispatchId) seenDispatches.add(dispatchId);

    const range = rangeFromRtsDispatch(dispatch);
    if (!range) continue;
    const interpretation = POINTER_INTERPRETATION_LABELS.rtsTrick;
    const accumulator = getAccumulator(accumulators, {
      kind: 'pointerTable',
      subtype: interpretation.subtype,
      occupancy: 'romData',
      range,
      label: 'Pointer table',
      note: interpretation.note
    });
    if (!accumulator) continue;

    const sourceId = dispatchId || `rtsTrick:${range.start}:${range.end}`;
    accumulator.addSourceTableId(sourceId);
    accumulator.addEntryCount(arrayOrEmpty(dispatch.pointerTable?.entries).length >>> 0, `rtsDispatch:${sourceId}`);

    const readerLink = makeReaderLinkFromDispatch(dispatch, indexes);
    if (readerLink) accumulator.addReader(readerLink);

    for (const entry of arrayOrEmpty(dispatch.pointerTable?.entries)) {
      const targetLink = makeTargetLinkFromRtsEntry(entry);
      if (targetLink) accumulator.addTarget(targetLink);
    }
  }
}

function annotationSort(a, b) {
  return String(a.range?.space || '').localeCompare(String(b.range?.space || ''))
    || ((a.range?.start ?? 0) - (b.range?.start ?? 0))
    || ((a.range?.end ?? 0) - (b.range?.end ?? 0))
    || String(a.kind || '').localeCompare(String(b.kind || ''))
    || String(a.subtype || '').localeCompare(String(b.subtype || ''));
}

function mergeableRange(a, b) {
  if (!a || !b) return false;
  if (a.space !== b.space) return false;
  return (b.start >>> 0) <= ((a.end >>> 0) + 1);
}

function materializeMaximalSpans(accumulators) {
  const byBucket = new Map();
  for (const accumulator of accumulators.values()) {
    const bucket = `${accumulator.range.space}:${accumulator.kind}:${accumulator.subtype}:${accumulator.occupancy || ''}`;
    let list = byBucket.get(bucket);
    if (!list) {
      list = [];
      byBucket.set(bucket, list);
    }
    list.push(accumulator);
  }

  const merged = [];
  for (const list of byBucket.values()) {
    list.sort(annotationSort);
    let current = null;
    for (const item of list) {
      if (current && mergeableRange(current.range, item.range)) {
        current.absorb(item);
        continue;
      }
      if (current) merged.push(current);
      current = new PointerTableAccumulator({
        kind: item.kind,
        subtype: item.subtype,
        occupancy: item.occupancy,
        range: item.range,
        label: item.label,
        note: item.note
      });
      current.absorb(item);
    }
    if (current) merged.push(current);
  }

  merged.sort(annotationSort);
  return merged.map((annotation, index) => annotation.toAnnotation(index));
}

export function buildMemoryMapRangeAnnotations(context, options = {}) {
  const tableIndex = tableById(context);
  const accumulators = new Map();

  addPointerPromotions(accumulators, context, tableIndex);
  addRtsTrickDispatches(accumulators, context);

  return materializeMaximalSpans(accumulators);
}
