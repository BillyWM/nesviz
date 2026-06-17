import { requireArray, requireInteger, requireObject } from '../dataShape.js';
import { countRangeBytes, extractRomReadDataRanges, subtractRanges } from '../memoryDiscoveries/romDataRanges.js';

function pct(part, total) {
  return total > 0 ? (part * 100) / total : 0;
}


function codeRangesFromCoalescedBlocks(coalescedBlocks) {
  return coalescedBlocks.map((block, index) => {
    requireObject(block, `summary coalescedBlocks[${index}]`);
    requireInteger(block.romStart, `summary coalescedBlocks[${index}].romStart`);
    requireInteger(block.romEnd, `summary coalescedBlocks[${index}].romEnd`);
    return { start: block.romStart >>> 0, end: block.romEnd >>> 0 };
  });
}

function countDataBytes(memoryDiscoveries, totalBytes, coalescedBlocks) {
  const romReadRanges = extractRomReadDataRanges(memoryDiscoveries, totalBytes);
  const codeRanges = codeRangesFromCoalescedBlocks(coalescedBlocks);
  return countRangeBytes(subtractRanges(romReadRanges, codeRanges));
}

function countInstructionBytes(instructions) {
  const covered = new Set();
  for (let i = 0; i < instructions.length; i += 1) {
    const instruction = instructions[i];
    requireInteger(instruction.romOff, `instructions[${i}].romOff`);
    requireInteger(instruction.size, `instructions[${i}].size`);
    for (let off = instruction.romOff; off < instruction.romOff + instruction.size; off += 1) {
      covered.add(off >>> 0);
    }
  }
  return covered.size;
}

export function generateSummary(context) {
  requireObject(context, 'summary context');
  const mapper = requireObject(context.mapper, 'summary context.mapper');
  const instructions = requireArray(context.instructions, 'summary context.instructions');
  const displayArtifacts = requireObject(context.displayArtifacts, 'summary context.displayArtifacts');
  const coalescedBlocks = requireArray(displayArtifacts.coalescedBlocks, 'summary displayArtifacts.coalescedBlocks');
  const displayAnalysis = requireObject(displayArtifacts.displayAnalysis, 'summary displayArtifacts.displayAnalysis');
  requireArray(displayAnalysis.blocks, 'summary displayArtifacts.displayAnalysis.blocks');

  const totalBytes = requireInteger(mapper.prgSize, 'summary mapper.prgSize');
  const codeBytes = countInstructionBytes(instructions);
  const memoryDiscoveries = context.memoryDiscoveries || displayAnalysis.memoryDiscoveries || null;
  const dataBytes = countDataBytes(memoryDiscoveries, totalBytes, coalescedBlocks);
  const unknownBytes = Math.max(0, totalBytes - codeBytes - dataBytes);
  const codePct = pct(codeBytes, totalBytes);
  const dataPct = pct(dataBytes, totalBytes);
  const unknownPct = pct(unknownBytes, totalBytes);
  const totalPct = pct(codeBytes + dataBytes, totalBytes);

  return {
    mapper: {
      id: mapper.id,
      kind: mapper.family,
      family: mapper.family,
      meta: mapper.meta,
      prgSize: mapper.prgSize
    },
    stats: {
      blockCount: coalescedBlocks.length,
      instructionCount: instructions.length,
      codePct,
      confirmedCodePctOfCode: codeBytes > 0 ? 100 : 0,
      probableCodePctOfCode: 0,
      dataPct,
      unknownPct,
      totalPct
    }
  };
}
