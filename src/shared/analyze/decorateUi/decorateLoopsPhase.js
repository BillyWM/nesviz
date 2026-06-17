import { ANALYSIS_PHASE_IDS } from '../analysisConstants.js';
import {
  buildInstructionMap,
  requireArray,
  requireInteger,
  requireObject,
  requireString
} from '../dataShape.js';
import {
  isSpanWithinSingleDisplayBlock,
  locateDisplayBlockForSpan
} from '../display/displaySpan.js';

function makeCounters() {
  return {
    summarizedLoops: 0,
    detectedLoops: 0,
    materializedLoopGuides: 0,
    materializedSummaryLoopGuides: 0,
    materializedDetectedLoopGuides: 0,
    skippedMissingAnchor: 0,
    skippedInvalidSpan: 0,
    skippedNoContainingDisplayBlock: 0,
    skippedCrossDisplayBlock: 0,
    skippedMultipleContainingDisplayBlocks: 0,
    skippedMissingDisplayLine: 0,
    skippedBackwardsOrZeroLineSpan: 0,
    skippedOther: 0
  };
}

function incrementSkip(counters, reason) {
  if (reason === 'invalidSpan') counters.skippedInvalidSpan += 1;
  else if (reason === 'noContainingDisplayBlock') counters.skippedNoContainingDisplayBlock += 1;
  else if (reason === 'crossDisplayBlock') counters.skippedCrossDisplayBlock += 1;
  else if (reason === 'multipleContainingDisplayBlocks') counters.skippedMultipleContainingDisplayBlocks += 1;
  else if (reason === 'missingStartLine' || reason === 'missingEndLine') counters.skippedMissingDisplayLine += 1;
  else if (reason === 'backwardsOrZeroLineSpan') counters.skippedBackwardsOrZeroLineSpan += 1;
  else counters.skippedOther += 1;
}

function mapByString(items, key, label) {
  const out = new Map();
  const arr = requireArray(items, label);
  for (let i = 0; i < arr.length; i += 1) {
    const item = requireObject(arr[i], `${label}[${i}]`);
    const id = requireString(item[key], `${label}[${i}].${key}`);
    if (out.has(id)) throw new Error(`Duplicate ${label} ${key} ${id}`);
    out.set(id, item);
  }
  return out;
}

function firstRomOffForBlockInstance(blockInstanceId, indexes) {
  const instance = indexes.blockInstanceById.get(blockInstanceId);
  if (!instance) return null;
  const block = indexes.blockById.get(instance.blockId);
  if (!block) return null;
  const instructionIds = requireArray(block.instructionIds, `${block.blockId}.instructionIds`);
  if (!instructionIds.length) return null;
  const firstInstruction = indexes.instructionById.get(instructionIds[0] >>> 0);
  return firstInstruction ? (firstInstruction.romOff >>> 0) : (requireInteger(block.romStart, `${block.blockId}.romStart`) >>> 0);
}

function headerRomOffForSummary(summary, indexes) {
  const headerBlockInstanceId = requireString(summary.headerBlockInstanceId, 'loop summary.headerBlockInstanceId');
  return firstRomOffForBlockInstance(headerBlockInstanceId, indexes);
}

function headerRomOffForDetectedLoop(loop, indexes) {
  const headerBlockInstanceId = requireString(loop.headerBlockInstanceId, 'detected loop.headerBlockInstanceId');
  return firstRomOffForBlockInstance(headerBlockInstanceId, indexes);
}

function branchInstructionForSummary(summary, indexes) {
  const evidence = requireObject(summary.evidence, 'loop summary.evidence');
  const branchInstructionId = Number(evidence.branchInstructionId);
  if (!Number.isInteger(branchInstructionId)) return null;
  return indexes.instructionById.get(branchInstructionId >>> 0) || null;
}

