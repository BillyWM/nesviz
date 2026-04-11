import { createNromMapper } from './map/nrom.js';
import { createFixedSwitch16kMapper } from './map/fixedSwitch16k.js';
import { createFixedSwitch32kMapper } from './map/fixedSwitch32k.js';
import { createMmc1Mapper } from './map/mmc1.js';
import { cpuToRomOffWithMapper } from './map/cpuToRomOff.js';
import { discoverCfg } from './discover/cfg.js';
import { buildTimeline } from './discover/timeline.js';
import { buildBlockContextIndex } from './discover/blockContextIndex.js';
import { runVsa } from './vsa/run.js';
import { runVsaFacts } from './vsa/runFacts.js';
import { buildVsaDataflow } from './vsa/dataflow.js';
import { buildMemoryDiscoveries } from './vsa/memoryDiscoveries.js';
import { recognizeJumpTables } from './recognize/jumpTables.js';
import { inferSpeculativeDispatchTargets } from './recognize/speculativeDispatch.js';
import { DEFAULT_PROBABLE_CONFIG_NROM, DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K, DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH32K, buildProbableConfigFixedSwitch16K, buildProbableConfigFixedSwitch32K } from './probable/config.js';
import { scanProbableCode } from './probable/scanUnknown.js';
import { buildProbableInterruptRootSet } from './probable/rtiVectorHeuristic.js';
import { deriveProbableSeedItems } from './probable/deriveSeeds.js';
import { cpuAddrForRomOffUsingSlot, decodePrgCdlByte, isPrgDataObserved } from './cdl/nesCdl.js';


async function collectVsaData({
  prgBytes,
  mapper,
  blocks,
  edges,
  entryBlockIds,
  vectorSeedItemsByFamily = null,
  vectorCpuAddrsByFamily = null,
  yieldEveryMs = 0,
  onVsaProgress = null,
  vsaProgressEveryMs = 0
}) {
  if (!Array.isArray(blocks) || !blocks.length || !Array.isArray(entryBlockIds) || !entryBlockIds.length) {
    return { vsaFacts: null, vsaDataflow: null, memoryDiscoveries: null, blockContextIndex: null };
  }

  if (typeof onVsaProgress === 'function' && (vsaProgressEveryMs > 0)) {
    onVsaProgress({ stableBlocks: 0, totalBlocks: blocks.length });
  }

  const blockContextIndex = buildBlockContextIndex({ blocks, edges, vectorSeedItemsByFamily, vectorCpuAddrsByFamily });

  const vsaFacts = await runVsaFacts({
    prgBytes,
    mapper,
    blocks,
    edges,
    entryBlockIds,
    blockContextIndex,
    yieldEveryMs,
    onProgress: onVsaProgress,
    progressEveryMs: vsaProgressEveryMs
  });

  const vsaDataflow = vsaFacts ? buildVsaDataflow({ observationsResult: vsaFacts }) : null;
  const memoryDiscoveries = (vsaFacts && vsaDataflow) ? buildMemoryDiscoveries({ observationsResult: vsaFacts, vsaDataflow, blockContextIndex, prgBytes, blocks, edges }) : null;
  return { vsaFacts, vsaDataflow, memoryDiscoveries, blockContextIndex };
}


function seedItemKey(mapper, seed) {
  const cpu = seed?.cpuAddr & 0xffff;
  const ctxKey = mapper?.fetchCtxKey ? mapper.fetchCtxKey(seed?.fetchCtx || mapper.initialFetchCtx()) : 'default';
  return `${ctxKey}:${cpu}`;
}

function seedSiteKey(mapper, seed) {
  if (typeof seed?.cpuAddr !== 'number') return null;
  const cpu = seed.cpuAddr & 0xffff;
  const ctx = seed?.fetchCtx || mapper?.initialFetchCtx?.() || null;
  const ctxKey = mapper?.fetchCtxKey ? mapper.fetchCtxKey(ctx) : (ctx?.key || 'default');
  return `${ctxKey}:${cpu.toString(16).toUpperCase().padStart(4, '0')}`;
}

