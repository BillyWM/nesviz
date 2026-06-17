import { ADDRESSING_MODES as AM } from '../../cpu6502/addressingModes.js';
import { OPCODES } from '../../cpu6502/opcodes.js';
import { hex2, hex4 } from '../../cpu6502/fmt.js';
import { EDGE_KINDS, FLOW_TYPES } from '../cfg/constants.js';
import { createMapperModel } from '../mapper/createMapperModel.js';
import { buildCoalescedBlocks } from '../coalesce/coalesceView.js';
import { ANALYSIS_ENGINE_ID } from '../analysisConstants.js';
import {
  buildInstructionMap,
  requireArray,
  requireBlockInstance,
  requireCoalescedBlock,
  requireDisplayBlock,
  requireEdge,
  requireInstructionExecution,
  requireInstructionFromMap,
  requireObject,
  requireRawBlock
} from '../dataShape.js';

function readU16le(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8)) & 0xffff;
}

function readS8(n) {
  const b = n & 0xff;
  return b < 0x80 ? b : b - 0x100;
}

function requirePrgBytes(analysis) {
  const prgBytes = analysis.prgBytes;
  if (!(prgBytes instanceof Uint8Array)) {
    throw new Error('buildDisplayAnalysis requires analysis.prgBytes to be a byte array');
  }
  return prgBytes;
}

function createDisplayMapper(analysis) {
  const mapperInfo = requireObject(analysis.mapper, 'analysis.mapper');
  const mapperMeta = requireObject(mapperInfo.meta, 'analysis.mapper.meta');
  return createMapperModel({
    prgBytes: requirePrgBytes(analysis),
    mapperMeta,
    mapperKind: typeof mapperInfo.kind === 'string' ? mapperInfo.kind : mapperInfo.family
  });
}

function operandText(mode, bytes, cpuAddr) {
  switch (mode) {
    case AM.IMPLIED:
      return '';
    case AM.ACCUMULATOR:
      return 'A';
    case AM.IMMEDIATE:
      return `#$${hex2(bytes[1])}`;
    case AM.ZERO_PAGE:
      return `$${hex2(bytes[1])}`;
    case AM.ZERO_PAGE_X:
      return `$${hex2(bytes[1])},X`;
    case AM.ZERO_PAGE_Y:
      return `$${hex2(bytes[1])},Y`;
    case AM.ABSOLUTE:
      return `$${hex4(readU16le(bytes, 1))}`;
    case AM.ABSOLUTE_X:
      return `$${hex4(readU16le(bytes, 1))},X`;
    case AM.ABSOLUTE_Y:
      return `$${hex4(readU16le(bytes, 1))},Y`;
    case AM.INDIRECT:
      return `($${hex4(readU16le(bytes, 1))})`;
    case AM.INDIRECT_X:
      return `($${hex2(bytes[1])},X)`;
    case AM.INDIRECT_Y:
      return `($${hex2(bytes[1])}),Y`;
    case AM.RELATIVE: {
      if (typeof cpuAddr !== 'number') return `$${hex2(bytes[1])}`;
      const target = (cpuAddr + 2 + readS8(bytes[1])) & 0xffff;
      return `$${hex4(target)}`;
    }
    default:
      throw new Error(`Unsupported addressing mode in display builder: ${mode}`);
  }
}

function requireOpcodeEntry(instruction) {
  const entry = OPCODES[instruction.opcode & 0xff];
  if (!entry) {
    throw new Error(`Missing opcode table entry for decoded opcode ${instruction.opcode} at romOff ${instruction.romOff}`);
  }
  return entry;
}

