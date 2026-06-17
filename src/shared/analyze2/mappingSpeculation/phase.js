import { ANALYSIS_PHASE_IDS } from '../analysisConstants.js';
import { FRONTIER_KINDS } from '../cfg/constants.js';
import { requireArray, requireInteger, requireObject } from '../dataShape.js';
import {
  isDirectFrontierEligibleForMappingSpeculation,
  makeAttemptKey,
  requireFrontierForMappingSpeculation,
  requireMappingSpeculationCandidate
} from './candidates.js';
import {
  addFailedSpan,
  createFailedSpanIndex,
  findFailedSpanContainingStart
} from './failedSpanIndex.js';
import { runMappingDecodeAttempt } from './decodeAttempt.js';

function requireMapperForSpeculation(mapper) {
  requireObject(mapper, 'mapping speculation mapper');
  if (typeof mapper.getMappingSpeculationCandidates !== 'function') {
    throw new Error('mapper must provide getMappingSpeculationCandidates()');
  }
  return mapper;
}

function cloneSpanRef(span) {
  return {
    attemptId: span.attemptId,
    romStart: span.romStart >>> 0,
    romEnd: span.romEnd >>> 0
  };
}

function makeEmptySpeculativeBlocks(counters) {
  return {
    producedBy: 'mappingSpeculation',
    attempts: [],
    successfulDecodeSpans: [],
    failedDecodeSpans: [],
    skippedCandidates: [],
    candidateInstructions: [],
    candidateBlocks: [],
    candidateEdges: [],
    counters: { ...counters }
  };
}

