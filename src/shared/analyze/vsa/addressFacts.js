import { addToSet } from '../../utils/collectionMapUtils.js';
import { addMany } from '../../utils/collectionUtils.js';
import { normalizeAddr } from '../../utils/addressUtils.js';
import { normalizePhysicalRom } from '../../utils/romIdentityUtils.js';

function makeFact(space, addr) {
  const normalizedAddr = normalizeAddr(space, addr);
  return {
    key: `${space}:${normalizedAddr}`,
    space,
    addr: normalizedAddr,
    readObservationIds: new Set(),
    possibleReadObservationIds: new Set(),
    writeObservationIds: new Set(),
    compareObservationIds: new Set(),
    possibleCompareObservationIds: new Set(),
    readRawBlockIds: new Set(),
    possibleReadRawBlockIds: new Set(),
    writeRawBlockIds: new Set(),
    readByFunctionIds: new Set(),
    possibleReadByFunctionIds: new Set(),
    writtenByFunctionIds: new Set(),
    readInFamilies: new Set(),
    possibleReadInFamilies: new Set(),
    writtenInFamilies: new Set(),
    traceIds: new Set(),
    possibleTraceIds: new Set(),
    flowsTo2007: false,
    possibleFlowsTo2007: false,
    flowsTo4014: false,
    possibleFlowsTo4014: false,
    flowsToIoAddrs: new Set(),
    possibleFlowsToIoAddrs: new Set(),
    usedAsPointerByte: false,
    pointerPairKeys: new Set(),
    relatedObservationIds: new Set(),
    possibleRelatedObservationIds: new Set(),
    relatedTraceNodeIds: new Set(),
    possibleRelatedTraceNodeIds: new Set(),
    touchingRawBlockIds: new Set(),
    possibleTouchingRawBlockIds: new Set(),
    touchingFunctionIds: new Set(),
    possibleTouchingFunctionIds: new Set(),
    streamFootprintIds: new Set(),
    possibleStreamFootprintIds: new Set()
  };
}

function getOrCreateFact(factsByKey, space, addr) {
  const normalizedAddr = normalizeAddr(space, addr);
  const key = `${space}:${normalizedAddr}`;
  let fact = factsByKey.get(key);
  if (!fact) {
    fact = makeFact(space, addr);
    factsByKey.set(key, fact);
  }
  return fact;
}

function mergeContextIntoFact(fact, observation, direction, possible = false) {
  const obsId = String(observation.id);
  (possible ? fact.possibleRelatedObservationIds : fact.relatedObservationIds).add(obsId);
  if (typeof observation.rawBlockId === 'string') {
    (possible ? fact.possibleTouchingRawBlockIds : fact.touchingRawBlockIds).add(observation.rawBlockId);
    if (direction === 'read') (possible ? fact.possibleReadRawBlockIds : fact.readRawBlockIds).add(observation.rawBlockId);
    if (direction === 'write') fact.writeRawBlockIds.add(observation.rawBlockId);
  }
  for (const family of observation.entryFamilies || []) {
    if (direction === 'read') (possible ? fact.possibleReadInFamilies : fact.readInFamilies).add(family);
    if (direction === 'write') fact.writtenInFamilies.add(family);
  }
  for (const functionId of observation.functionIds || []) {
    (possible ? fact.possibleTouchingFunctionIds : fact.touchingFunctionIds).add(functionId);
    if (direction === 'read') (possible ? fact.possibleReadByFunctionIds : fact.readByFunctionIds).add(functionId);
    if (direction === 'write') fact.writtenByFunctionIds.add(functionId);
  }
}

function normalizeTraceMap(dataflowMap) {
  if (!dataflowMap) return [];
  if (Array.isArray(dataflowMap)) return dataflowMap;
  return Object.values(dataflowMap);
}

