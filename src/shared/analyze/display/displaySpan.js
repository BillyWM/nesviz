import { requireArray, requireInteger, requireObject } from '../dataShape.js';

function displayBlocksForAnalysis(displayAnalysis) {
  const analysis = requireObject(displayAnalysis, 'displayAnalysis');
  const blocks = Array.isArray(analysis.displayBlocks)
    ? analysis.displayBlocks
    : analysis.blocks;
  return requireArray(blocks, 'displayAnalysis.displayBlocks');
}

function normalizeSpan(span, label = 'display span') {
  const item = requireObject(span, label);
  const startRomOff = requireInteger(item.startRomOff, `${label}.startRomOff`) >>> 0;
  const endRomOff = requireInteger(item.endRomOff, `${label}.endRomOff`) >>> 0;
  if (endRomOff <= startRomOff) {
    return { ok: false, reason: 'invalidSpan', startRomOff, endRomOff };
  }
  return { ok: true, startRomOff, endRomOff };
}

function containsSpan(block, startRomOff, endRomOff) {
  const blockStart = requireInteger(block.romStart, 'displayBlock.romStart') >>> 0;
  const blockEnd = requireInteger(block.romEnd, 'displayBlock.romEnd') >>> 0;
  return startRomOff >= blockStart && endRomOff <= blockEnd;
}

function containsRomOff(block, romOff) {
  const blockStart = requireInteger(block.romStart, 'displayBlock.romStart') >>> 0;
  const blockEnd = requireInteger(block.romEnd, 'displayBlock.romEnd') >>> 0;
  return romOff >= blockStart && romOff < blockEnd;
}

function overlapsSpan(block, startRomOff, endRomOff) {
  const blockStart = requireInteger(block.romStart, 'displayBlock.romStart') >>> 0;
  const blockEnd = requireInteger(block.romEnd, 'displayBlock.romEnd') >>> 0;
  return blockStart < endRomOff && blockEnd > startRomOff;
}

function findLineIndexByRomOff(lines, romOff) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = requireObject(lines[i], `displayBlock.lines[${i}]`);
    if ((requireInteger(line.romOff, `displayBlock.lines[${i}].romOff`) >>> 0) === (romOff >>> 0)) return i;
  }
  return -1;
}

function findLineIndexContainingRomOff(lines, romOff) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = requireObject(lines[i], `displayBlock.lines[${i}]`);
    const lineStart = requireInteger(line.romOff, `displayBlock.lines[${i}].romOff`) >>> 0;
    const lineLen = requireInteger(line.len, `displayBlock.lines[${i}].len`) >>> 0;
    const lineEnd = lineStart + Math.max(1, lineLen);
    if (romOff >= lineStart && romOff < lineEnd) return i;
  }
  return -1;
}

export function isSpanWithinSingleDisplayBlock(displayAnalysis, span) {
  const normalized = normalizeSpan(span);
  if (!normalized.ok) return normalized;

  const { startRomOff, endRomOff } = normalized;
  const blocks = displayBlocksForAnalysis(displayAnalysis);
  const containing = [];

  for (const block of blocks) {
    const displayBlock = requireObject(block, 'displayBlock');
    if (containsSpan(displayBlock, startRomOff, endRomOff)) containing.push(displayBlock);
  }

  if (containing.length === 1) {
    return {
      ok: true,
      displayBlockId: containing[0].id
    };
  }
  if (containing.length > 1) {
    return { ok: false, reason: 'multipleContainingDisplayBlocks' };
  }

  const startBlocks = blocks.filter((block) => containsRomOff(requireObject(block, 'displayBlock'), startRomOff));
  const endBlocks = blocks.filter((block) => containsRomOff(requireObject(block, 'displayBlock'), endRomOff - 1));
  const overlapping = blocks.filter((block) => overlapsSpan(requireObject(block, 'displayBlock'), startRomOff, endRomOff));
  if (startBlocks.length > 0 && endBlocks.length > 0) return { ok: false, reason: 'crossDisplayBlock' };
  if (overlapping.length > 1) return { ok: false, reason: 'crossDisplayBlock' };
  return { ok: false, reason: 'noContainingDisplayBlock' };
}

export function locateDisplayBlockForSpan(displayAnalysis, span) {
  const normalized = normalizeSpan(span);
  if (!normalized.ok) return normalized;

  const containment = isSpanWithinSingleDisplayBlock(displayAnalysis, normalized);
  if (!containment.ok) return containment;

  const blocks = displayBlocksForAnalysis(displayAnalysis);
  const displayBlock = blocks.find((block) => block.id === containment.displayBlockId) || null;
  if (!displayBlock) return { ok: false, reason: 'noContainingDisplayBlock' };

  const lines = requireArray(displayBlock.lines, 'displayBlock.lines');
  const startAnchorRomOff = Number.isInteger(span.startAnchorRomOff)
    ? (span.startAnchorRomOff >>> 0)
    : normalized.startRomOff;
  const endAnchorRomOff = Number.isInteger(span.endAnchorRomOff)
    ? (span.endAnchorRomOff >>> 0)
    : ((normalized.endRomOff - 1) >>> 0);

  const startLineIndex = findLineIndexByRomOff(lines, startAnchorRomOff);
  if (startLineIndex < 0) return { ok: false, reason: 'missingStartLine', displayBlockId: containment.displayBlockId };

  let endLineIndex = findLineIndexByRomOff(lines, endAnchorRomOff);
  if (endLineIndex < 0 && !Number.isInteger(span.endAnchorRomOff)) {
    endLineIndex = findLineIndexContainingRomOff(lines, endAnchorRomOff);
  }
  if (endLineIndex < 0) return { ok: false, reason: 'missingEndLine', displayBlockId: containment.displayBlockId };
  if (endLineIndex <= startLineIndex) {
    return { ok: false, reason: 'backwardsOrZeroLineSpan', displayBlockId: containment.displayBlockId };
  }

  return {
    ok: true,
    displayBlock,
    displayBlockId: containment.displayBlockId,
    startLineIndex,
    endLineIndex,
    startLine: lines[startLineIndex],
    endLine: lines[endLineIndex]
  };
}