function lastInstructionForBlockInstance(blockInstanceId, indexes) {
  const instance = indexes.blockInstanceById.get(blockInstanceId);
  if (!instance) return null;
  const block = indexes.blockById.get(instance.blockId);
  if (!block) return null;
  const instructionIds = requireArray(block.instructionIds, `${block.blockId}.instructionIds`);
  if (!instructionIds.length) return null;
  return indexes.instructionById.get(instructionIds[instructionIds.length - 1] >>> 0) || null;
}

function branchInstructionForDetectedLoop(loop, indexes) {
  const evidence = loop.evidence && typeof loop.evidence === 'object' ? loop.evidence : {};
  const branchInstructionId = Number(evidence.branchInstructionId);
  if (Number.isInteger(branchInstructionId)) {
    const instruction = indexes.instructionById.get(branchInstructionId >>> 0) || null;
    if (instruction) return instruction;
  }
  const tailInstructionId = Number(evidence.tailInstructionId);
  if (Number.isInteger(tailInstructionId)) {
    const instruction = indexes.instructionById.get(tailInstructionId >>> 0) || null;
    if (instruction) return instruction;
  }
  const tailBlockInstanceId = typeof loop.tailBlockInstanceId === 'string' ? loop.tailBlockInstanceId : null;
  return tailBlockInstanceId ? lastInstructionForBlockInstance(tailBlockInstanceId, indexes) : null;
}

function loopGuideKind(summary) {
  return summary.kind === 'counterLoop' ? 'index' : 'flag';
}

function makeLoopGuide(summary, startRomOff, branchInstruction) {
  const branchRomOff = branchInstruction.romOff >>> 0;
  return {
    kind: 'loopGuide',
    id: `loopGuide:${summary.loopId}`,
    guideKind: loopGuideKind(summary),
    range: {
      startRomOff,
      endRomOff: branchRomOff
    },
    anchors: {
      targetRomOff: startRomOff,
      branchRomOff
    },
    loopId: summary.loopId,
    depth: Number.isInteger(summary.depth) ? summary.depth : null,
    confidence: typeof summary.confidence === 'string' ? summary.confidence : null
  };
}

function makeDetectedLoopGuide(loop, startRomOff, branchInstruction) {
  const branchRomOff = branchInstruction.romOff >>> 0;
  return {
    kind: 'loopGuide',
    id: `loopGuide:${loop.loopId}`,
    guideKind: 'flag',
    range: {
      startRomOff,
      endRomOff: branchRomOff
    },
    anchors: {
      targetRomOff: startRomOff,
      branchRomOff
    },
    loopId: loop.loopId,
    sourceLoopId: typeof loop.sourceLoopId === 'string' ? loop.sourceLoopId : null,
    depth: Number.isInteger(loop.depth) ? loop.depth : null,
    confidence: typeof loop.confidence === 'string' ? loop.confidence : null,
    detectedLoopKind: typeof loop.kind === 'string' ? loop.kind : null
  };
}

function appendLoopGuide(displayBlock, loopGuide) {
  const existing = Array.isArray(displayBlock.loopGuides) ? displayBlock.loopGuides : [];
  if (existing.some((guide) => guide && guide.id === loopGuide.id)) return false;
  displayBlock.loopGuides = [...existing, loopGuide];
  return true;
}

function decorateOneLoop({ summary, displayAnalysis, indexes, counters }) {
  const startRomOff = headerRomOffForSummary(summary, indexes);
  const branchInstruction = branchInstructionForSummary(summary, indexes);
  if (startRomOff === null || !branchInstruction) {
    counters.skippedMissingAnchor += 1;
    return;
  }

  const branchRomOff = branchInstruction.romOff >>> 0;
  const branchEndRomOff = (branchInstruction.romOff + branchInstruction.size) >>> 0;
  const span = {
    startRomOff,
    endRomOff: branchEndRomOff,
    startAnchorRomOff: startRomOff,
    endAnchorRomOff: branchRomOff
  };

  const containment = isSpanWithinSingleDisplayBlock(displayAnalysis, span);
  if (!containment.ok) {
    incrementSkip(counters, containment.reason);
    return;
  }

  const location = locateDisplayBlockForSpan(displayAnalysis, span);
  if (!location.ok) {
    incrementSkip(counters, location.reason);
    return;
  }

  const loopGuide = makeLoopGuide(summary, startRomOff, branchInstruction);
  if (appendLoopGuide(location.displayBlock, loopGuide)) {
    counters.materializedLoopGuides += 1;
    counters.materializedSummaryLoopGuides += 1;
  }
}