function toPlainFact(fact) {
  const allReadObservationIds = Array.from(new Set([...fact.readObservationIds, ...fact.possibleReadObservationIds])).sort();
  const allCompareObservationIds = Array.from(new Set([...fact.compareObservationIds, ...fact.possibleCompareObservationIds])).sort();
  const allReadBlockIds = Array.from(new Set([...fact.readRawBlockIds, ...fact.possibleReadRawBlockIds])).sort();
  const allReadByFunctionIds = Array.from(new Set([...fact.readByFunctionIds, ...fact.possibleReadByFunctionIds])).sort();
  const allReadInFamilies = Array.from(new Set([...fact.readInFamilies, ...fact.possibleReadInFamilies])).sort();
  const allTraceIds = Array.from(new Set([...fact.traceIds, ...fact.possibleTraceIds])).sort();
  const allFlowsToIoAddrs = Array.from(new Set([...fact.flowsToIoAddrs, ...fact.possibleFlowsToIoAddrs])).sort((a, b) => a - b);
  const allRelatedObservationIds = Array.from(new Set([...fact.relatedObservationIds, ...fact.possibleRelatedObservationIds])).sort();
  const allRelatedTraceNodeIds = Array.from(new Set([...fact.relatedTraceNodeIds, ...fact.possibleRelatedTraceNodeIds])).sort();
  const allTouchingRawBlockIds = Array.from(new Set([...fact.touchingRawBlockIds, ...fact.possibleTouchingRawBlockIds])).sort();
  const allTouchingFunctionIds = Array.from(new Set([...fact.touchingFunctionIds, ...fact.possibleTouchingFunctionIds])).sort();
  return {
    key: fact.key,
    space: fact.space,
    addr: fact.addr,
    readObservationIds: Array.from(fact.readObservationIds).sort(),
    possibleReadObservationIds: Array.from(fact.possibleReadObservationIds).sort(),
    writeObservationIds: Array.from(fact.writeObservationIds).sort(),
    compareObservationIds: Array.from(fact.compareObservationIds).sort(),
    possibleCompareObservationIds: Array.from(fact.possibleCompareObservationIds).sort(),
    readRawBlockIds: Array.from(fact.readRawBlockIds).sort(),
    possibleReadRawBlockIds: Array.from(fact.possibleReadRawBlockIds).sort(),
    writeRawBlockIds: Array.from(fact.writeRawBlockIds).sort(),
    readByFunctionIds: Array.from(fact.readByFunctionIds).sort(),
    possibleReadByFunctionIds: Array.from(fact.possibleReadByFunctionIds).sort(),
    writtenByFunctionIds: Array.from(fact.writtenByFunctionIds).sort(),
    readInFamilies: Array.from(fact.readInFamilies).sort(),
    possibleReadInFamilies: Array.from(fact.possibleReadInFamilies).sort(),
    writtenInFamilies: Array.from(fact.writtenInFamilies).sort(),
    allReadObservationIds,
    allCompareObservationIds,
    allReadBlockIds,
    allReadByFunctionIds,
    allReadInFamilies,
    traceIds: Array.from(fact.traceIds).sort(),
    possibleTraceIds: Array.from(fact.possibleTraceIds).sort(),
    allTraceIds,
    flowsTo2007: !!fact.flowsTo2007,
    possibleFlowsTo2007: !!fact.possibleFlowsTo2007,
    flowsTo4014: !!fact.flowsTo4014,
    possibleFlowsTo4014: !!fact.possibleFlowsTo4014,
    flowsToIoAddrs: Array.from(fact.flowsToIoAddrs).sort((a, b) => a - b),
    possibleFlowsToIoAddrs: Array.from(fact.possibleFlowsToIoAddrs).sort((a, b) => a - b),
    allFlowsToIoAddrs,
    usedAsPointerByte: !!fact.usedAsPointerByte,
    pointerPairKeys: Array.from(fact.pointerPairKeys).sort(),
    relatedObservationIds: Array.from(fact.relatedObservationIds).sort(),
    possibleRelatedObservationIds: Array.from(fact.possibleRelatedObservationIds).sort(),
    allRelatedObservationIds,
    relatedTraceNodeIds: Array.from(fact.relatedTraceNodeIds).sort(),
    possibleRelatedTraceNodeIds: Array.from(fact.possibleRelatedTraceNodeIds).sort(),
    allRelatedTraceNodeIds,
    touchingRawBlockIds: Array.from(fact.touchingRawBlockIds).sort(),
    possibleTouchingRawBlockIds: Array.from(fact.possibleTouchingRawBlockIds).sort(),
    allTouchingRawBlockIds,
    touchingFunctionIds: Array.from(fact.touchingFunctionIds).sort(),
    possibleTouchingFunctionIds: Array.from(fact.possibleTouchingFunctionIds).sort(),
    allTouchingFunctionIds,
    streamFootprintIds: Array.from(fact.streamFootprintIds).sort(),
    possibleStreamFootprintIds: Array.from(fact.possibleStreamFootprintIds).sort()
  };
}

