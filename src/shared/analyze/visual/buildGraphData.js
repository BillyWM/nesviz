function fmtHex(value, width) {
  if (!Number.isFinite(value)) return '?'.repeat(width);
  return (value >>> 0).toString(16).toUpperCase().padStart(width, '0');
}

function edgeKindForRaw(kind) {
  if (kind === 'call') return 'call';
  if (kind === 'jump' || kind === 'jump_table') return 'jump';
  if (kind === 'branch_taken') return 'branch';
  if (kind === 'branch_fallthrough' || kind === 'fallthrough') return 'fallthrough';
  return null;
}

function makeLineLookup(blocks) {
  const bySiteKey = new Map();
  const byCtxCpu = new Map();

  for (const block of Array.isArray(blocks) ? blocks : []) {
    const lines = Array.isArray(block?.lines) ? block.lines : [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const hit = {
        blockId: block.id,
        lineIndex: index,
        line
      };
      if (typeof line?.siteKey === 'string' && line.siteKey) {
        bySiteKey.set(line.siteKey, hit);
      }
      if (typeof line?.ctxKey === 'string' && line.ctxKey && typeof line?.cpuAddr === 'number') {
        const key = `${line.ctxKey}:${line.cpuAddr & 0xffff}`;
        if (!byCtxCpu.has(key)) byCtxCpu.set(key, hit);
      }
    }
  }

  return { bySiteKey, byCtxCpu };
}

function edgeDestinationCpuAddr(rawEdge, sourceLine) {
  const flow = sourceLine?.flow;
  if (!flow || typeof flow !== 'object') return null;

  if (rawEdge?.kind === 'branch_taken' || rawEdge?.kind === 'call' || rawEdge?.kind === 'jump' || rawEdge?.kind === 'jump_table') {
    return typeof flow.target === 'number' ? (flow.target & 0xffff) : null;
  }

  if (rawEdge?.kind === 'branch_fallthrough') {
    return typeof flow.fallthrough === 'number' ? (flow.fallthrough & 0xffff) : null;
  }

  if (rawEdge?.kind === 'fallthrough') {
    if (typeof flow.next === 'number') return flow.next & 0xffff;
    if (typeof flow.fallthrough === 'number') return flow.fallthrough & 0xffff;
  }

  return null;
}

function findLineHit(lookup, line) {
  if (!line) return null;
  if (typeof line.siteKey === 'string' && line.siteKey && lookup.bySiteKey.has(line.siteKey)) {
    return lookup.bySiteKey.get(line.siteKey);
  }
  if (typeof line.ctxKey === 'string' && line.ctxKey && typeof line.cpuAddr === 'number') {
    const key = `${line.ctxKey}:${line.cpuAddr & 0xffff}`;
    if (lookup.byCtxCpu.has(key)) return lookup.byCtxCpu.get(key);
  }
  return null;
}

function findRenderedTargetHit(block, targetCpuAddr, preferredCtxKey = null) {
  if (!block || typeof targetCpuAddr !== 'number') return null;

  const normalizedTargetCpuAddr = targetCpuAddr & 0xffff;
  const lines = Array.isArray(block?.lines) ? block.lines : [];
  const exactCtxHits = [];
  const cpuHits = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (typeof line?.cpuAddr !== 'number') continue;
    if ((line.cpuAddr & 0xffff) !== normalizedTargetCpuAddr) continue;

    const hit = {
      blockId: block.id,
      lineIndex: index,
      line
    };

    cpuHits.push(hit);
    if (preferredCtxKey && typeof line?.ctxKey === 'string' && line.ctxKey === preferredCtxKey) {
      exactCtxHits.push(hit);
    }
  }

  if (exactCtxHits.length === 1) return exactCtxHits[0];
  if (exactCtxHits.length > 1) return null;
  if (cpuHits.length === 1) return cpuHits[0];
  return null;
}

