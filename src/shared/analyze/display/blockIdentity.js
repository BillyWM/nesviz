function normalizeIdMap(map) {
  return map && typeof map === 'object' ? map : {};
}

function resolveRawBlockId(rawBlockId, rawBlockIdAliases) {
  if (typeof rawBlockId !== 'string' || !rawBlockId) return null;
  let currentRawBlockId = rawBlockId;
  const seenRawBlockIds = new Set();
  while (typeof currentRawBlockId === 'string' && currentRawBlockId && !seenRawBlockIds.has(currentRawBlockId)) {
    seenRawBlockIds.add(currentRawBlockId);
    const nextRawBlockId = rawBlockIdAliases[currentRawBlockId];
    if (typeof nextRawBlockId !== 'string' || !nextRawBlockId || nextRawBlockId === currentRawBlockId) break;
    currentRawBlockId = nextRawBlockId;
  }
  return currentRawBlockId;
}

function rawBlockIdsForDisplayBlock(displayBlock) {
  const rawBlockIds = Array.isArray(displayBlock?.rawBlockIds) ? displayBlock.rawBlockIds : [];
  return Array.from(new Set(rawBlockIds.filter((rawBlockId) => typeof rawBlockId === 'string' && rawBlockId)));
}

export function buildDisplayBlockIdentityIndex({ displayBlocks, rawBlockIdAliases = null, rawToDisplayBlockIds = null } = {}) {
  const rawBlockIdAliasMap = normalizeIdMap(rawBlockIdAliases);
  const rawToDisplayBlockIdMap = normalizeIdMap(rawToDisplayBlockIds);
  const displayBlockById = new Map();
  const rawToDisplayBlockIdByRawBlockId = new Map();
  const displayBlockIds = [];

  for (const displayBlock of displayBlocks || []) {
    if (typeof displayBlock?.id !== 'string' || !displayBlock.id) continue;
    displayBlockById.set(displayBlock.id, displayBlock);
    displayBlockIds.push(displayBlock.id);
    for (const rawBlockId of rawBlockIdsForDisplayBlock(displayBlock)) {
      rawToDisplayBlockIdByRawBlockId.set(rawBlockId, displayBlock.id);
    }
  }

  for (const [rawBlockId, displayBlockId] of Object.entries(rawToDisplayBlockIdMap)) {
    if (typeof rawBlockId !== 'string' || !rawBlockId) continue;
    if (typeof displayBlockId !== 'string' || !displayBlockId) continue;
    if (displayBlockById.has(displayBlockId)) rawToDisplayBlockIdByRawBlockId.set(rawBlockId, displayBlockId);
  }

  for (const rawBlockId of Object.keys(rawBlockIdAliasMap)) {
    const resolvedRawBlockId = resolveRawBlockId(rawBlockId, rawBlockIdAliasMap);
    if (typeof resolvedRawBlockId !== 'string' || !resolvedRawBlockId) continue;
    const displayBlockId = rawToDisplayBlockIdByRawBlockId.get(resolvedRawBlockId);
    if (displayBlockById.has(displayBlockId)) rawToDisplayBlockIdByRawBlockId.set(rawBlockId, displayBlockId);
  }

  return { displayBlockById, rawToDisplayBlockIdByRawBlockId, displayBlockIds };
}

export function getDisplayBlockIdForRawBlockId(rawBlockId, index) {
  if (typeof rawBlockId !== 'string' || !rawBlockId) return null;
  const displayBlockId = index?.rawToDisplayBlockIdByRawBlockId?.get(rawBlockId) || null;
  return index?.displayBlockById?.has(displayBlockId) ? displayBlockId : null;
}

export function getDisplayBlockForRawBlockId(rawBlockId, index) {
  const displayBlockId = getDisplayBlockIdForRawBlockId(rawBlockId, index);
  if (!displayBlockId) return null;
  return index?.displayBlockById?.get(displayBlockId) || null;
}

export function getDisplayBlockById(displayBlockId, index) {
  if (typeof displayBlockId !== 'string' || !displayBlockId) return null;
  return index?.displayBlockById?.get(displayBlockId) || null;
}

export function getDisplayAnchorInfo(displayBlock) {
  const firstLine = Array.isArray(displayBlock?.lines) && displayBlock.lines.length ? displayBlock.lines[0] : null;
  return {
    anchorBlockId: typeof displayBlock?.id === 'string' ? displayBlock.id : null,
    anchorRomOff: typeof firstLine?.romOff === 'number'
      ? (firstLine.romOff >>> 0)
      : (typeof displayBlock?.romStart === 'number' ? (displayBlock.romStart >>> 0) : null),
    anchorCpuAddr: typeof firstLine?.cpuAddr === 'number'
      ? (firstLine.cpuAddr & 0xffff)
      : (typeof displayBlock?.cpuStart === 'number' ? (displayBlock.cpuStart & 0xffff) : null)
  };
}

export function getVsaBlockIds(displayBlock) {
  if (!displayBlock || typeof displayBlock !== 'object') return [];
  return rawBlockIdsForDisplayBlock(displayBlock);
}
