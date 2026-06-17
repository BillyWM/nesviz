import { decodeInstructionAtRomOff } from '../cfg/decode.js';
import { EDGE_KINDS, FLOW_TYPES, PRODUCED_BY } from '../cfg/constants.js';
import { requireInstruction, requireInteger, requireObject, requireString } from '../dataShape.js';
import {
  makeAttemptId,
  makeCandidateBlockId,
  makeCandidateEdgeId,
  requireMappingSpeculationCandidate
} from './candidates.js';

const DEFAULT_MAX_INSTRUCTIONS = 256;
const DEFAULT_MAX_BYTES = 0x1000;

function isSoftTerminator(flow) {
  return flow.type === FLOW_TYPES.BRANCH;
}

function isHardTerminator(flow) {
  return flow.type === FLOW_TYPES.JUMP || flow.type === FLOW_TYPES.JMP_INDIRECT || flow.type === FLOW_TYPES.STOP;
}

function advanceCpu(cpuAddr, size) {
  return (cpuAddr + size) & 0xffff;
}

function makeSpan({ attemptId, frontierId, bankSize, bankIndex, romStart, romEnd, status, failure = null, terminator = null }) {
  const span = {
    attemptId,
    frontierId,
    bankSize: bankSize >>> 0,
    bankIndex: bankIndex >>> 0,
    romStart: romStart >>> 0,
    romEnd: romEnd >>> 0,
    status
  };
  if (failure) span.failure = failure;
  if (terminator) span.terminator = terminator;
  if (span.romEnd <= span.romStart) throw new Error('speculative decode span must be non-empty');
  return span;
}

function makeFailure(reason, decoded, romOff) {
  const failure = {
    reason: requireString(reason, 'speculative decode failure reason'),
    failedAtRomOff: romOff >>> 0
  };
  if (decoded && typeof decoded.opcode === 'number') failure.opcode = decoded.opcode & 0xff;
  return failure;
}

function terminatorForInstruction(kind, instruction) {
  requireInstruction(instruction, 'terminator instruction');
  return {
    kind,
    instructionId: instruction.instructionId >>> 0,
    flowType: requireString(instruction.flow.type, 'terminator flow.type')
  };
}

function targetRomOffInSameSlice(candidate, targetCpuAddr) {
  const bankSize = candidate.bankSize >>> 0;
  const bankStart = (candidate.bankIndex >>> 0) * bankSize;
  const windowBase = 0x8000 + Math.floor(((targetCpuAddr & 0xffff) - 0x8000) / bankSize) * bankSize;
  const offsetInWindow = (targetCpuAddr & 0xffff) - windowBase;
  if (offsetInWindow < 0 || offsetInWindow >= bankSize) return null;
  return bankStart + offsetInWindow;
}

function candidateEdgesForInstruction({ attemptId, frontierId, candidate, instruction }) {
  const flow = instruction.flow;
  const edges = [];

  function pushEdge(kind, targetCpuAddr) {
    const edge = {
      candidateEdgeId: makeCandidateEdgeId(attemptId, instruction.instructionId, kind, targetCpuAddr),
      attemptId,
      frontierId,
      kind,
      fromInstructionId: instruction.instructionId >>> 0,
      targetCpuAddr: targetCpuAddr & 0xffff
    };
    const targetRomOff = targetRomOffInSameSlice(candidate, targetCpuAddr);
    if (targetRomOff !== null) edge.targetRomOff = targetRomOff >>> 0;
    edges.push(edge);
  }

  if (flow.type === FLOW_TYPES.NEXT) {
    pushEdge(EDGE_KINDS.FALLTHROUGH, flow.next);
  } else if (flow.type === FLOW_TYPES.BRANCH) {
    pushEdge(EDGE_KINDS.BRANCH_TAKEN, flow.target);
    pushEdge(EDGE_KINDS.BRANCH_NOT_TAKEN, flow.fallthrough);
  } else if (flow.type === FLOW_TYPES.CALL) {
    pushEdge(EDGE_KINDS.CALL, flow.target);
    pushEdge(EDGE_KINDS.FALLTHROUGH, flow.fallthrough);
  } else if (flow.type === FLOW_TYPES.JUMP) {
    pushEdge(EDGE_KINDS.JUMP, flow.target);
  }

  return edges;
}

