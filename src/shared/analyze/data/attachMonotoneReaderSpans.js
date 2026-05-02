import { buildDisplayBlockIdentityIndex, getDisplayBlockForRawBlockId, getVsaBlockIds } from '../display/blockIdentity.js';
import { buildMonotoneReadFactKey } from '../semanticFacts/synthesizeMonotoneReadFacts.js';
import { buildMonotoneReaderSlice } from './buildMonotoneReaderSlice.js';

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

function observationId(obs, rawId = 'na') {
  if (typeof obs?.id === 'string' || typeof obs?.id === 'number') return String(obs.id);
  return `${rawId}:${obs?.kind ?? 'obs'}:${obs?.atRomOff ?? 'na'}`;
}

function collectDisplayBlockObservations(displayBlock, identityIndex, byRawBlock) {
  const rawBlockIds = getVsaBlockIds(displayBlock, identityIndex);
  const out = [];
  const seen = new Set();
  for (const rawId of rawBlockIds) {
    for (const obs of byRawBlock.get(rawId) || []) {
      const key = observationId(obs, rawId);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(obs);
    }
  }
  out.sort((a, b) => (a.atRomOff >>> 0) - (b.atRomOff >>> 0));
  return out;
}

function buildMonotoneReadFactIndex(semanticFacts) {
  const out = new Map();
  for (const fact of semanticFacts || []) {
    if (fact?.kind !== 'monotoneRead' || typeof fact?.id !== 'string') continue;
    out.set(fact.id, fact);
  }
  return out;
}

function monotoneReadFactIdForReader(reader, table) {
  return buildMonotoneReadFactKey({
    tableId: table?.id || null,
    rawReaderBlockId: reader?.rawBlockId || null,
    pairLineRomOffs: reader?.pairLineRomOffs || []
  });
}

function monotoneReadFactForReader(reader, table, factIndex) {
  const id = monotoneReadFactIdForReader(reader, table);
  return factIndex.get(id) || { id };
}

export function attachMonotoneReaderSpans({ displayBlocks, monotoneTables, observationsResult, rawBlockIdAliases = null, rawToDisplayBlockIds = null, semanticFacts = [] }) {
  const identityIndex = buildDisplayBlockIdentityIndex({ displayBlocks: displayBlocks || [], rawBlockIdAliases, rawToDisplayBlockIds });
  const observations = Array.isArray(observationsResult?.observations) ? observationsResult.observations : [];
  const byRawBlock = observationsByRawBlockId(observations);
  const factIndex = buildMonotoneReadFactIndex(semanticFacts);

  return Array.isArray(monotoneTables)
    ? monotoneTables.map((table) => ({
        ...table,
        readers: Array.isArray(table?.readers)
          ? table.readers.map((reader) => {
              const block = (typeof reader?.displayBlockId === 'string' && reader.displayBlockId)
                ? identityIndex.displayBlockById.get(reader.displayBlockId)
                : getDisplayBlockForRawBlockId(reader?.rawBlockId, identityIndex);
              if (!block) return { ...reader };
              const fact = monotoneReadFactForReader(reader, table, factIndex);
              const blockObservations = collectDisplayBlockObservations(block, identityIndex, byRawBlock);
              const slice = buildMonotoneReaderSlice({ reader, displayBlock: block, observations: blockObservations });
              return slice
                ? { ...reader, displayBlockId: block.id, semanticFactId: fact?.id || null, ...slice }
                : { ...reader, displayBlockId: block.id, semanticFactId: fact?.id || null };
            })
          : []
      }))
    : [];
}
