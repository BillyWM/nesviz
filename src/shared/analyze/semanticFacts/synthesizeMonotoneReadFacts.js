function normalizePairLineRomOffs(pairLineRomOffs) {
  return Array.isArray(pairLineRomOffs)
    ? pairLineRomOffs
        .filter((off) => Number.isFinite(off))
        .map((off) => off >>> 0)
    : [];
}

export function buildMonotoneReadFactKey({ tableId, rawReaderBlockId, pairLineRomOffs }) {
  const blockId = typeof rawReaderBlockId === 'string' ? rawReaderBlockId : '';
  const pairKey = normalizePairLineRomOffs(pairLineRomOffs).map((off) => off.toString(16).toUpperCase().padStart(6, '0')).join('-');
  return `monotoneRead:${tableId || 'unknown'}:${blockId}:${pairKey}`;
}

function buildMonotoneReadPayload(table, reader) {
  return {
    tableId: table?.id || null,
    tableRomStart: Number.isFinite(table?.romStart) ? (table.romStart >>> 0) : null,
    tableRomEnd: Number.isFinite(table?.romEnd) ? (table.romEnd >>> 0) : null,
    entryCount: Number.isFinite(table?.entryCount) ? (table.entryCount >>> 0) : null,
    rawReaderBlockId: typeof reader?.rawBlockId === 'string' ? reader.rawBlockId : null,
    displayBlockId: typeof reader?.displayBlockId === 'string' ? reader.displayBlockId : null,
    pairLineRomOffs: normalizePairLineRomOffs(reader?.pairLineRomOffs),
    pairLineCpuAddrs: Array.isArray(reader?.pairLineCpuAddrs)
      ? reader.pairLineCpuAddrs.filter((addr) => Number.isFinite(addr)).map((addr) => addr & 0xffff)
      : [],
    indexKind: reader?.evidence?.indexKind || null,
    promotes: !!reader?.promotes,
    zpBase: Number.isFinite(reader?.zpBase) ? (reader.zpBase & 0xff) : null,
    supportKind: typeof reader?.supportKind === 'string' ? reader.supportKind : 'structuralOnly',
    matchedTableByteIndex: Number.isFinite(reader?.evidence?.tableByteIndex) ? (reader.evidence.tableByteIndex | 0) : null,
    seedObservationIds: Array.isArray(reader?.seedObservationIds) ? reader.seedObservationIds.map(String) : [],
    seedInputProvIds: Array.isArray(reader?.seedInputProvIds) ? reader.seedInputProvIds.map((n) => n >>> 0) : [],
    seedOutputProvIds: Array.isArray(reader?.seedOutputProvIds) ? reader.seedOutputProvIds.map((n) => n >>> 0) : [],
    seedUses: Array.isArray(reader?.seedUses) ? reader.seedUses.filter((v) => typeof v === 'string' && v) : [],
    seedDefs: Array.isArray(reader?.seedDefs) ? reader.seedDefs.filter((v) => typeof v === 'string' && v) : [],
    seedAddrProvIds: Array.isArray(reader?.seedAddrProvIds) ? reader.seedAddrProvIds.map((n) => n >>> 0) : [],
    seedValueProvIds: Array.isArray(reader?.seedValueProvIds) ? reader.seedValueProvIds.map((n) => n >>> 0) : [],
    seedReadRomCandidates: Array.isArray(reader?.seedReadRomCandidates)
      ? reader.seedReadRomCandidates.map((arr) => Array.isArray(arr) ? arr.filter((n) => Number.isFinite(n)).map((n) => n >>> 0) : [])
      : [],
    seedPhysicalReads: Array.isArray(reader?.seedPhysicalReads) ? reader.seedPhysicalReads : [],
    seedIndexValues: Array.isArray(reader?.seedIndexValues)
      ? reader.seedIndexValues.map((arr) => Array.isArray(arr) ? arr.filter((n) => Number.isFinite(n)).map((n) => n & 0xff) : [])
      : [],
    seedIndexValueSources: Array.isArray(reader?.seedIndexValueSources)
      ? reader.seedIndexValueSources.map((source) => (typeof source === 'string' ? source : null))
      : [],
    backwardEvidenceObservationIds: Array.isArray(reader?.backwardEvidenceObservationIds) ? reader.backwardEvidenceObservationIds.map(String) : [],
    forwardEvidenceObservationIds: Array.isArray(reader?.forwardEvidenceObservationIds) ? reader.forwardEvidenceObservationIds.map(String) : [],
    evidenceObservationIds: Array.isArray(reader?.evidenceObservationIds) ? reader.evidenceObservationIds.map(String) : [],
    backwardProvClosure: Array.isArray(reader?.backwardProvClosure) ? reader.backwardProvClosure.map((n) => n >>> 0) : [],
    forwardProvClosure: Array.isArray(reader?.forwardProvClosure) ? reader.forwardProvClosure.map((n) => n >>> 0) : [],
    backwardTokenClosure: Array.isArray(reader?.backwardTokenClosure) ? reader.backwardTokenClosure.filter((v) => typeof v === 'string' && v) : [],
    forwardTokenClosure: Array.isArray(reader?.forwardTokenClosure) ? reader.forwardTokenClosure.filter((v) => typeof v === 'string' && v) : [],
    verified: !!reader?.verified,
    verificationKind: typeof reader?.verificationKind === 'string' ? reader.verificationKind : null,
    verifiedIndexValues: Array.isArray(reader?.verifiedIndexValues) ? reader.verifiedIndexValues.filter((n) => Number.isFinite(n)).map((n) => n & 0xff) : [],
    unknownIndexAlsoPossible: !!reader?.unknownIndexAlsoPossible,
    readSeeds: Array.isArray(reader?.readSeeds) ? reader.readSeeds : [],
    inputLineRomOffs: Array.isArray(reader?.inputLineRomOffs) ? reader.inputLineRomOffs.filter((n) => Number.isFinite(n)).map((n) => n >>> 0) : [],
    seedLineRomOffs: Array.isArray(reader?.seedLineRomOffs) ? reader.seedLineRomOffs.filter((n) => Number.isFinite(n)).map((n) => n >>> 0) : [],
    outputLineRomOffs: Array.isArray(reader?.outputLineRomOffs) ? reader.outputLineRomOffs.filter((n) => Number.isFinite(n)).map((n) => n >>> 0) : [],
    involvedLineRomOffs: Array.isArray(reader?.involvedLineRomOffs) ? reader.involvedLineRomOffs.filter((n) => Number.isFinite(n)).map((n) => n >>> 0) : []
  };
}

