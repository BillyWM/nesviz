import { UNKNOWN_FETCH_CTX_KEY, siteKeyFor } from '../fetchContext.js';

function addToSetMap(map, key, values) {
  if (key == null) return;
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  if (values instanceof Set) {
    for (const value of values) set.add(value);
    return;
  }
  if (Array.isArray(values)) {
    for (const value of values) set.add(value);
    return;
  }
  set.add(values);
}

function valuesFromBlockStarts(block) {
  const out = new Set();
  if (Array.isArray(block?.instances)) {
    for (const instance of block.instances) {
      if (typeof instance?.siteKey === 'string' && instance.siteKey) {
        out.add(String(instance.siteKey));
        continue;
      }
      if (typeof instance?.cpuStart === 'number') {
        const ctxKey = (typeof instance?.fetchCtxKey === 'string' && instance.fetchCtxKey)
          ? instance.fetchCtxKey
          : (typeof instance?.ctxId === 'string' && instance.ctxId ? instance.ctxId : UNKNOWN_FETCH_CTX_KEY);
        out.add(siteKeyFor(ctxKey, instance.cpuStart & 0xffff));
      }
    }
  }
  if (typeof block?.lines?.[0]?.siteKey === 'string' && block.lines[0].siteKey) {
    out.add(String(block.lines[0].siteKey));
  } else if (typeof block?.lines?.[0]?.cpuAddr === 'number') {
    const ctxKey = (typeof block?.ctxKey === 'string' && block.ctxKey) ? block.ctxKey : UNKNOWN_FETCH_CTX_KEY;
    out.add(siteKeyFor(ctxKey, block.lines[0].cpuAddr & 0xffff));
  }
  return out;
}

function propagateSets({ roots, succs, blockIds }) {
  const out = new Map();
  const work = [];
  for (const [blockId, values] of roots.entries()) {
    if (!values || !values.size) continue;
    out.set(blockId, new Set(values));
    work.push(blockId);
  }

  while (work.length) {
    const blockId = work.pop();
    const cur = out.get(blockId);
    const nextIds = succs.get(blockId) || [];
    for (const nextId of nextIds) {
      if (!blockIds.has(nextId)) continue;
      let target = out.get(nextId);
      let changed = false;
      if (!target) {
        target = new Set();
        out.set(nextId, target);
      }
      for (const value of cur) {
        if (target.has(value)) continue;
        target.add(value);
        changed = true;
      }
      if (changed) work.push(nextId);
    }
  }

  return out;
}

function toSortedObjectArray(map) {
  const out = {};
  for (const [key, set] of map.entries()) {
    out[key] = Array.from(set).sort();
  }
  return out;
}

export function buildBlockContextIndex({
  blocks,
  edges,
  vectorCpuAddrsByFamily = null,
  vectorSeedItemsByFamily = null
}) {
  const blockIds = new Set((blocks || []).map((block) => block.id));
  const blockCpuStartsById = new Map();
  for (const block of blocks || []) blockCpuStartsById.set(block.id, valuesFromBlockStarts(block));

  const allSuccs = new Map();
  const functionSuccs = new Map();
  const callTargetIds = new Set();
  for (const edge of edges || []) {
    if (!edge?.from || !edge?.to || !blockIds.has(edge.to)) continue;
    addToSetMap(allSuccs, edge.from, edge.to);
    if (edge.kind === 'call') {
      callTargetIds.add(edge.to);
      continue;
    }
    addToSetMap(functionSuccs, edge.from, edge.to);
  }

  const familyRoots = new Map();
  const families = [
    ['reset', vectorSeedItemsByFamily?.reset || null, vectorCpuAddrsByFamily?.reset || []],
    ['nmi', vectorSeedItemsByFamily?.nmi || null, vectorCpuAddrsByFamily?.nmi || []],
    ['irq', vectorSeedItemsByFamily?.irq || null, vectorCpuAddrsByFamily?.irq || []]
  ];
  for (const [family, seedItems, cpuAddrs] of families) {
    const wantedSiteKeys = new Set((seedItems || [])
      .filter((x) => typeof x?.cpuAddr === 'number')
      .map((x) => {
        const ctxKey = typeof x?.fetchCtxKey === 'string' && x.fetchCtxKey
          ? x.fetchCtxKey
          : (typeof x?.fetchCtx?.key === 'string' && x.fetchCtx.key ? x.fetchCtx.key : null);
        if (!ctxKey) return null;
        return siteKeyFor(ctxKey, x.cpuAddr & 0xffff);
      })
      .filter(Boolean));
    if (!wantedSiteKeys.size && !(cpuAddrs || []).length) continue;
    for (const block of blocks || []) {
      const starts = blockCpuStartsById.get(block.id) || new Set();
      for (const start of starts) {
        if (typeof start === 'string' && wantedSiteKeys.has(start)) {
          addToSetMap(familyRoots, block.id, family);
          break;
        }
      }
    }
  }

  const blockFamiliesById = propagateSets({ roots: familyRoots, succs: allSuccs, blockIds });
  for (const block of blocks || []) {
    if (blockFamiliesById.has(block.id)) continue;
    blockFamiliesById.set(block.id, new Set(['mainOrUnknown']));
  }

  const functionRoots = new Map();
  for (const [blockId] of familyRoots.entries()) addToSetMap(functionRoots, blockId, `function:${blockId}`);
  for (const blockId of callTargetIds) addToSetMap(functionRoots, blockId, `function:${blockId}`);

  let blockFunctionIdsById = propagateSets({ roots: functionRoots, succs: functionSuccs, blockIds });
  for (const block of blocks || []) {
    if (blockFunctionIdsById.has(block.id)) continue;
    blockFunctionIdsById.set(block.id, new Set([`function:${block.id}`]));
  }

  return {
    blockFamiliesById,
    blockFunctionIdsById,
    blockFamiliesByIdObject: toSortedObjectArray(blockFamiliesById),
    blockFunctionIdsByIdObject: toSortedObjectArray(blockFunctionIdsById)
  };
}
