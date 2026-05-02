function confidenceRank(confidence) {
  return confidence === 'certain' ? 2 : confidence === 'probable' ? 1 : 0;
}

function leaderKindRank(leaderKind) {
  return leaderKind === 'hard' ? 2 : leaderKind === 'soft' ? 1 : 0;
}

function leaderReasonRank(reason) {
  const kind = reason?.kind || null;
  if (kind === 'branch_target' || kind === 'jump_target' || kind === 'call_target') return 9;
  if (kind === 'mapper_split') return 8;
  if (kind === 'seed_entry') return 7;
  if (kind === 'fallthrough_seed') return 6;
  if (kind === 'probable_seed') return 2;
  return 0;
}

function bestLeaderReasonRank(block) {
  let best = 0;
  for (const reason of block?.leaderReasons || []) {
    best = Math.max(best, leaderReasonRank(reason));
  }
  return best;
}

function exactSegmentsForBlock(block) {
  const segments = [];
  for (const line of block?.lines || []) {
    if (line?.backing?.kind !== 'exact') continue;
    const romOff = line.backing.romOff | 0;
    const len = line.len | 0;
    if (len <= 0) continue;
    segments.push({ start: romOff, end: romOff + len });
  }
  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    if (prev && seg.start <= prev.end) {
      prev.end = Math.max(prev.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

function segmentLength(segments) {
  return segments.reduce((sum, seg) => sum + Math.max(0, (seg.end | 0) - (seg.start | 0)), 0);
}

function segmentsOverlap(aSegments, bSegments) {
  let i = 0;
  let j = 0;
  while (i < aSegments.length && j < bSegments.length) {
    const a = aSegments[i];
    const b = bSegments[j];
    if (a.end <= b.start) {
      i++;
      continue;
    }
    if (b.end <= a.start) {
      j++;
      continue;
    }
    return true;
  }
  return false;
}

function compareBlocksForWinner(a, b) {
  const confidenceDiff = confidenceRank(a?.confidence) - confidenceRank(b?.confidence);
  if (confidenceDiff) return confidenceDiff;

  const certainHardDiff = ((a?.isCertainHardLeader ? 1 : 0) - (b?.isCertainHardLeader ? 1 : 0));
  if (certainHardDiff) return certainHardDiff;

  const leaderKindDiff = leaderKindRank(a?.leaderKind) - leaderKindRank(b?.leaderKind);
  if (leaderKindDiff) return leaderKindDiff;

  const reasonDiff = bestLeaderReasonRank(a) - bestLeaderReasonRank(b);
  if (reasonDiff) return reasonDiff;

  const aExactLen = Number.isFinite(a?.exactByteLen) ? a.exactByteLen : 0;
  const bExactLen = Number.isFinite(b?.exactByteLen) ? b.exactByteLen : 0;
  if (aExactLen !== bExactLen) return aExactLen - bExactLen;

  const aLineCount = Array.isArray(a?.lines) ? a.lines.length : 0;
  const bLineCount = Array.isArray(b?.lines) ? b.lines.length : 0;
  if (aLineCount !== bLineCount) return aLineCount - bLineCount;

  const aRom = Number.isFinite(a?.exactStart) ? a.exactStart : Number.MAX_SAFE_INTEGER;
  const bRom = Number.isFinite(b?.exactStart) ? b.exactStart : Number.MAX_SAFE_INTEGER;
  if (aRom !== bRom) return bRom - aRom;

  return String(b?.id || '').localeCompare(String(a?.id || ''));
}

function cloneInstance(instance) {
  return instance && typeof instance === 'object' ? { ...instance } : instance;
}

function uniqueSortedStrings(values) {
  return Array.from(new Set((values || []).filter((value) => typeof value === 'string' && value))).sort();
}

function mergeWinnerMetadata(winner, losers) {
  const rawBlockIds = new Set(winner?.rawBlockIds || [winner?.id]);
  const instancesByKey = new Map();

  for (const inst of winner?.instances || []) {
    const key = `${inst?.ctxId || ''}:${typeof inst?.cpuStart === 'number' ? (inst.cpuStart & 0xffff) : '?'}`;
    if (!instancesByKey.has(key)) instancesByKey.set(key, cloneInstance(inst));
  }

  for (const loser of losers || []) {
    for (const rawId of loser?.rawBlockIds || [loser?.id]) {
      if (typeof rawId === 'string' && rawId) rawBlockIds.add(rawId);
    }
    if (typeof loser?.id === 'string' && loser.id) rawBlockIds.add(loser.id);
    for (const inst of loser?.instances || []) {
      const key = `${inst?.ctxId || ''}:${typeof inst?.cpuStart === 'number' ? (inst.cpuStart & 0xffff) : '?'}`;
      if (!instancesByKey.has(key)) instancesByKey.set(key, cloneInstance(inst));
    }
  }

  return {
    ...winner,
    rawBlockIds: uniqueSortedStrings(Array.from(rawBlockIds)),
    instances: Array.from(instancesByKey.values())
  };
}

function remapEdge(edge, rawBlockIdAliases) {
  if (!edge || typeof edge !== 'object') return edge;
  const from = typeof edge.from === 'string' ? (rawBlockIdAliases[edge.from] || edge.from) : edge.from;
  const to = typeof edge.to === 'string' ? (rawBlockIdAliases[edge.to] || edge.to) : edge.to;
  return { ...edge, from, to };
}

function remapKnownBlockIds(value, rawBlockIdAliases, seen = new Map()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (ArrayBuffer.isView(value)) return value;
  if (value instanceof Date) return value;

  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(remapKnownBlockIds(item, rawBlockIdAliases, seen));
    return out;
  }

  const out = {};
  seen.set(value, out);
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' && (key === 'rawBlockId' || key === 'fromRawBlockId' || key === 'toRawBlockId' || key === 'sourceRawBlockId' || key === 'targetRawBlockId' || key === 'rawHeaderBlockId' || key === 'rawTailBlockId' || key === 'sentinelRawBlockId')) {
      out[key] = rawBlockIdAliases[raw] || raw;
      continue;
    }
    if (Array.isArray(raw) && (key === 'touchingRawBlockIds' || key === 'possibleTouchingRawBlockIds' || key === 'allTouchingRawBlockIds' || key === 'rawBlockIds' || key === 'readRawBlockIds' || key === 'possibleReadRawBlockIds' || key === 'writeRawBlockIds')) {
      out[key] = uniqueSortedStrings(raw.map((value) => (typeof value === 'string' ? (rawBlockIdAliases[value] || value) : value)));
      continue;
    }
    out[key] = remapKnownBlockIds(raw, rawBlockIdAliases, seen);
  }
  return out;
}

