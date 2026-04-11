function familyPresence(readInFamilies, writtenInFamilies, family, possibleReadInFamilies = [], possibleWrittenInFamilies = []) {
  const read = Array.isArray(readInFamilies) && readInFamilies.includes(family);
  const write = Array.isArray(writtenInFamilies) && writtenInFamilies.includes(family);
  if (read || write) return 'observed';
  const maybeRead = Array.isArray(possibleReadInFamilies) && possibleReadInFamilies.includes(family);
  const maybeWrite = Array.isArray(possibleWrittenInFamilies) && possibleWrittenInFamilies.includes(family);
  if (maybeRead || maybeWrite) return 'possible';
  return 'unknown';
}

function predicateLevel(enabled, possible = false) {
  if (enabled) return 'observed';
  if (possible) return 'possible';
  return 'unknown';
}

export function deriveAddressPredicates({ addressFacts }) {
  const factsByKey = addressFacts?.addressFactsByKey || {};
  const out = {};

  for (const [key, fact] of Object.entries(factsByKey)) {
    const readInMain = fact.readInFamilies.includes('reset') || fact.readInFamilies.includes('mainOrUnknown') || fact.readInFamilies.includes('irq');
    const writeInMain = fact.writtenInFamilies.includes('reset') || fact.writtenInFamilies.includes('mainOrUnknown') || fact.writtenInFamilies.includes('irq');
    const possibleReadInMain = (fact.possibleReadInFamilies || []).includes('reset') || (fact.possibleReadInFamilies || []).includes('mainOrUnknown') || (fact.possibleReadInFamilies || []).includes('irq');
    const readInNmi = fact.readInFamilies.includes('nmi');
    const possibleReadInNmi = (fact.possibleReadInFamilies || []).includes('nmi');
    const writtenInNmi = fact.writtenInFamilies.includes('nmi');
    const isRom = fact.space === 'rom';
    const mainToNmiHandoff = (!isRom && writeInMain && readInNmi)
      ? 'observed'
      : ((!isRom && ((writeInMain && possibleReadInNmi) || (readInNmi && possibleReadInMain))) ? 'possible' : 'unknown');
    const sharedCount = new Set([...(fact.touchingFunctionIds || []), ...(fact.possibleTouchingFunctionIds || [])]).size;
    const hasRomRead = (fact.readObservationIds?.length || 0) > 0 || (fact.compareObservationIds?.length || 0) > 0;
    const hasPossibleRomRead = (fact.possibleReadObservationIds?.length || 0) > 0 || (fact.possibleCompareObservationIds?.length || 0) > 0;

    out[key] = {
      nmiAssociated: predicateLevel(readInNmi || writtenInNmi, possibleReadInNmi),
      readInNmi: familyPresence(fact.readInFamilies, [], 'nmi', fact.possibleReadInFamilies || [], []),
      writtenInNmi: familyPresence([], fact.writtenInFamilies, 'nmi', [], []),
      readInMainOrUnknown: predicateLevel(readInMain, possibleReadInMain),
      writtenInMainOrUnknown: predicateLevel(writeInMain),
      mainToNmiHandoff,
      ppuFlowAssociated: predicateLevel(!!fact.flowsTo2007, !!fact.possibleFlowsTo2007),
      oamFlowAssociated: predicateLevel(!!fact.flowsTo4014, !!fact.possibleFlowsTo4014),
      sharedByMultipleFunctions: predicateLevel((fact.touchingFunctionIds?.length || 0) >= 2, sharedCount >= 2),
      usedAsPointer: predicateLevel(!isRom && (!!fact.usedAsPointerByte || (fact.pointerPairKeys?.length || 0) > 0)),
      romDataObserved: predicateLevel(isRom && hasRomRead, isRom && hasPossibleRomRead),
      romStreamAssociated: predicateLevel(isRom && ((fact.streamFootprintIds?.length || 0) > 0), isRom && ((fact.possibleStreamFootprintIds?.length || 0) > 0))
    };
  }

  return {
    version: 1,
    addressPredicatesByKey: out,
    stats: {
      predicateAddressCount: Object.keys(out).length,
      nmiAssociatedCount: Object.values(out).filter((pred) => pred.nmiAssociated !== 'unknown').length,
      mainToNmiHandoffCount: Object.values(out).filter((pred) => pred.mainToNmiHandoff !== 'unknown').length,
      sharedByMultipleFunctionsCount: Object.values(out).filter((pred) => pred.sharedByMultipleFunctions !== 'unknown').length
    }
  };
}
