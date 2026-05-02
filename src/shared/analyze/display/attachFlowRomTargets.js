function edgeTargetField(kind) {
  if (kind === 'branch_taken' || kind === 'call' || kind === 'jump' || kind === 'jump_table') return 'targetRomOff';
  if (kind === 'branch_fallthrough') return 'fallthroughRomOff';
  if (kind === 'fallthrough') return 'nextRomOff';
  return null;
}

export function attachFlowRomTargets({ rawAnalysis, displayAnalysis } = {}) {
  const displayBlocks = Array.isArray(displayAnalysis?.blocks) ? displayAnalysis.blocks : [];
  const rawBlocks = Array.isArray(rawAnalysis?.blocks) ? rawAnalysis.blocks : [];
  const rawEdges = Array.isArray(rawAnalysis?.edges) ? rawAnalysis.edges : [];
  if (!displayBlocks.length || !rawBlocks.length || !rawEdges.length) return displayAnalysis;

  const rawById = new Map(rawBlocks.filter((block) => typeof block?.id === 'string' && block.id).map((block) => [block.id, block]));
  const displayLineByRomOff = new Map();
  for (const block of displayBlocks) {
    for (const line of Array.isArray(block?.lines) ? block.lines : []) {
      if (typeof line?.romOff !== 'number') continue;
      const romOff = line.romOff >>> 0;
      if (!displayLineByRomOff.has(romOff)) displayLineByRomOff.set(romOff, line);
    }
  }

  for (const edge of rawEdges) {
    const targetField = edgeTargetField(edge?.kind);
    if (!targetField) continue;
    const fromRaw = rawById.get(edge?.from) || null;
    const toRaw = rawById.get(edge?.to) || null;
    const sourceLine = Array.isArray(fromRaw?.lines) && fromRaw.lines.length ? fromRaw.lines[fromRaw.lines.length - 1] : null;
    const targetLine = Array.isArray(toRaw?.lines) && toRaw.lines.length ? toRaw.lines[0] : null;
    if (typeof sourceLine?.romOff !== 'number' || typeof targetLine?.romOff !== 'number') continue;
    const displayLine = displayLineByRomOff.get(sourceLine.romOff >>> 0);
    if (!displayLine) continue;
    if (!displayLine.flow || typeof displayLine.flow !== 'object') displayLine.flow = {};
    displayLine.flow[targetField] = targetLine.romOff >>> 0;
  }

  return displayAnalysis;
}
