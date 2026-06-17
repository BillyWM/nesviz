import { performance } from 'node:perf_hooks';
import { setImmediate as setImmediatePromise } from 'node:timers/promises';
import { parentPort, workerData } from 'node:worker_threads';

import { createAnalysisTask } from '../../shared/analyze2/index.js';
import { ANALYSIS_PROGRESS_MESSAGE_KINDS } from '../../shared/analyze2/analysisConstants.js';

const DEFAULT_SLICE_MAX_MS = 8;
const DEFAULT_SLICE_MAX_STEPS = 2000;
const DEFAULT_PROGRESS_EVERY_MS = 100;
const STRICT_CFG_PROGRESS_INSTRUCTION_DELTA = 300;
const STRICT_CFG_PROGRESS_BLOCK_DELTA = 50;

if (!parentPort) throw new Error('Analysis worker requires parentPort');

let cancelled = false;

parentPort.on('message', (msg) => {
  if (msg && typeof msg === 'object' && msg.kind === 'cancel') cancelled = true;
});

function nowMs() {
  return Number(performance.now());
}

function progressValue(progress, key) {
  const value = progress[key];
  return typeof value === 'number' ? value : 0;
}

function shouldPostProgress(progress, lastProgress, lastPostedAt) {
  if (!progress || typeof progress !== 'object') throw new Error('Progress payload must be an object');
  const elapsed = nowMs() - lastPostedAt;
  if (elapsed >= DEFAULT_PROGRESS_EVERY_MS) return true;
  if (!lastProgress) return true;

  if (progress.phase !== lastProgress.phase) return true;

  if (progress.phase === 'strictCfg') {
    const decodedDelta = progressValue(progress, 'decodedInstructions') - progressValue(lastProgress, 'decodedInstructions');
    const blockDelta = progressValue(progress, 'physicalBlockCount') - progressValue(lastProgress, 'physicalBlockCount');
    return decodedDelta >= STRICT_CFG_PROGRESS_INSTRUCTION_DELTA || blockDelta >= STRICT_CFG_PROGRESS_BLOCK_DELTA;
  }

  return false;
}

function postProgress(progress) {
  parentPort.postMessage({ kind: 'analysisProgress', progress });
}

function normalizeGroupIteration(groupIteration) {
  return Number.isInteger(groupIteration) && groupIteration > 0 ? groupIteration : null;
}

function phaseInfoKey(info) {
  if (!info || typeof info.phaseId !== 'string' || !info.phaseId) return null;
  const groupId = typeof info.groupId === 'string' && info.groupId ? info.groupId : '';
  const groupIteration = normalizeGroupIteration(info.groupIteration) ?? '';
  return `${groupId}:${groupIteration}:${info.phaseId}`;
}

function makePhaseStartedMessage(info, timing = null) {
  const groupId = typeof info.groupId === 'string' && info.groupId ? info.groupId : null;
  const out = {
    kind: ANALYSIS_PROGRESS_MESSAGE_KINDS.PHASE_STARTED,
    phaseId: info.phaseId,
    groupId,
    groupIteration: normalizeGroupIteration(info.groupIteration),
    elapsedMs: 0
  };
  if (groupId && timing && typeof timing.groupElapsedMs === 'number') out.groupElapsedMs = timing.groupElapsedMs;
  return out;
}

function copyProgressDetails(out, source) {
  if (!source || typeof source !== 'object') return out;
  if (typeof source.detailKind === 'string' && source.detailKind) out.detailKind = source.detailKind;
  if (source.details && typeof source.details === 'object') out.details = { ...source.details };
  return out;
}

function makePhaseCompleteMessage(result, timing = null) {
  const groupId = typeof result.groupId === 'string' && result.groupId ? result.groupId : null;
  const out = {
    kind: ANALYSIS_PROGRESS_MESSAGE_KINDS.PHASE_COMPLETE,
    phaseId: result.phase,
    groupId,
    groupIteration: normalizeGroupIteration(result.groupIteration),
    nextPhaseId: typeof result.nextPhase === 'string' && result.nextPhase ? result.nextPhase : null
  };
  if (timing && typeof timing.elapsedMs === 'number') out.elapsedMs = timing.elapsedMs;
  if (timing && typeof timing.groupElapsedMs === 'number') out.groupElapsedMs = timing.groupElapsedMs;
  return copyProgressDetails(out, result.progress);
}

function makePhaseProgressMessage(progress, timing = null) {
  const source = progress && typeof progress === 'object' ? progress : {};
  const groupId = typeof source.groupId === 'string' && source.groupId ? source.groupId : null;
  const out = {
    kind: ANALYSIS_PROGRESS_MESSAGE_KINDS.PHASE_PROGRESS,
    phaseId: typeof source.phase === 'string' && source.phase ? source.phase : null,
    groupId,
    groupIteration: normalizeGroupIteration(source.groupIteration),
    counters: { ...source }
  };
  if (timing && typeof timing.elapsedMs === 'number') out.elapsedMs = timing.elapsedMs;
  if (timing && typeof timing.groupElapsedMs === 'number') out.groupElapsedMs = timing.groupElapsedMs;
  return copyProgressDetails(out, source);
}

function postUiUpdate(update) {
  parentPort.postMessage({ kind: 'analysisUiUpdate', update });
}

