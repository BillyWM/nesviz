import { mergeInclusiveRomSpans, uniqueCountedBytesForInclusiveRomSpans } from './romDataSpans.js';

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

function groupRecordId(group, index) {
  const groupId = (typeof group?.id === 'string' && group.id.length) ? group.id : `group:${index}`;
  return `vsaMemory:${groupId}`;
}

export function buildDataDiscoveryRecordsFromVsaMemoryDiscoveries({ memoryDiscoveries, prgSize = null }) {
  const records = [];
  let index = 0;

  for (const group of Array.isArray(memoryDiscoveries?.groups) ? memoryDiscoveries.groups : []) {
    if (group?.space !== 'rom') continue;

    const romSpans = mergeInclusiveRomSpans(group.spans || [], prgSize);
    if (!romSpans.length) continue;

    index++;
    const romOffsets = cleanNumberArray(group.memberAddrs || []);
    records.push({
      id: groupRecordId(group, index),
      kind: group.kind || 'romDataObserved',
      source: 'vsaMemoryDiscoveries',
      confidence: 'observed',
      countsAsData: true,
      romSpans,
      romOffsets,
      anchors: [],
      evidence: {
        groupId: group.id || null,
        memberAddressKeys: cleanStringArray(group.memberAddressKeys || []),
        touchingFunctionIds: cleanStringArray(group.touchingFunctionIds || []),
        touchingRawBlockIds: cleanStringArray(group.touchingRawBlockIds || []),
        entryFamilies: cleanStringArray(group.entryFamilies || []),
        traceIds: cleanStringArray(group.traceIds || []),
        pointerPairKeys: cleanStringArray(group.pointerPairKeys || []),
        hardwareTargets: cleanNumberArray(group.hardwareTargets || []),
        evidenceSummary: group.evidenceSummary || null
      },
      stats: {
        spanCount: romSpans.length,
        countedDataByteCount: uniqueCountedBytesForInclusiveRomSpans(romSpans, prgSize)
      }
    });
  }

  return records;
}