function buildBlockInstanceMaps(analysis) {
  const blockInstanceById = new Map();
  const blockById = new Map();

  const blocks = requireArray(analysis.blocks, 'analysis.blocks');
  for (let i = 0; i < blocks.length; i += 1) {
    const block = requireRawBlock(blocks[i], `analysis.blocks[${i}]`);
    if (blockById.has(block.blockId)) throw new Error(`Duplicate raw block id ${block.blockId}`);
    blockById.set(block.blockId, block);
  }

  const instances = requireArray(analysis.blockInstances, 'analysis.blockInstances');
  for (let i = 0; i < instances.length; i += 1) {
    const instance = requireBlockInstance(instances[i], `analysis.blockInstances[${i}]`);
    if (!blockById.has(instance.blockId)) {
      throw new Error(`Block instance ${instance.blockInstanceId} references missing raw block ${instance.blockId}`);
    }
    if (blockInstanceById.has(instance.blockInstanceId)) {
      throw new Error(`Duplicate block instance id ${instance.blockInstanceId}`);
    }
    blockInstanceById.set(instance.blockInstanceId, instance);
  }

  return { blockById, blockInstanceById };
}

function buildInstructionExecutionMaps(analysis, maps) {
  const instructionExecutionsByInstructionId = new Map();
  const executions = requireArray(analysis.instructionExecutions, 'analysis.instructionExecutions');

  for (let i = 0; i < executions.length; i += 1) {
    const execution = requireInstructionExecution(executions[i], `analysis.instructionExecutions[${i}]`);
    const instructionId = execution.instructionId >>> 0;
    requireInstructionFromMap(maps.instructionById, instructionId, `analysis.instructionExecutions[${i}].instructionId`);
    const blockInstance = maps.blockInstanceById.get(execution.blockInstanceId);
    if (!blockInstance) {
      throw new Error(`Instruction execution references missing block instance ${execution.blockInstanceId}`);
    }

    let list = instructionExecutionsByInstructionId.get(instructionId);
    if (!list) {
      list = [];
      instructionExecutionsByInstructionId.set(instructionId, list);
    }
    list.push({
      instructionId,
      siteKey: execution.siteKey,
      contextKey: execution.contextKey,
      cpuAddr: execution.cpuAddr & 0xffff,
      blockInstanceId: execution.blockInstanceId,
      reachability: typeof blockInstance.reachability === 'string' ? blockInstance.reachability : 'execution',
      decodeReason: typeof blockInstance.decodeReason === 'string' ? blockInstance.decodeReason : null
    });
  }

  return { instructionExecutionsByInstructionId };
}

function buildEdgeMaps(analysis, maps) {
  const edgesByFromInstructionId = new Map();
  const edges = requireArray(analysis.edges, 'analysis.edges');

  for (let i = 0; i < edges.length; i += 1) {
    const edge = requireEdge(edges[i], `analysis.edges[${i}]`);
    const instructionId = edge.fromInstructionId >>> 0;
    requireInstructionFromMap(maps.instructionById, instructionId, `analysis.edges[${i}].fromInstructionId`);
    if (!maps.blockInstanceById.has(edge.fromBlockInstanceId)) {
      throw new Error(`Edge ${edge.edgeId} references missing from block instance ${edge.fromBlockInstanceId}`);
    }
    if (!maps.blockInstanceById.has(edge.toBlockInstanceId)) {
      throw new Error(`Edge ${edge.edgeId} references missing to block instance ${edge.toBlockInstanceId}`);
    }

    let list = edgesByFromInstructionId.get(instructionId);
    if (!list) {
      list = [];
      edgesByFromInstructionId.set(instructionId, list);
    }
    list.push(edge);
  }

  return { edgesByFromInstructionId };
}


function addDeadCodeReason(deadCodeByInstructionId, instructionId, reason) {
  if (typeof reason !== 'string' || !reason) return;
  const key = instructionId >>> 0;
  let item = deadCodeByInstructionId.get(key);
  if (!item) {
    item = { reasons: [] };
    deadCodeByInstructionId.set(key, item);
  }
  if (!item.reasons.includes(reason)) item.reasons.push(reason);
}