function mergeSeedItems(mapper, seedGroups) {
  const byKey = new Map();
  for (const group of seedGroups || []) {
    for (const seed of group || []) {
      if (typeof seed?.cpuAddr !== 'number') continue;
      const normalized = {
        cpuAddr: seed.cpuAddr & 0xffff,
        fetchCtx: seed.fetchCtx || mapper.initialFetchCtx(),
        confidence: seed.confidence === 'certain' ? 'certain' : 'probable'
      };
      const key = seedItemKey(mapper, normalized);
      const prev = byKey.get(key);
      if (!prev || normalized.confidence === 'certain') byKey.set(key, normalized);
    }
  }
  return Array.from(byKey.values());
}

function entryBlockIdsForSeeds(cfg, mapper, seedItems) {
  const wanted = new Set((seedItems || []).map((seed) => seedSiteKey(mapper, seed)).filter(Boolean));
  return (cfg.blocks || [])
    .filter((b) => b.instances?.some((i) => wanted.has(i.siteKey || seedSiteKey(mapper, { cpuAddr: i.cpuStart, fetchCtx: b.fetchCtx })) ))
    .map((b) => b.id);
}

async function runDispatchFixpoint({
  prgBytes,
  mapper,
  baseSeedItems,
  probableConfig,
  cdlPrg = null,
  yieldEveryMs = 0,
  maxIterations = 4
}) {
  const exactSeedMap = new Map();
  const speculativeSeedMap = new Map();
  const artifactMap = new Map();
  const syntheticEdgeMap = new Map();
  let lastCfg = null;

  for (let iter = 0; iter < maxIterations; iter++) {
    const seedItems = mergeSeedItems(mapper, [baseSeedItems, Array.from(exactSeedMap.values()), Array.from(speculativeSeedMap.values())]);
    const cfg = discoverCfg({ prgBytes, mapper, fetchCtx: mapper.initialFetchCtx(), seedItems, cdlPrg, probableConfig });
    lastCfg = cfg;

    const entryBlockIds = entryBlockIdsForSeeds(cfg, mapper, seedItems);
    const vsa = await runVsa({
      prgBytes,
      mapper,
      blocks: cfg.blocks,
      edges: cfg.edges,
      entryBlockIds,
      unresolvedSites: cfg.unresolvedSites,
      yieldEveryMs,
      onProgress: null,
      progressEveryMs: 0
    });

    const blocksByStartSite = new Map();
    for (const block of cfg.blocks || []) {
      for (const instance of block.instances || []) {
        if (typeof instance?.siteKey === 'string' && instance.siteKey) blocksByStartSite.set(instance.siteKey, block.id);
      }
    }
    const jt = recognizeJumpTables({
      prgBytes,
      mapper,
      blocksByStartSite,
      unresolvedSites: cfg.unresolvedSites,
      siteStatesBySiteKey: vsa.siteStatesBySiteKey
    });
    const spec = inferSpeculativeDispatchTargets({
      prgBytes,
      mapper,
      unresolvedSites: cfg.unresolvedSites,
      siteStatesBySiteKey: vsa.siteStatesBySiteKey
    });

    for (const art of [...(jt.artifacts || []), ...(spec.artifacts || [])]) {
      if (art?.id) artifactMap.set(art.id, art);
    }
    for (const edge of jt.syntheticEdges || []) {
      syntheticEdgeMap.set(JSON.stringify(edge), edge);
    }

    let added = 0;
    for (const seed of jt.newSeedItems || []) {
      const key = seedItemKey(mapper, seed);
      if (!exactSeedMap.has(key)) {
        exactSeedMap.set(key, { ...seed, confidence: 'certain' });
        speculativeSeedMap.delete(key);
        added++;
      }
    }
    for (const seed of spec.seedItems || []) {
      const key = seedItemKey(mapper, seed);
      if (exactSeedMap.has(key) || speculativeSeedMap.has(key)) continue;
      speculativeSeedMap.set(key, { ...seed, confidence: 'probable' });
      added++;
    }

    if (!added) break;
  }

  return {
    cfg: lastCfg,
    artifacts: Array.from(artifactMap.values()),
    syntheticEdges: Array.from(syntheticEdgeMap.values()),
    exactSeedItems: Array.from(exactSeedMap.values()),
    speculativeSeedItems: Array.from(speculativeSeedMap.values())
  };
}

function buildBaseEntrypointSeeds({ vectors, mapper }) {
  const fetchCtx = mapper.initialFetchCtx();
  return collectEntrypoints(vectors).map((cpuAddr) => ({ cpuAddr, confidence: 'certain', fetchCtx }));
}