export function runMappingDecodeAttempt({ prgBytes, candidate, options = null }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('mapping decode attempt requires PRG bytes');
  requireMappingSpeculationCandidate(candidate, 'mapping decode attempt candidate');
  const opts = options === null || options === undefined ? {} : requireObject(options, 'mapping decode attempt options');
  const maxInstructions = typeof opts.maxInstructions === 'number' ? opts.maxInstructions : DEFAULT_MAX_INSTRUCTIONS;
  const maxBytes = typeof opts.maxBytes === 'number' ? opts.maxBytes : DEFAULT_MAX_BYTES;
  requireInteger(maxInstructions, 'mapping decode maxInstructions');
  requireInteger(maxBytes, 'mapping decode maxBytes');

  const attemptId = makeAttemptId(candidate);
  const frontierId = candidate.frontierId;
  const instructions = [];
  const candidateEdges = [];
  const successfulDecodeSpans = [];
  const failedDecodeSpans = [];
  const candidateBlocks = [];

  let romOff = candidate.startRomOff >>> 0;
  let cpuAddr = candidate.targetCpuAddr & 0xffff;
  const startRomOff = romOff;
  let latestBranchInstruction = null;
  let latestBranchEndRomOff = null;
  let latestBranchInstructionCount = 0;

  function recordSuccessThrough(instruction, kind, instructionCount) {
    const romEnd = (instruction.romOff + instruction.size) >>> 0;
    const blockInstructionIds = instructions.slice(0, instructionCount).map((item) => item.instructionId >>> 0);
    const candidateBlockId = makeCandidateBlockId(attemptId, startRomOff);
    candidateBlocks.push({
      candidateBlockId,
      producedBy: PRODUCED_BY.MAPPING_SPECULATION,
      frontierId,
      attemptId,
      romStart: startRomOff,
      romEnd,
      instructionIds: blockInstructionIds,
      bankSize: candidate.bankSize >>> 0,
      bankIndex: candidate.bankIndex >>> 0,
      targetCpuAddr: candidate.targetCpuAddr & 0xffff
    });
    successfulDecodeSpans.push(makeSpan({
      attemptId,
      frontierId,
      bankSize: candidate.bankSize,
      bankIndex: candidate.bankIndex,
      romStart: startRomOff,
      romEnd,
      status: 'success',
      terminator: terminatorForInstruction(kind, instruction)
    }));
    return { candidateBlockId, romEnd };
  }

  function recordFailureFrom(romStart, decoded, reason) {
    const failedAt = decoded && typeof decoded.romOff === 'number' ? decoded.romOff : romOff;
    const romEnd = Math.max((failedAt >>> 0) + 1, (romStart >>> 0) + 1);
    const failure = makeFailure(reason, decoded, failedAt);
    const span = makeSpan({
      attemptId,
      frontierId,
      bankSize: candidate.bankSize,
      bankIndex: candidate.bankIndex,
      romStart,
      romEnd,
      status: 'failed',
      failure
    });
    failedDecodeSpans.push(span);
    return { failure, span };
  }

  for (let count = 0; count < maxInstructions; count += 1) {
    if ((romOff - startRomOff) >= maxBytes) {
      if (latestBranchInstruction) {
        const success = recordSuccessThrough(latestBranchInstruction, 'soft', latestBranchInstructionCount);
        recordFailureFrom(latestBranchEndRomOff, { romOff }, 'maxBytesAfterSoftTerminator');
        return makeAttemptResult('success', success);
      }
      const { failure } = recordFailureFrom(startRomOff, { romOff }, 'maxBytesBeforeTerminator');
      return makeAttemptResult('failed', { failure });
    }

    const decoded = decodeInstructionAtRomOff({ prgBytes, romOff, cpuAddr });
    if (!decoded.ok) {
      if (latestBranchInstruction) {
        const success = recordSuccessThrough(latestBranchInstruction, 'soft', latestBranchInstructionCount);
        recordFailureFrom(latestBranchEndRomOff, decoded, decoded.reason || 'decodeFailedAfterSoftTerminator');
        return makeAttemptResult('success', success);
      }
      const { failure } = recordFailureFrom(startRomOff, decoded, decoded.reason || 'decodeFailedBeforeTerminator');
      return makeAttemptResult('failed', { failure });
    }

    const instruction = requireInstruction(decoded.instruction, 'speculative decoded instruction');
    instructions.push(instruction);
    candidateEdges.push(...candidateEdgesForInstruction({ attemptId, frontierId, candidate, instruction }));
    const instructionEnd = (instruction.romOff + instruction.size) >>> 0;

    if (isSoftTerminator(instruction.flow)) {
      latestBranchInstruction = instruction;
      latestBranchEndRomOff = instructionEnd;
      latestBranchInstructionCount = instructions.length;
      romOff = instructionEnd;
      cpuAddr = advanceCpu(cpuAddr, instruction.size);
      continue;
    }

    if (isHardTerminator(instruction.flow)) {
      const success = recordSuccessThrough(instruction, 'hard', instructions.length);
      return makeAttemptResult('success', success);
    }

    romOff = instructionEnd;
    cpuAddr = advanceCpu(cpuAddr, instruction.size);
  }

  if (latestBranchInstruction) {
    const success = recordSuccessThrough(latestBranchInstruction, 'soft', latestBranchInstructionCount);
    recordFailureFrom(latestBranchEndRomOff, { romOff }, 'maxInstructionsAfterSoftTerminator');
    return makeAttemptResult('success', success);
  }
  const { failure } = recordFailureFrom(startRomOff, { romOff }, 'maxInstructionsBeforeTerminator');
  return makeAttemptResult('failed', { failure });

  function makeAttemptResult(status, detail) {
    const attempt = {
      attemptId,
      frontierId,
      bankSize: candidate.bankSize >>> 0,
      bankIndex: candidate.bankIndex >>> 0,
      sourceBankIndex: candidate.sourceBankIndex >>> 0,
      targetCpuAddr: candidate.targetCpuAddr & 0xffff,
      startRomOff,
      status,
      romStart: startRomOff,
      romEnd: status === 'success' ? detail.romEnd >>> 0 : failedDecodeSpans[failedDecodeSpans.length - 1].romEnd >>> 0,
      terminator: status === 'success' ? successfulDecodeSpans[successfulDecodeSpans.length - 1].terminator : null,
      failure: status === 'failed' ? detail.failure : null,
      candidateBlockIds: candidateBlocks.map((block) => block.candidateBlockId)
    };
    return {
      status,
      attempt,
      instructions: status === 'success' ? instructions.slice(0, requireObject(candidateBlocks[0], 'successful candidate block').instructionIds.length) : [],
      candidateBlocks,
      candidateEdges,
      successfulDecodeSpans,
      failedDecodeSpans
    };
  }
}