function buildDeadCodeMaps(maps) {
  const deadCodeByInstructionId = new Map();

  for (const edges of maps.edgesByFromInstructionId.values()) {
    for (const edge of edges) {
      if (edge.kind !== EDGE_KINDS.PHYSICAL_CONTINUATION) continue;
      if (edge.deadCodeReason !== 'resolvedMapperWritePhysicalContinuation') continue;

      const targetInstance = maps.blockInstanceById.get(edge.toBlockInstanceId);
      if (!targetInstance) continue;
      if (targetInstance.reachability !== 'physicalOnly') continue;
      if (targetInstance.decodeReason !== 'afterMapperWriteOldPhysicalStream') continue;

      const targetBlock = maps.blockById.get(targetInstance.blockId);
      if (!targetBlock || !Array.isArray(targetBlock.instructionIds)) continue;
      for (const instructionId of targetBlock.instructionIds) {
        addDeadCodeReason(deadCodeByInstructionId, instructionId, edge.deadCodeReason);
      }
    }
  }

  return { deadCodeByInstructionId };
}

function deadCodeForInstruction(maps, instructionId) {
  const item = maps.deadCodeByInstructionId.get(instructionId >>> 0);
  if (!item || !Array.isArray(item.reasons) || item.reasons.length === 0) return null;
  return { reasons: item.reasons.slice() };
}

function buildResolvedIndirectJumpMaps(analysis) {
  const byInstructionId = new Map();
  const items = Array.isArray(analysis.abstractInterpretation?.resolvedIndirectJumps)
    ? analysis.abstractInterpretation.resolvedIndirectJumps
    : [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rawInstructionId = Number(item.instructionId);
    if (!Number.isFinite(rawInstructionId)) continue;
    const instructionId = rawInstructionId >>> 0;
    let list = byInstructionId.get(instructionId);
    if (!list) {
      list = [];
      byInstructionId.set(instructionId, list);
    }
    list.push(item);
  }

  return { resolvedIndirectJumpsByInstructionId: byInstructionId };
}

function resolutionMatchesExecution(resolution, execution) {
  if (!resolution || !execution) return false;
  if ((Number(resolution.instructionId) >>> 0) !== (Number(execution.instructionId) >>> 0)) return false;
  if (resolution.siteKey !== execution.siteKey) return false;
  if (resolution.contextKey !== execution.contextKey) return false;
  if (resolution.blockInstanceId !== execution.blockInstanceId) return false;
  return true;
}

function resolveIndirectJumpDisplayTarget(instruction, maps) {
  requireInstructionFromMap(maps.instructionById, instruction.instructionId >>> 0, 'indirect display jump instruction');
  if (instruction.flow.type !== FLOW_TYPES.JMP_INDIRECT) return null;

  const executions = executionsForInstruction(maps, instruction.instructionId);
  if (!executions.length) return null;
  const resolutions = maps.resolvedIndirectJumpsByInstructionId.get(instruction.instructionId >>> 0) || [];
  const targetRomOffs = [];

  for (const execution of executions) {
    const match = resolutions.find((resolution) => resolutionMatchesExecution(resolution, execution));
    if (!match) return null;
    const targetRomOff = Number(match.targetRomOff);
    if (!Number.isInteger(targetRomOff)) return null;
    targetRomOffs.push(targetRomOff >>> 0);
  }

  return uniqueNumberOrNull(targetRomOffs);
}

function enrichResolvedIndirectJumpFlow(out, instruction, maps) {
  if (out.targetRomOff !== undefined) return out;
  const targetRomOff = resolveIndirectJumpDisplayTarget(instruction, maps);
  if (targetRomOff === null) return out;
  return {
    ...out,
    targetRomOff
  };
}

