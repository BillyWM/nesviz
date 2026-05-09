const HARDWARE_FLOW_ANNOTATION_TARGETS = [
  { addr: 0x2000, name: 'PPUCTRL', label: 'PPUCTRL' },
  { addr: 0x2005, name: 'PPUSCROLL', label: 'PPUSCROLL' }
];

const HARDWARE_FLOW_ANNOTATION_TARGETS_BY_ADDR = new Map(
  HARDWARE_FLOW_ANNOTATION_TARGETS.map((target) => [target.addr & 0xffff, target])
);

function targetSpecForAddr(addr) {
  if (typeof addr !== 'number' || !Number.isFinite(addr)) return null;
  return HARDWARE_FLOW_ANNOTATION_TARGETS_BY_ADDR.get(addr & 0xffff) || null;
}

function uniqStrings(values) {
  return Array.from(new Set((values || []).filter((value) => typeof value === 'string' && value))).sort();
}

function uniqNumbers(values) {
  return Array.from(new Set((values || [])
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .map((value) => value >>> 0)))
    .sort((a, b) => a - b);
}

function uniqUseSites(values) {
  const byKey = new Map();
  for (const value of values || []) {
    if (typeof value?.romOff !== 'number') {
      throw new Error('Memory map annotation use site is missing a ROM-absolute address');
    }
    const romOff = value.romOff >>> 0;
    const key = [
      romOff.toString(16),
      value?.traceId || '',
      value?.observationId || '',
      value?.rawBlockId || ''
    ].join(':');
    if (!byKey.has(key)) {
      byKey.set(key, {
        romOff,
        rawBlockId: typeof value?.rawBlockId === 'string' && value.rawBlockId ? value.rawBlockId : null,
        traceId: typeof value?.traceId === 'string' && value.traceId ? value.traceId : null,
        observationId: typeof value?.observationId === 'string' && value.observationId ? value.observationId : null
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => (a.romOff - b.romOff)
    || String(a.rawBlockId || '').localeCompare(String(b.rawBlockId || ''))
    || String(a.traceId || '').localeCompare(String(b.traceId || ''))
    || String(a.observationId || '').localeCompare(String(b.observationId || '')));
}

function normalizedAddrForSpace(space, addr) {
  if (space === 'rom') return addr >>> 0;
  return addr & 0xffff;
}

function rawBlockIdFromNode(node) {
  return typeof node?.rawBlockId === 'string' && node.rawBlockId ? node.rawBlockId : null;
}

function blockRomStart(block) {
  if (typeof block?.romStart === 'number' && Number.isFinite(block.romStart)) return block.romStart >>> 0;
  const lineOffsets = (Array.isArray(block?.lines) ? block.lines : [])
    .map((line) => (typeof line?.romOff === 'number' && Number.isFinite(line.romOff)) ? (line.romOff >>> 0) : null)
    .filter((value) => value !== null);
  if (lineOffsets.length) return Math.min(...lineOffsets) >>> 0;
  return null;
}

function blockRomEnd(block) {
  if (typeof block?.romEnd === 'number' && Number.isFinite(block.romEnd)) return block.romEnd >>> 0;
  const ends = (Array.isArray(block?.lines) ? block.lines : [])
    .map((line) => {
      if (!(typeof line?.romOff === 'number' && Number.isFinite(line.romOff))) return null;
      const len = (typeof line?.len === 'number' && Number.isFinite(line.len)) ? Math.max(1, line.len | 0) : 1;
      return ((line.romOff >>> 0) + len) >>> 0;
    })
    .filter((value) => value !== null);
  if (ends.length) return Math.max(...ends) >>> 0;
  return null;
}

function mapFromMaybeMap(value) {
  if (value instanceof Map) return value;
  const out = new Map();
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) out.set(key, item);
  }
  return out;
}

function setMapFromMaybeMap(value) {
  if (value instanceof Map) return value;
  const out = new Map();
  if (value && typeof value === 'object') {
    for (const [key, items] of Object.entries(value)) out.set(key, new Set(Array.isArray(items) ? items : []));
  }
  return out;
}

function buildFunctionContext(blockContextIndex, blocks = []) {
  const functionInfoById = mapFromMaybeMap(blockContextIndex?.functionInfoById || blockContextIndex?.functionInfoByIdObject);
  const rawBlockFunctionIdsById = setMapFromMaybeMap(blockContextIndex?.rawBlockFunctionIdsById || blockContextIndex?.rawBlockFunctionIdsByIdObject);
  const blocksById = new Map();
  const blockRanges = [];

  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!(typeof block?.id === 'string' && block.id)) continue;
    blocksById.set(block.id, block);
    const start = blockRomStart(block);
    const end = blockRomEnd(block);
    if (start !== null && end !== null && end > start) blockRanges.push({ id: block.id, start, end });
  }

  function functionUseForRawBlock(rawBlockId) {
    if (!(typeof rawBlockId === 'string' && rawBlockId)) return null;
    const functionIds = uniqStrings(Array.from(rawBlockFunctionIdsById.get(rawBlockId) || []));
    const uses = [];

    for (const functionId of functionIds) {
      const info = functionInfoById.get(functionId) || null;
      const rootBlockId = (typeof info?.rootBlockId === 'string' && info.rootBlockId) ? info.rootBlockId : null;
      let functionRomStart = (typeof info?.functionRomStart === 'number' && Number.isFinite(info.functionRomStart))
        ? (info.functionRomStart >>> 0)
        : null;

      if (functionRomStart === null && rootBlockId) {
        functionRomStart = blockRomStart(blocksById.get(rootBlockId));
      }

      if (functionRomStart === null) {
        const start = blockRomStart(blocksById.get(rawBlockId));
        if (start !== null) functionRomStart = start;
      }

      if (functionRomStart !== null) {
        uses.push({
          functionId,
          functionRomStart,
          functionRootRawBlockId: rootBlockId
        });
      }
    }

    if (uses.length) {
      return uses.sort((a, b) => (a.functionRomStart - b.functionRomStart)
        || String(a.functionId || '').localeCompare(String(b.functionId || '')));
    }

    const rawBlockStart = blockRomStart(blocksById.get(rawBlockId));
    if (rawBlockStart !== null) {
      return [{
        functionId: null,
        functionRomStart: rawBlockStart,
        functionRootRawBlockId: rawBlockId
      }];
    }

    return null;
  }

  function rawBlockIdsAtRomOff(romOff) {
    if (!(typeof romOff === 'number' && Number.isFinite(romOff))) return [];
    const off = romOff >>> 0;
    return blockRanges
      .filter((range) => off >= range.start && off < range.end)
      .map((range) => range.id)
      .sort();
  }

  return {
    functionUseForRawBlock,
    rawBlockIdsAtRomOff
  };
}

