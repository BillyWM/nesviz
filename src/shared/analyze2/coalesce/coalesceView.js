import { OPCODES } from '../../cpu6502/opcodes.js';
import { EDGE_KINDS } from '../cfg/constants.js';
import { extractRomReadDataRanges, subtractRanges } from '../memoryDiscoveries/romDataRanges.js';
import { makeCoalescedBlockId } from '../identity.js';
import {
  buildInstructionMap,
  requireArray,
  requireCoalescedBlock,
  requireEdge,
  requireInstructionFromMap,
  requireNumber,
  requireObject,
  requireRawBlock
} from '../dataShape.js';

const BRANCH_OVER_HARD_STOP_MAX_INSTR = 16;
const HARD_STOP_MNEMONICS = new Set(['BRK', 'JMP', 'RTS', 'RTI']);
const BRANCH_EDGE_KINDS = new Set([EDGE_KINDS.BRANCH_TAKEN]);

function requireOpcodeEntry(instruction) {
  const entry = OPCODES[instruction.opcode & 0xff];
  if (!entry) {
    throw new Error(`Missing opcode table entry for decoded opcode ${instruction.opcode} at romOff ${instruction.romOff}`);
  }
  return entry;
}

function lastInstructionOfBlock(instructionById, block) {
  requireRawBlock(block, 'raw block');
  return requireInstructionFromMap(
    instructionById,
    block.instructionIds[block.instructionIds.length - 1],
    `${block.blockId}.lastInstructionId`
  );
}

function instructionMnemonic(instruction) {
  return requireOpcodeEntry(instruction).mnemonic;
}

function isHardStopInstruction(instruction) {
  return HARD_STOP_MNEMONICS.has(instructionMnemonic(instruction));
}

function isBareRtsGroup(group, instructionById) {
  requireCoalescedBlock(group, 'coalesced group');
  if (group.instructionIds.length !== 1) return false;
  return instructionMnemonic(requireInstructionFromMap(instructionById, group.instructionIds[0], `${group.coalescedBlockId}.instructionIds[0]`)) === 'RTS';
}

function isContiguous(a, b) {
  requireObject(a, 'left block/group');
  requireObject(b, 'right block/group');
  requireNumber(a.romEnd, 'left.romEnd');
  requireNumber(b.romStart, 'right.romStart');
  return a.romEnd === b.romStart;
}

function maybeContiguous(a, b) {
  if (!a || !b) return false;
  return isContiguous(a, b);
}

function dedupeStrings(values) {
  return Array.from(new Set(values)).sort();
}

function sourceIdsForMember(member) {
  if (typeof member.blockId === 'string' && member.blockId) return [member.blockId];
  requireCoalescedBlock(member, 'coalesced member');
  return member.sourceBlockIds;
}

function producedByForMember(member) {
  if (typeof member.producedBy === 'string' && member.producedBy) return [member.producedBy];
  requireCoalescedBlock(member, 'coalesced member');
  return member.producedBy;
}

function instructionIdsForMember(member) {
  if (Array.isArray(member.instructionIds)) return member.instructionIds;
  throw new Error('Coalesced member is missing instructionIds');
}

function makeGroup(members) {
  const arr = requireArray(members, 'coalesced group members');
  if (!arr.length) throw new Error('Cannot build a coalesced block from an empty member list');

  const sourceBlockIds = [];
  const producedBy = [];
  const instructionIds = [];
  let romStart = null;
  let romEnd = null;

  for (let i = 0; i < arr.length; i += 1) {
    const member = requireObject(arr[i], `coalesced group member ${i}`);
    requireNumber(member.romStart, `coalesced group member ${i}.romStart`);
    requireNumber(member.romEnd, `coalesced group member ${i}.romEnd`);
    if (i > 0 && !isContiguous(arr[i - 1], member)) {
      throw new Error('Cannot coalesce non-contiguous physical code members');
    }
    if (romStart === null || member.romStart < romStart) romStart = member.romStart >>> 0;
    if (romEnd === null || member.romEnd > romEnd) romEnd = member.romEnd >>> 0;
    sourceBlockIds.push(...sourceIdsForMember(member));
    producedBy.push(...producedByForMember(member));
    instructionIds.push(...instructionIdsForMember(member));
  }

  const group = {
    coalescedBlockId: makeCoalescedBlockId(romStart),
    romStart,
    romEnd,
    sourceBlockIds: dedupeStrings(sourceBlockIds),
    producedBy: dedupeStrings(producedBy),
    instructionIds
  };
  return requireCoalescedBlock(group, group.coalescedBlockId);
}

