import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter, on as onEvent } from 'node:events';
import { Worker } from 'node:worker_threads';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKER_EVENT_NAMES = Object.freeze({
  MESSAGE: 'message',
  ERROR: 'error',
  EXIT: 'exit',
  NORMALIZED: 'workerEvent'
});

const WORKER_MESSAGE_KINDS = Object.freeze({
  ANALYSIS_PROGRESS: 'analysisProgress',
  ANALYSIS_UI_UPDATE: 'analysisUiUpdate',
  PROGRESS: 'progress',
  UI_UPDATE: 'uiUpdate',
  RESULT: 'result',
  ERROR: 'error'
});

let activeWorker = null;

export async function cancelActiveAnalysisExecution() {
  const worker = activeWorker;
  if (!worker) return;
  activeWorker = null;
  try {
    worker.postMessage({ kind: 'cancel' });
  } catch {}
  try {
    await worker.terminate();
  } catch {}
}

function resolveAnalysisWorkerPath() {
  const candidates = [
    path.join(__dirname, 'analyze', 'analysisWorker.js'),
    path.join(__dirname, 'analysisWorker.js')
  ];
  return Promise.any(candidates.map(async (candidate) => {
    await fs.access(candidate);
    return candidate;
  })).catch(() => {
    throw new Error(`Analysis worker not found. Tried: ${candidates.join(', ')}`);
  });
}

async function runAnalysisWorker(payload, opts = null) {
  const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
  const onUiUpdate = typeof opts?.onUiUpdate === 'function' ? opts.onUiUpdate : null;
  const onWorker = typeof opts?.onWorker === 'function' ? opts.onWorker : null;

  const workerPath = await resolveAnalysisWorkerPath();
  const worker = new Worker(workerPath, { workerData: payload });
  const workerEvents = new EventEmitter();
  const eventIterator = onEvent(workerEvents, WORKER_EVENT_NAMES.NORMALIZED);

  let finished = false;

  const emitWorkerEvent = (event) => {
    if (finished) return;
    workerEvents.emit(WORKER_EVENT_NAMES.NORMALIZED, event);
  };

  const handleMessage = (msg) => {
    if (msg?.kind === WORKER_MESSAGE_KINDS.ANALYSIS_PROGRESS) {
      emitWorkerEvent({
        kind: WORKER_MESSAGE_KINDS.PROGRESS,
        progress: msg.progress || null
      });
      return;
    }
    if (msg?.kind === WORKER_MESSAGE_KINDS.ANALYSIS_UI_UPDATE) {
      emitWorkerEvent({
        kind: WORKER_MESSAGE_KINDS.UI_UPDATE,
        update: msg.update || null
      });
      return;
    }
    emitWorkerEvent({
      kind: WORKER_MESSAGE_KINDS.RESULT,
      result: msg
    });
  };

  const handleError = (err) => {
    emitWorkerEvent({
      kind: WORKER_MESSAGE_KINDS.ERROR,
      error: err?.message || String(err)
    });
  };

  const handleExit = (code) => {
    if (finished) return;
    emitWorkerEvent({
      kind: WORKER_MESSAGE_KINDS.ERROR,
      error: code === 0
        ? 'Analysis worker exited without sending a result'
        : `Analysis worker exited with code ${code}`
    });
  };

  worker.on(WORKER_EVENT_NAMES.MESSAGE, handleMessage);
  worker.once(WORKER_EVENT_NAMES.ERROR, handleError);
  worker.once(WORKER_EVENT_NAMES.EXIT, handleExit);

  if (onWorker) {
    try { onWorker(worker); } catch {}
  }

  try {
    for await (const [event] of eventIterator) {
      if (event?.kind === WORKER_MESSAGE_KINDS.PROGRESS) {
        if (onProgress) {
          try { onProgress(event.progress || null); } catch {}
        }
        continue;
      }

      if (event?.kind === WORKER_MESSAGE_KINDS.UI_UPDATE) {
        if (onUiUpdate) {
          try { onUiUpdate(event.update || null); } catch {}
        }
        continue;
      }

      if (event?.kind === WORKER_MESSAGE_KINDS.RESULT) {
        finished = true;
        return event.result;
      }

      if (event?.kind === WORKER_MESSAGE_KINDS.ERROR) {
        finished = true;
        throw new Error(event.error || 'Analysis worker failed');
      }
    }

    throw new Error('Analysis worker ended before returning a result');
  } finally {
    finished = true;
    worker.off(WORKER_EVENT_NAMES.MESSAGE, handleMessage);
    worker.off(WORKER_EVENT_NAMES.ERROR, handleError);
    worker.off(WORKER_EVENT_NAMES.EXIT, handleExit);
    workerEvents.removeAllListeners();
  }
}

export async function executeAnalysis(payload, opts = null) {
  await cancelActiveAnalysisExecution();

  let thisWorker = null;
  try {
    const result = await runAnalysisWorker(payload, {
      onWorker: (worker) => {
        thisWorker = worker;
        activeWorker = worker;
      },
      onProgress: opts?.onProgress,
      onUiUpdate: opts?.onUiUpdate
    });
    if (activeWorker === thisWorker) activeWorker = null;
    return result;
  } catch (err) {
    if (activeWorker === thisWorker) activeWorker = null;
    throw err;
  }
}