function buildVectorSeedDebug(mapper, seedItems) {
  return {
    vectorSeedCount: seedItems.length,
    vectorSeedSites: seedItems.map((s) => ({ cpuAddr: s.cpuAddr & 0xffff, ctxKey: mapper.fetchCtxKey(s.fetchCtx) }))
  };
}

async function runStaticAnalysisPipeline({
  prgBytes,
  vectors,
  mapper,
  mapperKind,
  vectorSeedItemsByFamily = null,
  mapperMeta = null,
  initialSeedItems,
  probableCfg,
  computeScanBitmap = (bitmap) => bitmap,
  computeFinalBitmap = (bitmap) => bitmap,
  cdlResult = null,
  debugExtras = null,
  yieldEveryMs = 0,
  onVsaProgress = null,
  vsaProgressEveryMs = 0
}) {
  const phase1 = await runDispatchFixpoint({
    prgBytes,
    mapper,
    baseSeedItems: initialSeedItems,
    probableConfig: probableCfg,
    cdlPrg: cdlResult?.prg || null,
    yieldEveryMs
  });
  const cfg1 = phase1.cfg;
  if (!cfg1) return emptyResult();

  const probableContext = { ...buildProbableInterruptRootSet({ mapper, vectors, prgBytes }), mapper };
  const scanBitmap1 = computeScanBitmap(cfg1.codeBitmap);
  const probableScan = probableCfg.enabled
    ? scanProbableCode({
        prgBytes,
        mapper,
        codeBitmap: scanBitmap1,
        config: probableCfg,
        seedProbeOffsets: cfg1.probableProbeOffsets || [],
        probableContext
      })
    : { kept: [], regionStats: [] };
  const probableKeptAll = probableScan.kept || [];
  const probableKept = probableKeptAll.slice(0, Math.max(0, probableCfg.maxPromotedChunks | 0));
  const probableSeeds = (probableCfg.enabled && probableCfg.promoteToCfg)
    ? deriveProbableSeedItems({ keptChunks: probableKept, mapper, maxChunks: probableCfg.maxPromotedChunks })
    : [];

  const phase2Base = [...initialSeedItems, ...phase1.exactSeedItems, ...phase1.speculativeSeedItems, ...probableSeeds];
  const phase2 = probableSeeds.length
    ? await runDispatchFixpoint({
        prgBytes,
        mapper,
        baseSeedItems: phase2Base,
        probableConfig: probableCfg,
        cdlPrg: cdlResult?.prg || null,
        yieldEveryMs
      })
    : phase1;
  const cfg = phase2.cfg;

  const finalSeedItems = mergeSeedItems(mapper, [phase2Base, phase2.exactSeedItems, phase2.speculativeSeedItems]);
  const entryBlockIds = entryBlockIdsForSeeds(cfg, mapper, finalSeedItems);

  const { vsaFacts, vsaDataflow, memoryDiscoveries } = await collectVsaData({
    prgBytes,
    mapper,
    blocks: cfg.blocks,
    edges: [...cfg.edges, ...phase2.syntheticEdges],
    entryBlockIds,
    vectorSeedItemsByFamily,
    vectorCpuAddrsByFamily: collectVectorCpuAddrsByFamily(vectors),
    yieldEveryMs,
    onVsaProgress,
    vsaProgressEveryMs
  });

  const finalBitmap = computeFinalBitmap(cfg.codeBitmap);
  const timeline = buildTimeline({ prgSize: prgBytes.length, blocks: cfg.blocks, bitmap: finalBitmap });
  const probableBlockCount = cfg.blocks.filter((b) => b.confidence === 'probable').length;
  const occupancyStats = computePrgOccupancyStats({
    prgSize: prgBytes.length,
    blocks: cfg.blocks,
    memoryDiscoveries
  });
  const determinedByteCount = occupancyStats.totalBytes;
  const coveragePct = occupancyStats.totalPct;

  return {
    mapper: { kind: mapperKind, prgSize: prgBytes.length, meta: mapperMeta || null },
    blocks: cfg.blocks,
    edges: [...cfg.edges, ...phase2.syntheticEdges],
    timeline,
    artifacts: phase2.artifacts,
    vsaFacts,
    vsaDataflow,
    memoryDiscoveries,
    unresolvedSites: cfg.unresolvedSites,
    probable: {
      keptChunkCount: probableKeptAll.length,
      promotedChunkCount: probableKept.length,
      promotedSeedCount: probableSeeds.length,
      maxPromotedChunks: probableCfg.maxPromotedChunks,
      globalCapHit: probableKeptAll.length > probableKept.length,
      regionSummaries: summarizeProbableRegions(probableScan.regionStats || [], mapper, prgBytes.length)
    },
    cdl: cdlResult,
    debug: {
      cfg: cfg.debug || null,
      decodeFailuresByPc: cfg.decodeFailuresByPc || [],
      ...(debugExtras || {})
    },
    stats: {
      instructionCount: cfg.instructionCount,
      blockCount: cfg.blocks.length,
      probableBlockCount,
      determinedByteCount,
      coveragePct,
      codeByteCount: occupancyStats.codeBytes,
      dataByteCount: occupancyStats.dataBytes,
      unknownByteCount: occupancyStats.unknownBytes,
      totalByteCount: occupancyStats.totalBytes,
      codePct: occupancyStats.codePct,
      dataPct: occupancyStats.dataPct,
      unknownPct: occupancyStats.unknownPct,
      totalPct: occupancyStats.totalPct
    }
  };
}