function rootRawBlockIdsForTrace(rootNodes, functionContext, romOff) {
  const rawBlockIds = uniqStrings(rootNodes.map(rawBlockIdFromNode));
  if (rawBlockIds.length) return rawBlockIds;
  return functionContext.rawBlockIdsAtRomOff(romOff);
}

function functionUsesForTraceRoot(rootRawBlockIds, functionContext, traceId) {
  const byRomStart = new Map();

  for (const rawBlockId of rootRawBlockIds) {
    const rawBlockUses = functionContext.functionUseForRawBlock(rawBlockId) || [];
    for (const functionUse of rawBlockUses) {
      const key = `${functionUse.functionRomStart >>> 0}:${functionUse.functionId || ''}`;
      const prev = byRomStart.get(key);
      if (prev) {
        prev.functionRootRawBlockId = prev.functionRootRawBlockId || functionUse.functionRootRawBlockId || null;
        continue;
      }
      byRomStart.set(key, {
        functionId: functionUse.functionId || null,
        functionRomStart: functionUse.functionRomStart >>> 0,
        functionRootRawBlockId: functionUse.functionRootRawBlockId || null
      });
    }
  }

  if (!byRomStart.size) {
    const rawBlockText = rootRawBlockIds.length ? rootRawBlockIds.join(', ') : '<unknown raw block>';
    throw new Error(`Memory map annotation trace ${traceId || '<unknown>'} is missing current ROM-absolute function data for ${rawBlockText}`);
  }

  return Array.from(byRomStart.values()).sort((a, b) => (a.functionRomStart - b.functionRomStart)
    || String(a.functionId || '').localeCompare(String(b.functionId || '')));
}

