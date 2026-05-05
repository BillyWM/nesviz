import { fmtHex } from '../../utils/numberUtils.js';

function edgeKindForRaw(kind) {
  if (kind === 'call') return 'call';
  if (kind === 'jump' || kind === 'jump_table') return 'jump';
  if (kind === 'branch_taken') return 'branch';
  if (kind === 'branch_fallthrough' || kind === 'fallthrough') return 'fallthrough';
  return null;
}

function makeLineLookup(blocks) {
  const byRomOff = new Map();

  for (const block of Array.isArray(blocks) ? blocks : []) {
    const lines = Array.isArray(block?.lines) ? block.lines : [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (typeof line?.romOff !== 'number') continue;
      const romOff = line.romOff >>> 0;
      if (byRomOff.has(romOff)) continue;
      byRomOff.set(romOff, {
        blockId: block.id,
        lineIndex: index,
        line
      });
    }
  }

  return { byRomOff };
}

function edgeDestinationRomOff(rawEdge, sourceLine, targetLine) {
  const flow = sourceLine?.flow;
  if (flow && typeof flow === 'object') {
    if ((rawEdge?.kind === 'branch_taken' || rawEdge?.kind === 'call' || rawEdge?.kind === 'jump' || rawEdge?.kind === 'jump_table') && typeof flow.targetRomOff === 'number') {
      return flow.targetRomOff >>> 0;
    }
    if (rawEdge?.kind === 'branch_fallthrough' && typeof flow.fallthroughRomOff === 'number') {
      return flow.fallthroughRomOff >>> 0;
    }
    if (rawEdge?.kind === 'fallthrough') {
      if (typeof flow.nextRomOff === 'number') return flow.nextRomOff >>> 0;
      if (typeof flow.fallthroughRomOff === 'number') return flow.fallthroughRomOff >>> 0;
    }
  }
  return typeof targetLine?.romOff === 'number' ? (targetLine.romOff >>> 0) : null;
}

