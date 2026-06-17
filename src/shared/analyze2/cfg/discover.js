import {
  EDGE_KINDS,
  FLOW_TYPES,
  FRONTIER_KINDS,
  PRODUCED_BY
} from './constants.js';
import { decodeInstructionAtRomOff, decodeInstructionAtSite } from './decode.js';
import { CONTROL_TRANSFER_RESULT_KINDS } from '../mapper/controlTransfer.js';
import {
  createBranchPruningState,
  getBranchFeasibility,
  isBranchPrunedToSingleEdge,
  updateBranchPruningStateForInstruction
} from './branchPruning.js';
import { classifyInstructionWriteEffect } from '../mapper/writeEffects.js';
import { transferInstruction } from '../abstractInterpretation/transfer.js';
import { unknownEntryStateForMapperContext } from '../abstractInterpretation/state.js';
import {
  makeBlockId,
  makeBlockInstanceId,
  makeEdgeId,
  makeFrontierId,
  makeSiteKey
} from '../identity.js';
import {
  requireArray,
  requireInteger,
  requireInstruction,
  requireObject,
  requireString
} from '../dataShape.js';

function requireSite(site, label = 'site') {
  requireObject(site, label);
  requireString(site.siteKey, `${label}.siteKey`);
  requireString(site.contextKey, `${label}.contextKey`);
  requireInteger(site.cpuAddr, `${label}.cpuAddr`);
  requireInteger(site.romOff, `${label}.romOff`);
  requireObject(site.mapperContext, `${label}.mapperContext`);
  return site;
}

function requireFrontier(frontier, label = 'frontier') {
  requireObject(frontier, label);
  requireString(frontier.frontierId, `${label}.frontierId`);
  requireString(frontier.kind, `${label}.kind`);
  requireString(frontier.siteKey, `${label}.siteKey`);
  requireString(frontier.contextKey, `${label}.contextKey`);
  requireInteger(frontier.cpuAddr, `${label}.cpuAddr`);
  if (frontier.romOff !== undefined && frontier.romOff !== null) requireInteger(frontier.romOff, `${label}.romOff`);
  return frontier;
}

function makeQueueKey(site) {
  return requireSite(site, 'queue site').siteKey;
}

function originFieldsFromSite(site) {
  requireObject(site, 'origin site');
  const out = {};
  if (typeof site.reachability === 'string') out.reachability = site.reachability;
  if (typeof site.decodeReason === 'string') out.decodeReason = site.decodeReason;
  if (typeof site.seedKind === 'string') out.seedKind = site.seedKind;
  if (typeof site.expandCfgFrontierId === 'string') out.expandCfgFrontierId = site.expandCfgFrontierId;
  if (typeof site.excavationKind === 'string') out.excavationKind = site.excavationKind;
  if (typeof site.excavationCandidateId === 'string') out.excavationCandidateId = site.excavationCandidateId;
  if (typeof site.recognitionMode === 'string') out.recognitionMode = site.recognitionMode;
  return out;
}

function originFieldsFromBlockInstance(instance) {
  requireObject(instance, 'origin block instance');
  const out = {};
  if (instance.reachability === 'excavated') out.reachability = 'excavated';
  if (typeof instance.decodeReason === 'string') out.decodeReason = instance.decodeReason;
  if (typeof instance.seedKind === 'string') out.seedKind = instance.seedKind;
  if (typeof instance.expandCfgFrontierId === 'string') out.expandCfgFrontierId = instance.expandCfgFrontierId;
  if (typeof instance.excavationKind === 'string') out.excavationKind = instance.excavationKind;
  if (typeof instance.excavationCandidateId === 'string') out.excavationCandidateId = instance.excavationCandidateId;
  if (typeof instance.recognitionMode === 'string') out.recognitionMode = instance.recognitionMode;
  return out;
}

function inheritOrigin(targetSite, fromInstance) {
  const inherited = originFieldsFromBlockInstance(fromInstance);
  if (!Object.keys(inherited).length) return targetSite;
  return { ...targetSite, ...inherited };
}

function createFrontier(kind, site, detail = null) {
  requireObject(site, 'frontier site');
  requireString(site.siteKey, 'frontier site.siteKey');
  requireString(site.contextKey, 'frontier site.contextKey');
  requireInteger(site.cpuAddr, 'frontier site.cpuAddr');

  const frontier = {
    frontierId: makeFrontierId(kind, site.siteKey),
    kind,
    siteKey: site.siteKey,
    contextKey: site.contextKey,
    cpuAddr: site.cpuAddr & 0xffff
  };
  if (typeof site.romOff === 'number') frontier.romOff = site.romOff >>> 0;
  if (detail !== null) frontier.detail = requireObject(detail, 'frontier detail');
  return requireFrontier(frontier, `frontier ${frontier.frontierId}`);
}

function makeControlTransferRequest(fromInstruction, kind) {
  requireInstruction(fromInstruction, 'control transfer source instruction');
  requireString(kind, 'control transfer edge kind');
  const flow = requireObject(fromInstruction.flow, 'control transfer source flow');
  const transfer = {
    sourceRomOff: fromInstruction.romOff >>> 0,
    instructionSize: fromInstruction.size >>> 0,
    transferKind: kind,
    fromInstructionId: fromInstruction.instructionId >>> 0,
    edgeKind: kind
  };

  if (kind === EDGE_KINDS.BRANCH_TAKEN) {
    transfer.displacement = requireInteger(fromInstruction.operand, 'branch displacement operand') & 0xff;
  } else if (kind === EDGE_KINDS.CALL || kind === EDGE_KINDS.JUMP) {
    transfer.targetCpuAddr = requireInteger(flow.target, 'absolute control transfer target') & 0xffff;
  }

  return transfer;
}