function buildTraceInfoById(vsaDataflow, functionContext) {
  const out = new Map();
  for (const trace of Array.isArray(vsaDataflow?.hardwareTraces) ? vsaDataflow.hardwareTraces : []) {
    const id = typeof trace?.id === 'string' && trace.id ? trace.id : null;
    if (!id) continue;
    const nodes = Array.isArray(trace?.graph?.nodes) ? trace.graph.nodes : [];
    const rootNodes = nodes.filter((node) => node?.kind === 'hardwareWriteRoot' || node?.observationId === trace?.rootObservationId);
    const rootObservationId = typeof trace?.rootObservationId === 'string' && trace.rootObservationId ? trace.rootObservationId : null;
    const rootNodeWithRom = rootNodes.find((node) => typeof node?.atRomOff === 'number');
    const romOff = typeof trace?.atRomOff === 'number'
      ? (trace.atRomOff >>> 0)
      : (typeof rootNodeWithRom?.atRomOff === 'number' ? (rootNodeWithRom.atRomOff >>> 0) : null);
    const rawBlockIds = rootRawBlockIdsForTrace(rootNodes, functionContext, romOff);
    const targetAddr = typeof trace?.target?.addr === 'number' ? (trace.target.addr & 0xffff) : null;
    const targetSpec = targetSpecForAddr(targetAddr);
    const functionUses = targetSpec ? functionUsesForTraceRoot(rawBlockIds, functionContext, id) : [];
    out.set(id, {
      id,
      targetAddr,
      romOff,
      rawBlockId: rawBlockIds[0] || null,
      rawBlockIds,
      functionUses,
      observationId: rootObservationId
    });
  }
  return out;
}

function graphIndexes(trace) {
  const nodesById = new Map();
  const edgesByFrom = new Map();

  for (const node of Array.isArray(trace?.graph?.nodes) ? trace.graph.nodes : []) {
    if (typeof node?.id === 'string' && node.id) nodesById.set(node.id, node);
  }

  for (const edge of Array.isArray(trace?.graph?.edges) ? trace.graph.edges : []) {
    if (!(typeof edge?.from === 'string' && edge.from && typeof edge?.to === 'string' && edge.to)) continue;
    let list = edgesByFrom.get(edge.from);
    if (!list) {
      list = [];
      edgesByFrom.set(edge.from, list);
    }
    list.push(edge);
  }

  return { nodesById, edgesByFrom };
}

function addSource(out, source) {
  if (!(source?.space === 'zp' || source?.space === 'ram' || source?.space === 'rom')) return;
  if (typeof source?.addr !== 'number' || !Number.isFinite(source.addr)) return;
  const addr = normalizedAddrForSpace(source.space, source.addr);
  const key = [source.space, addr.toString(16), source.traceNodeId || ''].join(':');
  if (!out.has(key)) {
    out.set(key, {
      space: source.space,
      addr,
      traceNodeId: typeof source.traceNodeId === 'string' && source.traceNodeId ? source.traceNodeId : null
    });
  }
}

