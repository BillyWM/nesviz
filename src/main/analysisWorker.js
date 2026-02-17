import { parentPort, workerData } from 'node:worker_threads';

import { analyzeStaticNrom } from '../shared/analyze/analyzeStatic.js';
import { buildCoalescedAnalysisView } from '../shared/analyze/coalesce/coalesceView.js';
import { DEFAULT_COALESCE_CONFIG } from '../shared/analyze/coalesce/config.js';
import { runPointsOfInterestRecognizers } from '../shared/analyze/recognize/pointsOfInterest.js';

async function run() {
  try {
    const { prgBytes, vectors, mapperKind, cdlPrg, cdlChr, cdlMeta, yieldEveryMs } = workerData || {};

    const onVsaProgress = (p) => {
      // Stream only the VSA metric we care about to the renderer.
      parentPort?.postMessage({
        kind: 'vsaProgress',
        stableBlocks: p?.stableBlocks,
        totalBlocks: p?.totalBlocks,
        runId: p?.runId
      });
    };

    const raw = await analyzeStaticNrom({
      prgBytes,
      vectors,
      mapperKind,
      cdlPrg,
      cdlChr,
      cdlMeta,
      // Yielding is optional; in the worker it doesn't affect UI responsiveness,
      // but keeping the knob makes it easy to re-enable progress/cancellation later.
      yieldEveryMs: (yieldEveryMs | 0) || 0,
      onVsaProgress,
      vsaProgressEveryMs: 100
    });

    // Build a coalesced display view after analysis passes have produced the true CFG.
    const { analysis, blockAliases } = buildCoalescedAnalysisView(raw, DEFAULT_COALESCE_CONFIG);

    // Run strict, constants-only POI recognizers on the coalesced view so UI pills/POIs line up with what the user reads.
    runPointsOfInterestRecognizers(analysis);

    parentPort?.postMessage({ ok: true, raw, analysis, blockAliases });
  } catch (err) {
    const msg = err?.message || String(err);
    const stack = err?.stack || null;
    parentPort?.postMessage({ ok: false, error: msg, stack });
  }
}

run();
