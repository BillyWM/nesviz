import { normalizePhysicalRom } from '../../utils/romIdentityUtils.js';
import { cellDepsAt, cellValuesAt, replayLocalPath } from '../localProof/index.js';

function observationId(obs, rawId = 'na') {
  if (typeof obs?.id === 'string' || typeof obs?.id === 'number') return String(obs.id);
  return `${rawId}:${obs?.kind ?? 'obs'}:${obs?.atRomOff ?? 'na'}`;
}

function candidateSetsPairUniversally(lowOffsets, highOffsets) {
  if (!lowOffsets?.length || !highOffsets?.length) return false;
  const highSet = new Set(highOffsets.map((off) => off >>> 0));
  const lowSet = new Set(lowOffsets.map((off) => off >>> 0));
  for (const lowRom of lowSet) if (!highSet.has((lowRom + 1) >>> 0)) return false;
  for (const highRom of highSet) if (!lowSet.has((highRom - 1) >>> 0)) return false;
  return true;
}

function tableBounds(table) {
  return {
    start: Number.isFinite(table?.romStart) ? (table.romStart >>> 0) : 0,
    end: Number.isFinite(table?.romEnd) ? (table.romEnd >>> 0) : 0
  };
}

function observationCandidatesAtRomOff(observations, romOff, table) {
  const target = romOff >>> 0;
  const { start, end } = tableBounds(table);
  const candidates = [];
  for (const obs of observations || []) {
    if (obs?.kind !== 'read8') continue;
    if ((obs.atRomOff >>> 0) !== target) continue;
    if (obs?.src?.space !== 'rom') continue;
    const physical = normalizePhysicalRom(obs?.src?.physicalRom || obs?.addrFlow?.physicalRom || (typeof obs?.src?.romOff === 'number' ? { kind: 'exact', romOffsets: [obs.src.romOff >>> 0] } : null), { nullIfUnknown: true, setForMultiple: true });
    if (!physical?.romOffsets?.length) continue;
    const inside = physical.romOffsets.filter((off) => off >= start && off < end);
    candidates.push({
      observation: obs,
      physicalRom: physical,
      allInsideTable: inside.length === physical.romOffsets.length,
      indexValues: Array.isArray(obs?.addrFlow?.indexValues) ? obs.addrFlow.indexValues.map((v) => v & 0xff) : [],
      indexValueSource: typeof obs?.addrFlow?.indexValueSource === 'string' ? obs.addrFlow.indexValueSource : null
    });
  }
  return candidates;
}

function tryGlobalVsaSupport({ reader, table, observations }) {
  const pairLineRomOffs = Array.isArray(reader?.pairLineRomOffs)
    ? reader.pairLineRomOffs.filter((off) => Number.isFinite(off)).map((off) => off >>> 0)
    : [];
  if (pairLineRomOffs.length < 2) return null;
  const lowCandidates = observationCandidatesAtRomOff(observations, pairLineRomOffs[0], table);
  const highCandidates = observationCandidatesAtRomOff(observations, pairLineRomOffs[1], table);

  let best = null;
  for (const low of lowCandidates) {
    if (!low.allInsideTable) continue;
    for (const high of highCandidates) {
      if (!high.allInsideTable) continue;
      if (!candidateSetsPairUniversally(low.physicalRom.romOffsets, high.physicalRom.romOffsets)) continue;
      const supportKind = (low.physicalRom.kind === 'exact' && high.physicalRom.kind === 'exact') ? 'exactPair' : 'setBackedPair';
      const candidate = {
        verified: true,
        supportKind,
        verificationKind: 'globalVsa',
        seedObservations: [low.observation, high.observation],
        seedObservationIds: [low.observation, high.observation].map((obs) => observationId(obs)),
        seedReadRomCandidates: [low.physicalRom.romOffsets, high.physicalRom.romOffsets],
        seedPhysicalReads: [low.physicalRom, high.physicalRom],
        seedIndexValues: [low.indexValues, high.indexValues],
        seedIndexValueSources: [low.indexValueSource, high.indexValueSource]
      };
      if (!best || (best.supportKind !== 'exactPair' && candidate.supportKind === 'exactPair')) best = candidate;
    }
  }
  return best;
}

function tableIndexInside(table, index) {
  return Number.isFinite(index) && index >= 0 && index < ((table.romEnd >>> 0) - (table.romStart >>> 0));
}

function readSeedLineIndex(seed) {
  return Number.isFinite(seed?.lineIndex) ? (seed.lineIndex | 0) : null;
}