export function createMappingSpeculationPhase(context, options = null) {
  requireObject(context, 'mapping speculation context');
  const opts = options === null || options === undefined ? {} : requireObject(options, 'mapping speculation options');
  const maxInstructions = opts.maxInstructions === undefined ? 256 : requireInteger(opts.maxInstructions, 'mapping speculation options.maxInstructions');
  const maxBytes = opts.maxBytes === undefined ? 0x1000 : requireInteger(opts.maxBytes, 'mapping speculation options.maxBytes');

  const state = {
    initialized: false,
    frontierQueue: [],
    candidateQueue: [],
    attemptKeys: new Set(),
    failedSpanIndex: createFailedSpanIndex(),
    attempts: [],
    successfulDecodeSpans: [],
    failedDecodeSpans: [],
    skippedCandidates: [],
    candidateInstructions: [],
    candidateInstructionKeys: new Set(),
    candidateBlocks: [],
    candidateEdges: [],
    counters: {
      frontiersTotal: 0,
      frontiersProcessed: 0,
      candidatesQueued: 0,
      attemptsStarted: 0,
      attemptsSucceeded: 0,
      attemptsFailed: 0,
      candidatesSkipped: 0,
      candidateBlockCount: 0,
      failedSpanCount: 0
    }
  };

  function initialize() {
    const mapper = requireMapperForSpeculation(context.mapper);
    const frontiers = requireArray(context.frontiers, 'mapping speculation frontiers')
      .filter((frontier) => frontier.kind === FRONTIER_KINDS.AMBIGUOUS_DIRECT_TARGET)
      .filter(isDirectFrontierEligibleForMappingSpeculation)
      .map((frontier, index) => requireFrontierForMappingSpeculation(frontier, `mapping speculation frontier ${index}`));
    state.frontierQueue = frontiers.slice();
    state.counters.frontiersTotal = state.frontierQueue.length;
    state.initialized = true;
    if (!context.speculativeBlocks) context.speculativeBlocks = makeEmptySpeculativeBlocks(state.counters);
    return mapper;
  }

  function recordSkipped(skipped) {
    state.skippedCandidates.push(skipped);
    state.counters.candidatesSkipped = state.skippedCandidates.length;
  }

  function enqueueCandidate(candidate) {
    requireMappingSpeculationCandidate(candidate, 'mapping speculation mapper candidate');
    const key = makeAttemptKey(candidate);
    if (state.attemptKeys.has(key)) {
      recordSkipped({
        frontierId: candidate.frontierId,
        bankSize: candidate.bankSize >>> 0,
        bankIndex: candidate.bankIndex >>> 0,
        startRomOff: candidate.startRomOff >>> 0,
        reason: 'duplicateAttempt'
      });
      return;
    }

    const failedSpan = findFailedSpanContainingStart(state.failedSpanIndex, candidate);
    if (failedSpan) {
      recordSkipped({
        frontierId: candidate.frontierId,
        bankSize: candidate.bankSize >>> 0,
        bankIndex: candidate.bankIndex >>> 0,
        startRomOff: candidate.startRomOff >>> 0,
        reason: 'insideFailedDecodeSpan',
        failedAttemptId: failedSpan.attemptId,
        failedSpan: cloneSpanRef(failedSpan)
      });
      return;
    }

    state.candidateQueue.push(candidate);
    state.counters.candidatesQueued = state.candidateQueue.length;
  }

  function prepareNextFrontier(mapper) {
    const frontier = state.frontierQueue.shift();
    requireFrontierForMappingSpeculation(frontier, 'mapping speculation queued frontier');
    const candidates = mapper.getMappingSpeculationCandidates(frontier, {
      maxInstructions,
      maxBytes
    });
    requireArray(candidates, 'mapping speculation candidates');
    for (let i = 0; i < candidates.length; i += 1) {
      enqueueCandidate(requireMappingSpeculationCandidate(candidates[i], `mapping speculation candidate ${i}`));
    }
    state.counters.frontiersProcessed += 1;
  }

  function addCandidateInstruction(instruction) {
    requireObject(instruction, 'speculative instruction');
    const key = requireInteger(instruction.instructionId, 'speculative instruction.instructionId') >>> 0;
    if (state.candidateInstructionKeys.has(key)) return;
    state.candidateInstructionKeys.add(key);
    state.candidateInstructions.push(instruction);
  }

  function recordAttemptResult(result) {
    requireObject(result, 'mapping decode result');
    requireObject(result.attempt, 'mapping decode result.attempt');
    state.attempts.push(result.attempt);
    if (result.status === 'success') state.counters.attemptsSucceeded += 1;
    else if (result.status === 'failed') state.counters.attemptsFailed += 1;
    else throw new Error(`Unexpected mapping decode result status ${result.status}`);

    for (const instruction of requireArray(result.instructions, 'mapping decode result.instructions')) {
      addCandidateInstruction(instruction);
    }
    for (const block of requireArray(result.candidateBlocks, 'mapping decode result.candidateBlocks')) {
      state.candidateBlocks.push(block);
    }
    for (const edge of requireArray(result.candidateEdges, 'mapping decode result.candidateEdges')) {
      state.candidateEdges.push(edge);
    }
    for (const span of requireArray(result.successfulDecodeSpans, 'mapping decode result.successfulDecodeSpans')) {
      state.successfulDecodeSpans.push(span);
    }
    for (const span of requireArray(result.failedDecodeSpans, 'mapping decode result.failedDecodeSpans')) {
      state.failedDecodeSpans.push(span);
      addFailedSpan(state.failedSpanIndex, span);
    }

    state.counters.candidateBlockCount = state.candidateBlocks.length;
    state.counters.failedSpanCount = state.failedDecodeSpans.length;
  }

  function finish() {
    context.speculativeBlocks = {
      producedBy: 'mappingSpeculation',
      attempts: state.attempts,
      successfulDecodeSpans: state.successfulDecodeSpans,
      failedDecodeSpans: state.failedDecodeSpans,
      skippedCandidates: state.skippedCandidates,
      candidateInstructions: state.candidateInstructions,
      candidateBlocks: state.candidateBlocks,
      candidateEdges: state.candidateEdges,
      counters: { ...state.counters }
    };
    requireObject(context.diagnostics, 'mapping speculation diagnostics');
    requireArray(context.diagnostics.phaseSummaries, 'mapping speculation diagnostics.phaseSummaries');
    context.diagnostics.phaseSummaries.push({
      name: ANALYSIS_PHASE_IDS.MAPPING_SPECULATION,
      status: 'complete',
      counters: { ...state.counters }
    });
  }

  return {
    name: ANALYSIS_PHASE_IDS.MAPPING_SPECULATION,
    stepOne() {
      const mapper = state.initialized ? requireMapperForSpeculation(context.mapper) : initialize();

      if (state.candidateQueue.length > 0) {
        const candidate = requireMappingSpeculationCandidate(state.candidateQueue.shift(), 'mapping speculation decode candidate');
        state.counters.candidatesQueued = state.candidateQueue.length;
        const key = makeAttemptKey(candidate);
        if (state.attemptKeys.has(key)) {
          recordSkipped({
            frontierId: candidate.frontierId,
            bankSize: candidate.bankSize >>> 0,
            bankIndex: candidate.bankIndex >>> 0,
            startRomOff: candidate.startRomOff >>> 0,
            reason: 'duplicateAttempt'
          });
          return { status: 'running' };
        }
        const failedSpan = findFailedSpanContainingStart(state.failedSpanIndex, candidate);
        if (failedSpan) {
          recordSkipped({
            frontierId: candidate.frontierId,
            bankSize: candidate.bankSize >>> 0,
            bankIndex: candidate.bankIndex >>> 0,
            startRomOff: candidate.startRomOff >>> 0,
            reason: 'insideFailedDecodeSpan',
            failedAttemptId: failedSpan.attemptId,
            failedSpan: cloneSpanRef(failedSpan)
          });
          return { status: 'running' };
        }

        state.attemptKeys.add(key);
        state.counters.attemptsStarted += 1;
        const result = runMappingDecodeAttempt({
          prgBytes: context.prgBytes,
          candidate,
          options: { maxInstructions, maxBytes }
        });
        recordAttemptResult(result);
        return { status: 'running' };
      }

      if (state.frontierQueue.length > 0) {
        prepareNextFrontier(mapper);
        return { status: 'running' };
      }

      finish();
      return { status: 'complete' };
    },
    progress() {
      return {
        phase: ANALYSIS_PHASE_IDS.MAPPING_SPECULATION,
        ...state.counters
      };
    }
  };
}