function monotoneReadCertainty(reader) {
  const supportKind = typeof reader?.supportKind === 'string' ? reader.supportKind : 'structuralOnly';
  if (supportKind === 'exactPair' || supportKind === 'setBackedPair' || supportKind === 'pathWitness') return 'verified';
  return 'recognized';
}

function shouldEmitFactForReader(reader) {
  if (!reader?.verified) return false;
  const supportKind = typeof reader?.supportKind === 'string' ? reader.supportKind : 'structuralOnly';
  return supportKind === 'exactPair' || supportKind === 'setBackedPair' || supportKind === 'pathWitness';
}

export function synthesizeMonotoneReadFacts({ monotoneTables }) {
  const facts = [];
  for (const table of monotoneTables || []) {
    for (const reader of table?.readers || []) {
      if (!shouldEmitFactForReader(reader)) continue;
      const payload = buildMonotoneReadPayload(table, reader);
      const anchorRomOff = payload.pairLineRomOffs.length ? Math.min(...payload.pairLineRomOffs) : null;
      const anchorCpuAddr = payload.pairLineCpuAddrs.length ? payload.pairLineCpuAddrs[0] : null;
      const fact = {
        id: buildMonotoneReadFactKey({
          tableId: payload.tableId,
          rawReaderBlockId: payload.rawReaderBlockId,
          pairLineRomOffs: payload.pairLineRomOffs
        }),
        kind: 'monotoneRead',
        sourcePass: 'synthesizeMonotoneReadFacts',
        certainty: monotoneReadCertainty(reader),
        anchorBlockId: payload.displayBlockId,
        anchorRomOff,
        anchorCpuAddr,
        payload
      };
      facts.push(fact);
    }
  }
  return facts;
}
