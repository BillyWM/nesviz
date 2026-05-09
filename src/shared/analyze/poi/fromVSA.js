import { buildDisplayBlockIdentityIndex, getDisplayBlockForRawBlockId } from '../display/blockIdentity.js';

function uniqStrings(values) {
  return Array.from(new Set((values || []).filter((value) => typeof value === 'string' && value))).sort();
}

function uniqNumbers(values) {
  return Array.from(new Set((values || [])
    .map((value) => (typeof value === 'number' ? value : Number(value)))
    .filter((value) => Number.isFinite(value))
    .map((value) => value >>> 0))).sort((a, b) => a - b);
}

function bestEvidenceRank(q) {
  if (q === 'exact') return 3;
  if (q === 'bounded') return 2;
  if (q === 'partial') return 1;
  return 0;
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

function addFootprintToAggregate(agg, fp) {
  agg.tableCount += 1;
  agg.families.add(fp.addressFamily || 'unknown');
  if (fp.terminationKind) agg.terminationKinds.add(fp.terminationKind);
  if (fp.kind) agg.footprintKinds.add(fp.kind);
  if (fp.id) agg.footprintIds.push(fp.id);
  if (fp.terminationKind === 'sentinel1' || fp.terminationKind === 'sentinel2') agg.hasSentinel = true;
  if (bestEvidenceRank(fp.evidenceQuality) > bestEvidenceRank(agg.bestEvidenceQuality)) agg.bestEvidenceQuality = fp.evidenceQuality || 'partial';
  const memberCount = Array.isArray(fp.memberRomOffsets) ? fp.memberRomOffsets.length : 0;
  const possibleCount = Array.isArray(fp.possibleRomOffsets) ? fp.possibleRomOffsets.length : 0;
  agg.memberCount += memberCount;
  agg.possibleCount += possibleCount;
}

function collectDataTablePois({ identityIndex, footprints, pointsOfInterest, pillsByBlockId }) {
  const grouped = new Map();

  for (const fp of footprints) {
    if (!isDataTableFootprint(fp)) continue;
    const rawAnchorId = chooseAnchorRawBlockId(fp);
    if (!rawAnchorId) continue;
    const displayBlock = getDisplayBlockForRawBlockId(rawAnchorId, identityIndex);
    if (!displayBlock) continue;
    const displayBlockId = displayBlock.id;

    let agg = grouped.get(displayBlockId);
    if (!agg) {
      agg = {
        displayBlock,
        tableCount: 0,
        families: new Set(),
        terminationKinds: new Set(),
        footprintKinds: new Set(),
        footprintIds: [],
        hasSentinel: false,
        bestEvidenceQuality: 'weak',
        memberCount: 0,
        possibleCount: 0
      };
      grouped.set(displayBlockId, agg);
    }
    addFootprintToAggregate(agg, fp);
  }

  const aggs = Array.from(grouped.values()).sort((a, b) => {
    const aRom = typeof a.displayBlock?.romStart === 'number' ? a.displayBlock.romStart : Number.MAX_SAFE_INTEGER;
    const bRom = typeof b.displayBlock?.romStart === 'number' ? b.displayBlock.romStart : Number.MAX_SAFE_INTEGER;
    return aRom - bRom;
  });

  for (const agg of aggs) {
    const displayBlockId = typeof agg.displayBlock?.id === 'string' ? agg.displayBlock.id : null;
    const firstLine = Array.isArray(agg.displayBlock?.lines) ? agg.displayBlock.lines.find((line) => Number.isFinite(line?.romOff)) : null;
    if (!displayBlockId || !firstLine) continue;
    const spanStart = firstLine.romOff >>> 0;
    const spanEnd = Number.isFinite(agg.displayBlock?.romEnd) ? (agg.displayBlock.romEnd >>> 0) : (spanStart + 1);
    const poi = {
      id: `dataTables:${spanStart}:${spanEnd}`,
      kind: 'dataTables',
      label: 'Data table reads',
      pill: 'Data table reads',
      basis: { romOffSpan: { start: spanStart, end: Math.max(spanStart + 1, spanEnd) } },
      meta: {
        tableCount: agg.tableCount,
        families: uniqStrings(Array.from(agg.families)),
        terminationKinds: uniqStrings(Array.from(agg.terminationKinds)),
        footprintKinds: uniqStrings(Array.from(agg.footprintKinds)),
        footprintIds: [...agg.footprintIds],
        hasSentinel: !!agg.hasSentinel,
        bestEvidenceQuality: agg.bestEvidenceQuality,
        memberCount: agg.memberCount,
        possibleCount: agg.possibleCount
      }
    };
    pointsOfInterest.push(poi);
    pillsByBlockId[displayBlockId] = pillsByBlockId[displayBlockId] || [];
    if (!pillsByBlockId[displayBlockId].includes(poi.pill)) pillsByBlockId[displayBlockId].push(poi.pill);
  }
}

function labelForPpuDataWrite(write) {
  if (write?.ppuDest?.class === 'palettes') return 'Writes Palettes';
  if (write?.ppuDest?.class === 'attributes') return 'Writes Attributes';
  return null;
}

function kindForPpuDataWrite(write) {
  if (write?.ppuDest?.class === 'palettes') return 'writesPalettes';
  if (write?.ppuDest?.class === 'attributes') return 'writesAttributes';
  return null;
}

function collectPpuDataWritePois({ identityIndex, ppuDataWrites, pointsOfInterest, pillsByBlockId }) {
  const pillKeys = new Set();
  const sortedWrites = Array.from(ppuDataWrites || []).sort((a, b) => {
    const aRom = typeof a?.atRomOff === 'number' ? a.atRomOff : Number.MAX_SAFE_INTEGER;
    const bRom = typeof b?.atRomOff === 'number' ? b.atRomOff : Number.MAX_SAFE_INTEGER;
    if (aRom !== bRom) return aRom - bRom;
    return String(a?.observationId || '').localeCompare(String(b?.observationId || ''));
  });

  for (const write of sortedWrites) {
    const label = labelForPpuDataWrite(write);
    const kind = kindForPpuDataWrite(write);
    if (!label || !kind) continue;

    const rawBlockId = typeof write?.rawBlockId === 'string' ? write.rawBlockId : null;
    if (!rawBlockId) continue;
    const displayBlock = getDisplayBlockForRawBlockId(rawBlockId, identityIndex);
    if (!displayBlock) continue;
    const displayBlockId = typeof displayBlock?.id === 'string' ? displayBlock.id : null;
    if (!displayBlockId) continue;

    const basisSpan = write?.basis?.romOffSpan && Number.isFinite(write.basis.romOffSpan.start) && Number.isFinite(write.basis.romOffSpan.end)
      ? { start: write.basis.romOffSpan.start >>> 0, end: write.basis.romOffSpan.end >>> 0 }
      : (typeof write?.atRomOff === 'number' ? { start: write.atRomOff >>> 0, end: (write.atRomOff >>> 0) + 1 } : null);
    if (!basisSpan || basisSpan.end <= basisSpan.start) continue;

    const poi = {
      id: `${kind}:${basisSpan.start}:${basisSpan.end}:${String(write?.observationId || '')}`,
      kind,
      label,
      pill: label,
      basis: { romOffSpan: basisSpan },
      meta: {
        observationId: typeof write?.observationId === 'string' ? write.observationId : null,
        rawBlockId,
        ppuDestClass: write.ppuDest.class,
        ppuDestCandidates: uniqNumbers(write.ppuDest.candidates || []),
        ppuDestNormalizedCandidates: uniqNumbers(write.ppuDest.normalizedCandidates || []),
        target: '$2007'
      }
    };
    pointsOfInterest.push(poi);

    const pillKey = `${displayBlockId}:${label}`;
    if (!pillKeys.has(pillKey)) {
      pillsByBlockId[displayBlockId] = pillsByBlockId[displayBlockId] || [];
      if (!pillsByBlockId[displayBlockId].includes(label)) pillsByBlockId[displayBlockId].push(label);
      pillKeys.add(pillKey);
    }
  }
}

function collectOamDmaPois({ identityIndex, transfers, pointsOfInterest, pillsByBlockId }) {
  const pillsAdded = new Set();
  const sortedTransfers = Array.from(transfers || []).sort((a, b) => {
    const aRom = typeof a?.atRomOff === 'number' ? a.atRomOff : Number.MAX_SAFE_INTEGER;
    const bRom = typeof b?.atRomOff === 'number' ? b.atRomOff : Number.MAX_SAFE_INTEGER;
    if (aRom !== bRom) return aRom - bRom;
    const aCpu = typeof a?.cpuAddr === 'number' ? a.cpuAddr : Number.MAX_SAFE_INTEGER;
    const bCpu = typeof b?.cpuAddr === 'number' ? b.cpuAddr : Number.MAX_SAFE_INTEGER;
    if (aCpu !== bCpu) return aCpu - bCpu;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });

  for (const transfer of sortedTransfers) {
    const rawAnchorId = typeof transfer?.rawBlockId === 'string' ? transfer.rawBlockId : null;
    if (!rawAnchorId) continue;
    const displayBlock = getDisplayBlockForRawBlockId(rawAnchorId, identityIndex);
    if (!displayBlock) continue;

    const displayBlockId = typeof displayBlock?.id === 'string' ? displayBlock.id : null;
    if (!displayBlockId) continue;

    const transferSpan = transfer?.basis?.romOffSpan && Number.isFinite(transfer.basis.romOffSpan.start) && Number.isFinite(transfer.basis.romOffSpan.end)
      ? { start: transfer.basis.romOffSpan.start >>> 0, end: transfer.basis.romOffSpan.end >>> 0 }
      : (typeof transfer?.atRomOff === 'number' ? { start: transfer.atRomOff >>> 0, end: (transfer.atRomOff >>> 0) + 1 } : null);
    if (!transferSpan || transferSpan.end <= transferSpan.start) continue;

    const poi = {
      id: typeof transfer?.id === 'string' && transfer.id
        ? transfer.id
        : `oamDma:${transferSpan.start}:${transferSpan.end}:${String(transfer?.observationId || '')}`,
      kind: 'oamDma',
      label: 'triggers OAM DMA',
      pill: 'triggers OAM DMA',
      basis: { romOffSpan: transferSpan },
      meta: {
        observationId: typeof transfer?.observationId === 'string' ? transfer.observationId : null,
        pageEvidenceKind: transfer?.pageEvidenceKind || 'unknown',
        pageByte: typeof transfer?.pageByte === 'number' ? (transfer.pageByte & 0xff) : null,
        candidatePageBytes: uniqNumbers(Array.isArray(transfer?.candidatePageBytes) ? transfer.candidatePageBytes : []),
        backingKinds: uniqStrings(transfer?.exactSource?.backingKind ? [transfer.exactSource.backingKind] : []),
        exactSourceCount: typeof transfer?.pageByte === 'number' ? 1 : 0,
        exactInternalRamCount: transfer?.exactSource?.qualifiesForMemoryMap ? 1 : 0,
        notes: uniqStrings(Array.isArray(transfer?.notes) ? transfer.notes : []),
        exactSource: transfer?.exactSource ? { ...transfer.exactSource } : null
      }
    };
    pointsOfInterest.push(poi);

    if (!pillsAdded.has(displayBlockId)) {
      pillsByBlockId[displayBlockId] = pillsByBlockId[displayBlockId] || [];
      if (!pillsByBlockId[displayBlockId].includes(poi.pill)) pillsByBlockId[displayBlockId].push(poi.pill);
      pillsAdded.add(displayBlockId);
    }
  }
}

export function collectPointsOfInterestFromVsa(analysis) {
  const blocks = Array.isArray(analysis?.blocks) ? analysis.blocks : [];
  const identityIndex = buildDisplayBlockIdentityIndex({ displayBlocks: blocks, rawBlockIdAliases: analysis?.rawBlockIdAliases || null, rawToDisplayBlockIds: analysis?.rawToDisplayBlockIds || null });
  const footprints = Array.isArray(analysis?.memoryDiscoveries?.streamFootprints) ? analysis.memoryDiscoveries.streamFootprints : [];
  const oamDmaTransfers = Array.isArray(analysis?.memoryDiscoveries?.oamDmaTransfers) ? analysis.memoryDiscoveries.oamDmaTransfers : [];
  const ppuDataWrites = Array.isArray(analysis?.vsaDataflow?.ppuDataWrites) ? analysis.vsaDataflow.ppuDataWrites : [];
  const pointsOfInterest = [];
  const pillsByBlockId = {};

  collectDataTablePois({ identityIndex, footprints, pointsOfInterest, pillsByBlockId });
  collectOamDmaPois({ identityIndex, transfers: oamDmaTransfers, pointsOfInterest, pillsByBlockId });
  collectPpuDataWritePois({ identityIndex, ppuDataWrites, pointsOfInterest, pillsByBlockId });

  return { pointsOfInterest, pillsByBlockId };
}