function buildPrimaryGroups(instructionById, sortedBlocks) {
  const groups = [];

  for (let i = 0; i < sortedBlocks.length; ) {
    const members = [];
    let j = i;

    while (j < sortedBlocks.length) {
      const block = requireRawBlock(sortedBlocks[j], `sorted raw block ${j}`);
      members.push(block);

      const next = sortedBlocks[j + 1] || null;
      const canContinue = next ? isContiguous(block, next) : false;
      const hardStop = isHardStopInstruction(lastInstructionOfBlock(instructionById, block));
      j += 1;

      if (!canContinue || hardStop) break;
    }

    groups.push(makeGroup(members));
    i = j;
  }

  return groups;
}

function buildBranchTargetRomOffsByInstructionId(analysis) {
  const out = new Map();
  for (const edge of requireArray(analysis.edges, 'analysis.edges')) {
    requireObject(edge, 'analysis edge');
    if (!BRANCH_EDGE_KINDS.has(edge.kind)) continue;
    requireEdge(edge, `edge ${edge.edgeId || '(missing id)'}`);
    const fromInstructionId = edge.fromInstructionId >>> 0;
    let targets = out.get(fromInstructionId);
    if (!targets) {
      targets = [];
      out.set(fromInstructionId, targets);
    }
    targets.push(edge.targetRomOff >>> 0);
  }
  return out;
}

function countInstrFromGroupIndexToRomStart(groups, startIndex, targetRomOff, maxInstr) {
  let count = 0;

  for (let i = startIndex; i < groups.length; i += 1) {
    const group = requireCoalescedBlock(groups[i], `coalesced group ${i}`);
    if (i > startIndex && !isContiguous(groups[i - 1], group)) {
      return { found: false, index: null, count };
    }

    if ((group.romStart >>> 0) === (targetRomOff >>> 0)) {
      return { found: true, index: i, count };
    }

    count += group.instructionIds.length;
    if (count > maxInstr) return { found: false, index: null, count };
  }

  return { found: false, index: null, count };
}

function branchOverHardStopTargetIndex(instructionById, groups, groupIndex, branchTargetRomOffsByInstructionId) {
  const group = requireCoalescedBlock(groups[groupIndex], `coalesced group ${groupIndex}`);
  const last = requireInstructionFromMap(
    instructionById,
    group.instructionIds[group.instructionIds.length - 1],
    `${group.coalescedBlockId}.lastInstructionId`
  );
  if (!isHardStopInstruction(last)) return null;

  let bestIndex = null;
  for (const instructionId of group.instructionIds) {
    const targets = branchTargetRomOffsByInstructionId.get(instructionId >>> 0) || [];
    for (const targetRomOff of targets) {
      if ((targetRomOff >>> 0) <= (group.romEnd >>> 0)) continue;
      const result = countInstrFromGroupIndexToRomStart(
        groups,
        groupIndex + 1,
        targetRomOff,
        BRANCH_OVER_HARD_STOP_MAX_INSTR
      );
      if (!result.found || typeof result.index !== 'number') continue;
      if (bestIndex === null || result.index > bestIndex) bestIndex = result.index;
    }
  }

  return bestIndex;
}

function applyBranchOverHardStop(analysis, instructionById, groups) {
  const branchTargetRomOffsByInstructionId = buildBranchTargetRomOffsByInstructionId(analysis);
  const out = [];

  for (let i = 0; i < groups.length; ) {
    let endIndex = i;

    while (endIndex < groups.length) {
      const targetIndex = branchOverHardStopTargetIndex(instructionById, groups, endIndex, branchTargetRomOffsByInstructionId);
      if (targetIndex === null || targetIndex <= endIndex) break;

      let contiguous = true;
      for (let k = endIndex; k < targetIndex; k += 1) {
        if (!isContiguous(groups[k], groups[k + 1])) {
          contiguous = false;
          break;
        }
      }
      if (!contiguous) break;
      endIndex = targetIndex;
    }

    out.push(makeGroup(groups.slice(i, endIndex + 1)));
    i = endIndex + 1;
  }

  return out;
}

function applyBareRtsAbsorption(instructionById, groups) {
  let current = requireArray(groups, 'coalesced groups');

  while (true) {
    const next = [];
    let changed = false;

    for (const group of current) {
      requireCoalescedBlock(group, 'coalesced group');
      const prev = next[next.length - 1] || null;
      if (prev && isBareRtsGroup(group, instructionById) && maybeContiguous(prev, group)) {
        next.pop();
        next.push(makeGroup([prev, group]));
        changed = true;
        continue;
      }
      next.push(group);
    }

    if (!changed) return next;
    current = next;
  }
}

function sizeClass(byteLen) {
  if (byteLen <= 10) return 'small';
  if (byteLen <= 50) return 'medium';
  return 'large';
}

function codeRangeForBlock(block) {
  requireCoalescedBlock(block, 'timeline coalesced block');
  return { start: block.romStart >>> 0, end: block.romEnd >>> 0 };
}