function buildNode(block) {
  const lines = Array.isArray(block?.lines) ? block.lines : [];
  const cpuStart = typeof block?.cpuStart === 'number' ? (block.cpuStart & 0xffff) : (typeof lines[0]?.cpuAddr === 'number' ? (lines[0].cpuAddr & 0xffff) : null);
  const cpuEnd = typeof block?.cpuEnd === 'number' ? (block.cpuEnd & 0xffff) : null;
  const romStart = typeof block?.romStart === 'number' ? (block.romStart >>> 0) : null;
  const romEnd = typeof block?.romEnd === 'number' ? (block.romEnd >>> 0) : null;

  return {
    id: block.id,
    confidence: block?.confidence === 'probable' ? 'probable' : 'certain',
    romStart,
    romEnd,
    cpuStart,
    cpuEnd,
    memberBlockIds: Array.isArray(block?.memberBlockIds) ? block.memberBlockIds.slice() : [],
    lines: lines.map((line) => ({
      siteKey: typeof line?.siteKey === 'string' ? line.siteKey : null,
      ctxKey: typeof line?.ctxKey === 'string' ? line.ctxKey : null,
      romOff: typeof line?.romOff === 'number' ? (line.romOff >>> 0) : null,
      cpuAddr: typeof line?.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null,
      bytesText: typeof line?.bytesText === 'string' ? line.bytesText : '',
      asm: typeof line?.asm === 'string' && line.asm ? line.asm : (typeof line?.text === 'string' ? line.text : ''),
      mnemonic: typeof line?.mnemonic === 'string' ? line.mnemonic : '',
      flow: line?.flow && typeof line.flow === 'object'
        ? {
            type: typeof line.flow.type === 'string' ? line.flow.type : null,
            target: typeof line.flow.target === 'number' ? (line.flow.target & 0xffff) : null,
            fallthrough: typeof line.flow.fallthrough === 'number' ? (line.flow.fallthrough & 0xffff) : null,
            next: typeof line.flow.next === 'number' ? (line.flow.next & 0xffff) : null
          }
        : null
    })),
    title: cpuStart !== null && cpuEnd !== null
      ? `$${fmtHex(cpuStart, 4)}–$${fmtHex((cpuEnd - 1) & 0xffff, 4)}`
      : block.id,
    subtitle: romStart !== null && romEnd !== null
      ? `ROM ${fmtHex(romStart, 6)}–${fmtHex(Math.max(romStart, romEnd - 1), 6)}`
      : '',
    lineCount: lines.length
  };
}

