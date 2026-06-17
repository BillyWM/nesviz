import {
  ANALYSIS_PHASE_IDS,
  ANALYSIS_PROGRESS_DETAIL_KINDS
} from '../analysisConstants.js';
import { requireObject } from '../dataShape.js';
import { createMonotoneTableScanner } from './monotoneTableScanner.js';

const FIND_MONOTONE_TABLES_WORDS_PER_STEP = 2048;
const FIND_MONOTONE_TABLES_PROGRESS_INTERVAL_MS = 100;

export function createFindMonotoneTablesPhase(context, options = {}) {
  const phaseOptions = options && typeof options === 'object' ? options : {};
  const wordsPerStep = Number.isInteger(phaseOptions.wordsPerStep) && phaseOptions.wordsPerStep > 0
    ? phaseOptions.wordsPerStep
    : FIND_MONOTONE_TABLES_WORDS_PER_STEP;
  let scanner = null;
  let complete = false;
  let lastProgressNowAt = 0;

  function shouldPostProgressNow(force = false) {
    const now = Date.now();
    if (!force && now - lastProgressNowAt < FIND_MONOTONE_TABLES_PROGRESS_INTERVAL_MS) return false;
    lastProgressNowAt = now;
    return true;
  }

  function ensureScanner() {
    if (!scanner) scanner = createMonotoneTableScanner({ prgBytes: context.prgBytes });
    return scanner;
  }

  function detailsFromResult(result) {
    const counters = result && result.counters && typeof result.counters === 'object' ? result.counters : {};
    return {
      tablesFound: Number.isInteger(counters.tablesFound) ? counters.tablesFound >>> 0 : 0,
      longestTableEntries: Number.isInteger(counters.longestTableEntries) ? counters.longestTableEntries >>> 0 : 0,
      longestTableRomOff: Number.isInteger(counters.longestTableRomOff) ? counters.longestTableRomOff >>> 0 : null,
      wordsScanned: Number.isInteger(counters.wordsScanned) ? counters.wordsScanned >>> 0 : 0
    };
  }

  function finalize() {
    const result = ensureScanner().result();
    context.monotoneTables = result;
    context.diagnostics.phaseSummaries.push({
      name: ANALYSIS_PHASE_IDS.FIND_MONOTONE_TABLES,
      status: 'complete',
      counters: { ...requireObject(result.counters, 'findMonotoneTables counters') }
    });
    complete = true;
    return result;
  }

  return {
    name: ANALYSIS_PHASE_IDS.FIND_MONOTONE_TABLES,
    stepOne() {
      if (complete) return { status: 'complete', progress: this.progress() };
      const currentScanner = ensureScanner();
      const step = currentScanner.stepWords(wordsPerStep);
      context.monotoneTables = currentScanner.result();
      if (!step.complete) {
        return {
          status: 'running',
          phase: ANALYSIS_PHASE_IDS.FIND_MONOTONE_TABLES,
          progressNow: shouldPostProgressNow(false)
        };
      }
      const result = finalize();
      shouldPostProgressNow(true);
      return { status: 'complete', progress: this.progress(result) };
    },
    progress(result = null) {
      const current = result || (scanner ? scanner.result() : null);
      if (!current) {
        const details = detailsFromResult(null);
        return {
          phase: ANALYSIS_PHASE_IDS.FIND_MONOTONE_TABLES,
          detailKind: ANALYSIS_PROGRESS_DETAIL_KINDS.FIND_MONOTONE_TABLES,
          details
        };
      }
      const details = detailsFromResult(current);
      return {
        phase: ANALYSIS_PHASE_IDS.FIND_MONOTONE_TABLES,
        ...current.counters,
        detailKind: ANALYSIS_PROGRESS_DETAIL_KINDS.FIND_MONOTONE_TABLES,
        details
      };
    }
  };
}