function addReadNodeSources(out, node) {
  if (node.kind === 'memoryReadProvenance') {
    addSource(out, {
      space: node.space,
      addr: node.addr,
      traceNodeId: node.id
    });
    return;
  }

  if (node.kind !== 'romReadProvenance') return;

  const physicalRom = node.physicalRom || null;
  if ((physicalRom?.kind === 'exact' || physicalRom?.kind === 'set') && Array.isArray(physicalRom.romOffsets)) {
    for (const romOff of physicalRom.romOffsets) {
      if (typeof romOff === 'number' && Number.isFinite(romOff)) {
        addSource(out, {
          space: 'rom',
          addr: romOff >>> 0,
          traceNodeId: node.id
        });
      }
    }
    return;
  }

  if (node.space === 'rom' && typeof node.addr === 'number') {
    addSource(out, {
      space: 'rom',
      addr: node.addr >>> 0,
      traceNodeId: node.id
    });
  }
}

function collectValueSourceReads(trace, targetSpec) {
  const targetAddr = typeof trace?.target?.addr === 'number' ? (trace.target.addr & 0xffff) : null;
  if (!targetSpec || targetAddr !== (targetSpec.addr & 0xffff)) return [];

  const { nodesById, edgesByFrom } = graphIndexes(trace);
  const startId = typeof trace?.graph?.rootNodeId === 'string' && trace.graph.rootNodeId ? trace.graph.rootNodeId : null;
  if (!startId || !nodesById.has(startId)) return [];

  const sourcesByKey = new Map();
  const seen = new Set();
  const stack = [startId];

  while (stack.length) {
    const nodeId = stack.pop();
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);

    const node = nodesById.get(nodeId);
    if (!node) continue;

    if (node.kind === 'memoryReadProvenance' || node.kind === 'romReadProvenance') {
      addReadNodeSources(sourcesByKey, node);
      continue;
    }

    for (const edge of edgesByFrom.get(nodeId) || []) {
      if (!(edge.kind === 'traceRoot' || edge.kind === 'valueSource' || edge.kind === 'provenanceSource')) continue;
      if (nodesById.has(edge.to)) stack.push(edge.to);
    }
  }

  return Array.from(sourcesByKey.values()).sort((a, b) => a.space.localeCompare(b.space)
    || (a.addr - b.addr)
    || String(a.traceNodeId || '').localeCompare(String(b.traceNodeId || '')));
}

function addSiteToFunctionMap(map, functionUse, site) {
  const key = `${functionUse.functionRomStart >>> 0}:${functionUse.functionId || ''}`;
  let item = map.get(key);
  if (!item) {
    item = {
      functionId: functionUse.functionId || null,
      functionRomStart: functionUse.functionRomStart >>> 0,
      functionRootRawBlockId: functionUse.functionRootRawBlockId || null,
      useSites: []
    };
    map.set(key, item);
  }
  item.useSites.push(site);
}

function functionUseSitesForTrace(traceInfo, targetSpec) {
  const byFunction = new Map();

  if (!traceInfo || !targetSpec || traceInfo.targetAddr !== (targetSpec.addr & 0xffff)) return byFunction;
  if (typeof traceInfo.romOff !== 'number') {
    throw new Error(`Memory map annotation trace ${traceInfo?.id || '<unknown>'} is missing a ROM-absolute use site`);
  }
  if (!traceInfo.functionUses.length) {
    throw new Error(`Memory map annotation trace ${traceInfo?.id || '<unknown>'} is missing carried function identity data`);
  }

  const site = {
    romOff: traceInfo.romOff >>> 0,
    rawBlockId: traceInfo.rawBlockId,
    traceId: traceInfo.id,
    observationId: traceInfo.observationId
  };

  for (const functionUse of traceInfo.functionUses) addSiteToFunctionMap(byFunction, functionUse, site);
  for (const item of byFunction.values()) item.useSites = uniqUseSites(item.useSites);
  return byFunction;
}