function drainUiUpdates(task) {
  if (!task || typeof task.consumeUiUpdates !== 'function') return;
  const updates = task.consumeUiUpdates();
  if (!Array.isArray(updates)) return;
  for (const update of updates) {
    postUiUpdate(update);
  }
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function errorStack(err) {
  return err instanceof Error ? err.stack || null : null;
}

async function run() {
  try {
    const task = createAnalysisTask(workerData);
    let lastProgress = null;
    let lastPostedAt = 0;

    let startedPhaseKey = null;
    const phaseStartedAtByKey = new Map();
    const groupStartedAtById = new Map();

    function timingForPhaseInfo(info) {
      const key = phaseInfoKey(info);
      const startedAt = key ? phaseStartedAtByKey.get(key) : null;
      const elapsedMs = typeof startedAt === 'number' ? Math.max(0, nowMs() - startedAt) : null;
      const groupId = typeof info?.groupId === 'string' && info.groupId ? info.groupId : null;
      const groupStartedAt = groupId ? groupStartedAtById.get(groupId) : null;
      const groupElapsedMs = typeof groupStartedAt === 'number' ? Math.max(0, nowMs() - groupStartedAt) : null;
      return { elapsedMs, groupElapsedMs };
    }

    function timingForProgress(progress) {
      const info = {
        phaseId: typeof progress?.phase === 'string' ? progress.phase : null,
        groupId: typeof progress?.groupId === 'string' ? progress.groupId : null,
        groupIteration: normalizeGroupIteration(progress?.groupIteration)
      };
      return timingForPhaseInfo(info);
    }

    function timingForPhaseComplete(result) {
      const info = {
        phaseId: result.phase,
        groupId: typeof result.groupId === 'string' ? result.groupId : null,
        groupIteration: normalizeGroupIteration(result.groupIteration)
      };
      const groupIsCompleting = !info.groupId && typeof result.phase === 'string' && groupStartedAtById.has(result.phase);
      if (groupIsCompleting) {
        const groupStartedAt = groupStartedAtById.get(result.phase);
        return {
          elapsedMs: Math.max(0, nowMs() - groupStartedAt),
          groupElapsedMs: Math.max(0, nowMs() - groupStartedAt)
        };
      }
      return timingForPhaseInfo(info);
    }

    while (!task.isDone() && !task.isFailed()) {
      const sliceStart = nowMs();
      let steps = 0;
      let phaseBoundary = false;

      while (!cancelled && !task.isDone() && !task.isFailed()) {
        const phaseInfo = typeof task.getCurrentPhaseInfo === 'function' ? task.getCurrentPhaseInfo() : null;
        const currentPhaseKey = phaseInfoKey(phaseInfo);
        if (currentPhaseKey && currentPhaseKey !== startedPhaseKey) {
          const phaseStartedAt = nowMs();
          phaseStartedAtByKey.set(currentPhaseKey, phaseStartedAt);
          if (phaseInfo && typeof phaseInfo.groupId === 'string' && phaseInfo.groupId && !groupStartedAtById.has(phaseInfo.groupId)) {
            groupStartedAtById.set(phaseInfo.groupId, phaseStartedAt);
          }
          postProgress(makePhaseStartedMessage(phaseInfo, timingForPhaseInfo(phaseInfo)));
          startedPhaseKey = currentPhaseKey;
        }

        const result = task.stepOne();
        steps += 1;
        if (result.status === 'phaseComplete') {
          const timing = timingForPhaseComplete(result);
          postProgress(makePhaseCompleteMessage(result, timing));
          const completedKey = phaseInfoKey({
            phaseId: result.phase,
            groupId: typeof result.groupId === 'string' ? result.groupId : null,
            groupIteration: normalizeGroupIteration(result.groupIteration)
          });
          if (completedKey) phaseStartedAtByKey.delete(completedKey);
          if (!result.groupId && typeof result.phase === 'string' && groupStartedAtById.has(result.phase)) {
            groupStartedAtById.delete(result.phase);
          }
          startedPhaseKey = null;
          phaseBoundary = true;
          break;
        }
        if (result.status === 'done') {
          if (typeof result.phase === 'string' && result.phase && result.phase !== 'done') {
            const timing = timingForPhaseComplete(result);
            postProgress(makePhaseCompleteMessage(result, timing));
          }
          startedPhaseKey = null;
          phaseBoundary = true;
          break;
        }
        if (result.status === 'groupIterationComplete' || result.status === 'failed') {
          phaseBoundary = true;
          break;
        }
        if (result.progressNow) {
          const immediateProgress = task.getProgress();
          postProgress(makePhaseProgressMessage(immediateProgress, timingForProgress(immediateProgress)));
          lastProgress = { ...immediateProgress };
          lastPostedAt = nowMs();
        }
        if (steps >= DEFAULT_SLICE_MAX_STEPS) break;
        if ((nowMs() - sliceStart) >= DEFAULT_SLICE_MAX_MS) break;
      }

      if (cancelled) {
        parentPort.postMessage({ ok: false, canceled: true, error: 'Analysis cancelled' });
        return;
      }

      drainUiUpdates(task);

      const progress = task.getProgress();
      if (phaseBoundary || shouldPostProgress(progress, lastProgress, lastPostedAt)) {
        postProgress(makePhaseProgressMessage(progress, timingForProgress(progress)));
        lastProgress = { ...progress };
        lastPostedAt = nowMs();
      }

      await setImmediatePromise();
    }

    drainUiUpdates(task);

    const result = task.getResult();
    if (!result) throw new Error('Analysis finished without a result');
    parentPort.postMessage(result);
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: errorMessage(err),
      stack: errorStack(err)
    });
  }
}

run();
