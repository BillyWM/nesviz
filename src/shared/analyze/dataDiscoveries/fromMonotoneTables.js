import { normalizeInclusiveRomSpan, uniqueCountedBytesForInclusiveRomSpans } from './romDataSpans.js';

const STRONG_SUPPORT_KINDS = new Set(['exactPair', 'setBackedPair', 'pathWitness']);

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

function cleanNestedNumberArrays(values) {
  return (Array.isArray(values) ? values : [])
    .map((arr) => cleanNumberArray(arr))
    .filter((arr) => arr.length);
}

function isStrongVerifiedReader(reader) {
  if (!reader?.verified) return false;
  const supportKind = typeof reader?.supportKind === 'string' ? reader.supportKind : 'structuralOnly';
  return STRONG_SUPPORT_KINDS.has(supportKind);
}

function spanForTable(table, prgSize) {
  const start = Number(table?.romStart);
  const endExclusive = Number(table?.romEnd);
  if (!Number.isFinite(start) || !Number.isFinite(endExclusive)) return null;
  return normalizeInclusiveRomSpan({ start: start | 0, end: (endExclusive | 0) - 1 }, prgSize);
}

function anchorForReader(reader) {
  const rawBlockId = typeof reader?.rawBlockId === 'string' && reader.rawBlockId ? reader.rawBlockId : null;
  if (!rawBlockId) return null;
  const pairLineRomOffs = cleanNumberArray(reader?.pairLineRomOffs || []);
  const start = Number.isFinite(reader?.seedRomOffStart) ? (reader.seedRomOffStart >>> 0) : (pairLineRomOffs[0] ?? null);
  const end = Number.isFinite(reader?.seedRomOffEnd) ? (reader.seedRomOffEnd >>> 0) : (pairLineRomOffs.length ? (pairLineRomOffs[pairLineRomOffs.length - 1] + 1) >>> 0 : null);
  return {
    kind: 'reader',
    rawBlockId,
    romOffSpan: (Number.isFinite(start) && Number.isFinite(end) && end > start) ? { start, end } : null,
    pairLineRomOffs,
    supportKind: typeof reader?.supportKind === 'string' ? reader.supportKind : null,
    verificationKind: typeof reader?.verificationKind === 'string' ? reader.verificationKind : null
  };
}

function readerEvidence(readers) {
  const supportKinds = cleanStringArray(readers.map((reader) => reader.supportKind));
  const verificationKinds = cleanStringArray(readers.map((reader) => reader.verificationKind));
  const readerRawBlockIds = cleanStringArray(readers.map((reader) => reader.rawBlockId));
  const seedObservationIds = cleanStringArray(readers.flatMap((reader) => reader.seedObservationIds || []));
  const verifiedIndexValues = cleanNumberArray(readers.flatMap((reader) => reader.verifiedIndexValues || []));
  const pairLineRomOffs = cleanNumberArray(readers.flatMap((reader) => reader.pairLineRomOffs || []));
  const seedReadRomCandidates = cleanNestedNumberArrays(readers.flatMap((reader) => reader.seedReadRomCandidates || []));
  const localProofKinds = cleanStringArray(readers.map((reader) => reader?.localProof?.kind));
  return {
    supportKinds,
    verificationKinds,
    readerRawBlockIds,
    seedObservationIds,
    verifiedIndexValues,
    pairLineRomOffs,
    seedReadRomCandidates,
    localProofKinds
  };
}

export function buildDataDiscoveryRecordsFromMonotoneTables({ monotoneTables, prgSize = null }) {
  const records = [];
  for (const table of Array.isArray(monotoneTables) ? monotoneTables : []) {
    const strongReaders = (Array.isArray(table?.readers) ? table.readers : []).filter(isStrongVerifiedReader);
    if (!strongReaders.length) continue;

    const span = spanForTable(table, prgSize);
    if (!span) continue;

    const anchors = strongReaders.map(anchorForReader).filter(Boolean);
    const evidence = readerEvidence(strongReaders);
    const promotedToPointerTable = !!table?.promotedToPointerTable;
    const kind = promotedToPointerTable ? 'pointerTable' : 'monotoneTable';
    records.push({
      id: `monotone:${table.id || `${span.start}:${span.end}`}`,
      kind,
      source: 'monotoneTables',
      confidence: 'verified',
      countsAsData: true,
      romSpans: [span],
      romOffsets: [],
      anchors,
      evidence: {
        tableId: table?.id || null,
        entryCount: Number.isFinite(table?.entryCount) ? (table.entryCount | 0) : null,
        promotedToPointerTable,
        pointerInterpretation: table?.pointerInterpretation || null,
        interpretationKinds: cleanStringArray(table?.interpretationKinds || []),
        ...evidence
      },
      stats: {
        spanCount: 1,
        countedDataByteCount: uniqueCountedBytesForInclusiveRomSpans([span], prgSize)
      }
    });
  }
  return records;
}
