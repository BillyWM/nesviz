function hasRomPhysicalCandidates(physicalRom) {
  if (!physicalRom || physicalRom.kind === 'unknown') return false;
  if (Array.isArray(physicalRom.romOffsets) && physicalRom.romOffsets.length) return true;
  if (Array.isArray(physicalRom.candidates) && physicalRom.candidates.length) return true;
  return physicalRom.kind === 'set' || physicalRom.kind === 'exact';
}

function observationReadsRom(obs) {
  return obs?.kind === 'read8'
    && obs?.src?.space === 'rom'
    && hasRomPhysicalCandidates(obs?.src?.physicalRom || obs?.addrFlow?.physicalRom);
}

function observationHasTightRomRead(obs) {
  if (!observationReadsRom(obs)) return false;
  const physical = obs?.src?.physicalRom || obs?.addrFlow?.physicalRom || null;
  if (physical?.kind === 'exact' || physical?.kind === 'set') return true;
  if (Array.isArray(obs?.addrFlow?.indexValues) && obs.addrFlow.indexValues.length) return true;
  if (Array.isArray(obs?.addrFlow?.cpuAddrSet) && obs.addrFlow.cpuAddrSet.length && obs.addrFlow.cpuAddrSet.length <= 16) return true;
  return false;
}

function intersects(a, b) {
  if (!a?.length || !b?.size) return false;
  for (const id of a) {
    if (b.has(String(id))) return true;
  }
  return false;
}

function addProof(map, blockId, kind, detail = null) {
  if (typeof blockId !== 'string' || !blockId) return;
  let list = map.get(blockId);
  if (!list) {
    list = [];
    map.set(blockId, list);
  }
  list.push({ kind, ...(detail || {}) });
}

function strongFootprint(fp) {
  if (fp?.space !== 'rom') return false;
  if (fp?.evidenceQuality === 'weak') return false;
  if (Array.isArray(fp?.memberRomOffsets) && fp.memberRomOffsets.length) return true;
  if (fp?.boundingRange && typeof fp.boundingRange.start === 'number' && typeof fp.boundingRange.end === 'number') return true;
  if (Array.isArray(fp?.sentinelBytes) && fp.sentinelBytes.length) return true;
  return false;
}

export function buildCandidateDataflowProofs({ candidateIds = new Set(), observationsResult = null, memoryDiscoveries = null } = {}) {
  const observations = (observationsResult?.observations || observationsResult?.facts || [])
    .filter((obs) => obs?.vsaRole === 'candidate' && candidateIds.has(obs.rawBlockId));
  const proofsByBlockId = new Map();
  const romReadProvIds = new Set();
  const romReadProvSources = new Map();
  const pointerProvIds = new Set();
  const pointerProvSources = new Map();
  const candidateBlocksWithRomReads = new Set();

  for (const obs of observations) {
    if (!observationReadsRom(obs)) continue;
    candidateBlocksWithRomReads.add(obs.rawBlockId);
    addProof(proofsByBlockId, obs.rawBlockId, observationHasTightRomRead(obs) ? 'tightRomRead' : 'romRead', { observationId: obs.id || null });
    for (const id of obs.outputProvIds || []) {
      const key = String(id);
      romReadProvIds.add(key);
      romReadProvSources.set(key, { blockId: obs.rawBlockId, observationId: obs.id || null });
    }
  }

  for (const obs of observations) {
    if (obs?.kind === 'store8' && intersects(obs.inputProvIds || [], romReadProvIds)) {
      addProof(proofsByBlockId, obs.rawBlockId, 'romReadMeaningfulUse', { observationId: obs.id || null, use: 'store8' });
      for (const id of obs.inputProvIds || []) {
        const src = romReadProvSources.get(String(id));
        if (src) addProof(proofsByBlockId, src.blockId, 'romReadMeaningfulUse', { observationId: src.observationId, useObservationId: obs.id || null, use: 'store8' });
      }
    }

    if (obs?.kind === 'zpPtr16' && intersects(obs.inputProvIds || [], romReadProvIds)) {
      addProof(proofsByBlockId, obs.rawBlockId, 'romReadToPointer', { observationId: obs.id || null, zpAddr: obs.zpAddr ?? null });
      for (const id of obs.outputProvIds || []) {
        const key = String(id);
        pointerProvIds.add(key);
        pointerProvSources.set(key, { blockId: obs.rawBlockId, observationId: obs.id || null });
      }
      for (const id of obs.inputProvIds || []) {
        const src = romReadProvSources.get(String(id));
        if (src) addProof(proofsByBlockId, src.blockId, 'romReadToPointer', { observationId: src.observationId, pointerObservationId: obs.id || null, zpAddr: obs.zpAddr ?? null });
      }
    }
  }

  for (const obs of observations) {
    const isIndirectRead = obs?.kind === 'read8' && typeof obs?.addrFlow?.ptrZp === 'number';
    if (!isIndirectRead || !intersects(obs.inputProvIds || [], pointerProvIds)) continue;
    addProof(proofsByBlockId, obs.rawBlockId, 'pointerToIndirectUse', { observationId: obs.id || null, ptrZp: obs.addrFlow.ptrZp });
    for (const id of obs.inputProvIds || []) {
      const src = pointerProvSources.get(String(id));
      if (src) addProof(proofsByBlockId, src.blockId, 'romReadPointerIndirectUse', { observationId: src.observationId, indirectReadObservationId: obs.id || null, ptrZp: obs.addrFlow.ptrZp });
    }
  }

  for (const fp of memoryDiscoveries?.streamFootprints || []) {
    if (!strongFootprint(fp)) continue;
    for (const rawBlockId of fp?.touchingRawBlockIds || []) {
      if (!candidateIds.has(rawBlockId) || !candidateBlocksWithRomReads.has(rawBlockId)) continue;
      addProof(proofsByBlockId, rawBlockId, 'strongStreamReader', { footprintId: fp.id || null, evidenceQuality: fp.evidenceQuality || null });
    }
  }

  return { proofsByBlockId };
}