function findLineHit(lookup, line) {
  if (!line || typeof line.romOff !== 'number') return null;
  return lookup.byRomOff.get(line.romOff >>> 0) || null;
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
    rawBlockIds: Array.isArray(block?.rawBlockIds) ? block.rawBlockIds.slice() : [],
    lines: lines.map((line) => ({
      romOff: typeof line?.romOff === 'number' ? (line.romOff >>> 0) : null,
      cpuAddr: typeof line?.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null,
      bytesText: typeof line?.bytesText === 'string' ? line.bytesText : '',
      asm: typeof line?.asm === 'string' && line.asm ? line.asm : (typeof line?.text === 'string' ? line.text : ''),
      mnemonic: typeof line?.mnemonic === 'string' ? line.mnemonic : '',
      flow: line?.flow && typeof line.flow === 'object'
        ? {
            type: typeof line.flow.type === 'string' ? line.flow.type : null,
            target: typeof line.flow.target === 'number' ? (line.flow.target & 0xffff) : null,
            targetRomOff: typeof line.flow.targetRomOff === 'number' ? (line.flow.targetRomOff >>> 0) : null,
            fallthroughRomOff: typeof line.flow.fallthroughRomOff === 'number' ? (line.flow.fallthroughRomOff >>> 0) : null,
            nextRomOff: typeof line.flow.nextRomOff === 'number' ? (line.flow.nextRomOff >>> 0) : null
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

export function buildGraphData({ rawAnalysis, displayAnalysis, rawToDisplayBlockIds }) {
  const analysis = displayAnalysis || null;
  if (!analysis) {
    return {
      ok: true,
      hasAnalysis: false,
      nodes: [],
      edges: []
    };
  }

  const displayBlocks = Array.isArray(analysis?.blocks) ? analysis.blocks : [];
  const rawBlocks = Array.isArray(rawAnalysis?.blocks) ? rawAnalysis.blocks : [];
  const rawEdges = Array.isArray(rawAnalysis?.edges) ? rawAnalysis.edges : [];
  const rawToDisplayBlockIdMap = rawToDisplayBlockIds && typeof rawToDisplayBlockIds === 'object' ? rawToDisplayBlockIds : {};

  const displayById = new Map(displayBlocks.map((block) => [block.id, block]));
  const rawById = new Map(rawBlocks.map((block) => [block.id, block]));
  const lineLookup = makeLineLookup(displayBlocks);

  const nodes = displayBlocks
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

    const sourceBlockId = rawToDisplayBlockIdMap[fromRaw.id] || null;
    const targetBlockId = rawToDisplayBlockIdMap[toRaw.id] || null;
    if (!sourceBlockId || !targetBlockId) continue;
    if (!displayById.has(sourceBlockId) || !displayById.has(targetBlockId)) continue;
    if (sourceBlockId === targetBlockId) continue;

    const sourceRawLine = Array.isArray(fromRaw.lines) && fromRaw.lines.length ? fromRaw.lines[fromRaw.lines.length - 1] : null;
    const targetRawLine = Array.isArray(toRaw.lines) && toRaw.lines.length ? toRaw.lines[0] : null;
    if (!sourceRawLine || !targetRawLine) continue;

    const sourceHit = findLineHit(lineLookup, sourceRawLine);
    if (!sourceHit || sourceHit.blockId !== sourceBlockId) continue;

    const targetRomOff = edgeDestinationRomOff(rawEdge, sourceRawLine, targetRawLine);
    const targetHit = targetRomOff !== null ? lineLookup.byRomOff.get(targetRomOff) : null;
    if (!targetHit || targetHit.blockId !== targetBlockId) continue;

    const sourceRomOff = typeof sourceHit.line?.romOff === 'number' ? (sourceHit.line.romOff >>> 0) : null;
    const renderedTargetRomOff = typeof targetHit.line?.romOff === 'number' ? (targetHit.line.romOff >>> 0) : null;
    if (sourceRomOff === null || renderedTargetRomOff === null) continue;

    const edgeDisplayKey = `${kind}:${sourceRomOff}:${renderedTargetRomOff}`;
    if (seen.has(edgeDisplayKey)) continue;
    seen.add(edgeDisplayKey);

    edges.push({
      id: edgeDisplayKey,
      kind,
      rawKind: rawEdge.kind,
      source: sourceBlockId,
      target: targetBlockId,
      sourceLineIndex: sourceHit.lineIndex,
      targetLineIndex: targetHit.lineIndex,
      sourceRomOff,
      targetRomOff: renderedTargetRomOff,
      sourceCpuAddr: typeof sourceHit.line?.cpuAddr === 'number'
        ? (sourceHit.line.cpuAddr & 0xffff)
        : (typeof sourceRawLine?.cpuAddr === 'number' ? (sourceRawLine.cpuAddr & 0xffff) : null),
      targetCpuAddr: typeof targetHit.line?.cpuAddr === 'number'
        ? (targetHit.line.cpuAddr & 0xffff)
        : (typeof targetRawLine?.cpuAddr === 'number' ? (targetRawLine.cpuAddr & 0xffff) : null),
      sourceAsm: typeof sourceHit.line?.asm === 'string'
        ? sourceHit.line.asm
        : (typeof sourceRawLine?.asm === 'string' ? sourceRawLine.asm : (typeof sourceRawLine?.text === 'string' ? sourceRawLine.text : '')),
      targetAsm: typeof targetHit.line?.asm === 'string'
        ? targetHit.line.asm
        : (typeof targetHit.line?.text === 'string'
            ? targetHit.line.text
            : (typeof targetRawLine?.asm === 'string' ? targetRawLine.asm : (typeof targetRawLine?.text === 'string' ? targetRawLine.text : ''))),
      sourceRawBlockId: fromRaw.id,
      targetRawBlockId: toRaw.id
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
