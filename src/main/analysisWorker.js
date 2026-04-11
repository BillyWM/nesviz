import { parentPort, workerData } from 'node:worker_threads';

import { analyzeStaticFixedSwitch16k, analyzeStaticFixedSwitch32k, analyzeStaticMmc1, analyzeStaticNrom } from '../shared/analyze/analyzeStatic.js';
import { buildDisplayAnalysis } from '../shared/analyze/display/buildDisplayAnalysis.js';

async function run() {
  try {
    const { prgBytes, vectors, mapperKind, mapperMeta, cdlPrg, cdlChr, cdlMeta, yieldEveryMs, tuningOverrides } = workerData || {};
    const family = mapperMeta?.mapperFamily || mapperKind || 'NROM';
    const isFixedSwitch16k = family === 'UxROM' || family === 'UN1ROM';
    const isFixedSwitch32k = family === 'AxROM' || family === 'BNROM' || family === 'GxROM';
    const isMmc1 = family === 'MMC1';

    const onVsaProgress = (p) => {
      parentPort?.postMessage({
        kind: 'vsaProgress',
        stableBlocks: p?.stableBlocks,
        totalBlocks: p?.totalBlocks,
        runId: p?.runId
      });
    };

    const raw = isFixedSwitch16k
      ? await analyzeStaticFixedSwitch16k({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides: tuningOverrides?.fixedSwitch16k || null })
      : isFixedSwitch32k
        ? await analyzeStaticFixedSwitch32k({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides: tuningOverrides?.fixedSwitch32k || null })
        : isMmc1
          ? await analyzeStaticMmc1({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides: tuningOverrides?.mmc1 || tuningOverrides?.fixedSwitch16k || null })
          : await analyzeStaticNrom({
            prgBytes,
            vectors,
            mapperKind,
            mapperMeta,
            cdlPrg,
            cdlChr,
            cdlMeta,
            yieldEveryMs: (yieldEveryMs | 0) || 0,
            onVsaProgress,
            vsaProgressEveryMs: 100
          });

    const { analysis, blockAliases } = buildDisplayAnalysis(raw);
    parentPort?.postMessage({ ok: true, raw, analysis, blockAliases });
  } catch (err) {
    const msg = err?.message || String(err);
    const stack = err?.stack || null;
    parentPort?.postMessage({ ok: false, error: msg, stack });
  }
}

run();