export function buildGraphData({ rawAnalysis, coalescedAnalysis, blockAliases }) {
  const analysis = coalescedAnalysis || null;
  if (!analysis) {
    return {
      ok: true,
      hasAnalysis: false,
      nodes: [],
      edges: []
    };
  }

  const coalescedBlocks = Array.isArray(analysis?.blocks) ? analysis.blocks : [];
  const rawBlocks = Array.isArray(rawAnalysis?.blocks) ? rawAnalysis.blocks : [];
  const rawEdges = Array.isArray(rawAnalysis?.edges) ? rawAnalysis.edges : [];
  const aliases = blockAliases && typeof blockAliases === 'object' ? blockAliases : {};

  const coalescedById = new Map(coalescedBlocks.map((block) => [block.id, block]));
  const rawById = new Map(rawBlocks.map((block) => [block.id, block]));
  const lineLookup = makeLineLookup(coalescedBlocks);

  const nodes = coalescedBlocks
    .map((block) => buildNode(block))
    .sort((a, b) => {
      const aRom = Number.isFinite(a.romStart) ? a.romStart : Number.MAX_SAFE_INTEGER;
      const bRom = Number.isFinite(b.romStart) ? b.romStart : Number.MAX_SAFE_INTEGER;
      if (aRom !== bRom) return aRom - bRom;
      const aCpu = Number.isFinite(a.cpuStart) ? a.cpuStart : Number.MAX_SAFE_INTEGER;
      const bCpu = Number.isFinite(b.cpuStart) ? b.cpuStart : Number.MAX_SAFE_INTEGER;
      if (aCpu !== bCpu) return aCpu - bCpu;
      return String(a.id).localeCompare(String(b.id));
    });

  const edges = [];
  const seen = new Set();

  for (let index = 0; index < rawEdges.length; index++) {
    const rawEdge = rawEdges[index];
    const kind = edgeKindForRaw(rawEdge?.kind);
    if (!kind) continue;

    const fromRaw = rawById.get(rawEdge?.from) || null;
    const toRaw = rawById.get(rawEdge?.to) || null;
    if (!fromRaw || !toRaw) continue;

    const sourceBlockId = aliases[fromRaw.id] || fromRaw.id;
    const targetBlockId = aliases[toRaw.id] || toRaw.id;
    if (!coalescedById.has(sourceBlockId) || !coalescedById.has(targetBlockId)) continue;
    if (sourceBlockId === targetBlockId) continue;

    const sourceRawLine = Array.isArray(fromRaw.lines) && fromRaw.lines.length ? fromRaw.lines[fromRaw.lines.length - 1] : null;
    const targetRawLine = Array.isArray(toRaw.lines) && toRaw.lines.length ? toRaw.lines[0] : null;
    if (!sourceRawLine || !targetRawLine) continue;

    const sourceHit = findLineHit(lineLookup, sourceRawLine);
    if (!sourceHit || sourceHit.blockId !== sourceBlockId) continue;

    const targetCpuAddr = edgeDestinationCpuAddr(rawEdge, sourceRawLine);
    const preferredTargetCtxKey = typeof targetRawLine?.ctxKey === 'string' && targetRawLine.ctxKey
      ? targetRawLine.ctxKey
      : (typeof sourceRawLine?.ctxKey === 'string' && sourceRawLine.ctxKey ? sourceRawLine.ctxKey : null);

    const targetHit = targetCpuAddr !== null
      ? findRenderedTargetHit(coalescedById.get(targetBlockId) || null, targetCpuAddr, preferredTargetCtxKey)
      : findLineHit(lineLookup, targetRawLine);
    if (!targetHit || targetHit.blockId !== targetBlockId) continue;

    const sourceSiteKey = sourceHit.line?.siteKey || sourceRawLine?.siteKey || `source:${fromRaw.id}:${index}`;
    const targetSiteKey = targetHit.line?.siteKey || targetRawLine?.siteKey || `target:${toRaw.id}:${index}`;
    const edgeId = `${kind}:${sourceSiteKey}:${targetSiteKey}:${index}`;
    if (seen.has(edgeId)) continue;
    seen.add(edgeId);

    edges.push({
      id: edgeId,
      kind,
      rawKind: rawEdge.kind,
      source: sourceBlockId,
      target: targetBlockId,
      sourceLineIndex: sourceHit.lineIndex,
      targetLineIndex: targetHit.lineIndex,
      sourceSiteKey,
      targetSiteKey,
      sourceCpuAddr: typeof sourceHit.line?.cpuAddr === 'number'
        ? (sourceHit.line.cpuAddr & 0xffff)
        : (typeof sourceRawLine?.cpuAddr === 'number' ? (sourceRawLine.cpuAddr & 0xffff) : null),
      targetCpuAddr: targetCpuAddr !== null
        ? targetCpuAddr
        : (typeof targetHit.line?.cpuAddr === 'number'
            ? (targetHit.line.cpuAddr & 0xffff)
            : (typeof targetRawLine?.cpuAddr === 'number' ? (targetRawLine.cpuAddr & 0xffff) : null)),
      sourceAsm: typeof sourceHit.line?.asm === 'string'
        ? sourceHit.line.asm
        : (typeof sourceRawLine?.asm === 'string' ? sourceRawLine.asm : (typeof sourceRawLine?.text === 'string' ? sourceRawLine.text : '')),
      targetAsm: typeof targetHit.line?.asm === 'string'
        ? targetHit.line.asm
        : (typeof targetHit.line?.text === 'string'
            ? targetHit.line.text
            : (typeof targetRawLine?.asm === 'string' ? targetRawLine.asm : (typeof targetRawLine?.text === 'string' ? targetRawLine.text : ''))),
      sourceMemberBlockId: fromRaw.id,
      targetMemberBlockId: toRaw.id
    });
  }

  edges.sort((a, b) => {
    if (a.source !== b.source) return String(a.source).localeCompare(String(b.source));
    if (a.sourceLineIndex !== b.sourceLineIndex) return a.sourceLineIndex - b.sourceLineIndex;
    if (a.target !== b.target) return String(a.target).localeCompare(String(b.target));
    if (a.targetLineIndex !== b.targetLineIndex) return a.targetLineIndex - b.targetLineIndex;
    return String(a.id).localeCompare(String(b.id));
  });

  return {
    ok: true,
    hasAnalysis: true,
    nodes,
    edges
  };
}