function analyzeLocalIndexFlow({ reader, table, displayBlock }) {
  const seeds = Array.isArray(reader?.readSeeds) ? reader.readSeeds : [];
  const lowSeed = seeds.find((seed) => seed?.role === 'low') || seeds[0];
  const highSeed = seeds.find((seed) => seed?.role === 'high') || seeds[1];
  const lowLineIndex = readSeedLineIndex(lowSeed);
  const highLineIndex = readSeedLineIndex(highSeed);
  if (lowLineIndex == null || highLineIndex == null) return null;
  if (!Number.isFinite(lowSeed?.tableByteIndex) || !Number.isFinite(highSeed?.tableByteIndex)) return null;
  if (lowSeed.indexKind !== highSeed.indexKind) return null;

  const end = Math.max(lowLineIndex, highLineIndex);
  const replay = replayLocalPath({ block: displayBlock, startLineIndex: 0, endLineIndex: end });
  const indexKind = lowSeed.indexKind || 'none';

  const depLineIndexes = new Set();
  if (indexKind !== 'none') {
    for (const idx of cellDepsAt(replay, lowLineIndex, indexKind)) depLineIndexes.add(idx | 0);
    for (const idx of cellDepsAt(replay, highLineIndex, indexKind)) depLineIndexes.add(idx | 0);
  }
  const sortedDeps = Array.from(depLineIndexes).filter((idx) => idx < end).sort((a, b) => a - b);
  const lines = Array.isArray(displayBlock?.lines) ? displayBlock.lines : [];
  const witnessLineIndexes = Array.from(new Set([...sortedDeps, lowLineIndex, highLineIndex])).sort((a, b) => a - b);

  const lowIndexValues = indexKind === 'none' ? [0] : cellValuesAt(replay, lowLineIndex, indexKind);
  const highIndexValues = indexKind === 'none' ? [0] : cellValuesAt(replay, highLineIndex, indexKind);
  const verifiedIndexValues = [];
  if (lowIndexValues?.length && highIndexValues?.length) {
    const highSet = new Set(highIndexValues.map((value) => value & 0xff));
    for (const idx of lowIndexValues) {
      const index = idx & 0xff;
      if (!highSet.has(index)) continue;
      const lowByteIndex = (lowSeed.tableByteIndex | 0) + index;
      const highByteIndex = (highSeed.tableByteIndex | 0) + index;
      if (highByteIndex !== lowByteIndex + 1) continue;
      if (!tableIndexInside(table, lowByteIndex) || !tableIndexInside(table, highByteIndex)) continue;
      verifiedIndexValues.push(index);
    }
  }

  const uniqueVerifiedIndexValues = Array.from(new Set(verifiedIndexValues)).sort((a, b) => a - b);
  return {
    verified: uniqueVerifiedIndexValues.length > 0,
    indexKind,
    verifiedIndexValues: uniqueVerifiedIndexValues,
    inputLineIndexes: sortedDeps,
    witnessLineIndexes,
    witnessLineRomOffs: witnessLineIndexes
      .map((idx) => lines[idx]?.romOff)
      .filter((romOff) => Number.isFinite(romOff))
      .map((romOff) => romOff >>> 0),
    seedReadRomCandidates: uniqueVerifiedIndexValues.length
      ? [
          uniqueVerifiedIndexValues.map((idx) => (table.romStart + (lowSeed.tableByteIndex | 0) + idx) >>> 0),
          uniqueVerifiedIndexValues.map((idx) => (table.romStart + (highSeed.tableByteIndex | 0) + idx) >>> 0)
        ]
      : []
  };
}

function localProofPayload(local) {
  if (!local) return null;
  return {
    kind: 'monotoneReadPair',
    indexKind: local.indexKind,
    valueProofVerified: !!local.verified,
    inputLineIndexes: local.inputLineIndexes || [],
    witnessLineIndexes: local.witnessLineIndexes || [],
    witnessLineRomOffs: local.witnessLineRomOffs || []
  };
}

function firstNonEmptyIndexValues(seedIndexValues) {
  for (const values of seedIndexValues || []) {
    if (Array.isArray(values) && values.length) return Array.from(new Set(values.map((v) => v & 0xff))).sort((a, b) => a - b);
  }
  return [];
}

export function proveMonotoneReader({ reader, table, displayBlock, observations }) {
  const global = tryGlobalVsaSupport({ reader, table, observations });
  const local = analyzeLocalIndexFlow({ reader, table, displayBlock });
  if (global) {
    const globalIndexValues = firstNonEmptyIndexValues(global.seedIndexValues);
    return {
      ...global,
      verifiedIndexValues: globalIndexValues.length ? globalIndexValues : (local?.verified ? (local.verifiedIndexValues || []) : []),
      unknownIndexAlsoPossible: false,
      localProof: localProofPayload(local)
    };
  }
  if (local?.verified) {
    return {
      verified: true,
      supportKind: 'pathWitness',
      verificationKind: 'localProof',
      seedObservations: [],
      seedObservationIds: [],
      seedReadRomCandidates: local.seedReadRomCandidates || [],
      seedPhysicalReads: [],
      seedIndexValues: [local.verifiedIndexValues, local.verifiedIndexValues],
      seedIndexValueSources: ['localProof', 'localProof'],
      verifiedIndexValues: local.verifiedIndexValues || [],
      unknownIndexAlsoPossible: true,
      localProof: localProofPayload(local)
    };
  }
  return {
    verified: false,
    supportKind: 'structuralOnly',
    verificationKind: null,
    seedObservations: [],
    seedObservationIds: [],
    seedReadRomCandidates: [],
    seedPhysicalReads: [],
    seedIndexValues: [],
    seedIndexValueSources: []
  };
}