function decorateOneDetectedLoop({ loop, displayAnalysis, indexes, counters }) {
  const startRomOff = headerRomOffForDetectedLoop(loop, indexes);
  const branchInstruction = branchInstructionForDetectedLoop(loop, indexes);
  if (startRomOff === null || !branchInstruction) {
    counters.skippedMissingAnchor += 1;
    return;
  }

  const branchRomOff = branchInstruction.romOff >>> 0;
  const branchEndRomOff = (branchInstruction.romOff + branchInstruction.size) >>> 0;
  const span = {
    startRomOff,
    endRomOff: branchEndRomOff,
    startAnchorRomOff: startRomOff,
    endAnchorRomOff: branchRomOff
  };

  const containment = isSpanWithinSingleDisplayBlock(displayAnalysis, span);
  if (!containment.ok) {
    incrementSkip(counters, containment.reason);
    return;
  }

  const location = locateDisplayBlockForSpan(displayAnalysis, span);
  if (!location.ok) {
    incrementSkip(counters, location.reason);
    return;
  }

  const loopGuide = makeDetectedLoopGuide(loop, startRomOff, branchInstruction);
  if (appendLoopGuide(location.displayBlock, loopGuide)) {
    counters.materializedLoopGuides += 1;
    counters.materializedDetectedLoopGuides += 1;
  }
}

export function createDecorateLoopsPhase(context) {
  let counters = makeCounters();

  return {
    name: ANALYSIS_PHASE_IDS.DECORATE_LOOPS,
    stepOne() {
      counters = makeCounters();
      const loopSummaries = requireObject(context.loopSummaries, 'decorateLoops loopSummaries');
      const summaries = requireArray(loopSummaries.summaries, 'decorateLoops loopSummaries.summaries');
      const loopDetections = context.loopDetections && typeof context.loopDetections === 'object'
        ? context.loopDetections
        : null;
      const detectedLoops = loopDetections
        ? requireArray(loopDetections.loops, 'decorateLoops loopDetections.loops')
        : [];
      const displayArtifacts = requireObject(context.displayArtifacts, 'decorateLoops displayArtifacts');
      const displayAnalysis = requireObject(displayArtifacts.displayAnalysis, 'decorateLoops displayAnalysis');
      const indexes = {
        blockById: mapByString(context.blocks, 'blockId', 'decorateLoops blocks'),
        blockInstanceById: mapByString(context.blockInstances, 'blockInstanceId', 'decorateLoops blockInstances'),
        instructionById: buildInstructionMap(context.instructions, 'decorateLoops instructions')
      };

      counters.summarizedLoops = summaries.length;
      counters.detectedLoops = detectedLoops.length;
      for (const summary of summaries) {
        decorateOneLoop({
          summary: requireObject(summary, 'loop summary'),
          displayAnalysis,
          indexes,
          counters
        });
      }
      for (const loop of detectedLoops) {
        decorateOneDetectedLoop({
          loop: requireObject(loop, 'detected loop'),
          displayAnalysis,
          indexes,
          counters
        });
      }

      context.diagnostics.phaseSummaries.push({
        name: ANALYSIS_PHASE_IDS.DECORATE_LOOPS,
        status: 'complete',
        counters: { ...counters }
      });
      return { status: 'complete', progress: this.progress() };
    },
    progress() {
      return {
        phase: ANALYSIS_PHASE_IDS.DECORATE_LOOPS,
        detailKind: 'decorateLoops',
        details: { ...counters }
      };
    }
  };
}