export function createStrictCfgPhase({ mapper, prgBytes, seedSites, acceptedCodeSpans = [] }) {
  requireObject(mapper, 'strict CFG mapper');
  if (!(prgBytes instanceof Uint8Array)) throw new Error('strict CFG requires PRG bytes');
  requireArray(seedSites, 'strict CFG seedSites');
  requireArray(acceptedCodeSpans, 'strict CFG acceptedCodeSpans');

  const state = {
    initialized: false,
    queue: [],
    queuedKeys: new Set(),
    visitedBlockStartSites: new Set(),
    siteToBlockInstanceId: new Map(),
    siteToInstructionId: new Map(),
    leaderRomOffs: new Set(),
    ownedRomOffToBlockId: new Map(),
    current: null,
    mapperContextByKey: new Map(),

    instructions: [],
    instructionById: new Map(),
    blocks: [],
    blockById: new Map(),
    blockInstances: [],
    blockInstanceById: new Map(),
    blockInstanceIdsByBlockId: new Map(),
    instructionExecutions: [],
    instructionExecutionKeys: new Set(),
    edges: [],
    edgeIds: new Set(),
    pendingEdges: [],
    frontiers: [],
    frontierIds: new Set(),

    counters: {
      seedCount: seedSites.length,
      decodedInstructions: 0,
      physicalBlockCount: 0,
      blockInstanceCount: 0,
      edgeCount: 0,
      fallthroughEdgeCount: 0,
      branchEdgeCount: 0,
      jumpEdgeCount: 0,
      callEdgeCount: 0,
      physicalContinuationEdgeCount: 0,
      frontierCount: 0,
      indirectJumpFrontierCount: 0,
      ambiguousDirectTargetFrontierCount: 0,
      unmappedTargetFrontierCount: 0,
      decodeFailedFrontierCount: 0,
      possibleMapperWriteFrontierCount: 0,
      unsupportedControlFlowFrontierCount: 0,
      queuedSites: 0,
      visitedSites: 0,
      pendingEdgeCount: 0,
      forcedBranches: 0,
      prunedBranchEdges: 0,
      blockSplits: 0,
      mapperWritesObserved: 0,
      mapperWritesResolved: 0,
      mapperWritesUnresolved: 0,
      rtsStops: 0,
      rtiStops: 0,
      brkStops: 0
    }
  };

  function rememberMapperContext(contextKey, mapperContext) {
    requireString(contextKey, 'mapper context key');
    requireObject(mapperContext, 'mapper context');
    const existing = state.mapperContextByKey.get(contextKey);
    if (existing && existing !== mapperContext) {
      throw new Error(`Mapper context key ${contextKey} was registered with two different context objects`);
    }
    state.mapperContextByKey.set(contextKey, mapperContext);
  }

  function mapperContextForKey(contextKey) {
    requireString(contextKey, 'mapper context lookup key');
    const mapperContext = state.mapperContextByKey.get(contextKey);
    if (!mapperContext) throw new Error(`Missing mapper context for key ${contextKey}`);
    return mapperContext;
  }

  function requireInstructionById(instructionId, label) {
    requireInteger(instructionId, label);
    const key = instructionId >>> 0;
    const instruction = state.instructionById.get(key);
    if (!instruction) throw new Error(`Missing decoded instruction for romOff ${key}`);
    return instruction;
  }

  function replaceInstructionIfUnexecuted(instruction) {
    requireInstruction(instruction, 'replacement instruction');
    const instructionId = instruction.instructionId >>> 0;
    const existing = state.instructionById.get(instructionId);
    if (!existing) {
      state.instructions.push(instruction);
      state.instructionById.set(instructionId, instruction);
      state.counters.decodedInstructions = state.instructions.length;
      return instruction;
    }

    const hasExecution = state.instructionExecutions.some((execution) => (execution.instructionId >>> 0) === instructionId);
    if (hasExecution) return existing;

    state.instructionById.set(instructionId, instruction);
    const index = state.instructions.findIndex((item) => (item.instructionId >>> 0) === instructionId);
    if (index >= 0) state.instructions[index] = instruction;
    else state.instructions.push(instruction);
    state.counters.decodedInstructions = state.instructions.length;
    return instruction;
  }

  function requireBlockById(blockId, label = 'blockId') {
    requireString(blockId, label);
    const block = state.blockById.get(blockId);
    if (!block) throw new Error(`Missing raw block ${blockId}`);
    return block;
  }

  function requireBlockInstanceById(blockInstanceId, label = 'blockInstanceId') {
    requireString(blockInstanceId, label);
    const instance = state.blockInstanceById.get(blockInstanceId);
    if (!instance) throw new Error(`Missing block instance ${blockInstanceId}`);
    return instance;
  }

  function blockContainsInstruction(block, instructionId) {
    const normalized = requireInteger(instructionId, 'block instructionId') >>> 0;
    return block.instructionIds.some((id) => (id >>> 0) === normalized);
  }

  function blockInstanceIdSetForBlock(blockId) {
    requireString(blockId, 'block instance set blockId');
    let set = state.blockInstanceIdsByBlockId.get(blockId);
    if (!set) {
      set = new Set();
      state.blockInstanceIdsByBlockId.set(blockId, set);
    }
    return set;
  }

  function possibleCpuAddrForSpanInstruction(span, instructionRomOff) {
    const appearances = Array.isArray(span.possibleAppearances) ? span.possibleAppearances : [];
    for (const appearance of appearances) {
      if (!appearance || typeof appearance !== 'object') continue;
      const appearanceRomOff = Number(appearance.romOff);
      const appearanceCpuAddr = Number(appearance.cpuAddr);
      if (!Number.isInteger(appearanceRomOff) || !Number.isInteger(appearanceCpuAddr)) continue;
      const delta = (instructionRomOff >>> 0) - (appearanceRomOff >>> 0);
      if (delta < 0) continue;
      return (appearanceCpuAddr + delta) & 0xffff;
    }
    return instructionRomOff & 0xffff;
  }

  function cpuAddrForAcceptedInstruction(appearance, instructionRomOff) {
    requireSite(appearance, 'accepted code runtime appearance');
    const baseRomOff = appearance.romOff >>> 0;
    const targetRomOff = requireInteger(instructionRomOff, 'accepted code instruction romOff') >>> 0;
    if (targetRomOff < baseRomOff) return null;
    return (appearance.cpuAddr + (targetRomOff - baseRomOff)) & 0xffff;
  }

  function acceptedRuntimeAppearancesForSpan(span) {
    if (typeof mapper.unambiguousAcceptedCodeAppearances !== 'function') return [];
    const appearances = mapper.unambiguousAcceptedCodeAppearances(span);
    if (!Array.isArray(appearances) || appearances.length !== 1) return [];
    const appearance = requireSite(appearances[0], 'unambiguous accepted code appearance');
    if ((appearance.romOff >>> 0) !== (span.romStart >>> 0)) return [];
    return [appearance];
  }

  function materializeAcceptedCodeSpanAppearance(span, block, decodedInstructions, appearance) {
    requireObject(span, 'accepted code span');
    requireObject(block, 'accepted code block');
    requireArray(decodedInstructions, 'accepted code decoded instructions');
    requireSite(appearance, 'accepted code runtime appearance');
    rememberMapperContext(appearance.contextKey, appearance.mapperContext);

    const firstInstruction = requireInstruction(decodedInstructions[0], 'accepted code block first instruction');
    const blockCpuAddr = cpuAddrForAcceptedInstruction(appearance, firstInstruction.romOff);
    if (blockCpuAddr === null) {
      throw new Error(`Cannot place accepted code block ${block.blockId}; no CPU address for first instruction ${firstInstruction.instructionId}`);
    }
    const blockSiteKey = makeSiteKey(appearance.contextKey, blockCpuAddr);
    const blockInstanceId = makeBlockInstanceId(appearance.contextKey, blockCpuAddr);
    registerBlockInstance({
      blockInstanceId,
      blockId: block.blockId,
      siteKey: blockSiteKey,
      contextKey: appearance.contextKey,
      cpuStart: blockCpuAddr & 0xffff,
      producedBy: block.producedBy,
      reachability: 'acceptedPhysicalCode',
      decodeReason: block.decodeReason,
      seedKind: 'acceptedCode',
      excavationKind: typeof span.kind === 'string' ? span.kind : undefined,
      excavationCandidateId: typeof span.candidateId === 'string' ? span.candidateId : undefined,
      recognitionMode: typeof span.recognitionMode === 'string' ? span.recognitionMode : undefined
    });
    state.siteToBlockInstanceId.set(blockSiteKey, blockInstanceId);

    for (const instruction of decodedInstructions) {
      const cpuAddr = cpuAddrForAcceptedInstruction(appearance, instruction.romOff);
      if (cpuAddr === null) continue;
      const siteKey = makeSiteKey(appearance.contextKey, cpuAddr);
      state.siteToInstructionId.set(siteKey, instruction.instructionId >>> 0);
      addInstructionExecution({
        instructionId: instruction.instructionId,
        siteKey,
        contextKey: appearance.contextKey,
        cpuAddr,
        blockInstanceId
      });
    }

    return blockInstanceId;
  }

  function acceptedInstructionCpuToRomOff(span, decodedInstructions) {
    requireObject(span, 'accepted code span');
    requireArray(decodedInstructions, 'accepted code decoded instructions');
    const out = new Map();
    for (const instruction of decodedInstructions) {
      requireInstruction(instruction, 'accepted code decoded instruction');
      const cpuAddr = possibleCpuAddrForSpanInstruction(span, instruction.romOff);
      out.set(cpuAddr & 0xffff, instruction.romOff >>> 0);
    }
    return out;
  }

  function addAcceptedLeaderForCpuAddr(leaders, cpuToRomOff, cpuAddr) {
    requireObject(leaders, 'accepted code leader set');
    requireObject(cpuToRomOff, 'accepted code CPU map');
    const romOff = cpuToRomOff.get(requireInteger(cpuAddr, 'accepted code leader cpuAddr') & 0xffff);
    if (typeof romOff === 'number') leaders.add(romOff >>> 0);
  }

  function acceptedCodeBlockChunks(span, decodedInstructions) {
    requireObject(span, 'accepted code span');
    requireArray(decodedInstructions, 'accepted code decoded instructions');
    if (!decodedInstructions.length) return [];

    const cpuToRomOff = acceptedInstructionCpuToRomOff(span, decodedInstructions);
    const leaders = new Set([decodedInstructions[0].romOff >>> 0]);

    for (let i = 0; i < decodedInstructions.length; i += 1) {
      const instruction = requireInstruction(decodedInstructions[i], 'accepted code decoded instruction');
      const flow = requireObject(instruction.flow, 'accepted code instruction.flow');
      const nextInstruction = decodedInstructions[i + 1] || null;

      if (flow.type === FLOW_TYPES.BRANCH) {
        addAcceptedLeaderForCpuAddr(leaders, cpuToRomOff, requireInteger(flow.target, 'accepted code branch target'));
        addAcceptedLeaderForCpuAddr(leaders, cpuToRomOff, requireInteger(flow.fallthrough, 'accepted code branch fallthrough'));
      } else if (flow.type === FLOW_TYPES.CALL) {
        addAcceptedLeaderForCpuAddr(leaders, cpuToRomOff, requireInteger(flow.target, 'accepted code call target'));
        addAcceptedLeaderForCpuAddr(leaders, cpuToRomOff, requireInteger(flow.fallthrough, 'accepted code call fallthrough'));
      } else if (flow.type === FLOW_TYPES.JUMP) {
        addAcceptedLeaderForCpuAddr(leaders, cpuToRomOff, requireInteger(flow.target, 'accepted code jump target'));
      }

      if (nextInstruction && flow.type !== FLOW_TYPES.NEXT) {
        leaders.add(nextInstruction.romOff >>> 0);
      }
    }

    const chunks = [];
    let current = [];
    function flushCurrent() {
      if (!current.length) return;
      chunks.push(current);
      current = [];
    }

    for (let i = 0; i < decodedInstructions.length; i += 1) {
      const instruction = requireInstruction(decodedInstructions[i], 'accepted code decoded instruction');
      if (current.length && leaders.has(instruction.romOff >>> 0)) flushCurrent();
      current.push(instruction);

      const nextInstruction = decodedInstructions[i + 1] || null;
      if (!nextInstruction) {
        flushCurrent();
        continue;
      }
      if (instruction.flow.type !== FLOW_TYPES.NEXT || leaders.has(nextInstruction.romOff >>> 0)) {
        flushCurrent();
      }
    }

    return chunks;
  }

  function branchPruningStateForAcceptedBlock(decodedInstructions) {
    requireArray(decodedInstructions, 'accepted code block instructions');
    let branchPruningState = createBranchPruningState();
    for (const instruction of decodedInstructions) {
      branchPruningState = updateBranchPruningStateForInstruction(
        branchPruningState,
        requireInstruction(instruction, 'accepted code block instruction')
      );
    }
    return branchPruningState;
  }

  function normalizeAcceptedCodeSpan(span, index) {
    requireObject(span, `accepted code span ${index}`);
    const instructionRomOffs = requireArray(span.instructionRomOffs, `accepted code span ${index}.instructionRomOffs`)
      .map((item, itemIndex) => requireInteger(item, `accepted code span ${index}.instructionRomOffs[${itemIndex}]`) >>> 0);
    if (!instructionRomOffs.length) throw new Error(`accepted code span ${index}.instructionRomOffs must not be empty`);
    const romStart = requireInteger(span.romStart ?? instructionRomOffs[0], `accepted code span ${index}.romStart`) >>> 0;
    const romEnd = requireInteger(span.romEnd, `accepted code span ${index}.romEnd`) >>> 0;
    if (romEnd <= romStart) throw new Error(`accepted code span ${index}.romEnd must be greater than romStart`);
    return {
      ...span,
      romStart,
      romEnd,
      instructionRomOffs
    };
  }

  function preloadAcceptedCodeSpan(rawSpan, index) {
    const span = normalizeAcceptedCodeSpan(rawSpan, index);
    const decodedInstructions = [];

    for (const instructionRomOff of span.instructionRomOffs) {
      if (state.ownedRomOffToBlockId.has(instructionRomOff)) return false;
      const decoded = decodeInstructionAtRomOff({
        prgBytes,
        romOff: instructionRomOff,
        cpuAddr: possibleCpuAddrForSpanInstruction(span, instructionRomOff)
      });
      requireObject(decoded, 'accepted code decoded instruction result');
      if (!decoded.ok) return false;
      const instruction = requireInstruction(decoded.instruction, 'accepted code decoded instruction');
      decodedInstructions.push(instruction);
    }

    const chunks = acceptedCodeBlockChunks(span, decodedInstructions);
    for (const chunk of chunks) {
      const first = requireInstruction(chunk[0], 'accepted code block first instruction');
      if (state.blockById.has(makeBlockId(first.romOff))) return false;
    }

    const blocks = [];
    for (const chunk of chunks) {
      const first = requireInstruction(chunk[0], 'accepted code block first instruction');
      const last = requireInstruction(chunk[chunk.length - 1], 'accepted code block last instruction');
      const block = {
        blockId: makeBlockId(first.romOff),
        romStart: first.romOff >>> 0,
        romEnd: (last.romOff + last.size) >>> 0,
        producedBy: typeof span.source === 'string' && span.source ? span.source : 'acceptedCode',
        reachability: 'acceptedPhysicalCode',
        decodeReason: typeof span.kind === 'string' && span.kind ? `acceptedCode/${span.kind}` : 'acceptedCode',
        instructionIds: chunk.map((instruction) => requireInstruction(instruction, 'accepted code block instruction').instructionId >>> 0)
      };

      state.blockById.set(block.blockId, block);
      state.blocks.push(block);
      state.leaderRomOffs.add(block.romStart >>> 0);
      blocks.push({ block, decodedInstructions: chunk });
    }
    state.counters.physicalBlockCount = state.blocks.length;

    for (const instruction of decodedInstructions) {
      replaceInstructionIfUnexecuted(instruction);
    }
    for (const item of blocks) {
      for (const instruction of item.decodedInstructions) {
        state.ownedRomOffToBlockId.set(instruction.romOff >>> 0, item.block.blockId);
      }
    }

    const appearances = acceptedRuntimeAppearancesForSpan(span);
    if (appearances.length === 1) {
      const appearance = appearances[0];
      const blockInstances = [];
      for (const item of blocks) {
        blockInstances.push({
          ...item,
          blockInstanceId: materializeAcceptedCodeSpanAppearance(span, item.block, item.decodedInstructions, appearance)
        });
      }
      for (const item of blockInstances) {
        materializeBlockExitEdges(
          item.block,
          item.blockInstanceId,
          appearance.mapperContext,
          branchPruningStateForAcceptedBlock(item.decodedInstructions)
        );
      }
    }

    return true;
  }

  function preloadAcceptedCodeSpans() {
    for (let i = 0; i < acceptedCodeSpans.length; i += 1) {
      preloadAcceptedCodeSpan(acceptedCodeSpans[i], i);
    }
  }

  function registerBlockInstance(blockInstance) {
    requireObject(blockInstance, 'block instance');
    requireString(blockInstance.blockInstanceId, 'block instance.blockInstanceId');
    requireString(blockInstance.blockId, 'block instance.blockId');
    requireString(blockInstance.siteKey, 'block instance.siteKey');
    requireString(blockInstance.contextKey, 'block instance.contextKey');
    requireInteger(blockInstance.cpuStart, 'block instance.cpuStart');
    requireString(blockInstance.producedBy, 'block instance.producedBy');
    requireBlockById(blockInstance.blockId, 'block instance.blockId');

    const existing = state.blockInstanceById.get(blockInstance.blockInstanceId);
    if (existing) {
      if (existing.blockId !== blockInstance.blockId) {
        throw new Error(`Block instance ${blockInstance.blockInstanceId} already points at ${existing.blockId}, not ${blockInstance.blockId}`);
      }
      return existing.blockInstanceId;
    }

    const normalized = {
      blockInstanceId: blockInstance.blockInstanceId,
      blockId: blockInstance.blockId,
      siteKey: blockInstance.siteKey,
      contextKey: blockInstance.contextKey,
      cpuStart: blockInstance.cpuStart & 0xffff,
      producedBy: blockInstance.producedBy
    };
    if (typeof blockInstance.reachability === 'string') normalized.reachability = blockInstance.reachability;
    if (typeof blockInstance.decodeReason === 'string') normalized.decodeReason = blockInstance.decodeReason;
    if (typeof blockInstance.seedKind === 'string') normalized.seedKind = blockInstance.seedKind;
    if (typeof blockInstance.excavationKind === 'string') normalized.excavationKind = blockInstance.excavationKind;
    if (typeof blockInstance.excavationCandidateId === 'string') normalized.excavationCandidateId = blockInstance.excavationCandidateId;
    if (typeof blockInstance.recognitionMode === 'string') normalized.recognitionMode = blockInstance.recognitionMode;
    state.blockInstanceById.set(normalized.blockInstanceId, normalized);
    state.blockInstances.push(normalized);
    blockInstanceIdSetForBlock(normalized.blockId).add(normalized.blockInstanceId);
    state.counters.blockInstanceCount = state.blockInstances.length;
    return normalized.blockInstanceId;
  }

  function rebuildInstructionExecutionKeys() {
    const next = new Set();
    for (const execution of state.instructionExecutions) {
      requireInteger(execution.instructionId, 'instruction execution.instructionId');
      requireString(execution.siteKey, 'instruction execution.siteKey');
      requireString(execution.contextKey, 'instruction execution.contextKey');
      requireInteger(execution.cpuAddr, 'instruction execution.cpuAddr');
      requireString(execution.blockInstanceId, 'instruction execution.blockInstanceId');
      requireBlockInstanceById(execution.blockInstanceId, 'instruction execution.blockInstanceId');
      requireInstructionById(execution.instructionId, 'instruction execution.instructionId');
      const key = `${execution.blockInstanceId}|${execution.siteKey}|${execution.instructionId >>> 0}`;
      if (next.has(key)) throw new Error(`Duplicate instruction execution ${key}`);
      next.add(key);
    }
    state.instructionExecutionKeys = next;
  }

  function rebuildEdgeIds() {
    const next = new Set();
    for (const edge of state.edges) {
      requireString(edge.edgeId, 'edge.edgeId');
      requireString(edge.fromBlockInstanceId, 'edge.fromBlockInstanceId');
      requireString(edge.toBlockInstanceId, 'edge.toBlockInstanceId');
      requireString(edge.kind, 'edge.kind');
      requireInteger(edge.fromInstructionId, 'edge.fromInstructionId');
      requireInteger(edge.targetCpuAddr, 'edge.targetCpuAddr');
      requireInteger(edge.targetRomOff, 'edge.targetRomOff');
      const fromInstance = requireBlockInstanceById(edge.fromBlockInstanceId, 'edge.fromBlockInstanceId');
      const toInstance = requireBlockInstanceById(edge.toBlockInstanceId, 'edge.toBlockInstanceId');
      const fromBlock = requireBlockById(fromInstance.blockId, 'edge.from blockId');
      const toBlock = requireBlockById(toInstance.blockId, 'edge.to blockId');
      if (!blockContainsInstruction(fromBlock, edge.fromInstructionId)) {
        throw new Error(`Edge ${edge.edgeId} starts at instruction ${edge.fromInstructionId} outside source block ${fromBlock.blockId}`);
      }
      if ((toBlock.romStart >>> 0) !== (edge.targetRomOff >>> 0)) {
        throw new Error(`Edge ${edge.edgeId} target romOff ${edge.targetRomOff} does not match target block start ${toBlock.romStart}`);
      }
      if (next.has(edge.edgeId)) throw new Error(`Duplicate edge id ${edge.edgeId}`);
      next.add(edge.edgeId);
    }
    state.edgeIds = next;
    state.counters.edgeCount = state.edges.length;
  }

  function addPhysicalLeader(site) {
    requireSite(site, 'physical leader site');
    rememberMapperContext(site.contextKey, site.mapperContext);
    state.leaderRomOffs.add(site.romOff >>> 0);
  }

  function enqueue(site) {
    requireSite(site, 'queued site');
    rememberMapperContext(site.contextKey, site.mapperContext);
    if (state.visitedBlockStartSites.has(site.siteKey)) return;
    if (state.siteToBlockInstanceId.has(site.siteKey)) return;
    const key = makeQueueKey(site);
    if (state.queuedKeys.has(key)) return;
    addPhysicalLeader(site);
    state.queuedKeys.add(key);
    state.queue.push(site);
    state.counters.queuedSites = state.queue.length;
  }

  function incrementFrontierKindCounter(kind) {
    switch (kind) {
      case FRONTIER_KINDS.INDIRECT_JUMP:
        state.counters.indirectJumpFrontierCount += 1;
        break;
      case FRONTIER_KINDS.AMBIGUOUS_DIRECT_TARGET:
        state.counters.ambiguousDirectTargetFrontierCount += 1;
        break;
      case FRONTIER_KINDS.UNMAPPED_TARGET:
        state.counters.unmappedTargetFrontierCount += 1;
        break;
      case FRONTIER_KINDS.DECODE_FAILED:
        state.counters.decodeFailedFrontierCount += 1;
        break;
      case FRONTIER_KINDS.POSSIBLE_MAPPER_WRITE:
        state.counters.possibleMapperWriteFrontierCount += 1;
        break;
      case FRONTIER_KINDS.UNSUPPORTED_CONTROL_FLOW:
        state.counters.unsupportedControlFlowFrontierCount += 1;
        break;
      default:
        break;
    }
  }

  function addFrontier(frontier) {
    requireFrontier(frontier, 'frontier');
    if (state.frontierIds.has(frontier.frontierId)) return;
    state.frontierIds.add(frontier.frontierId);
    state.frontiers.push(frontier);
    state.counters.frontierCount = state.frontiers.length;
    incrementFrontierKindCounter(frontier.kind);
  }

  function addEdge(fromBlockInstanceId, toBlockInstanceId, kind, detail) {
    requireString(fromBlockInstanceId, 'edge.fromBlockInstanceId');
    requireString(toBlockInstanceId, 'edge.toBlockInstanceId');
    requireString(kind, 'edge.kind');
    requireObject(detail, 'edge detail');
    requireInteger(detail.fromInstructionId, 'edge.detail.fromInstructionId');
    requireInteger(detail.targetCpuAddr, 'edge.detail.targetCpuAddr');
    requireInteger(detail.targetRomOff, 'edge.detail.targetRomOff');

    const fromInstance = requireBlockInstanceById(fromBlockInstanceId, 'edge.fromBlockInstanceId');
    const toInstance = requireBlockInstanceById(toBlockInstanceId, 'edge.toBlockInstanceId');
    const fromBlock = requireBlockById(fromInstance.blockId, 'edge.from blockId');
    const toBlock = requireBlockById(toInstance.blockId, 'edge.to blockId');
    if (!blockContainsInstruction(fromBlock, detail.fromInstructionId)) {
      throw new Error(`Cannot add ${kind} edge from instruction ${detail.fromInstructionId} outside source block ${fromBlock.blockId}`);
    }
    if ((toBlock.romStart >>> 0) !== (detail.targetRomOff >>> 0)) {
      throw new Error(`Cannot add ${kind} edge to ${toBlock.blockId}: target romOff ${detail.targetRomOff} does not match block start ${toBlock.romStart}`);
    }

    const edgeId = makeEdgeId(fromBlockInstanceId, toBlockInstanceId, kind);
    if (state.edgeIds.has(edgeId)) return;
    const edge = {
      edgeId,
      fromBlockInstanceId,
      toBlockInstanceId,
      kind,
      fromInstructionId: detail.fromInstructionId >>> 0,
      targetCpuAddr: detail.targetCpuAddr & 0xffff,
      targetRomOff: detail.targetRomOff >>> 0
    };
    if (typeof detail.deadCodeReason === 'string' && detail.deadCodeReason) {
      edge.deadCodeReason = detail.deadCodeReason;
    }
    state.edgeIds.add(edgeId);
    state.edges.push(edge);
    state.counters.edgeCount = state.edges.length;
    switch (kind) {
      case EDGE_KINDS.FALLTHROUGH:
        state.counters.fallthroughEdgeCount += 1;
        break;
      case EDGE_KINDS.BRANCH_TAKEN:
      case EDGE_KINDS.BRANCH_NOT_TAKEN:
        state.counters.branchEdgeCount += 1;
        break;
      case EDGE_KINDS.JUMP:
        state.counters.jumpEdgeCount += 1;
        break;
      case EDGE_KINDS.CALL:
        state.counters.callEdgeCount += 1;
        break;
      case EDGE_KINDS.PHYSICAL_CONTINUATION:
        state.counters.physicalContinuationEdgeCount += 1;
        break;
      default:
        break;
    }
  }

  function addPendingEdge(fromBlockInstanceId, targetSite, kind, detail) {
    requireString(fromBlockInstanceId, 'pending edge.fromBlockInstanceId');
    requireSite(targetSite, 'pending edge target site');
    requireString(kind, 'pending edge.kind');
    requireObject(detail, 'pending edge detail');
    requireInteger(detail.fromInstructionId, 'pending edge.detail.fromInstructionId');
    requireString(detail.fromSiteKey, 'pending edge.detail.fromSiteKey');
    requireInteger(detail.targetCpuAddr, 'pending edge.detail.targetCpuAddr');
    requireInteger(detail.targetRomOff, 'pending edge.detail.targetRomOff');

    state.pendingEdges.push({
      fromBlockInstanceId,
      fromSiteKey: detail.fromSiteKey,
      fromInstructionId: detail.fromInstructionId >>> 0,
      targetSite,
      kind,
      targetCpuAddr: detail.targetCpuAddr & 0xffff,
      targetRomOff: detail.targetRomOff >>> 0
    });
    state.counters.pendingEdgeCount = state.pendingEdges.length;
  }

  function addInstructionExecution(execution) {
    requireObject(execution, 'instruction execution');
    requireInteger(execution.instructionId, 'instruction execution.instructionId');
    requireString(execution.siteKey, 'instruction execution.siteKey');
    requireString(execution.contextKey, 'instruction execution.contextKey');
    requireInteger(execution.cpuAddr, 'instruction execution.cpuAddr');
    requireString(execution.blockInstanceId, 'instruction execution.blockInstanceId');

    const instructionId = execution.instructionId >>> 0;
    requireInstructionById(instructionId, 'instruction execution.instructionId');
    requireBlockInstanceById(execution.blockInstanceId, 'instruction execution.blockInstanceId');
    const key = `${execution.blockInstanceId}|${execution.siteKey}|${instructionId}`;
    if (state.instructionExecutionKeys.has(key)) return;
    state.instructionExecutionKeys.add(key);
    state.instructionExecutions.push({
      instructionId,
      siteKey: execution.siteKey,
      contextKey: execution.contextKey,
      cpuAddr: execution.cpuAddr & 0xffff,
      blockInstanceId: execution.blockInstanceId
    });
  }

  function strictDomainOptions() {
    return { mapperDomain: mapper.mapperDomain };
  }

  function strictTransferEnv(contextKey) {
    const contexts = {};
    for (const [key, mapperContext] of state.mapperContextByKey.entries()) {
      contexts[key] = mapperContext;
    }
    return {
      mapper,
      prgBytes,
      contexts,
      contextKey
    };
  }

  function transferStrictAbstractStateForInstruction(instruction) {
    if (!state.current || !state.current.abstractState) return;
    state.current.abstractState = transferInstruction(
      state.current.abstractState,
      instruction,
      strictTransferEnv(state.current.contextKey),
      strictDomainOptions()
    );
  }

  function resolveMapperWriteFallthroughTarget(instruction) {
    if (!state.current || !state.current.abstractState) return null;
    if (instruction.flow.type !== FLOW_TYPES.NEXT) return null;
    if (typeof mapper.contextFromMapperState !== 'function') return null;

    const nextMapperContext = mapper.contextFromMapperState(state.current.abstractState.mapperState);
    if (!nextMapperContext) return null;
    const nextContextKey = mapper.contextKey(nextMapperContext);
    rememberMapperContext(nextContextKey, nextMapperContext);

    const resolved = mapper.resolveControlTarget(nextMapperContext, instruction.flow.next & 0xffff, {
      policy: 'exactOnly',
      purpose: 'mapperWriteFallthrough'
    });
    requireObject(resolved, 'mapper-write fallthrough target resolution');
    if (!resolved.ok) return null;
    return requireSite(resolved.target, 'mapper-write fallthrough target');
  }

  function recordMapperWriteExit(instruction, site, writeEffect) {
    requireInstruction(instruction, 'mapper-write exit instruction');
    requireSite(site, 'mapper-write exit site');
    requireObject(writeEffect, 'mapper-write exit effect');
    if (!state.current) throw new Error('Cannot record mapper-write exit without an active block');

    state.counters.mapperWritesObserved += 1;
    const target = resolveMapperWriteFallthroughTarget(instruction);
    if (target) state.counters.mapperWritesResolved += 1;
    else state.counters.mapperWritesUnresolved += 1;

    state.current.exitOverride = {
      kind: 'mapperWrite',
      sourceSite: {
        siteKey: site.siteKey,
        contextKey: site.contextKey,
        cpuAddr: site.cpuAddr & 0xffff,
        romOff: site.romOff >>> 0
      },
      fromInstructionId: instruction.instructionId >>> 0,
      sourceRomOff: instruction.romOff >>> 0,
      fallthroughCpuAddr: instruction.flow.type === FLOW_TYPES.NEXT ? (instruction.flow.next & 0xffff) : null,
      writeEffectKind: String(writeEffect.kind || 'possibleMapperWrite'),
      targetKind: String(writeEffect.targetKind || 'unknown'),
      target
    };
  }

  function isHardPhysicalContinuationTerminator(instruction) {
    requireInstruction(instruction, 'physical continuation terminator instruction');
    return instruction.flow.type === FLOW_TYPES.JUMP ||
      instruction.flow.type === FLOW_TYPES.JMP_INDIRECT ||
      instruction.flow.type === FLOW_TYPES.STOP;
  }

  function oldPhysicalFallthroughSiteForMapperWrite(exitOverride) {
    requireObject(exitOverride, 'physical continuation exit override');
    if (exitOverride.fallthroughCpuAddr === null || exitOverride.fallthroughCpuAddr === undefined) return null;
    const sourceSite = requireObject(exitOverride.sourceSite, 'physical continuation sourceSite');
    const mapperContext = mapperContextForKey(sourceSite.contextKey);
    const resolved = mapper.resolveControlTarget(mapperContext, exitOverride.fallthroughCpuAddr & 0xffff, {
      policy: 'exactOnly',
      purpose: 'physicalContinuationAfterMapperWrite'
    });
    requireObject(resolved, 'physical continuation old fallthrough resolution');
    if (!resolved.ok) return null;
    return requireSite(resolved.target, 'physical continuation old fallthrough target');
  }

  function preflightPhysicalContinuation(startSite) {
    requireSite(startSite, 'physical continuation startSite');
    const entries = [];
    const seenRomOffs = new Set();
    let cpuAddr = startSite.cpuAddr & 0xffff;
    let expectedRomOff = startSite.romOff >>> 0;

    while (true) {
      const decoded = decodeInstructionAtSite({
        prgBytes,
        mapper,
        mapperContext: startSite.mapperContext,
        cpuAddr
      });
      requireObject(decoded, 'physical continuation decoded instruction result');
      if (!decoded.ok) return null;

      const instruction = requireInstruction(decoded.instruction, 'physical continuation decoded instruction');
      const site = requireSite(decoded.site, 'physical continuation decoded site');
      const romOff = site.romOff >>> 0;
      if (romOff !== expectedRomOff) return null;
      if (seenRomOffs.has(romOff)) return null;
      if (isPhysicalBoundary(romOff)) return null;

      seenRomOffs.add(romOff);
      entries.push({ instruction, site });

      if (isHardPhysicalContinuationTerminator(instruction)) {
        return { startSite, entries };
      }

      if (instruction.flow.type !== FLOW_TYPES.NEXT) return null;
      cpuAddr = instruction.flow.next & 0xffff;
      expectedRomOff = (instruction.romOff + instruction.size) >>> 0;
      if (expectedRomOff >= prgBytes.length) return null;
    }
  }

  function commitPhysicalContinuationSpan(span) {
    requireObject(span, 'physical continuation span');
    const entries = requireArray(span.entries, 'physical continuation entries');
    if (entries.length === 0) return null;
    const startSite = requireSite(span.startSite, 'physical continuation span startSite');
    rememberMapperContext(startSite.contextKey, startSite.mapperContext);

    const first = requireInstruction(entries[0].instruction, 'physical continuation first instruction');
    const last = requireInstruction(entries[entries.length - 1].instruction, 'physical continuation last instruction');
    const blockId = makeBlockId(first.romOff);
    if (state.blockById.has(blockId)) return null;

    for (const entry of entries) {
      const instruction = requireInstruction(entry.instruction, 'physical continuation instruction');
      const site = requireSite(entry.site, 'physical continuation instruction site');
      if (state.ownedRomOffToBlockId.has(instruction.romOff >>> 0)) return null;
      if (state.leaderRomOffs.has(instruction.romOff >>> 0)) return null;
      rememberMapperContext(site.contextKey, site.mapperContext);
    }

    const instructionIds = entries.map((entry) => requireInstruction(entry.instruction, 'physical continuation instruction').instructionId >>> 0);
    const block = {
      blockId,
      romStart: first.romOff >>> 0,
      romEnd: (last.romOff + last.size) >>> 0,
      producedBy: PRODUCED_BY.EXACT_CFG_PASS,
      reachability: 'physicalOnly',
      decodeReason: 'afterMapperWriteOldPhysicalStream',
      instructionIds
    };

    state.blockById.set(blockId, block);
    state.blocks.push(block);
    state.counters.physicalBlockCount = state.blocks.length;

    for (const entry of entries) {
      const instruction = requireInstruction(entry.instruction, 'physical continuation instruction');
      const instructionId = instruction.instructionId >>> 0;
      if (!state.instructionById.has(instructionId)) {
        state.instructions.push(instruction);
        state.instructionById.set(instructionId, instruction);
        state.counters.decodedInstructions = state.instructions.length;
      }
      state.ownedRomOffToBlockId.set(instruction.romOff >>> 0, blockId);
    }

    const blockInstanceId = makeBlockInstanceId(startSite.contextKey, startSite.cpuAddr);
    registerBlockInstance({
      blockInstanceId,
      blockId,
      siteKey: startSite.siteKey,
      contextKey: startSite.contextKey,
      cpuStart: startSite.cpuAddr & 0xffff,
      producedBy: PRODUCED_BY.EXACT_CFG_PASS,
      reachability: 'physicalOnly',
      decodeReason: 'afterMapperWriteOldPhysicalStream'
    });
    state.siteToBlockInstanceId.set(startSite.siteKey, blockInstanceId);

    for (const entry of entries) {
      const instruction = requireInstruction(entry.instruction, 'physical continuation instruction');
      const site = requireSite(entry.site, 'physical continuation instruction site');
      state.siteToInstructionId.set(site.siteKey, instruction.instructionId >>> 0);
      addInstructionExecution({
        instructionId: instruction.instructionId,
        siteKey: site.siteKey,
        contextKey: site.contextKey,
        cpuAddr: site.cpuAddr & 0xffff,
        blockInstanceId
      });
    }

    return blockInstanceId;
  }

  function materializePhysicalContinuation(blockInstanceId, exitOverride) {
    requireString(blockInstanceId, 'physical continuation source blockInstanceId');
    requireObject(exitOverride, 'physical continuation exit override');
    const oldTarget = oldPhysicalFallthroughSiteForMapperWrite(exitOverride);
    if (!oldTarget) return;
    if (exitOverride.target && (exitOverride.target.romOff >>> 0) === (oldTarget.romOff >>> 0)) return;

    const span = preflightPhysicalContinuation(oldTarget);
    if (!span) return;
    const targetBlockInstanceId = commitPhysicalContinuationSpan(span);
    if (!targetBlockInstanceId) return;

    const sourceSite = requireObject(exitOverride.sourceSite, 'physical continuation sourceSite');
    const actualFromBlockInstanceId = sourceBlockInstanceIdForInstruction(
      blockInstanceId,
      sourceSite.siteKey,
      exitOverride.fromInstructionId
    );
    const deadCodeReason = exitOverride.target && ((exitOverride.target.romOff >>> 0) !== (oldTarget.romOff >>> 0))
      ? 'resolvedMapperWritePhysicalContinuation'
      : null;
    addEdge(actualFromBlockInstanceId, targetBlockInstanceId, EDGE_KINDS.PHYSICAL_CONTINUATION, {
      fromInstructionId: exitOverride.fromInstructionId >>> 0,
      targetCpuAddr: oldTarget.cpuAddr & 0xffff,
      targetRomOff: oldTarget.romOff >>> 0,
      deadCodeReason
    });
  }

  function materializeMapperWriteExit(blockInstanceId, exitOverride) {
    requireString(blockInstanceId, 'mapper-write exit blockInstanceId');
    requireObject(exitOverride, 'mapper-write exit override');
    const sourceSite = requireObject(exitOverride.sourceSite, 'mapper-write exit sourceSite');
    let handledExecutableExit = false;

    if (exitOverride.target) {
      const resolvedTarget = requireSite(exitOverride.target, 'mapper-write exact fallthrough target');
      const sourceInstanceForOrigin = requireBlockInstanceById(blockInstanceId, 'mapper-write origin source blockInstanceId');
      const target = inheritOrigin(resolvedTarget, sourceInstanceForOrigin);
      addPhysicalLeader(target);
      let targetInstanceId = state.siteToBlockInstanceId.get(target.siteKey);
      if (!targetInstanceId) targetInstanceId = ensureBlockInstanceForSite(target);
      if (targetInstanceId) {
        const actualFromBlockInstanceId = sourceBlockInstanceIdForInstruction(
          blockInstanceId,
          sourceSite.siteKey,
          exitOverride.fromInstructionId
        );
        addEdge(actualFromBlockInstanceId, targetInstanceId, EDGE_KINDS.FALLTHROUGH, {
          fromInstructionId: exitOverride.fromInstructionId >>> 0,
          targetCpuAddr: target.cpuAddr & 0xffff,
          targetRomOff: target.romOff >>> 0
        });
        handledExecutableExit = true;
      } else {
        enqueue(target);
        addPendingEdge(blockInstanceId, target, EDGE_KINDS.FALLTHROUGH, {
          fromInstructionId: exitOverride.fromInstructionId >>> 0,
          fromSiteKey: sourceSite.siteKey,
          targetCpuAddr: target.cpuAddr & 0xffff,
          targetRomOff: target.romOff >>> 0
        });
        handledExecutableExit = true;
      }
    }

    if (!handledExecutableExit) {
      addFrontier(createFrontier(FRONTIER_KINDS.POSSIBLE_MAPPER_WRITE, sourceSite, {
        reason: 'mapperWriteFallthroughNotExact',
        fromInstructionId: exitOverride.fromInstructionId >>> 0,
        sourceRomOff: exitOverride.sourceRomOff >>> 0,
        fallthroughCpuAddr: exitOverride.fallthroughCpuAddr,
        writeEffectKind: exitOverride.writeEffectKind,
        targetKind: exitOverride.targetKind
      }));
    }

    materializePhysicalContinuation(blockInstanceId, exitOverride);
  }

  function executionForInstructionSite(instructionId, siteKey) {
    const normalized = requireInteger(instructionId, 'execution lookup instructionId') >>> 0;
    requireString(siteKey, 'execution lookup siteKey');
    return state.instructionExecutions.find((execution) => (
      (execution.instructionId >>> 0) === normalized && execution.siteKey === siteKey
    )) || null;
  }

  function blockInstanceIdForInstructionSite(instructionId, siteKey) {
    const execution = executionForInstructionSite(instructionId, siteKey);
    return execution ? execution.blockInstanceId : null;
  }

  function frontierSiteForCurrentInstruction(cur, instruction) {
    requireObject(cur, 'current block');
    requireInstruction(instruction, 'frontier instruction');
    const site = cur.executionSites.find((entry) => entry.instructionId === instruction.instructionId);
    if (!site) {
      throw new Error(`Missing execution site for current instruction ${instruction.instructionId}`);
    }
    return {
      siteKey: site.siteKey,
      contextKey: site.contextKey,
      cpuAddr: site.cpuAddr,
      romOff: instruction.romOff
    };
  }

  function sourceBlockInstanceIdForInstruction(defaultBlockInstanceId, sourceSiteKey, fromInstructionId) {
    const actual = blockInstanceIdForInstructionSite(fromInstructionId, sourceSiteKey);
    if (actual) return actual;
    const defaultInstance = requireBlockInstanceById(defaultBlockInstanceId, 'source default block instance');
    const defaultBlock = requireBlockById(defaultInstance.blockId, 'source default block');
    if (!blockContainsInstruction(defaultBlock, fromInstructionId)) {
      throw new Error(`Instruction ${fromInstructionId} is not owned by source block instance ${defaultBlockInstanceId}`);
    }
    return defaultBlockInstanceId;
  }

  function findExecutionForBlockInstruction(blockInstanceId, instructionId) {
    requireString(blockInstanceId, 'block instruction execution blockInstanceId');
    const normalized = requireInteger(instructionId, 'block instruction execution instructionId') >>> 0;
    return state.instructionExecutions.find((execution) => (
      execution.blockInstanceId === blockInstanceId && (execution.instructionId >>> 0) === normalized
    )) || null;
  }

  function createBlockInstanceForOwnedBlockAtSite(block, site) {
    requireObject(block, 'owned block');
    requireSite(site, 'owned block site');
    rememberMapperContext(site.contextKey, site.mapperContext);
    if ((block.romStart >>> 0) !== (site.romOff >>> 0)) {
      throw new Error(`Cannot attach site ${site.siteKey} to block ${block.blockId}; site starts at ${site.romOff}, block starts at ${block.romStart}`);
    }

    const blockInstanceId = makeBlockInstanceId(site.contextKey, site.cpuAddr);
    registerBlockInstance({
      blockInstanceId,
      blockId: block.blockId,
      siteKey: site.siteKey,
      contextKey: site.contextKey,
      cpuStart: site.cpuAddr & 0xffff,
      producedBy: PRODUCED_BY.EXACT_CFG_PASS,
      ...originFieldsFromSite(site)
    });
    state.siteToBlockInstanceId.set(site.siteKey, blockInstanceId);

    let cpuAddr = site.cpuAddr & 0xffff;
    for (const instructionId of block.instructionIds) {
      let instruction = requireInstructionById(instructionId, `${block.blockId}.instructionId`);
      const resolved = mapper.resolveCpuAddress(site.mapperContext, cpuAddr, { purpose: 'blockInstanceInstructionExecution' });
      requireObject(resolved, 'block instance instruction resolution');
      if (!resolved.ok) {
        throw new Error(`Cannot attach block ${block.blockId} at ${site.siteKey}; CPU ${cpuAddr} does not resolve to PRG ROM`);
      }
      const backing = requireObject(resolved.backing, 'block instance instruction backing');
      if (backing.kind !== 'exact' || (requireInteger(backing.romOff, 'block instance instruction backing.romOff') >>> 0) !== (instruction.romOff >>> 0)) {
        throw new Error(`Cannot attach block ${block.blockId} at ${site.siteKey}; CPU ${cpuAddr} resolves to romOff ${backing.romOff}, expected ${instruction.romOff}`);
      }
      const decoded = decodeInstructionAtSite({
        prgBytes,
        mapper,
        mapperContext: site.mapperContext,
        cpuAddr
      });
      requireObject(decoded, 'block instance decoded instruction result');
      if (!decoded.ok) {
        throw new Error(`Cannot attach block ${block.blockId} at ${site.siteKey}; decode failed at CPU ${cpuAddr}`);
      }
      instruction = replaceInstructionIfUnexecuted(requireInstruction(decoded.instruction, 'block instance decoded instruction'));
      const contextKey = requireString(resolved.contextKey, 'block instance instruction contextKey');
      const instructionSiteKey = makeSiteKey(contextKey, cpuAddr);
      state.siteToInstructionId.set(instructionSiteKey, instruction.instructionId >>> 0);
      addInstructionExecution({
        instructionId: instruction.instructionId,
        siteKey: instructionSiteKey,
        contextKey,
        cpuAddr,
        blockInstanceId
      });
      cpuAddr = (cpuAddr + instruction.size) & 0xffff;
    }

    materializeBlockExitEdges(block, blockInstanceId, site.mapperContext, createBranchPruningState());
    return blockInstanceId;
  }

  function createSuffixBlockInstanceFromExecution(suffixBlock, execution) {
    requireObject(suffixBlock, 'suffix block');
    requireObject(execution, 'suffix execution');
    requireInteger(execution.instructionId, 'suffix execution.instructionId');
    requireString(execution.siteKey, 'suffix execution.siteKey');
    requireString(execution.contextKey, 'suffix execution.contextKey');
    requireInteger(execution.cpuAddr, 'suffix execution.cpuAddr');

    const suffixBlockInstanceId = makeBlockInstanceId(execution.contextKey, execution.cpuAddr);
    registerBlockInstance({
      blockInstanceId: suffixBlockInstanceId,
      blockId: suffixBlock.blockId,
      siteKey: execution.siteKey,
      contextKey: execution.contextKey,
      cpuStart: execution.cpuAddr & 0xffff,
      producedBy: PRODUCED_BY.EXACT_CFG_PASS
    });
    state.siteToBlockInstanceId.set(execution.siteKey, suffixBlockInstanceId);
    return suffixBlockInstanceId;
  }

  function edgeKindsForSplitTarget(fromInstruction, fromExecution, targetExecution) {
    requireInstruction(fromInstruction, 'split source instruction');
    requireObject(fromExecution, 'split source execution');
    requireObject(targetExecution, 'split target execution');
    requireInteger(fromExecution.cpuAddr, 'split source execution.cpuAddr');
    requireInteger(targetExecution.cpuAddr, 'split target execution.cpuAddr');
    const flow = requireObject(fromInstruction.flow, 'split source flow');
    const targetCpuAddr = targetExecution.cpuAddr & 0xffff;
    const edgeKinds = [];

    if (flow.type === FLOW_TYPES.NEXT) {
      if ((requireInteger(flow.next, 'split next target') & 0xffff) === targetCpuAddr) {
        edgeKinds.push(EDGE_KINDS.FALLTHROUGH);
      }
      return edgeKinds;
    }

    if (flow.type === FLOW_TYPES.CALL) {
      if ((requireInteger(flow.fallthrough, 'split call fallthrough') & 0xffff) === targetCpuAddr) {
        edgeKinds.push(EDGE_KINDS.FALLTHROUGH);
      }
      return edgeKinds;
    }

    if (flow.type === FLOW_TYPES.BRANCH) {
      if ((requireInteger(flow.target, 'split branch target') & 0xffff) === targetCpuAddr) {
        edgeKinds.push(EDGE_KINDS.BRANCH_TAKEN);
      }
      if ((requireInteger(flow.fallthrough, 'split branch fallthrough') & 0xffff) === targetCpuAddr) {
        edgeKinds.push(EDGE_KINDS.BRANCH_NOT_TAKEN);
      }
      return edgeKinds;
    }

    if (flow.type === FLOW_TYPES.JUMP) {
      if ((requireInteger(flow.target, 'split jump target') & 0xffff) === targetCpuAddr) {
        edgeKinds.push(EDGE_KINDS.JUMP);
      }
      return edgeKinds;
    }

    return edgeKinds;
  }

  function splitBlockAtRomOff(site) {
    requireSite(site, 'split site');
    const splitRomOff = site.romOff >>> 0;
    const oldBlockId = state.ownedRomOffToBlockId.get(splitRomOff);
    if (!oldBlockId) return null;

    const oldBlock = requireBlockById(oldBlockId, 'split owning block');
    if ((oldBlock.romStart >>> 0) === splitRomOff) return oldBlock;

    const splitIndex = oldBlock.instructionIds.findIndex((instructionId) => (instructionId >>> 0) === splitRomOff);
    if (splitIndex <= 0) {
      throw new Error(`Cannot split block ${oldBlock.blockId} at romOff ${splitRomOff}; target is not an interior instruction`);
    }

    const originalInstructionIds = oldBlock.instructionIds.slice();
    const prefixInstructionIds = originalInstructionIds.slice(0, splitIndex);
    const suffixInstructionIds = originalInstructionIds.slice(splitIndex);
    const suffixInstructionIdSet = new Set(suffixInstructionIds.map((instructionId) => instructionId >>> 0));
    const prefixLast = requireInstructionById(prefixInstructionIds[prefixInstructionIds.length - 1], 'split prefix last instruction');
    const suffixFirst = requireInstructionById(suffixInstructionIds[0], 'split suffix first instruction');
    const suffixLast = requireInstructionById(suffixInstructionIds[suffixInstructionIds.length - 1], 'split suffix last instruction');

    const suffixBlockId = makeBlockId(suffixFirst.romOff);
    if (state.blockById.has(suffixBlockId)) {
      throw new Error(`Cannot split block ${oldBlock.blockId}; suffix block ${suffixBlockId} already exists`);
    }

    const oldInstanceIds = Array.from(blockInstanceIdSetForBlock(oldBlock.blockId));
    const suffixExecutionByOldInstanceId = new Map();
    for (const oldInstanceId of oldInstanceIds) {
      const execution = findExecutionForBlockInstruction(oldInstanceId, suffixFirst.instructionId);
      if (!execution) {
        throw new Error(`Cannot split block ${oldBlock.blockId}; instance ${oldInstanceId} has no execution for suffix instruction ${suffixFirst.instructionId}`);
      }
      suffixExecutionByOldInstanceId.set(oldInstanceId, { ...execution });
    }

    oldBlock.instructionIds = prefixInstructionIds;
    oldBlock.romEnd = (prefixLast.romOff + prefixLast.size) >>> 0;

    const suffixBlock = {
      blockId: suffixBlockId,
      romStart: suffixFirst.romOff >>> 0,
      romEnd: (suffixLast.romOff + suffixLast.size) >>> 0,
      producedBy: oldBlock.producedBy,
      instructionIds: suffixInstructionIds
    };

    state.blockById.set(suffixBlockId, suffixBlock);
    const oldIndex = state.blocks.findIndex((block) => block.blockId === oldBlock.blockId);
    if (oldIndex < 0) throw new Error(`Cannot split block ${oldBlock.blockId}; block is missing from ordered block list`);
    state.blocks.splice(oldIndex + 1, 0, suffixBlock);
    state.counters.physicalBlockCount = state.blocks.length;
    state.counters.blockSplits += 1;

    for (const instructionId of suffixInstructionIds) {
      state.ownedRomOffToBlockId.set(instructionId >>> 0, suffixBlockId);
    }

    const suffixInstanceByOldInstanceId = new Map();
    for (const oldInstanceId of oldInstanceIds) {
      const suffixExecution = suffixExecutionByOldInstanceId.get(oldInstanceId);
      const suffixBlockInstanceId = createSuffixBlockInstanceFromExecution(suffixBlock, suffixExecution);
      suffixInstanceByOldInstanceId.set(oldInstanceId, suffixBlockInstanceId);
    }

    for (const execution of state.instructionExecutions) {
      const suffixBlockInstanceId = suffixInstanceByOldInstanceId.get(execution.blockInstanceId);
      if (suffixBlockInstanceId && suffixInstructionIdSet.has(execution.instructionId >>> 0)) {
        execution.blockInstanceId = suffixBlockInstanceId;
      }
    }
    rebuildInstructionExecutionKeys();

    for (const edge of state.edges) {
      const suffixBlockInstanceId = suffixInstanceByOldInstanceId.get(edge.fromBlockInstanceId);
      if (suffixBlockInstanceId && suffixInstructionIdSet.has(edge.fromInstructionId >>> 0)) {
        edge.fromBlockInstanceId = suffixBlockInstanceId;
        edge.edgeId = makeEdgeId(suffixBlockInstanceId, edge.toBlockInstanceId, edge.kind);
      }
    }
    rebuildEdgeIds();

    for (const pending of state.pendingEdges) {
      const suffixBlockInstanceId = suffixInstanceByOldInstanceId.get(pending.fromBlockInstanceId);
      if (suffixBlockInstanceId && suffixInstructionIdSet.has(pending.fromInstructionId >>> 0)) {
        pending.fromBlockInstanceId = suffixBlockInstanceId;
      }
    }

    for (const oldInstanceId of oldInstanceIds) {
      const suffixBlockInstanceId = suffixInstanceByOldInstanceId.get(oldInstanceId);
      const suffixExecution = suffixExecutionByOldInstanceId.get(oldInstanceId);
      const prefixLastExecution = findExecutionForBlockInstruction(oldInstanceId, prefixLast.instructionId);
      if (!prefixLastExecution) {
        throw new Error(`Cannot split block ${oldBlock.blockId}; missing execution for instruction before split ${prefixLast.instructionId}`);
      }
      const edgeKinds = edgeKindsForSplitTarget(prefixLast, prefixLastExecution, suffixExecution);
      if (!edgeKinds.length) {
        throw new Error(`Cannot split block ${oldBlock.blockId} at ${splitRomOff}; instruction before split does not reach split target`);
      }
      for (const edgeKind of edgeKinds) {
        addEdge(oldInstanceId, suffixBlockInstanceId, edgeKind, {
          fromInstructionId: prefixLast.instructionId,
          targetCpuAddr: suffixExecution.cpuAddr,
          targetRomOff: suffixFirst.romOff
        });
      }
    }

    for (const oldInstanceId of oldInstanceIds) {
      const suffixBlockInstanceId = suffixInstanceByOldInstanceId.get(oldInstanceId);
      const suffixExecution = suffixExecutionByOldInstanceId.get(oldInstanceId);
      const suffixMapperContext = mapperContextForKey(suffixExecution.contextKey);
      materializeBlockExitEdges(suffixBlock, suffixBlockInstanceId, suffixMapperContext, createBranchPruningState());
    }

    return suffixBlock;
  }

  function ensureBlockInstanceForSite(site) {
    requireSite(site, 'block instance site');
    rememberMapperContext(site.contextKey, site.mapperContext);

    const existing = state.siteToBlockInstanceId.get(site.siteKey);
    if (existing) return existing;

    const blockId = state.ownedRomOffToBlockId.get(site.romOff >>> 0);
    if (!blockId) return null;

    const block = state.blockById.get(blockId);
    if (!block) throw new Error(`Owned romOff ${site.romOff} references missing physical block ${blockId}`);
    const targetBlock = (block.romStart >>> 0) === (site.romOff >>> 0) ? block : splitBlockAtRomOff(site);
    if (!targetBlock) return null;
    if ((targetBlock.romStart >>> 0) !== (site.romOff >>> 0)) {
      throw new Error(`Split did not produce a block starting at romOff ${site.romOff}`);
    }

    return createBlockInstanceForOwnedBlockAtSite(targetBlock, site);
  }

  function materializePendingEdge(pending) {
    requireObject(pending, 'pending edge');
    const targetSite = requireSite(pending.targetSite, 'pending edge target site');
    let targetInstanceId = state.siteToBlockInstanceId.get(targetSite.siteKey);
    if (!targetInstanceId) targetInstanceId = ensureBlockInstanceForSite(targetSite);
    if (!targetInstanceId) return false;

    const fromBlockInstanceId = sourceBlockInstanceIdForInstruction(
      pending.fromBlockInstanceId,
      pending.fromSiteKey,
      pending.fromInstructionId
    );
    addEdge(fromBlockInstanceId, targetInstanceId, pending.kind, {
      fromInstructionId: pending.fromInstructionId,
      targetCpuAddr: pending.targetCpuAddr,
      targetRomOff: pending.targetRomOff
    });
    return true;
  }

  function resolvePendingEdges() {
    if (!state.pendingEdges.length) return;
    const unresolved = [];
    for (const pending of state.pendingEdges) {
      if (!materializePendingEdge(pending)) unresolved.push(pending);
    }
    state.pendingEdges = unresolved;
    state.counters.pendingEdgeCount = state.pendingEdges.length;
  }

  function resolveFinalPendingEdges() {
    resolvePendingEdges();
    for (const pending of state.pendingEdges) {
      addFrontier(createFrontier(FRONTIER_KINDS.UNSUPPORTED_CONTROL_FLOW, pending.targetSite, {
        reason: 'pendingEdgeTargetNotMaterialized',
        fromInstructionId: pending.fromInstructionId >>> 0,
        targetCpuAddr: pending.targetCpuAddr & 0xffff,
        targetRomOff: pending.targetRomOff >>> 0
      }));
    }
    state.pendingEdges = [];
    state.counters.pendingEdgeCount = 0;
  }

  function resolveSuccessorFromSite(fromBlockInstanceId, mapperContext, sourceSite, fromInstruction, kind) {
    requireString(fromBlockInstanceId, 'successor fromBlockInstanceId');
    requireObject(mapperContext, 'successor mapperContext');
    requireObject(sourceSite, 'successor source site');
    requireString(sourceSite.siteKey, 'successor source site.siteKey');
    requireString(sourceSite.contextKey, 'successor source site.contextKey');
    requireInteger(sourceSite.cpuAddr, 'successor source site.cpuAddr');
    if (sourceSite.romOff !== undefined && sourceSite.romOff !== null) requireInteger(sourceSite.romOff, 'successor source site.romOff');
    requireInstruction(fromInstruction, 'successor fromInstruction');
    requireString(kind, 'successor edge kind');
    if (typeof mapper.resolveControlTransferFromRomOff !== 'function') {
      throw new Error('Mapper must provide resolveControlTransferFromRomOff() for exact CFG');
    }

    const transfer = makeControlTransferRequest(fromInstruction, kind);
    transfer.sourceCpuAddr = sourceSite.cpuAddr & 0xffff;
    const resolved = mapper.resolveControlTransferFromRomOff(mapperContext, transfer);
    requireObject(resolved, 'resolved control transfer');

    if (resolved.kind === CONTROL_TRANSFER_RESULT_KINDS.FRONTIER) {
      const targetCpuAddr = Array.isArray(resolved.targetCpuAddrs) && resolved.targetCpuAddrs.length > 0
        ? resolved.targetCpuAddrs[0] & 0xffff
        : null;
      const frontierKind = resolved.reason === 'targetNotMapped' || resolved.reason === 'cpuAddressOutsidePrgRom'
        ? FRONTIER_KINDS.UNMAPPED_TARGET
        : FRONTIER_KINDS.AMBIGUOUS_DIRECT_TARGET;
      addFrontier(createFrontier(frontierKind, sourceSite, {
        fromInstructionId: fromInstruction.instructionId >>> 0,
        fromBlockInstanceId,
        fromSiteKey: sourceSite.siteKey,
        edgeKind: kind,
        transferKind: kind,
        sourceRomOff: fromInstruction.romOff >>> 0,
        instructionSize: fromInstruction.size >>> 0,
        targetCpuAddr,
        reason: typeof resolved.reason === 'string' ? resolved.reason : 'controlTransferNotExact',
        sourceAppearances: Array.isArray(resolved.sourceAppearances) ? resolved.sourceAppearances : [],
        targetCpuAddrs: Array.isArray(resolved.targetCpuAddrs) ? resolved.targetCpuAddrs : [],
        candidateTargets: Array.isArray(resolved.candidateTargets) ? resolved.candidateTargets : [],
        ...(resolved.detail && typeof resolved.detail === 'object' ? resolved.detail : {})
      }));
      return;
    }

    if (resolved.kind !== CONTROL_TRANSFER_RESULT_KINDS.EXACT) {
      throw new Error(`Unexpected control transfer result kind ${resolved.kind}`);
    }

    const resolvedTarget = requireSite(resolved.target, 'resolved control transfer.target');
    const sourceInstanceForOrigin = requireBlockInstanceById(fromBlockInstanceId, 'successor origin source blockInstanceId');
    const target = inheritOrigin(resolvedTarget, sourceInstanceForOrigin);
    addPhysicalLeader(target);

    let targetInstanceId = state.siteToBlockInstanceId.get(target.siteKey);
    if (!targetInstanceId) targetInstanceId = ensureBlockInstanceForSite(target);

    if (targetInstanceId) {
      const actualFromBlockInstanceId = sourceBlockInstanceIdForInstruction(
        fromBlockInstanceId,
        sourceSite.siteKey,
        fromInstruction.instructionId
      );
      const detail = requireObject(resolved.detail, 'resolved exact control transfer detail');
      addEdge(actualFromBlockInstanceId, targetInstanceId, kind, {
        fromInstructionId: fromInstruction.instructionId,
        targetCpuAddr: requireInteger(detail.targetCpuAddr, 'resolved exact targetCpuAddr'),
        targetRomOff: requireInteger(detail.targetRomOff, 'resolved exact targetRomOff')
      });
      return;
    }

    enqueue(target);
    const detail = requireObject(resolved.detail, 'resolved pending control transfer detail');
    addPendingEdge(fromBlockInstanceId, target, kind, {
      fromInstructionId: fromInstruction.instructionId,
      fromSiteKey: sourceSite.siteKey,
      targetCpuAddr: requireInteger(detail.targetCpuAddr, 'resolved pending targetCpuAddr'),
      targetRomOff: requireInteger(detail.targetRomOff, 'resolved pending targetRomOff')
    });
  }

  function sourceSiteForBlockInstruction(blockInstanceId, instruction) {
    requireString(blockInstanceId, 'source site blockInstanceId');
    requireInstruction(instruction, 'source site instruction');
    const execution = findExecutionForBlockInstruction(blockInstanceId, instruction.instructionId);
    if (!execution) {
      throw new Error(`Missing execution site for instruction ${instruction.instructionId} in block instance ${blockInstanceId}`);
    }
    return {
      siteKey: execution.siteKey,
      contextKey: execution.contextKey,
      cpuAddr: execution.cpuAddr,
      romOff: instruction.romOff
    };
  }

  function materializeBlockExitEdges(block, blockInstanceId, mapperContext, branchPruningState) {
    requireObject(block, 'exit edge block');
    requireString(blockInstanceId, 'exit edge blockInstanceId');
    requireObject(mapperContext, 'exit edge mapperContext');
    const lastInstructionId = block.instructionIds[block.instructionIds.length - 1];
    const last = requireInstructionById(lastInstructionId, 'exit edge last instructionId');
    const sourceSite = sourceSiteForBlockInstruction(blockInstanceId, last);
    const flow = last.flow;

    switch (flow.type) {
      case FLOW_TYPES.NEXT:
        resolveSuccessorFromSite(blockInstanceId, mapperContext, sourceSite, last, EDGE_KINDS.FALLTHROUGH);
        break;

      case FLOW_TYPES.BRANCH: {
        // Use exact-CFG local flags only to avoid following impossible immediate
        // branch edges. If the condition is unknown, both edges remain feasible.
        const feasibility = getBranchFeasibility(last, branchPruningState);
        if (!feasibility.taken && !feasibility.fallthrough) {
          throw new Error(`Strict CFG branch feasibility pruned both edges at instruction ${last.instructionId}`);
        }
        if (isBranchPrunedToSingleEdge(last, branchPruningState)) {
          state.counters.forcedBranches += 1;
          state.counters.prunedBranchEdges += 1;
        }
        if (feasibility.taken) {
          resolveSuccessorFromSite(blockInstanceId, mapperContext, sourceSite, last, EDGE_KINDS.BRANCH_TAKEN);
        }
        if (feasibility.fallthrough) {
          resolveSuccessorFromSite(blockInstanceId, mapperContext, sourceSite, last, EDGE_KINDS.BRANCH_NOT_TAKEN);
        }
        break;
      }

      case FLOW_TYPES.CALL:
        resolveSuccessorFromSite(blockInstanceId, mapperContext, sourceSite, last, EDGE_KINDS.CALL);
        resolveSuccessorFromSite(blockInstanceId, mapperContext, sourceSite, last, EDGE_KINDS.FALLTHROUGH);
        break;

      case FLOW_TYPES.JUMP:
        resolveSuccessorFromSite(blockInstanceId, mapperContext, sourceSite, last, EDGE_KINDS.JUMP);
        break;

      case FLOW_TYPES.JMP_INDIRECT:
        addFrontier(createFrontier(FRONTIER_KINDS.INDIRECT_JUMP, sourceSite, { ptrAddr: flow.ptrAddr & 0xffff }));
        break;

      case FLOW_TYPES.STOP:
        if (last.flow.reason === 'rts') state.counters.rtsStops += 1;
        else if (last.flow.reason === 'rti') state.counters.rtiStops += 1;
        else if (last.flow.reason === 'brk') state.counters.brkStops += 1;
        break;

      default:
        addFrontier(createFrontier(FRONTIER_KINDS.UNSUPPORTED_CONTROL_FLOW, sourceSite, { flowType: flow.type }));
        break;
    }
  }

  function finishCurrentBlock() {
    const cur = state.current;
    if (!cur) return;
    state.current = null;
    if (!cur.instructionIds.length) return;

    const first = requireInstructionById(cur.instructionIds[0], 'current first instructionId');
    const last = requireInstructionById(cur.instructionIds[cur.instructionIds.length - 1], 'current last instructionId');
    const blockId = makeBlockId(first.romOff);
    const blockInstanceId = makeBlockInstanceId(cur.contextKey, cur.cpuStart);
    const romStart = first.romOff >>> 0;
    const romEnd = (last.romOff + last.size) >>> 0;

    const block = {
      blockId,
      romStart,
      romEnd,
      producedBy: PRODUCED_BY.EXACT_CFG_PASS,
      instructionIds: cur.instructionIds.slice()
    };

    if (!state.blockById.has(blockId)) {
      state.blockById.set(blockId, block);
      state.blocks.push(block);
      state.counters.physicalBlockCount = state.blocks.length;
    }

    registerBlockInstance({
      blockInstanceId,
      blockId,
      siteKey: cur.startSiteKey,
      contextKey: cur.contextKey,
      cpuStart: cur.cpuStart,
      producedBy: PRODUCED_BY.EXACT_CFG_PASS,
      ...cur.origin
    });

    state.siteToBlockInstanceId.set(cur.startSiteKey, blockInstanceId);
    for (const instructionId of cur.instructionIds) {
      const instruction = requireInstructionById(instructionId, 'current block instructionId');
      state.ownedRomOffToBlockId.set(instruction.romOff >>> 0, blockId);
    }

    for (const execution of cur.executionSites) {
      state.siteToInstructionId.set(execution.siteKey, execution.instructionId);
      addInstructionExecution({ ...execution, blockInstanceId });
    }

    if (cur.exitOverride) materializeMapperWriteExit(blockInstanceId, cur.exitOverride);
    else materializeBlockExitEdges(block, blockInstanceId, cur.mapperContext, cur.branchPruningState);
  }

  function startNextBlock() {
    while (state.queue.length) {
      const site = requireSite(state.queue.shift(), 'dequeued site');
      rememberMapperContext(site.contextKey, site.mapperContext);
      state.queuedKeys.delete(makeQueueKey(site));
      state.counters.queuedSites = state.queue.length;
      if (state.visitedBlockStartSites.has(site.siteKey)) continue;
      if (state.siteToBlockInstanceId.has(site.siteKey)) continue;

      const existingInstanceId = ensureBlockInstanceForSite(site);
      if (existingInstanceId) {
        state.visitedBlockStartSites.add(site.siteKey);
        state.counters.visitedSites = state.visitedBlockStartSites.size;
        continue;
      }

      state.visitedBlockStartSites.add(site.siteKey);
      state.counters.visitedSites = state.visitedBlockStartSites.size;
      state.current = {
        mapperContext: site.mapperContext,
        contextKey: site.contextKey,
        startSiteKey: site.siteKey,
        cpuStart: site.cpuAddr & 0xffff,
        romStart: site.romOff >>> 0,
        nextCpuAddr: site.cpuAddr & 0xffff,
        // Keep strict-CFG branch pruning flags block-local. They only prune branches whose condition
        // is forced by instructions already decoded in this same raw block.
        branchPruningState: createBranchPruningState(),
        abstractState: unknownEntryStateForMapperContext(site.mapperContext, strictDomainOptions()),
        exitOverride: null,
        instructionIds: [],
        origin: originFieldsFromSite(site),
        executionSites: []
      };
      addPhysicalLeader(site);
      return true;
    }
    return false;
  }

  function isPhysicalBoundary(romOff) {
    const normalized = requireInteger(romOff, 'physical boundary romOff') >>> 0;
    return state.leaderRomOffs.has(normalized) || state.ownedRomOffToBlockId.has(normalized);
  }

  function appendInstruction(instruction, site) {
    requireInstruction(instruction, 'decoded instruction');
    requireSite(site, 'decoded instruction site');
    if (!state.current) throw new Error('Cannot append instruction without an active block');

    const instructionId = instruction.instructionId >>> 0;
    const romOff = instruction.romOff >>> 0;

    if (state.ownedRomOffToBlockId.has(romOff)) {
      throw new Error(`Instruction ROM offset is already owned by a physical block: ${romOff}`);
    }
    if (state.current.instructionIds.includes(instructionId)) {
      throw new Error(`Instruction ROM offset is already in the current physical block: ${romOff}`);
    }

    if (!state.instructionById.has(instructionId)) {
      state.instructions.push(instruction);
      state.instructionById.set(instructionId, instruction);
      state.counters.decodedInstructions = state.instructions.length;
    }

    state.current.instructionIds.push(instructionId);
    state.current.executionSites.push({
      instructionId,
      siteKey: site.siteKey,
      contextKey: site.contextKey,
      cpuAddr: site.cpuAddr & 0xffff
    });
    state.current.branchPruningState = updateBranchPruningStateForInstruction(state.current.branchPruningState, instruction);
  }

  function validateFinalGraph() {
    for (const [romOff, blockId] of state.ownedRomOffToBlockId.entries()) {
      const block = requireBlockById(blockId, `owner for romOff ${romOff}`);
      if (!blockContainsInstruction(block, romOff)) {
        throw new Error(`ownedRomOffToBlockId says ${romOff} belongs to ${blockId}, but the block does not contain it`);
      }
    }
    for (const block of state.blocks) {
      requireString(block.blockId, 'final block.blockId');
      for (const instructionId of block.instructionIds) {
        const owner = state.ownedRomOffToBlockId.get(instructionId >>> 0);
        if (owner !== block.blockId) {
          throw new Error(`Instruction ${instructionId} is in block ${block.blockId}, but owner map points to ${owner}`);
        }
      }
    }
    rebuildInstructionExecutionKeys();
    rebuildEdgeIds();
  }

  function stepOne(context) {
    if (!state.initialized) {
      state.initialized = true;
      preloadAcceptedCodeSpans();
      for (const seed of seedSites) enqueue(seed);
      state.counters.queuedSites = state.queue.length;
      return { status: 'running' };
    }

    if (!state.current && !startNextBlock()) {
      resolveFinalPendingEdges();
      validateFinalGraph();
      for (const [contextKey, mapperContext] of state.mapperContextByKey.entries()) {
        context.contexts[contextKey] = mapperContext;
      }
      context.instructions = state.instructions;
      context.blocks = state.blocks;
      context.blockInstances = state.blockInstances;
      context.instructionExecutions = state.instructionExecutions;
      context.edges = state.edges;
      context.frontiers = state.frontiers;
      context.strictCfgCounters = { ...state.counters, contextsSeen: state.mapperContextByKey.size };
      return { status: 'complete' };
    }

    if (!state.current) throw new Error('strict CFG expected an active block after startNextBlock');
    const decoded = decodeInstructionAtSite({
      prgBytes,
      mapper,
      mapperContext: state.current.mapperContext,
      cpuAddr: state.current.nextCpuAddr
    });
    requireObject(decoded, 'decoded instruction result');

    if (!decoded.ok) {
      const frontierSite = {
        siteKey: requireString(decoded.siteKey, 'decode failure siteKey'),
        contextKey: requireString(decoded.contextKey, 'decode failure contextKey'),
        cpuAddr: requireInteger(decoded.cpuAddr, 'decode failure cpuAddr'),
        romOff: decoded.romOff
      };
      if (state.current.origin?.seedKind === 'expandCfg' &&
        typeof state.current.origin.expandCfgFrontierId === 'string' &&
        typeof context?.markExpandCfgAttempt === 'function') {
        context.markExpandCfgAttempt(state.current.origin.expandCfgFrontierId, {
          state: 'rejected',
          reason: typeof decoded.reason === 'string' ? decoded.reason : 'decodeFailed',
          rejectedAt: 'strictCfg',
          detail: {
            opcode: typeof decoded.opcode === 'number' ? decoded.opcode & 0xff : null,
            cpuAddr: frontierSite.cpuAddr & 0xffff,
            romOff: typeof frontierSite.romOff === 'number' ? frontierSite.romOff >>> 0 : null
          }
        });
      }
      addFrontier(createFrontier(FRONTIER_KINDS.DECODE_FAILED, frontierSite, {
        reason: typeof decoded.reason === 'string' ? decoded.reason : 'decodeFailed',
        opcode: typeof decoded.opcode === 'number' ? decoded.opcode & 0xff : null
      }));
      finishCurrentBlock();
      return { status: 'running' };
    }

    const instruction = requireInstruction(decoded.instruction, 'decoded instruction');
    const site = requireSite(decoded.site, 'decoded instruction site');
    rememberMapperContext(site.contextKey, site.mapperContext);
    if (state.current.instructionIds.length > 0 && isPhysicalBoundary(site.romOff)) {
      finishCurrentBlock();
      return { status: 'running' };
    }

    const writeEffect = classifyInstructionWriteEffect({
      mapper,
      instruction,
      state: state.current.abstractState,
      env: strictTransferEnv(state.current.contextKey),
      options: strictDomainOptions()
    });

    appendInstruction(instruction, site);
    transferStrictAbstractStateForInstruction(instruction);

    if (writeEffect.mayAffectCodeMapping) {
      recordMapperWriteExit(instruction, site, writeEffect);
      finishCurrentBlock();
      return { status: 'running' };
    }

    if (instruction.flow.type === FLOW_TYPES.NEXT) {
      state.current.nextCpuAddr = instruction.flow.next & 0xffff;
      return { status: 'running' };
    }

    finishCurrentBlock();
    return { status: 'running' };
  }

  function strictCfgDetails() {
    return {
      ...state.counters,
      contextsSeen: state.mapperContextByKey.size
    };
  }

  function progress() {
    const details = strictCfgDetails();
    return {
      phase: 'strictCfg',
      ...details,
      detailKind: 'strictCfg',
      details
    };
  }

  return { name: 'strictCfg', stepOne, progress };
}