function addUseForFunction(uses, source, traceInfo, functionUse, targetSpec) {
  const space = source.space;
  if (!(space === 'zp' || space === 'ram' || space === 'rom')) return;
  const addr = normalizedAddrForSpace(space, source.addr);
  uses.push({
    space,
    start: addr,
    end: addr,
    label: targetSpec.label,
    kind: 'hardwareFlow',
    source: 'vsa',
    targetAddr: targetSpec.addr & 0xffff,
    targetName: targetSpec.name,
    functionId: functionUse.functionId || null,
    functionRomStart: functionUse.functionRomStart >>> 0,
    functionRootRawBlockId: functionUse.functionRootRawBlockId || null,
    useSites: uniqUseSites(functionUse.useSites),
    rawBlockIds: uniqStrings(traceInfo.rawBlockIds || []),
    traceIds: uniqStrings([traceInfo.id]),
    observationIds: uniqStrings([traceInfo.observationId]),
    traceNodeIds: uniqStrings([source.traceNodeId])
  });
}

function compareUse(a, b) {
  return a.space.localeCompare(b.space)
    || a.label.localeCompare(b.label)
    || (a.functionRomStart - b.functionRomStart)
    || String(a.functionId || '').localeCompare(String(b.functionId || ''))
    || (a.start - b.start)
    || (a.end - b.end);
}

function mergeUsesForFunction(uses) {
  const sorted = [...uses].sort(compareUse);
  const merged = [];
  for (const use of sorted) {
    const prev = merged[merged.length - 1];
    if (prev
      && prev.space === use.space
      && prev.label === use.label
      && prev.kind === use.kind
      && prev.source === use.source
      && prev.targetAddr === use.targetAddr
      && prev.functionRomStart === use.functionRomStart
      && prev.functionId === use.functionId
      && use.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, use.end);
      prev.rawBlockIds = uniqStrings([...prev.rawBlockIds, ...use.rawBlockIds]);
      prev.traceIds = uniqStrings([...prev.traceIds, ...use.traceIds]);
      prev.observationIds = uniqStrings([...prev.observationIds, ...use.observationIds]);
      prev.traceNodeIds = uniqStrings([...prev.traceNodeIds, ...use.traceNodeIds]);
      prev.useSites = uniqUseSites([...prev.useSites, ...use.useSites]);
      continue;
    }
    merged.push({ ...use, useSites: uniqUseSites(use.useSites) });
  }
  return merged;
}

function rangeKey(use) {
  return [use.source, use.kind, use.label, use.space, use.start, use.end, use.targetAddr].join(':');
}

function getFunctionUse(item, use) {
  const key = `${use.functionRomStart >>> 0}:${use.functionId || ''}`;
  let functionUse = item.functionUseMap.get(key);
  if (!functionUse) {
    functionUse = {
      functionId: use.functionId || null,
      functionRomStart: use.functionRomStart >>> 0,
      functionRootRawBlockId: use.functionRootRawBlockId || null,
      rawBlockIds: [],
      traceIds: [],
      observationIds: [],
      traceNodeIds: [],
      useSites: []
    };
    item.functionUseMap.set(key, functionUse);
  }
  return functionUse;
}

