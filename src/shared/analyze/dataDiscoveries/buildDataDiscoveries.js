import { buildDataDiscoveryRecordsFromVsaMemoryDiscoveries } from './fromVsaMemoryDiscoveries.js';
import { buildDataDiscoveryRecordsFromStreamFootprints } from './fromStreamFootprints.js';
import { buildDataDiscoveryRecordsFromMonotoneTables } from './fromMonotoneTables.js';
import { mergeInclusiveRomSpans, uniqueCountedBytesForInclusiveRomSpans } from './romDataSpans.js';

function incrementCounter(counter, key) {
  const name = (typeof key === 'string' && key.length) ? key : 'unknown';
  counter[name] = (counter[name] || 0) + 1;
}

function countedRecordSpans(records) {
  const spans = [];
  for (const record of records || []) {
    if (!record?.countsAsData) continue;
    for (const span of record.romSpans || []) spans.push(span);
  }
  return spans;
}

export function buildDataDiscoveries({ memoryDiscoveries, monotoneTables = null, prgSize = null }) {
  const records = [
    ...buildDataDiscoveryRecordsFromVsaMemoryDiscoveries({ memoryDiscoveries, prgSize }),
    ...buildDataDiscoveryRecordsFromStreamFootprints({ memoryDiscoveries, prgSize }),
    ...buildDataDiscoveryRecordsFromMonotoneTables({ monotoneTables, prgSize })
  ];

  const countsByKind = {};
  const countsBySource = {};
  let countedDataSpanCount = 0;
  for (const record of records) {
    incrementCounter(countsByKind, record.kind);
    incrementCounter(countsBySource, record.source);
    if (record.countsAsData) countedDataSpanCount += Array.isArray(record.romSpans) ? record.romSpans.length : 0;
  }

  const countedSpans = countedRecordSpans(records);
  const countedMergedSpans = mergeInclusiveRomSpans(countedSpans, prgSize);

  return {
    version: 1,
    records,
    stats: {
      recordCount: records.length,
      countsByKind,
      countsBySource,
      countedDataSpanCount,
      uniqueCountedDataSpanCount: countedMergedSpans.length,
      countedDataByteCount: uniqueCountedBytesForInclusiveRomSpans(countedSpans, prgSize)
    }
  };
}
