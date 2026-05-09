import { discoverMonotoneReadersFromVsa } from './discoverMonotoneReadersFromVsa.js';
import { proveMonotoneReader } from './proveMonotoneReader.js';

function observationId(obs, rawId = 'na') {
  if (typeof obs?.id === 'string' || typeof obs?.id === 'number') return String(obs.id);
  return `${rawId}:${obs?.kind ?? 'obs'}:${obs?.atRomOff ?? 'na'}`;
}

function observationsByRawBlockId(observations) {
  const out = new Map();
  for (const obs of observations || []) {
    if (typeof obs?.rawBlockId !== 'string' || !obs.rawBlockId) continue;
    if (!out.has(obs.rawBlockId)) out.set(obs.rawBlockId, []);
    out.get(obs.rawBlockId).push(obs);
  }
  for (const list of out.values()) list.sort((a, b) => (a.atRomOff >>> 0) - (b.atRomOff >>> 0));
  return out;
}

function rawBlockIdSet(block) {
  const ids = new Set();
  if (typeof block?.id === 'string' && block.id) ids.add(block.id);
  for (const rawId of Array.isArray(block?.rawBlockIds) ? block.rawBlockIds : []) {
    if (typeof rawId === 'string' && rawId) ids.add(rawId);
  }
  return ids;
}

function collectRawBlockObservations(block, observationsByBlock) {
  const out = [];
  const seen = new Set();
  for (const rawId of rawBlockIdSet(block)) {
    for (const obs of observationsByBlock.get(rawId) || []) {
      const key = observationId(obs, rawId);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(obs);
    }
  }
  out.sort((a, b) => (a.atRomOff >>> 0) - (b.atRomOff >>> 0));
  return out;
}

function normalizePairLineRomOffs(reader) {
  return Array.isArray(reader?.pairLineRomOffs)
    ? reader.pairLineRomOffs.filter((off) => Number.isFinite(off)).map((off) => off >>> 0)
    : [];
}

function readerMergeKey(tableId, reader) {
  const rawBlockId = typeof reader?.rawBlockId === 'string' ? reader.rawBlockId : '';
  const pair = normalizePairLineRomOffs(reader).join('-');
  return `${tableId}:${rawBlockId}:${pair}`;
}

function mergeArrays(a, b, keyFn = (value) => JSON.stringify(value)) {
  const out = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function mergeReaders(existing, incoming) {
  if (!existing) return { ...incoming };
  return {
    ...existing,
    ...incoming,
    origin: existing.origin === incoming.origin ? existing.origin : 'merged',
    rawBlockId: existing.rawBlockId || incoming.rawBlockId || null,
    displayBlockId: null,
    readSeeds: mergeArrays(existing.readSeeds, incoming.readSeeds, (seed) => `${seed?.role}:${seed?.lineRomOff}:${seed?.lineIndex}`),
    evidence: { ...(existing.evidence || {}), ...(incoming.evidence || {}) },
    promotes: !!(existing.promotes || incoming.promotes),
    zpBase: Number.isFinite(existing.zpBase) ? existing.zpBase : incoming.zpBase
  };
}

function lineIndexByRomOff(block, romOff) {
  if (!Number.isFinite(romOff)) return null;
  const target = romOff >>> 0;
  const lines = Array.isArray(block?.lines) ? block.lines : [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i]?.romOff >>> 0) === target) return i;
  }
  return null;
}

function normalizeReaderForRawBlock(reader, block) {
  const readSeeds = Array.isArray(reader?.readSeeds)
    ? reader.readSeeds.map((seed) => {
        const lineIndex = lineIndexByRomOff(block, seed?.lineRomOff);
        return lineIndex == null ? { ...seed } : { ...seed, lineIndex };
      })
    : [];
  const pairLineIndexes = Array.isArray(reader?.pairLineRomOffs)
    ? reader.pairLineRomOffs.map((romOff) => lineIndexByRomOff(block, romOff))
    : reader?.pairLineIndexes;
  return {
    ...reader,
    rawBlockId: typeof reader?.rawBlockId === 'string' && reader.rawBlockId ? reader.rawBlockId : block?.id || null,
    displayBlockId: null,
    readSeeds,
    pairLineIndexes
  };
}