function materializeAnnotations(functionUses) {
  const byRange = new Map();
  for (const use of functionUses) {
    const key = rangeKey(use);
    let item = byRange.get(key);
    if (!item) {
      item = {
        source: use.source,
        kind: use.kind,
        label: use.label,
        range: {
          space: use.space,
          start: use.start,
          end: use.end
        },
        target: {
          space: 'io',
          addr: use.targetAddr,
          name: use.targetName
        },
        functionUseMap: new Map(),
        rawBlockIds: [],
        traceIds: [],
        observationIds: [],
        traceNodeIds: []
      };
      byRange.set(key, item);
    }

    const functionUse = getFunctionUse(item, use);
    functionUse.rawBlockIds.push(...use.rawBlockIds);
    functionUse.traceIds.push(...use.traceIds);
    functionUse.observationIds.push(...use.observationIds);
    functionUse.traceNodeIds.push(...use.traceNodeIds);
    functionUse.useSites.push(...use.useSites);

    item.rawBlockIds.push(...use.rawBlockIds);
    item.traceIds.push(...use.traceIds);
    item.observationIds.push(...use.observationIds);
    item.traceNodeIds.push(...use.traceNodeIds);
  }

  const out = [];
  for (const item of byRange.values()) {
    const functionUsesOut = Array.from(item.functionUseMap.values()).map((functionUse) => {
      const useSites = uniqUseSites(functionUse.useSites);
      return {
        functionId: functionUse.functionId,
        functionRomStart: functionUse.functionRomStart >>> 0,
        functionRootRawBlockId: functionUse.functionRootRawBlockId || null,
        rawBlockIds: uniqStrings(functionUse.rawBlockIds),
        traceIds: uniqStrings(functionUse.traceIds),
        observationIds: uniqStrings(functionUse.observationIds),
        traceNodeIds: uniqStrings(functionUse.traceNodeIds),
        useSites,
        primaryUseSiteRomOff: useSites[0]?.romOff ?? null
      };
    }).sort((a, b) => (a.functionRomStart - b.functionRomStart)
      || String(a.functionId || '').localeCompare(String(b.functionId || '')));

    const functionIds = uniqStrings(functionUsesOut.map((functionUse) => functionUse.functionId));
    const functionRomStarts = uniqNumbers(functionUsesOut.map((functionUse) => functionUse.functionRomStart));
    const annotation = {
      source: item.source,
      kind: item.kind,
      label: item.label,
      range: item.range,
      target: item.target,
      functionUses: functionUsesOut,
      functionIds,
      functionRomStarts,
      rawBlockIds: uniqStrings(item.rawBlockIds),
      traceIds: uniqStrings(item.traceIds),
      observationIds: uniqStrings(item.observationIds),
      traceNodeIds: uniqStrings(item.traceNodeIds)
    };
    annotation.id = [
      'vsa',
      'hardwareFlow',
      annotation.label,
      annotation.range.space,
      annotation.range.start.toString(16),
      annotation.range.end.toString(16),
      annotation.functionRomStarts.map((value) => value.toString(16)).join('+') || annotation.rawBlockIds.join('+') || 'unknown'
    ].join(':');
    out.push(annotation);
  }

  out.sort((a, b) => a.range.space.localeCompare(b.range.space)
    || (a.range.start - b.range.start)
    || (a.range.end - b.range.end)
    || a.label.localeCompare(b.label)
    || a.id.localeCompare(b.id));
  return out;
}

export function buildMapAnnotationsFromVsaHardwareFlows({ vsaDataflow = null, blockContextIndex = null, blocks = [] }) {
  const functionContext = buildFunctionContext(blockContextIndex, blocks);
  const traceInfoById = buildTraceInfoById(vsaDataflow, functionContext);
  const uses = [];

  for (const trace of Array.isArray(vsaDataflow?.hardwareTraces) ? vsaDataflow.hardwareTraces : []) {
    const id = typeof trace?.id === 'string' && trace.id ? trace.id : null;
    if (!id) continue;
    const traceInfo = traceInfoById.get(id);
    const targetSpec = targetSpecForAddr(traceInfo?.targetAddr);
    if (!traceInfo || !targetSpec) continue;

    const valueSources = collectValueSourceReads(trace, targetSpec);
    if (!valueSources.length) continue;

    const functionUseSites = functionUseSitesForTrace(traceInfo, targetSpec);
    for (const source of valueSources) {
      for (const functionUse of functionUseSites.values()) addUseForFunction(uses, source, traceInfo, functionUse, targetSpec);
    }
  }

  return materializeAnnotations(mergeUsesForFunction(uses));
}