export function resolveBlockConflicts({ blocks = [], edges = [], unresolvedSites = [], artifacts = [], memoryDiscoveries = null, vsaDataflow = null, vsaFacts = null } = {}) {
  const inputBlocks = Array.isArray(blocks) ? blocks : [];
  const blockMeta = inputBlocks.map((block, index) => {
    const exactSegments = exactSegmentsForBlock(block);
    const exactStart = exactSegments.length ? exactSegments[0].start : null;
    const exactEnd = exactSegments.length ? exactSegments[exactSegments.length - 1].end : null;
    return {
      block,
      index,
      exactSegments,
      exactStart,
      exactEnd,
      exactByteLen: segmentLength(exactSegments)
    };
  });

  const withExact = blockMeta.filter((meta) => meta.exactSegments.length > 0).sort((a, b) => {
    if (a.exactStart !== b.exactStart) return a.exactStart - b.exactStart;
    return (a.exactEnd - b.exactEnd) || (a.index - b.index);
  });
  const withoutExact = blockMeta.filter((meta) => meta.exactSegments.length === 0);

  const groups = [];
  let currentGroup = null;
  let currentMaxEnd = -1;
  for (const meta of withExact) {
    if (!currentGroup || meta.exactStart >= currentMaxEnd || !currentGroup.some((other) => segmentsOverlap(meta.exactSegments, other.exactSegments))) {
      currentGroup = [meta];
      groups.push(currentGroup);
      currentMaxEnd = meta.exactEnd;
      continue;
    }
    currentGroup.push(meta);
    currentMaxEnd = Math.max(currentMaxEnd, meta.exactEnd);
  }

  const rawBlockIdAliases = {};
  const keptBlocks = [];
  const keptIds = new Set();
  let conflictGroupCount = 0;
  let droppedBlockCount = 0;

  for (const group of groups) {
    if (!Array.isArray(group) || !group.length) continue;
    if (group.length === 1) {
      const meta = group[0];
      const winner = {
        ...meta.block,
        exactByteLen: meta.exactByteLen,
        exactStart: meta.exactStart,
        exactEnd: meta.exactEnd,
        rawBlockIds: uniqueSortedStrings(meta.block?.rawBlockIds || [meta.block?.id])
      };
      keptBlocks.push(winner);
      keptIds.add(winner.id);
      continue;
    }

    conflictGroupCount++;
    const ranked = group
      .map((meta) => ({
        ...meta.block,
        exactByteLen: meta.exactByteLen,
        exactStart: meta.exactStart,
        exactEnd: meta.exactEnd,
        rawBlockIds: uniqueSortedStrings(meta.block?.rawBlockIds || [meta.block?.id])
      }))
      .sort((a, b) => -compareBlocksForWinner(a, b));

    const winner = ranked[0];
    const losers = ranked.slice(1);
    const mergedWinner = mergeWinnerMetadata(winner, losers);
    keptBlocks.push(mergedWinner);
    keptIds.add(mergedWinner.id);

    for (const loser of losers) {
      if (!loser?.id || loser.id === mergedWinner.id) continue;
      rawBlockIdAliases[loser.id] = mergedWinner.id;
      for (const rawId of loser.rawBlockIds || []) {
        if (rawId && rawId !== mergedWinner.id) rawBlockIdAliases[rawId] = mergedWinner.id;
      }
      droppedBlockCount++;
    }
    for (const rawId of mergedWinner.rawBlockIds || []) {
      if (rawId && !rawBlockIdAliases[rawId]) rawBlockIdAliases[rawId] = mergedWinner.id;
    }
  }

  for (const meta of withoutExact) {
    const kept = {
      ...meta.block,
      exactByteLen: 0,
      exactStart: null,
      exactEnd: null,
      rawBlockIds: uniqueSortedStrings(meta.block?.rawBlockIds || [meta.block?.id])
    };
    keptBlocks.push(kept);
    keptIds.add(kept.id);
    for (const rawId of kept.rawBlockIds || []) {
      if (rawId && !rawBlockIdAliases[rawId]) rawBlockIdAliases[rawId] = kept.id;
    }
  }

  const rewrittenEdges = [];
  const edgeSeen = new Set();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const mapped = remapEdge(edge, rawBlockIdAliases);
    if (!mapped || !mapped.from || !mapped.to) continue;
    if (!keptIds.has(mapped.from) || !keptIds.has(mapped.to)) continue;
    if (mapped.from === mapped.to) continue;
    const key = JSON.stringify(mapped);
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    rewrittenEdges.push(mapped);
  }

  const sortedBlocks = keptBlocks.sort((a, b) => {
    const aRom = Number.isFinite(a?.romStart) ? a.romStart : Number.MAX_SAFE_INTEGER;
    const bRom = Number.isFinite(b?.romStart) ? b.romStart : Number.MAX_SAFE_INTEGER;
    if (aRom !== bRom) return aRom - bRom;
    const aCpu = typeof a?.lines?.[0]?.cpuAddr === 'number' ? (a.lines[0].cpuAddr & 0xffff) : Number.MAX_SAFE_INTEGER;
    const bCpu = typeof b?.lines?.[0]?.cpuAddr === 'number' ? (b.lines[0].cpuAddr & 0xffff) : Number.MAX_SAFE_INTEGER;
    if (aCpu !== bCpu) return aCpu - bCpu;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });

  return {
    blocks: sortedBlocks,
    edges: rewrittenEdges,
    unresolvedSites: remapKnownBlockIds(unresolvedSites, rawBlockIdAliases),
    artifacts: remapKnownBlockIds(artifacts, rawBlockIdAliases),
    memoryDiscoveries: remapKnownBlockIds(memoryDiscoveries, rawBlockIdAliases),
    vsaDataflow: remapKnownBlockIds(vsaDataflow, rawBlockIdAliases),
    vsaFacts: remapKnownBlockIds(vsaFacts, rawBlockIdAliases),
    rawBlockIdAliases,
    debug: {
      conflictGroupCount,
      droppedBlockCount,
      keptBlockCount: sortedBlocks.length,
      originalBlockCount: inputBlocks.length
    }
  };
}