function codeTimelineItem(block) {
  requireCoalescedBlock(block, 'timeline coalesced block');
  return {
    type: 'code',
    blockId: block.coalescedBlockId,
    coalescedBlockId: block.coalescedBlockId,
    romStart: block.romStart,
    romEnd: block.romEnd,
    byteLen: (block.romEnd - block.romStart) | 0
  };
}

function dataTimelineItem(range) {
  const byteLen = (range.end - range.start) | 0;
  return {
    type: 'data',
    id: `data:${range.start.toString(16)}-${range.end.toString(16)}`,
    romStart: range.start,
    romEnd: range.end,
    byteLen,
    sizeClass: sizeClass(byteLen)
  };
}

function unknownTimelineItem(start, end) {
  const byteLen = (end - start) | 0;
  return { type: 'unknown', romStart: start, romEnd: end, byteLen, sizeClass: sizeClass(byteLen) };
}

function buildTimeline(prgSize, coalescedBlocks, memoryDiscoveries = null) {
  requireNumber(prgSize, 'analysis.mapper.prgSize');
  const sortedBlocks = [...requireArray(coalescedBlocks, 'coalescedBlocks')]
    .map((block, index) => requireCoalescedBlock(block, `timeline coalescedBlocks[${index}]`))
    .sort((a, b) => a.romStart - b.romStart || a.romEnd - b.romEnd);
  const codeRanges = sortedBlocks.map((block) => codeRangeForBlock(block));
  const dataRanges = subtractRanges(extractRomReadDataRanges(memoryDiscoveries, prgSize), codeRanges);
  const occupied = [
    ...sortedBlocks.map((block) => codeTimelineItem(block)),
    ...dataRanges.map((range) => dataTimelineItem(range))
  ].sort((a, b) => a.romStart - b.romStart || a.romEnd - b.romEnd || (a.type === 'code' ? -1 : 1));

  const out = [];
  let offset = 0;

  for (const item of occupied) {
    if (item.romEnd <= offset) continue;
    if (item.romStart > offset) out.push(unknownTimelineItem(offset, item.romStart));
    if (item.romStart < offset) {
      const romEnd = item.romEnd;
      const romStart = offset;
      const byteLen = romEnd - romStart;
      out.push({ ...item, romStart, romEnd, byteLen, sizeClass: item.type === 'code' ? item.sizeClass : sizeClass(byteLen) });
      offset = Math.max(offset, romEnd);
      continue;
    }
    out.push(item);
    offset = Math.max(offset, item.romEnd);
  }

  if (prgSize > offset) out.push(unknownTimelineItem(offset, prgSize));
  return out;
}

export function buildCoalescedBlocks(analysis) {
  requireObject(analysis, 'analysis');
  const blocks = requireArray(analysis.blocks, 'analysis.blocks');
  const mapper = requireObject(analysis.mapper, 'analysis.mapper');
  requireNumber(mapper.prgSize, 'analysis.mapper.prgSize');

  const instructionById = buildInstructionMap(analysis.instructions, 'analysis.instructions');
  const edges = requireArray(analysis.edges, 'analysis.edges');
  for (let i = 0; i < edges.length; i += 1) requireEdge(edges[i], `analysis.edges[${i}]`);
  const sorted = [...blocks].map((block, index) => requireRawBlock(block, `analysis.blocks[${index}]`)).sort((a, b) => a.romStart - b.romStart);
  const primary = buildPrimaryGroups(instructionById, sorted);
  const branchMerged = applyBranchOverHardStop(analysis, instructionById, primary);
  const coalescedBlocks = applyBareRtsAbsorption(instructionById, branchMerged);

  const blockIdToCoalescedBlockId = {};
  for (const coalescedBlock of coalescedBlocks) {
    requireCoalescedBlock(coalescedBlock, 'coalesced block');
    for (const blockId of coalescedBlock.sourceBlockIds) {
      blockIdToCoalescedBlockId[blockId] = coalescedBlock.coalescedBlockId;
    }
  }

  return {
    coalescedBlocks,
    timeline: buildTimeline(mapper.prgSize, coalescedBlocks, analysis.memoryDiscoveries),
    blockIdToCoalescedBlockId
  };
}

export function buildCoalescedAnalysisView(analysis) {
  const coalesced = buildCoalescedBlocks(analysis);
  return {
    blocks: coalesced.coalescedBlocks,
    coalescedBlocks: coalesced.coalescedBlocks,
    timeline: coalesced.timeline,
    blockIdToDisplayBlockId: coalesced.blockIdToCoalescedBlockId,
    blockIdToCoalescedBlockId: coalesced.blockIdToCoalescedBlockId
  };
}