export function buildAddressFacts({ observationsResult, vsaDataflow, streamFootprints = null }) {
  const observations = Array.isArray(observationsResult?.observations) ? observationsResult.observations : [];
  const factsByKey = new Map();

  for (const observation of observations) {
    if (observation.kind === 'read8' && observation.src && (observation.src.space === 'zp' || observation.src.space === 'ram' || observation.src.space === 'prgram')) {
      const fact = getOrCreateFact(factsByKey, observation.src.space, observation.src.addr);
      fact.readObservationIds.add(String(observation.id));
      mergeContextIntoFact(fact, observation, 'read');
    }

    if (observation.kind === 'read8' && observation.src?.space === 'rom') {
      const physicalRom = normalizePhysicalRom(observation.src?.physicalRom || (typeof observation.src?.romOff === 'number' ? { kind: 'exact', romOffsets: [observation.src.romOff >>> 0] } : null));
      if (physicalRom.kind === 'exact') {
        const fact = getOrCreateFact(factsByKey, 'rom', physicalRom.romOffsets[0] >>> 0);
        fact.readObservationIds.add(String(observation.id));
        mergeContextIntoFact(fact, observation, 'read', false);
      } else if (physicalRom.kind === 'set') {
        for (const romOff of physicalRom.romOffsets || []) {
          const fact = getOrCreateFact(factsByKey, 'rom', romOff >>> 0);
          fact.possibleReadObservationIds.add(String(observation.id));
          mergeContextIntoFact(fact, observation, 'read', true);
        }
      }
    }


    if (observation.kind === 'cmp8' && observation.rhs?.kind === 'mem' && observation.rhs?.src && (observation.rhs.src.space === 'zp' || observation.rhs.src.space === 'ram' || observation.rhs.src.space === 'prgram')) {
      const fact = getOrCreateFact(factsByKey, observation.rhs.src.space, observation.rhs.src.addr);
      fact.compareObservationIds.add(String(observation.id));
      mergeContextIntoFact(fact, observation, 'read');
    }

    if (observation.kind === 'cmp8' && observation.rhs?.kind === 'mem' && observation.rhs?.src?.space === 'rom') {
      const physicalRom = normalizePhysicalRom(observation.rhs.src?.physicalRom || (typeof observation.rhs.src?.romOff === 'number' ? { kind: 'exact', romOffsets: [observation.rhs.src.romOff >>> 0] } : null));
      if (physicalRom.kind === 'exact') {
        const fact = getOrCreateFact(factsByKey, 'rom', physicalRom.romOffsets[0] >>> 0);
        fact.compareObservationIds.add(String(observation.id));
        mergeContextIntoFact(fact, observation, 'read', false);
      } else if (physicalRom.kind === 'set') {
        for (const romOff of physicalRom.romOffsets || []) {
          const fact = getOrCreateFact(factsByKey, 'rom', romOff >>> 0);
          fact.possibleCompareObservationIds.add(String(observation.id));
          mergeContextIntoFact(fact, observation, 'read', true);
        }
      }
    }

    if (observation.kind === 'store8' && observation.dst && (observation.dst.space === 'zp' || observation.dst.space === 'ram' || observation.dst.space === 'prgram')) {
      const fact = getOrCreateFact(factsByKey, observation.dst.space, observation.dst.addr);
      fact.writeObservationIds.add(String(observation.id));
      mergeContextIntoFact(fact, observation, 'write');
    }

    if (observation.kind === 'zpPtr16') {
      const loFact = getOrCreateFact(factsByKey, 'zp', observation.zpAddr & 0xff);
      const hiFact = getOrCreateFact(factsByKey, 'zp', (observation.zpAddr + 1) & 0xff);
      const pairKey = `zp:${observation.zpAddr & 0xff}+${(observation.zpAddr + 1) & 0xff}`;
      loFact.usedAsPointerByte = true;
      hiFact.usedAsPointerByte = true;
      loFact.pointerPairKeys.add(pairKey);
      hiFact.pointerPairKeys.add(pairKey);
      loFact.relatedObservationIds.add(String(observation.id));
      hiFact.relatedObservationIds.add(String(observation.id));
      mergeContextIntoFact(loFact, observation, null);
      mergeContextIntoFact(hiFact, observation, null);
    }
  }


  const footprints = Array.isArray(streamFootprints?.footprints) ? streamFootprints.footprints : [];
  for (const footprint of footprints) {
    if (footprint?.space !== 'rom') continue;
    const definite = Array.isArray(footprint.memberRomOffsets) ? footprint.memberRomOffsets : [];
    const possible = Array.isArray(footprint.possibleRomOffsets) ? footprint.possibleRomOffsets : [];
    for (const romOff of definite) {
      const fact = getOrCreateFact(factsByKey, 'rom', romOff >>> 0);
      fact.streamFootprintIds.add(String(footprint.id));
      addMany(fact.touchingRawBlockIds, footprint.touchingRawBlockIds || []);
      addMany(fact.touchingFunctionIds, footprint.touchingFunctionIds || []);
      addMany(fact.readInFamilies, footprint.entryFamilies || []);
    }
    for (const romOff of possible) {
      const fact = getOrCreateFact(factsByKey, 'rom', romOff >>> 0);
      if (definite.includes(romOff >>> 0)) continue;
      fact.possibleStreamFootprintIds.add(String(footprint.id));
      addMany(fact.possibleTouchingRawBlockIds, footprint.touchingRawBlockIds || []);
      addMany(fact.possibleTouchingFunctionIds, footprint.touchingFunctionIds || []);
      addMany(fact.possibleReadInFamilies, footprint.entryFamilies || []);
    }
    const range = footprint.boundingRange;
    if (!possible.length && range && Number.isFinite(range.start) && Number.isFinite(range.end) && (range.end - range.start) <= 64) {
      for (let off = range.start >>> 0; off <= (range.end >>> 0); off++) {
        const fact = getOrCreateFact(factsByKey, 'rom', off >>> 0);
        if (definite.includes(off >>> 0)) continue;
        fact.possibleStreamFootprintIds.add(String(footprint.id));
        addMany(fact.possibleTouchingRawBlockIds, footprint.touchingRawBlockIds || []);
        addMany(fact.possibleTouchingFunctionIds, footprint.touchingFunctionIds || []);
        addMany(fact.possibleReadInFamilies, footprint.entryFamilies || []);
      }
    }
  }

  const addressParticipation = normalizeTraceMap(vsaDataflow?.addressParticipationByKey);
  for (const item of addressParticipation) {
    if (!item || !(item.space === 'zp' || item.space === 'ram' || item.space === 'prgram' || item.space === 'rom')) continue;
    const fact = getOrCreateFact(factsByKey, item.space, item.addr);
    addMany(fact.traceIds, item.traceIds || []);
    addMany(fact.possibleTraceIds, item.possibleTraceIds || []);
    addMany(fact.relatedObservationIds, (item.observationIds || []).map(String));
    addMany(fact.possibleRelatedObservationIds, (item.possibleObservationIds || []).map(String));
    addMany(fact.relatedTraceNodeIds, (item.traceNodeIds || []).map(String));
    addMany(fact.possibleRelatedTraceNodeIds, (item.possibleTraceNodeIds || []).map(String));
    addMany(fact.touchingRawBlockIds, item.rawBlockIds || []);
    addMany(fact.possibleTouchingRawBlockIds, item.possibleRawBlockIds || []);
    addMany(fact.touchingFunctionIds, item.functionIds || []);
    addMany(fact.possibleTouchingFunctionIds, item.possibleFunctionIds || []);
    addMany(fact.readInFamilies, item.entryFamilies || []);
    addMany(fact.possibleReadInFamilies, item.possibleEntryFamilies || []);
    for (const ioAddr of item.hardwareTargets || []) {
      fact.flowsToIoAddrs.add(ioAddr & 0xffff);
      if ((ioAddr & 0xffff) === 0x2007) fact.flowsTo2007 = true;
      if ((ioAddr & 0xffff) === 0x4014) fact.flowsTo4014 = true;
    }
    for (const ioAddr of item.possibleHardwareTargets || []) {
      fact.possibleFlowsToIoAddrs.add(ioAddr & 0xffff);
      if ((ioAddr & 0xffff) === 0x2007) fact.possibleFlowsTo2007 = true;
      if ((ioAddr & 0xffff) === 0x4014) fact.possibleFlowsTo4014 = true;
    }
  }

  const out = {};
  for (const [key, fact] of factsByKey.entries()) out[key] = toPlainFact(fact);
  return {
    version: 1,
    addressFactsByKey: out,
    stats: {
      addressCount: Object.keys(out).length,
      nmiTouchedCount: Object.values(out).filter((fact) => fact.readInFamilies.includes('nmi') || fact.writtenInFamilies.includes('nmi')).length,
      ppuFlowCount: Object.values(out).filter((fact) => fact.flowsTo2007).length,
      oamFlowCount: Object.values(out).filter((fact) => fact.flowsTo4014).length,
      romAddressCount: Object.values(out).filter((fact) => fact.space === 'rom').length
    }
  };
}