function uniqueExecutions(executions) {
  const seen = new Set();
  const out = [];
  for (const execution of executions) {
    const key = `${execution.contextKey}|${execution.cpuAddr}|${execution.siteKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(execution);
  }
  return out;
}

function executionsForInstruction(maps, instructionId) {
  return uniqueExecutions(maps.instructionExecutionsByInstructionId.get(instructionId >>> 0) || []);
}

function computeRuntimeDisplayLocationMap(coalescedBlock, maps) {
  requireCoalescedBlock(coalescedBlock, 'coalesced block');
  const byInstructionId = new Map();

  for (const instructionId of coalescedBlock.instructionIds) {
    const executions = executionsForInstruction(maps, instructionId);
    if (!executions.length) {
      byInstructionId.set(instructionId >>> 0, {
        cpuAddr: null,
        cpuAddrCandidates: [],
        siteKey: null,
        contextKey: null
      });
      continue;
    }

    const first = executions[0];
    const cpuAddr = first.cpuAddr & 0xffff;
    const cpuAddrCandidates = Array.from(new Set(executions
      .map((execution) => execution.cpuAddr & 0xffff)))
      .sort((a, b) => a - b);
    let sameCpuAddr = true;
    let sameSiteKey = true;
    let sameContextKey = true;

    for (let i = 1; i < executions.length; i += 1) {
      const execution = executions[i];
      if ((execution.cpuAddr & 0xffff) !== cpuAddr) sameCpuAddr = false;
      if (execution.siteKey !== first.siteKey) sameSiteKey = false;
      if (execution.contextKey !== first.contextKey) sameContextKey = false;
    }

    byInstructionId.set(instructionId >>> 0, {
      cpuAddr: sameCpuAddr ? cpuAddr : null,
      cpuAddrCandidates,
      siteKey: sameSiteKey ? first.siteKey : null,
      contextKey: sameContextKey ? first.contextKey : null
    });
  }

  return byInstructionId;
}

function computeRuntimeLocations(coalescedBlock, maps) {
  requireCoalescedBlock(coalescedBlock, 'coalesced block');
  const grouped = new Map();

  for (const instructionId of coalescedBlock.instructionIds) {
    const instruction = requireInstructionFromMap(maps.instructionById, instructionId, `${coalescedBlock.coalescedBlockId}.instructionId`);
    for (const execution of executionsForInstruction(maps, instructionId)) {
      const key = `${execution.contextKey}|${execution.blockInstanceId}`;
      let location = grouped.get(key);
      if (!location) {
        location = {
          contextKey: execution.contextKey,
          blockInstanceId: execution.blockInstanceId,
          siteKey: execution.siteKey,
          cpuStart: execution.cpuAddr & 0xffff,
          cpuEnd: (execution.cpuAddr + instruction.size) & 0xffff
        };
        grouped.set(key, location);
      } else {
        location.cpuStart = Math.min(location.cpuStart, execution.cpuAddr & 0xffff);
        location.cpuEnd = Math.max(location.cpuEnd, (execution.cpuAddr + instruction.size) & 0xffff);
      }
    }
  }

  const deduped = new Map();
  for (const location of grouped.values()) {
    const key = `${location.contextKey}|${location.cpuStart}|${location.cpuEnd}`;
    if (!deduped.has(key)) deduped.set(key, location);
  }
  return Array.from(deduped.values()).sort((a, b) => a.cpuStart - b.cpuStart);
}

function allExecutionsArePhysicalOnly(executions) {
  return executions.length > 0 && executions.every((execution) => execution.reachability === 'physicalOnly');
}

function uniqueNumberOrNull(values) {
  let out = null;
  for (const value of values) {
    if (typeof value !== 'number') return null;
    const normalized = value >>> 0;
    if (out === null) out = normalized;
    else if (out !== normalized) return null;
  }
  return out;
}

function resolvePhysicalOnlyDirectJumpTarget(instruction, maps) {
  requireInstructionFromMap(maps.instructionById, instruction.instructionId >>> 0, 'physical-only jump instruction');
  if (instruction.flow.type !== FLOW_TYPES.JUMP) return null;
  const targetCpuAddr = Number(instruction.flow.target);
  if (!Number.isInteger(targetCpuAddr)) return null;

  const executions = executionsForInstruction(maps, instruction.instructionId);
  if (!allExecutionsArePhysicalOnly(executions)) return null;

  const targetRomOffs = [];
  for (const execution of executions) {
    const mapperContext = maps.contexts[execution.contextKey];
    if (!mapperContext) return null;
    const resolved = maps.mapper.resolveControlTarget(mapperContext, targetCpuAddr & 0xffff, {
      policy: 'exactOnly',
      purpose: 'physicalOnlyDisplayTarget'
    });
    requireObject(resolved, 'physical-only display target resolution');
    if (!resolved.ok) return null;
    const target = requireObject(resolved.target, 'physical-only display target');
    const romOff = Number(target.romOff);
    if (!Number.isInteger(romOff)) return null;
    targetRomOffs.push(romOff >>> 0);
  }

  return uniqueNumberOrNull(targetRomOffs);
}

function enrichPhysicalOnlyDirectJumpFlow(out, instruction, maps) {
  if (out.targetRomOff !== undefined) return out;
  const targetRomOff = resolvePhysicalOnlyDirectJumpTarget(instruction, maps);
  if (targetRomOff === null) return out;
  return {
    ...out,
    targetRomOff
  };
}

function enrichFlow(flow, instruction, maps) {
  requireObject(flow, `instruction ${instruction.instructionId}.flow`);
  let out = { ...flow };

  for (const edge of maps.edgesByFromInstructionId.get(instruction.instructionId >>> 0) || []) {
    if (edge.kind === EDGE_KINDS.BRANCH_TAKEN || edge.kind === EDGE_KINDS.JUMP || edge.kind === EDGE_KINDS.CALL) {
      out.targetRomOff = edge.targetRomOff >>> 0;
    } else if (edge.kind === EDGE_KINDS.BRANCH_NOT_TAKEN) {
      out.fallthroughRomOff = edge.targetRomOff >>> 0;
    } else if (edge.kind === EDGE_KINDS.FALLTHROUGH) {
      if (out.type === 'next') out.nextRomOff = edge.targetRomOff >>> 0;
      else out.fallthroughRomOff = edge.targetRomOff >>> 0;
    }
  }

  out = enrichPhysicalOnlyDirectJumpFlow(out, instruction, maps);
  out = enrichResolvedIndirectJumpFlow(out, instruction, maps);
  return out;
}

function displayLineForInstruction(analysis, instruction, maps, runtimeLocationByInstructionId) {
  const prgBytes = requirePrgBytes(analysis);
  const entry = requireOpcodeEntry(instruction);
  const size = instruction.size;
  if (instruction.romOff + size > prgBytes.length) {
    throw new Error(`Display line instruction extends beyond PRG bytes at romOff ${instruction.romOff}`);
  }
  const bytes = Array.from(prgBytes.subarray(instruction.romOff, instruction.romOff + size));
  const location = runtimeLocationByInstructionId.get(instruction.instructionId >>> 0);
  if (!location) throw new Error(`Missing runtime display location for instruction ${instruction.instructionId}`);
  const cpuAddr = typeof location.cpuAddr === 'number' ? (location.cpuAddr & 0xffff) : null;
  const cpuAddrCandidates = Array.isArray(location.cpuAddrCandidates)
    ? location.cpuAddrCandidates
      .filter((addr) => Number.isInteger(addr))
      .map((addr) => addr & 0xffff)
    : [];
  const bytesText = bytes.map(hex2).join(' ');
  const operand = operandText(entry.mode, bytes, cpuAddr);
  const asm = operand ? `${entry.mnemonic} ${operand}` : entry.mnemonic;

  return {
    instructionId: instruction.instructionId >>> 0,
    siteKey: location.siteKey,
    contextKey: location.contextKey,
    backing: { kind: 'exact', romOff: instruction.romOff >>> 0 },
    romOff: instruction.romOff >>> 0,
    cpuAddr,
    cpuAddrCandidates,
    len: size,
    bytesText,
    asm,
    mnemonic: entry.mnemonic,
    mode: entry.mode,
    flow: enrichFlow(instruction.flow, instruction, maps),
    deadCode: deadCodeForInstruction(maps, instruction.instructionId)
  };
}

function displayBlockForCoalescedBlock(analysis, coalescedBlock, maps) {
  requireCoalescedBlock(coalescedBlock, 'coalesced block');
  const runtimeLocationByInstructionId = computeRuntimeDisplayLocationMap(coalescedBlock, maps);
  const lines = coalescedBlock.instructionIds
    .map((id) => requireInstructionFromMap(maps.instructionById, id, `${coalescedBlock.coalescedBlockId}.instructionId`))
    .map((instruction) => displayLineForInstruction(analysis, instruction, maps, runtimeLocationByInstructionId));

  if (!lines.length) throw new Error(`Coalesced block ${coalescedBlock.coalescedBlockId} produced no display lines`);

  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  const hasSingleRuntimeLocation = lines.every((line) => typeof line.cpuAddr === 'number');
  const runtimeLocations = computeRuntimeLocations(coalescedBlock, maps);

  const displayBlock = {
    id: coalescedBlock.coalescedBlockId,
    coalescedBlockId: coalescedBlock.coalescedBlockId,
    romStart: coalescedBlock.romStart,
    romEnd: coalescedBlock.romEnd,
    sourceBlockIds: coalescedBlock.sourceBlockIds.slice(),
    producedBy: coalescedBlock.producedBy.slice(),
    cpuStart: hasSingleRuntimeLocation ? firstLine.cpuAddr : null,
    cpuEnd: hasSingleRuntimeLocation ? ((lastLine.cpuAddr + lastLine.len) & 0xffff) : null,
    runtimeLocations,
    lines
  };

  return requireDisplayBlock(displayBlock, displayBlock.id);
}

function validateCoalescedResult(coalescedResult) {
  requireObject(coalescedResult, 'coalesced result');
  const coalescedBlocks = requireArray(coalescedResult.coalescedBlocks, 'coalescedResult.coalescedBlocks');
  for (let i = 0; i < coalescedBlocks.length; i += 1) {
    requireCoalescedBlock(coalescedBlocks[i], `coalescedResult.coalescedBlocks[${i}]`);
  }
  requireArray(coalescedResult.timeline, 'coalescedResult.timeline');
  requireObject(coalescedResult.blockIdToCoalescedBlockId, 'coalescedResult.blockIdToCoalescedBlockId');
  return coalescedResult;
}

export function buildDisplayAnalysis(analysis, coalesced = null) {
  requireObject(analysis, 'analysis');
  const instructionById = buildInstructionMap(analysis.instructions, 'analysis.instructions');
  const maps = {
    instructionById,
    contexts: requireObject(analysis.contexts, 'analysis.contexts'),
    mapper: createDisplayMapper(analysis),
    ...buildBlockInstanceMaps(analysis)
  };
  Object.assign(maps, buildInstructionExecutionMaps(analysis, maps));
  Object.assign(maps, buildEdgeMaps(analysis, maps));
  Object.assign(maps, buildDeadCodeMaps(maps));
  Object.assign(maps, buildResolvedIndirectJumpMaps(analysis));

  const coalescedResult = validateCoalescedResult(coalesced === null ? buildCoalescedBlocks(analysis) : coalesced);
  const displayBlocks = coalescedResult.coalescedBlocks.map((block) => displayBlockForCoalescedBlock(analysis, block, maps));

  const displayAnalysis = {
    engine: ANALYSIS_ENGINE_ID,
    blocks: displayBlocks,
    displayBlocks,
    coalescedBlocks: coalescedResult.coalescedBlocks,
    timeline: coalescedResult.timeline
  };

  if (analysis.memoryDiscoveries && typeof analysis.memoryDiscoveries === 'object') {
    displayAnalysis.memoryDiscoveries = analysis.memoryDiscoveries;
  }

  return {
    analysis: displayAnalysis,
    rawToDisplayBlockIds: coalescedResult.blockIdToCoalescedBlockId
  };
}