function emptyProofFields() {
  return {
    verified: false,
    supportKind: 'structuralOnly',
    verificationKind: null,
    seedObservationIds: [],
    seedReadRomCandidates: [],
    seedPhysicalReads: [],
    seedPairVerifiedByVsa: false,
    seedIndexValues: [],
    seedIndexValueSources: [],
    verifiedIndexValues: [],
    unknownIndexAlsoPossible: false,
    localProof: null
  };
}

function enrichReader({ reader, table, block, observations }) {
  if (!block) return { ...reader, displayBlockId: null, ...emptyProofFields() };
  const rawReader = normalizeReaderForRawBlock(reader, block);
  const proof = proveMonotoneReader({ reader: rawReader, table, displayBlock: block, observations });
  return {
    ...rawReader,
    displayBlockId: null,
    verified: !!proof.verified,
    supportKind: proof.supportKind || 'structuralOnly',
    verificationKind: proof.verificationKind || null,
    seedObservationIds: proof.seedObservationIds || [],
    seedReadRomCandidates: proof.seedReadRomCandidates || [],
    seedPhysicalReads: proof.seedPhysicalReads || [],
    seedPairVerifiedByVsa: proof.verificationKind === 'globalVsa',
    seedIndexValues: proof.seedIndexValues || [],
    seedIndexValueSources: proof.seedIndexValueSources || [],
    verifiedIndexValues: proof.verifiedIndexValues || [],
    unknownIndexAlsoPossible: !!proof.unknownIndexAlsoPossible,
    localProof: proof.localProof || null,
    evidenceObservationIds: proof.seedObservationIds || []
  };
}

export function attachMonotoneReaderEvidenceRaw({ blocks, monotoneTables, observationsResult }) {
  const rawBlocks = Array.isArray(blocks) ? blocks : [];
  const tables = Array.isArray(monotoneTables) ? monotoneTables : [];
  const tableById = new Map(tables.map((table) => [table.id, table]));
  const blockById = new Map();
  for (const block of rawBlocks) {
    for (const rawId of rawBlockIdSet(block)) blockById.set(rawId, block);
  }

  const observations = Array.isArray(observationsResult?.observations) ? observationsResult.observations : [];
  const byRawBlock = observationsByRawBlockId(observations);
  const observationsByBlockId = new Map();
  for (const block of rawBlocks) observationsByBlockId.set(block.id, collectRawBlockObservations(block, byRawBlock));

  const readerMapsByTableId = new Map();
  function putReader(tableId, reader) {
    if (!tableById.has(tableId)) return;
    if (!readerMapsByTableId.has(tableId)) readerMapsByTableId.set(tableId, new Map());
    const map = readerMapsByTableId.get(tableId);
    const key = readerMergeKey(tableId, reader);
    map.set(key, mergeReaders(map.get(key), reader));
  }

  for (const table of tables) {
    for (const reader of table?.readers || []) {
      putReader(table.id, { ...reader, displayBlockId: null });
    }
  }

  for (const block of rawBlocks) {
    const blockObservations = observationsByBlockId.get(block.id) || [];
    const discovered = discoverMonotoneReadersFromVsa({ displayBlock: block, monotoneTables: tables, observations: blockObservations });
    for (const [tableId, readers] of discovered.entries()) {
      for (const reader of readers) putReader(tableId, { ...reader, rawBlockId: reader.rawBlockId || block.id, displayBlockId: null });
    }
  }

  return tables.map((table) => {
    const map = readerMapsByTableId.get(table.id) || new Map();
    const readers = Array.from(map.values()).map((reader) => {
      const block = blockById.get(reader?.rawBlockId) || null;
      const blockObservations = block ? (observationsByBlockId.get(block.id) || []) : [];
      return enrichReader({ reader, table, block, observations: blockObservations });
    });
    readers.sort((a, b) => {
      const ao = normalizePairLineRomOffs(a)[0] ?? 0;
      const bo = normalizePairLineRomOffs(b)[0] ?? 0;
      return ao - bo;
    });
    return {
      ...table,
      readers,
      promotedToPointerTable: readers.some((reader) => !!reader.promotes),
      pointerInterpretation: readers.some((reader) => !!reader.promotes) ? 'location16' : null
    };
  });
}
