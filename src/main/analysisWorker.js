import { parentPort, workerData } from 'node:worker_threads';

import { analyzeStaticFixedSwitch16k, analyzeStaticFixedSwitch32k, analyzeStaticMmc1, analyzeStaticMmc3, analyzeStaticNrom } from '../shared/analyze/analyzeStatic.js';
import { buildDisplayAnalysis } from '../shared/analyze/display/buildDisplayAnalysis.js';

async function run() {
  try {
    const { prgBytes, vectors, mapperKind, mapperMeta, cdlPrg, cdlChr, cdlMeta, yieldEveryMs, tuningOverrides } = workerData || {};
    const family = mapperMeta?.mapperFamily || mapperKind || 'NROM';
    const isFixedSwitch16k = family === 'UxROM' || family === 'UN1ROM';
    const isFixedSwitch32k = family === 'AxROM' || family === 'BNROM' || family === 'GxROM';
    const isMmc1 = family === 'MMC1';
    const isMmc3 = family === 'MMC3';

    const onVsaProgress = (p) => {
      parentPort?.postMessage({
        kind: 'vsaProgress',
        stableBlocks: p?.stableBlocks,
        totalBlocks: p?.totalBlocks,
        runId: p?.runId
      });
    };

    const rawAnalysis = isFixedSwitch16k
      ? await analyzeStaticFixedSwitch16k({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides: tuningOverrides?.fixedSwitch16k || null, cdlPrg, cdlChr, cdlMeta })
      : isFixedSwitch32k
        ? await analyzeStaticFixedSwitch32k({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides: tuningOverrides?.fixedSwitch32k || null, cdlPrg, cdlChr, cdlMeta })
        : isMmc1
          ? await analyzeStaticMmc1({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides: tuningOverrides?.mmc1 || tuningOverrides?.fixedSwitch16k || null, cdlPrg, cdlChr, cdlMeta })
        : isMmc3
          ? await analyzeStaticMmc3({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides: tuningOverrides?.mmc3 || tuningOverrides?.fixedSwitch16k || null, cdlPrg, cdlChr, cdlMeta })
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

    const { analysis: displayAnalysis, rawToDisplayBlockIds } = buildDisplayAnalysis(rawAnalysis);
    parentPort?.postMessage({ ok: true, rawAnalysis, displayAnalysis, rawToDisplayBlockIds });
  } catch (err) {
    const msg = err?.message || String(err);
    const stack = err?.stack || null;
    parentPort?.postMessage({ ok: false, error: msg, stack });
  }
}

run();
