import { buildDisplayBlockIdentityIndex } from '../display/blockIdentity.js';

function spanForReader(displayBlock, reader) {
  if (reader?.readRegionSpan && Number.isFinite(reader.readRegionSpan.start) && Number.isFinite(reader.readRegionSpan.end)) {
    const start = reader.readRegionSpan.start >>> 0;
    const end = reader.readRegionSpan.end >>> 0;
    if (end > start) return { start, end };
  }

  const offsets = Array.isArray(reader?.involvedLineRomOffs) && reader.involvedLineRomOffs.length
    ? reader.involvedLineRomOffs
    : (Array.isArray(reader?.pairLineRomOffs) ? reader.pairLineRomOffs : []);
  const finite = offsets.filter((off) => Number.isFinite(off)).map((off) => off >>> 0).sort((a, b) => a - b);
  if (finite.length) {
    return { start: finite[0], end: finite[finite.length - 1] + 1 };
  }

  const firstLine = Array.isArray(displayBlock?.lines) ? displayBlock.lines.find((line) => Number.isFinite(line?.romOff)) : null;
  if (!firstLine) return null;
  const start = firstLine.romOff >>> 0;
  const end = Number.isFinite(firstLine.len) && firstLine.len > 0 ? start + (firstLine.len >>> 0) : start + 1;
  return { start, end };
}

export function collectPointsOfInterestFromMonotoneTables(analysis) {
  const blocks = Array.isArray(analysis?.blocks) ? analysis.blocks : [];
  const identityIndex = buildDisplayBlockIdentityIndex({ displayBlocks: blocks, rawBlockIdAliases: analysis?.rawBlockIdAliases ?? null, rawToDisplayBlockIds: analysis?.rawToDisplayBlockIds ?? null });
  const tables = Array.isArray(analysis?.monotoneTables) ? analysis.monotoneTables : [];
  const pointsOfInterest = [];
  const pillsByBlockId = {};

  for (const table of tables) {
    for (const reader of table?.readers || []) {
      if (!reader?.verified) continue;
      const supportKind = typeof reader?.supportKind === 'string' ? reader.supportKind : 'structuralOnly';
      if (!(supportKind === 'exactPair' || supportKind === 'setBackedPair' || supportKind === 'pathWitness')) continue;
      const rawBlockId = typeof reader?.rawBlockId === 'string' ? reader.rawBlockId : null;
      if (!rawBlockId) continue;
      const displayBlockId = typeof reader?.displayBlockId === 'string' && reader.displayBlockId ? reader.displayBlockId : null;
      if (!displayBlockId) continue;
      const displayBlock = identityIndex.displayBlockById.get(displayBlockId);
      if (!displayBlock) continue;

      const span = spanForReader(displayBlock, reader);
      if (!span) continue;

      const promoted = !!table.promotedToPointerTable && !!reader.promotes;
      const kind = promoted ? 'pointerTables' : 'monotoneTables';
      const pill = promoted ? 'reads pointer table' : 'Monotone table reads';
      const seedId = `${span.start.toString(16)}-${span.end.toString(16)}`;

      pointsOfInterest.push({
        id: `${kind}:${table.id}:${seedId}`,
        kind,
        label: pill,
        pill,
        basis: { romOffSpan: span },
        meta: {
          tableId: table.id,
          tableRomStart: table.romStart,
          tableRomEnd: table.romEnd,
          entryCount: table.entryCount,
          promotedToPointerTable: !!table.promotedToPointerTable,
          interpretation: table.pointerInterpretation || null,
          rawReaderBlockId: rawBlockId,
          pairLineRomOffs: Array.isArray(reader?.pairLineRomOffs) ? reader.pairLineRomOffs : [],
          semanticFactId: typeof reader?.semanticFactId === 'string' ? reader.semanticFactId : null,
          seedObservationIds: Array.isArray(reader?.seedObservationIds) ? reader.seedObservationIds : [],
          supportKind: typeof reader?.supportKind === 'string' ? reader.supportKind : null,
          verificationKind: typeof reader?.verificationKind === 'string' ? reader.verificationKind : null,
          verifiedIndexValues: Array.isArray(reader?.verifiedIndexValues) ? reader.verifiedIndexValues : [],
          unknownIndexAlsoPossible: !!reader?.unknownIndexAlsoPossible,
          inputLineRomOffs: Array.isArray(reader?.inputLineRomOffs) ? reader.inputLineRomOffs : [],
          seedLineRomOffs: Array.isArray(reader?.seedLineRomOffs) ? reader.seedLineRomOffs : [],
          outputLineRomOffs: Array.isArray(reader?.outputLineRomOffs) ? reader.outputLineRomOffs : [],
          involvedLineRomOffs: Array.isArray(reader?.involvedLineRomOffs) ? reader.involvedLineRomOffs : [],
          spanStart: span.start,
          spanEnd: span.end
        }
      });

      pillsByBlockId[displayBlockId] = pillsByBlockId[displayBlockId] || [];
      if (!pillsByBlockId[displayBlockId].includes(pill)) pillsByBlockId[displayBlockId].push(pill);
    }
  }

  return { pointsOfInterest, pillsByBlockId };
}
