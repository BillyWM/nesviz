import { inclusiveRomSpansFromOffsets, uniqueCountedBytesForInclusiveRomSpans } from './romDataSpans.js';

function cleanStringArray(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string' && value.length)))
    .sort();
}

function cleanNumberArray(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .map((value) => value | 0)))
    .sort((a, b) => a - b);
}

function isDataTableFootprint(fp) {
  if (!fp || fp.space !== 'rom') return false;
  if (fp.kind !== 'synthesizedLoopTable' && fp.kind !== 'sentinelTerminatedLoopTable') return false;
  if (fp.evidenceQuality === 'weak') return false;
  const memberCount = Array.isArray(fp.memberRomOffsets) ? fp.memberRomOffsets.length : 0;
  const possibleCount = Array.isArray(fp.possibleRomOffsets) ? fp.possibleRomOffsets.length : 0;
  const hasTermination = fp.terminationKind === 'bound' || fp.terminationKind === 'sentinel1' || fp.terminationKind === 'sentinel2';
  return hasTermination || memberCount >= 3 || possibleCount >= 3 || !!fp.boundingRange;
}

function chooseAnchorRawBlockId(fp) {
  if (typeof fp?.loopInfo?.rawHeaderBlockId === 'string' && fp.loopInfo.rawHeaderBlockId) return fp.loopInfo.rawHeaderBlockId;
  if (Array.isArray(fp?.touchingRawBlockIds) && fp.touchingRawBlockIds.length) return fp.touchingRawBlockIds[0];
  return null;
}

function confidenceForFootprint(fp) {
  if (fp?.evidenceQuality === 'exact') return 'exact';
  if (fp?.evidenceQuality === 'bounded') return 'bounded';
  if (fp?.evidenceQuality === 'partial') return 'partial';
  return 'observed';
}

function footprintRecordId(fp, index) {
  const id = typeof fp?.id === 'string' && fp.id ? fp.id : `footprint:${index}`;
  return `streamFootprint:${id}`;
}

export function buildDataDiscoveryRecordsFromStreamFootprints({ memoryDiscoveries, prgSize = null }) {
  const records = [];
  let index = 0;
  const footprints = Array.isArray(memoryDiscoveries?.streamFootprints) ? memoryDiscoveries.streamFootprints : [];

  for (const fp of footprints) {
    if (!isDataTableFootprint(fp)) continue;
    const memberRomOffsets = cleanNumberArray(fp.memberRomOffsets || []);
    const romSpans = inclusiveRomSpansFromOffsets(memberRomOffsets, prgSize);
    if (!romSpans.length) continue;

    index++;
    const rawBlockId = chooseAnchorRawBlockId(fp);
    const anchors = rawBlockId ? [{
      kind: 'reader',
      rawBlockId,
      loopId: fp?.loopInfo?.loopId || null,
      footprintId: fp?.id || null
    }] : [];

    records.push({
      id: footprintRecordId(fp, index),
      kind: 'dataTable',
      source: 'vsaStreamFootprint',
      confidence: confidenceForFootprint(fp),
      countsAsData: true,
      romSpans,
      romOffsets: memberRomOffsets,
      anchors,
      evidence: {
        footprintId: fp?.id || null,
        footprintKind: fp?.kind || null,
        addressFamily: fp?.addressFamily || null,
        patternKind: fp?.patternKind || null,
        basisKind: fp?.basis?.kind || null,
        basisRomOffsets: cleanNumberArray(fp?.basis?.romOffsets || []),
        evidenceQuality: fp?.evidenceQuality || null,
        terminationKind: fp?.terminationKind || null,
        terminationEvidence: fp?.terminationEvidence || null,
        sentinelValue: Number.isFinite(fp?.sentinelValue) ? (fp.sentinelValue & 0xff) : null,
        sentinelBytes: cleanNumberArray(fp?.sentinelBytes || []),
        lengthBound: Number.isFinite(fp?.lengthBound) ? (fp.lengthBound | 0) : null,
        boundingRange: fp?.boundingRange || null,
        possibleRomOffsets: cleanNumberArray(fp?.possibleRomOffsets || []),
        touchingRawBlockIds: cleanStringArray(fp?.touchingRawBlockIds || []),
        touchingFunctionIds: cleanStringArray(fp?.touchingFunctionIds || []),
        entryFamilies: cleanStringArray(fp?.entryFamilies || []),
        observationIds: cleanStringArray(fp?.observationIds || []),
        traceIds: cleanStringArray(fp?.traceIds || []),
        loopInfo: fp?.loopInfo ? { ...fp.loopInfo } : null
      },
      stats: {
        spanCount: romSpans.length,
        countedDataByteCount: uniqueCountedBytesForInclusiveRomSpans(romSpans, prgSize),
        memberRomOffsetCount: memberRomOffsets.length,
        possibleRomOffsetCount: Array.isArray(fp?.possibleRomOffsets) ? fp.possibleRomOffsets.length : 0
      }
    });
  }

  return records;
}
