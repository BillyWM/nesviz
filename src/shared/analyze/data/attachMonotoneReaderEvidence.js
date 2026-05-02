import { buildDisplayBlockIdentityIndex, getDisplayBlockForRawBlockId, getVsaBlockIds } from '../display/blockIdentity.js';
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

function collectBlockObservations(displayBlock, identityIndex, observationsByBlock) {
  const rawBlockIds = getVsaBlockIds(displayBlock, identityIndex);
  const out = [];
  const seen = new Set();
  for (const rawId of rawBlockIds) {
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
  const displayBlockId = typeof reader?.displayBlockId === 'string' ? reader.displayBlockId : '';
  const pair = normalizePairLineRomOffs(reader).join('-');
  return `${tableId}:${displayBlockId}:${pair}`;
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
    displayBlockId: existing.displayBlockId || incoming.displayBlockId || null,
    readSeeds: mergeArrays(existing.readSeeds, incoming.readSeeds, (seed) => `${seed?.role}:${seed?.lineRomOff}:${seed?.lineIndex}`),
    evidence: { ...(existing.evidence || {}), ...(incoming.evidence || {}) },
    promotes: !!(existing.promotes || incoming.promotes),
    zpBase: Number.isFinite(existing.zpBase) ? existing.zpBase : incoming.zpBase
  };
}


function lineIndexByRomOff(displayBlock, romOff) {
  if (!Number.isFinite(romOff)) return null;
  const target = romOff >>> 0;
  const lines = Array.isArray(displayBlock?.lines) ? displayBlock.lines : [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i]?.romOff >>> 0) === target) return i;
  }
  return null;
}

function normalizeReaderForDisplay(reader, displayBlock) {
  if (!displayBlock) return { ...reader };
  const readSeeds = Array.isArray(reader?.readSeeds)
    ? reader.readSeeds.map((seed) => {
        const lineIndex = lineIndexByRomOff(displayBlock, seed?.lineRomOff);
        return lineIndex == null ? { ...seed } : { ...seed, lineIndex };
      })
    : [];
  const pairLineIndexes = Array.isArray(reader?.pairLineRomOffs)
    ? reader.pairLineRomOffs.map((romOff) => lineIndexByRomOff(displayBlock, romOff))
    : reader?.pairLineIndexes;
  return {
    ...reader,
    displayBlockId: displayBlock.id,
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

function enrichReader({ reader, table, displayBlock, observations }) {
  if (!displayBlock) return { ...reader, displayBlockId: null, ...emptyProofFields() };
  const displayReader = normalizeReaderForDisplay(reader, displayBlock);
  const proof = proveMonotoneReader({ reader: displayReader, table, displayBlock, observations });
  const seedObservations = Array.isArray(proof.seedObservations) ? proof.seedObservations : [];
  const seedInputProvIds = Array.from(new Set(seedObservations.flatMap((obs) => [...(obs?.inputProvIds || []), ...(obs?.addrFlow?.addrProvIds || [])]).map((n) => n >>> 0))).sort((a, b) => a - b);
  const seedOutputProvIds = Array.from(new Set(seedObservations.flatMap((obs) => obs?.outputProvIds || []).map((n) => n >>> 0))).sort((a, b) => a - b);
  const seedUses = Array.from(new Set(seedObservations.flatMap((obs) => obs?.uses || []).filter(Boolean))).sort();
  const seedDefs = Array.from(new Set(seedObservations.flatMap((obs) => obs?.defs || []).filter(Boolean))).sort();
  return {
    ...displayReader,
    displayBlockId: displayBlock.id,
    verified: !!proof.verified,
    supportKind: proof.supportKind || 'structuralOnly',
    verificationKind: proof.verificationKind || null,
    seedObservationIds: proof.seedObservationIds || [],
    seedReadRomCandidates: proof.seedReadRomCandidates || [],
    seedPhysicalReads: proof.seedPhysicalReads || [],
    seedPairVerifiedByVsa: proof.verificationKind === 'globalVsa',
    seedInputProvIds,
    seedOutputProvIds,
    seedUses,
    seedDefs,
    seedAddrProvIds: seedInputProvIds,
    seedValueProvIds: seedOutputProvIds,
    seedIndexValues: proof.seedIndexValues || [],
    seedIndexValueSources: proof.seedIndexValueSources || [],
    verifiedIndexValues: proof.verifiedIndexValues || [],
    unknownIndexAlsoPossible: !!proof.unknownIndexAlsoPossible,
    localProof: proof.localProof || null,
    backwardEvidenceObservationIds: [],
    forwardEvidenceObservationIds: [],
    evidenceObservationIds: proof.seedObservationIds || [],
    backwardProvClosure: [],
    forwardProvClosure: [],
    backwardTokenClosure: [],
    forwardTokenClosure: []
  };
}

export function attachMonotoneReaderEvidence({ displayBlocks, monotoneTables, observationsResult, rawBlockIdAliases = null, rawToDisplayBlockIds = null }) {
  const blocks = Array.isArray(displayBlocks) ? displayBlocks : [];
  const tables = Array.isArray(monotoneTables) ? monotoneTables : [];
  const tableById = new Map(tables.map((table) => [table.id, table]));
  const identityIndex = buildDisplayBlockIdentityIndex({ displayBlocks: blocks, rawBlockIdAliases, rawToDisplayBlockIds });
  const observations = Array.isArray(observationsResult?.observations) ? observationsResult.observations : [];
  const byRawBlock = observationsByRawBlockId(observations);
  const observationsByDisplayBlockId = new Map();
  for (const block of blocks) observationsByDisplayBlockId.set(block.id, collectBlockObservations(block, identityIndex, byRawBlock));

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
      const displayBlock = getDisplayBlockForRawBlockId(reader?.rawBlockId, identityIndex);
      putReader(table.id, { ...reader, displayBlockId: displayBlock?.id || null });
    }
  }

  for (const displayBlock of blocks) {
    const blockObservations = observationsByDisplayBlockId.get(displayBlock.id) || [];
    const discovered = discoverMonotoneReadersFromVsa({ displayBlock, monotoneTables: tables, observations: blockObservations });
    for (const [tableId, readers] of discovered.entries()) {
      for (const reader of readers) putReader(tableId, reader);
    }
  }

  return tables.map((table) => {
    const map = readerMapsByTableId.get(table.id) || new Map();
    const readers = Array.from(map.values()).map((reader) => {
      const displayBlock = typeof reader?.displayBlockId === 'string'
        ? identityIndex.displayBlockById.get(reader.displayBlockId)
        : getDisplayBlockForRawBlockId(reader?.rawBlockId, identityIndex);
      const blockObservations = displayBlock ? (observationsByDisplayBlockId.get(displayBlock.id) || []) : [];
      return enrichReader({ reader, table, displayBlock, observations: blockObservations });
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