function computePrgOccupancyStats({ prgSize, blocks, memoryDiscoveries }) {
  const size = Math.max(0, prgSize | 0);
  const types = new Uint8Array(size);

  for (const group of memoryDiscoveries?.groups || []) {
    if (group?.space !== 'rom') continue;
    for (const span of group?.spans || []) {
      const start = Math.max(0, Math.min(size, Number(span?.start) | 0));
      const end = Math.max(start, Math.min(size, (Number(span?.end) | 0) + 1));
      for (let i = start; i < end; i++) {
        if (types[i] === 0) types[i] = 2;
      }
    }
  }

  for (const block of Array.isArray(blocks) ? blocks : []) {
    const romStart = Number(block?.romStart);
    const romEnd = Number(block?.romEnd);
    if (!Number.isFinite(romStart) || !Number.isFinite(romEnd)) continue;
    const start = Math.max(0, Math.min(size, romStart | 0));
    const end = Math.max(start, Math.min(size, romEnd | 0));
    for (let i = start; i < end; i++) types[i] = 1;
  }

  let codeBytes = 0;
  let dataBytes = 0;
  for (let i = 0; i < size; i++) {
    if (types[i] === 1) codeBytes++;
    else if (types[i] === 2) dataBytes++;
  }
  const unknownBytes = Math.max(0, size - codeBytes - dataBytes);
  const totalBytes = codeBytes + dataBytes;
  return {
    codeBytes,
    dataBytes,
    unknownBytes,
    totalBytes,
    codePct: size ? (codeBytes * 100) / size : 0,
    dataPct: size ? (dataBytes * 100) / size : 0,
    unknownPct: size ? (unknownBytes * 100) / size : 0,
    totalPct: size ? (totalBytes * 100) / size : 0
  };
}


function buildSingleContextVectorSeedItemsByFamily({ vectors, mapper }) {
  const fetchCtx = mapper.initialFetchCtx();
  const mk = (cpuAddr) => ({ cpuAddr: cpuAddr & 0xffff, fetchCtx, confidence: 'certain' });
  return {
    reset: (typeof vectors?.reset === 'number' && (vectors.reset & 0xffff) >= 0x8000) ? [mk(vectors.reset)] : [],
    nmi: (typeof vectors?.nmi === 'number' && (vectors.nmi & 0xffff) >= 0x8000) ? [mk(vectors.nmi)] : [],
    irq: (typeof vectors?.irqBrk === 'number' && (vectors.irqBrk & 0xffff) >= 0x8000) ? [mk(vectors.irqBrk)] : []
  };
}

function flattenVectorSeedItemsByFamily(byFamily) {
  return [...(byFamily?.reset || []), ...(byFamily?.nmi || []), ...(byFamily?.irq || [])];
}

function collect32kVectorSeedsByFamily({ prgBytes, mapper }) {
  const out = { reset: [], nmi: [], irq: [] };
  const seen = new Set();
  const bankCount = Math.max(1, mapper?.bankCount | 0);
  const bankSize = 32 * 1024;
  for (let bank = 0; bank < bankCount; bank++) {
    const base = bank * bankSize;
    if (base + 0x7fff >= prgBytes.length) break;
    const fetchCtx = typeof mapper.ctxForBank === 'function' ? mapper.ctxForBank(bank) : mapper.initialFetchCtx();
    const targets = {
      reset: (prgBytes[base + 0x7ffc] | (prgBytes[base + 0x7ffd] << 8)) & 0xffff,
      nmi: (prgBytes[base + 0x7ffa] | (prgBytes[base + 0x7ffb] << 8)) & 0xffff,
      irq: (prgBytes[base + 0x7ffe] | (prgBytes[base + 0x7fff] << 8)) & 0xffff
    };
    for (const [family, cpuAddr] of Object.entries(targets)) {
      if (cpuAddr < 0x8000) continue;
      const resolved = mapper.resolveCodeFetch(fetchCtx, cpuAddr);
      if (resolved?.backing?.kind !== 'exact') continue;
      const key = `${family}:${mapper.fetchCtxKey(fetchCtx)}:${cpuAddr & 0xffff}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out[family].push({ cpuAddr: cpuAddr & 0xffff, fetchCtx, confidence: 'certain' });
    }
  }
  return out;
}

function buildAnalysisProfileNrom({ prgBytes, vectors, mapperKind, mapperMeta, cdlPrg, cdlChr, cdlMeta, yieldEveryMs, onVsaProgress, vsaProgressEveryMs }) {
  const mapper = createNromMapper({ prgSize: prgBytes.length });
  const cdlOverlay = deriveCdlOverlay({ cdlPrg, mapper, prgSize: prgBytes.length });
  const vectorSeedItemsByFamily = buildSingleContextVectorSeedItemsByFamily({ vectors, mapper });
  const baseCertainSeeds = flattenVectorSeedItemsByFamily(vectorSeedItemsByFamily);
  const fetchCtx = mapper.initialFetchCtx();
  const cdlSeedItems = (cdlOverlay?.seedItems || []).map((s) => ({ ...s, fetchCtx }));
  const vsaRunId = 1;
  const vsaFactsOnProgress = (typeof onVsaProgress === 'function')
    ? (p) => onVsaProgress({ ...(p || {}), runId: vsaRunId })
    : null;
  return {
    prgBytes,
    vectors,
    mapper,
    mapperKind: (typeof mapperKind === 'string' && mapperKind) ? mapperKind : 'NROM',
    mapperMeta,
    vectorSeedItemsByFamily,
    initialSeedItems: [...baseCertainSeeds, ...cdlSeedItems],
    probableCfg: DEFAULT_PROBABLE_CONFIG_NROM,
    computeScanBitmap: (bitmap) => overlayDataEvidence(bitmap, cdlOverlay?.dataOnly01 || null),
    computeFinalBitmap: (bitmap) => overlayDataEvidence(bitmap, cdlOverlay?.dataOnly01 || null),
    cdlResult: cdlOverlay ? { meta: cdlMeta, prg: cdlPrg, chr: cdlChr, summary: cdlOverlay.summary } : null,
    yieldEveryMs,
    onVsaProgress: vsaFactsOnProgress,
    vsaProgressEveryMs
  };
}

function buildAnalysisProfileMmc1({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides }) {
  const mapper = createMmc1Mapper({ prgBytes, mapperMeta });
  const vectorSeedItemsByFamily = buildSingleContextVectorSeedItemsByFamily({ vectors, mapper });
  const baseCertainSeeds = flattenVectorSeedItemsByFamily(vectorSeedItemsByFamily);
  return {
    prgBytes,
    vectors,
    mapper,
    mapperKind,
    mapperMeta,
    vectorSeedItemsByFamily,
    initialSeedItems: baseCertainSeeds,
    probableCfg: buildProbableConfigFixedSwitch16K(probableConfigOverrides),
    debugExtras: buildVectorSeedDebug(mapper, baseCertainSeeds)
  };
}

function buildAnalysisProfileFixedSwitch16k({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides }) {
  const mapperNumber = mapperMeta?.mapperFamily === 'UN1ROM' || mapperKind === 'UN1ROM' ? 94 : 2;
  const mapper = createFixedSwitch16kMapper({ prgBytes, mapperMeta, mapperNumber });
  const vectorSeedItemsByFamily = buildSingleContextVectorSeedItemsByFamily({ vectors, mapper });
  const baseCertainSeeds = flattenVectorSeedItemsByFamily(vectorSeedItemsByFamily);
  return {
    prgBytes,
    vectors,
    mapper,
    mapperKind,
    mapperMeta,
    vectorSeedItemsByFamily,
    initialSeedItems: baseCertainSeeds,
    probableCfg: buildProbableConfigFixedSwitch16K(probableConfigOverrides)
  };
}

function buildAnalysisProfileFixedSwitch32k({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides }) {
  const mapperNumber = mapperMeta?.mapperFamily === 'BNROM' ? 34 : mapperMeta?.mapperFamily === 'GxROM' ? 66 : 7;
  const mapper = createFixedSwitch32kMapper({ prgBytes, mapperMeta, mapperNumber });
  const vectorSeedItemsByFamily = collect32kVectorSeedsByFamily({ prgBytes, mapper });
  const baseCertainSeeds = flattenVectorSeedItemsByFamily(vectorSeedItemsByFamily);
  return {
    prgBytes,
    vectors,
    mapper,
    mapperKind,
    mapperMeta,
    vectorSeedItemsByFamily,
    initialSeedItems: baseCertainSeeds,
    probableCfg: buildProbableConfigFixedSwitch32K(probableConfigOverrides),
    debugExtras: buildVectorSeedDebug(mapper, baseCertainSeeds)
  };
}

export async function analyzeStaticNrom({
  prgBytes,
  vectors,
  mapperKind = 'NROM',
  mapperMeta = null,
  cdlPrg = null,
  cdlChr = null,
  cdlMeta = null,
  yieldEveryMs = 0,
  onVsaProgress = null,
  vsaProgressEveryMs = 0
}) {
  return runStaticAnalysisPipeline(buildAnalysisProfileNrom({ prgBytes, vectors, mapperKind, mapperMeta, cdlPrg, cdlChr, cdlMeta, yieldEveryMs, onVsaProgress, vsaProgressEveryMs }));
}

export async function analyzeStaticMmc1({
  prgBytes,
  vectors,
  mapperKind = 'MMC1',
  mapperMeta = null,
  probableConfigOverrides = null
}) {
  return runStaticAnalysisPipeline(buildAnalysisProfileMmc1({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides }));
}

export async function analyzeStaticFixedSwitch16k({
  prgBytes,
  vectors,
  mapperKind = 'UxROM',
  mapperMeta = null,
  probableConfigOverrides = null
}) {
  return runStaticAnalysisPipeline(buildAnalysisProfileFixedSwitch16k({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides }));
}

export async function analyzeStaticFixedSwitch32k({
  prgBytes,
  vectors,
  mapperKind = 'AxROM',
  mapperMeta = null,
  probableConfigOverrides = null
}) {
  return runStaticAnalysisPipeline(buildAnalysisProfileFixedSwitch32k({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides }));
}

function summarizeProbableRegions(regionStats, mapper, prgSize) {
  if (!Array.isArray(regionStats) || !regionStats.length) return [];
  const bankSize = (typeof mapper?.bankCount === 'number' && mapper.bankCount > 0 && Number.isFinite(prgSize) && prgSize > 0)
    ? ((prgSize / mapper.bankCount) | 0)
    : 0;
  return regionStats.map((s) => {
    const out = {
      rangeStart: s.rangeStart | 0,
      rangeEnd: s.rangeEnd | 0,
      probeStartCount: s.probeStartCount | 0,
      passingCandidateCount: s.passingCandidateCount | 0,
      keptCandidateCount: s.keptCandidateCount | 0,
      bestScore: Number.isFinite(s.bestScore) ? Number(s.bestScore) : null
    };
    if (bankSize > 0 && out.rangeStart % bankSize === 0 && out.rangeEnd - out.rangeStart === bankSize) {
      out.bankIndex = (out.rangeStart / bankSize) | 0;
    }
    return out;
  });
}


function collectVectorCpuAddrsByFamily(vectors) {
  return {
    reset: (typeof vectors?.reset === 'number' && (vectors.reset & 0xffff) >= 0x8000) ? [vectors.reset & 0xffff] : [],
    nmi: (typeof vectors?.nmi === 'number' && (vectors.nmi & 0xffff) >= 0x8000) ? [vectors.nmi & 0xffff] : [],
    irq: (typeof vectors?.irqBrk === 'number' && (vectors.irqBrk & 0xffff) >= 0x8000) ? [vectors.irqBrk & 0xffff] : []
  };
}

function collectEntrypoints(vectors) {
  return [vectors?.reset, vectors?.nmi, vectors?.irqBrk]
    .filter((x) => typeof x === 'number')
    .map((x) => x & 0xffff)
    .filter((x) => x >= 0x8000);
}

function emptyResult() {
  return {
    blocks: [],
    edges: [],
    timeline: [],
    artifacts: [],
    vsaFacts: null,
    vsaDataflow: null,
    memoryDiscoveries: null,
    unresolvedSites: [],
    stats: {
      instructionCount: 0,
      blockCount: 0,
      probableBlockCount: 0,
      determinedByteCount: 0,
      coveragePct: 0,
      codeByteCount: 0,
      dataByteCount: 0,
      unknownByteCount: 0,
      totalByteCount: 0,
      codePct: 0,
      dataPct: 0,
      unknownPct: 0,
      totalPct: 0
    }
  };
}

function countNonZero(u8) {
  if (!u8 || u8.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < u8.length; i++) if (u8[i] !== 0) n++;
  return n;
}

function overlayDataEvidence(codeBitmap01, dataObserved01) {
  if (!dataObserved01) return codeBitmap01;
  const out = new Uint8Array(codeBitmap01);
  const n = Math.min(out.length, dataObserved01.length);
  for (let i = 0; i < n; i++) {
    if (out[i] === 0 && dataObserved01[i]) out[i] = 2;
  }
  return out;
}

function deriveCdlOverlay({ cdlPrg, mapper, prgSize }) {
  if (!cdlPrg) return null;
  const limit = Math.min(prgSize, cdlPrg.length);
  const dataOnly01 = new Uint8Array(prgSize);
  const seedItems = [];
  const seen = new Set();
  const summary = { present: true, prgByteCount: limit, execByteCount: 0, dataByteCount: 0, jsrTargetSeedCount: 0, jumpTargetSeedCount: 0, execRunSeedCount: 0, totalSeedCount: 0 };
  let prevExec = false;

  for (let romOff = 0; romOff < limit; romOff++) {
    const flags = decodePrgCdlByte(cdlPrg[romOff]);
    if (flags.exec) summary.execByteCount++;
    if (isPrgDataObserved(flags) && !flags.exec) {
      dataOnly01[romOff] = 1;
      summary.dataByteCount++;
    }
    if (flags.exec && !prevExec) {
      const cpuAddr = pickCpuAddrForRomOff({ romOff, slot: flags.slot, mapper });
      if (addSeed({ cpuAddr, confidence: 'certain' })) summary.execRunSeedCount++;
    }
    if (flags.jsrTarget) {
      const cpuAddr = pickCpuAddrForRomOff({ romOff, slot: flags.slot, mapper });
      if (addSeed({ cpuAddr, confidence: 'certain' })) summary.jsrTargetSeedCount++;
    }
    if (flags.jumpTarget) {
      const cpuAddr = pickCpuAddrForRomOff({ romOff, slot: flags.slot, mapper });
      if (addSeed({ cpuAddr, confidence: 'certain' })) summary.jumpTargetSeedCount++;
    }
    prevExec = !!flags.exec;
  }

  summary.totalSeedCount = seedItems.length;
  return { seedItems, dataOnly01, summary };

  function addSeed(item) {
    if (typeof item.cpuAddr !== 'number') return false;
    const cpu = item.cpuAddr & 0xffff;
    if (cpu < 0x8000) return false;
    if (seen.has(cpu)) return false;
    seen.add(cpu);
    seedItems.push({ cpuAddr: cpu, confidence: item.confidence || 'certain' });
    return true;
  }
}

function pickCpuAddrForRomOff({ romOff, slot, mapper }) {
  const cpuGuess = cpuAddrForRomOffUsingSlot(romOff, slot);
  const fetchCtx = mapper?.initialFetchCtx ? mapper.initialFetchCtx() : null;
  const back = cpuToRomOffWithMapper(mapper, cpuGuess, fetchCtx);
  if (back === (romOff | 0)) return cpuGuess & 0xffff;
  const addrs = mapper.romOffToCpuAddrs ? mapper.romOffToCpuAddrs(romOff) : [];
  if (addrs.length) return addrs[0] & 0xffff;
  return cpuGuess & 0xffff;
}
