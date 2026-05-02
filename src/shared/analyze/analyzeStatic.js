import { createNromMapper } from './map/nrom.js';
import { createFixedSwitch16kMapper } from './map/fixedSwitch16k.js';
import { createFixedSwitch32kMapper } from './map/fixedSwitch32k.js';
import { createMmc1Mapper } from './map/mmc1.js';
import { createMmc3Mapper } from './map/mmc3.js';
import { buildVectorSeedItemsByFamily } from './vectorNavigation.js';
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
import { decodePrgCdlByte, isPrgDataObserved, NES_CDL_FORMAT_MESEN2 } from './cdl/nesCdl.js';
import { buildPrgOccupancy } from './occupancy/prgOccupancy.js';
import { resolveBlockConflicts } from './postprocess/resolveBlockConflicts.js';
import { detectMonotoneTables } from './data/detectMonotoneTables.js';
import { attachMonotoneTableReaders } from './data/attachMonotoneTableReaders.js';
import { deriveGoalDrivenProbeOffsets } from './data/goalDrivenProbableSearch.js';


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

function buildCodeOnlyBitmap(prgSize, blocks) {
  const bitmap = new Uint8Array(Math.max(0, prgSize | 0));
  for (const block of blocks || []) {
    for (const line of block?.lines || []) {
      const romOff = typeof line?.romOff === 'number' ? (line.romOff | 0) : null;
      const len = typeof line?.len === 'number' ? (line.len | 0) : 0;
      if (romOff == null || romOff < 0 || len <= 0) continue;
      for (let i = romOff; i < Math.min(bitmap.length, romOff + len); i++) bitmap[i] = 1;
    }
  }
  return bitmap;
}

function detectAndAttachMonotoneTables({ prgBytes, mapper, blocks, probableCfg }) {
  const codeBitmap = buildCodeOnlyBitmap(prgBytes.length, blocks);
  const detected = detectMonotoneTables({
    prgBytes,
    codeBitmap,
    minEntries: probableCfg?.monotoneTableMinEntries ?? 4
  });
  const tables = attachMonotoneTableReaders({ blocks, monotoneTables: detected, mapper });
  return { codeBitmap, tables };
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
  let activePhase = phase2;
  let activeBaseSeeds = phase2Base;
  let activeCfg = phase2.cfg;

  const preGoalMonotone = detectAndAttachMonotoneTables({
    prgBytes,
    mapper,
    blocks: activeCfg.blocks,
    probableCfg
  });

  const goalDrivenSearch = probableCfg.goalDrivenMonotoneSearch
    ? deriveGoalDrivenProbeOffsets({
        prgBytes,
        mapper,
        codeBitmap: computeScanBitmap(preGoalMonotone.codeBitmap),
        monotoneTables: preGoalMonotone.tables,
        config: probableCfg
      })
    : { probeOffsets: [], stats: { unresolvedTableCount: 0, rawHitCount: 0, probeOffsetCount: 0, perTableHitCount: {} } };

  let goalDrivenScan = { kept: [], regionStats: [] };
  let goalDrivenSeeds = [];

  if (probableCfg.enabled && goalDrivenSearch.probeOffsets.length) {
    goalDrivenScan = scanProbableCode({
      prgBytes,
      mapper,
      codeBitmap: computeScanBitmap(preGoalMonotone.codeBitmap),
      config: probableCfg,
      seedProbeOffsets: goalDrivenSearch.probeOffsets,
      probableContext
    });
    const goalDrivenKept = (goalDrivenScan.kept || []).slice(0, Math.max(0, probableCfg.goalDrivenMaxPromotedChunks | 0));
    goalDrivenSeeds = probableCfg.promoteToCfg
      ? deriveProbableSeedItems({ keptChunks: goalDrivenKept, mapper, maxChunks: probableCfg.goalDrivenMaxPromotedChunks })
      : [];

    if (goalDrivenSeeds.length) {
      activeBaseSeeds = [...activeBaseSeeds, ...goalDrivenSeeds];
      activePhase = await runDispatchFixpoint({
        prgBytes,
        mapper,
        baseSeedItems: activeBaseSeeds,
        probableConfig: probableCfg,
        cdlPrg: cdlResult?.prg || null,
        yieldEveryMs
      });
      activeCfg = activePhase.cfg;
    }
  }

  const finalSeedItems = mergeSeedItems(mapper, [activeBaseSeeds, activePhase.exactSeedItems, activePhase.speculativeSeedItems]);
  const entryBlockIds = entryBlockIdsForSeeds(activeCfg, mapper, finalSeedItems);

  const rawEdges = [...activeCfg.edges, ...activePhase.syntheticEdges];
  const { vsaFacts, vsaDataflow, memoryDiscoveries } = await collectVsaData({
    prgBytes,
    mapper,
    blocks: activeCfg.blocks,
    edges: rawEdges,
    entryBlockIds,
    vectorSeedItemsByFamily,
    vectorCpuAddrsByFamily: collectVectorCpuAddrsByFamily(vectors),
    yieldEveryMs,
    onVsaProgress,
    vsaProgressEveryMs
  });

  const resolved = resolveBlockConflicts({
    blocks: activeCfg.blocks,
    edges: rawEdges,
    unresolvedSites: activeCfg.unresolvedSites,
    artifacts: activePhase.artifacts,
    memoryDiscoveries,
    vsaDataflow,
    vsaFacts
  });

  const finalMonotone = detectAndAttachMonotoneTables({
    prgBytes,
    mapper,
    blocks: resolved.blocks,
    probableCfg
  });

  const finalBitmap = computeFinalBitmap(activeCfg.codeBitmap);
  const prgOccupancy = computePrgOccupancy({
    prgSize: prgBytes.length,
    blocks: resolved.blocks,
    memoryDiscoveries: resolved.memoryDiscoveries,
    cdlPrg: cdlResult?.prg || null,
    cdlFormat: cdlResult?.meta?.format || NES_CDL_FORMAT_MESEN2
  });
  const timeline = buildTimeline({ prgSize: prgBytes.length, blocks: resolved.blocks, occupancy: prgOccupancy, bitmap: finalBitmap });
  const probableBlockCount = resolved.blocks.filter((b) => b.confidence === 'probable').length;
  const occupancyStats = prgOccupancy.stats;
  const determinedByteCount = occupancyStats.totalBytes;
  const coveragePct = occupancyStats.totalPct;

  return {
    mapper: { kind: mapperKind, prgSize: prgBytes.length, meta: mapperMeta || null },
    blocks: resolved.blocks,
    edges: resolved.edges,
    timeline,
    artifacts: resolved.artifacts,
    monotoneTables: finalMonotone.tables,
    semanticFacts: [],
    vsaFacts: resolved.vsaFacts,
    vsaDataflow: resolved.vsaDataflow,
    memoryDiscoveries: resolved.memoryDiscoveries,
    unresolvedSites: resolved.unresolvedSites,
    rawBlockIdAliases: resolved.rawBlockIdAliases,
    probable: {
      keptChunkCount: probableKeptAll.length,
      promotedChunkCount: probableKept.length,
      promotedSeedCount: probableSeeds.length,
      maxPromotedChunks: probableCfg.maxPromotedChunks,
      globalCapHit: probableKeptAll.length > probableKept.length,
      regionSummaries: summarizeProbableRegions(probableScan.regionStats || [], mapper, prgBytes.length),
      goalDriven: {
        probeOffsetCount: goalDrivenSearch.probeOffsets.length,
        promotedSeedCount: goalDrivenSeeds.length,
        keptChunkCount: (goalDrivenScan.kept || []).length,
        maxPromotedChunks: probableCfg.goalDrivenMaxPromotedChunks,
        rawHitCount: goalDrivenSearch.stats?.rawHitCount || 0,
        unresolvedTableCount: goalDrivenSearch.stats?.unresolvedTableCount || 0,
        regionSummaries: summarizeProbableRegions(goalDrivenScan.regionStats || [], mapper, prgBytes.length)
      }
    },
    cdl: cdlResult,
    prgOccupancy,
    debug: {
      cfg: activeCfg.debug || null,
      decodeFailuresByPc: activeCfg.decodeFailuresByPc || [],
      monotoneTables: {
        preGoalCount: preGoalMonotone.tables.length,
        finalCount: finalMonotone.tables.length,
        unresolvedFinalCount: finalMonotone.tables.filter((table) => !table.promotedToPointerTable).length
      },
      rawConflictResolution: resolved.debug,
      ...(debugExtras || {})
    },
    stats: {
      instructionCount: activeCfg.instructionCount,
      rawBlockCount: activeCfg.blocks.length,
      blockCount: resolved.blocks.length,
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

function computePrgOccupancy({ prgSize, blocks, memoryDiscoveries, cdlPrg = null, cdlFormat = NES_CDL_FORMAT_MESEN2 }) {
  return buildPrgOccupancy({
    prgSize,
    blocks,
    memoryDiscoveries,
    cdlPrg,
    cdlFormat
  });
}


function flattenVectorSeedItemsByFamily(byFamily) {
  return [...(byFamily?.reset || []), ...(byFamily?.nmi || []), ...(byFamily?.irq || [])];
}

function buildAnalysisProfileNrom({ prgBytes, vectors, mapperKind, mapperMeta, cdlPrg, cdlChr, cdlMeta, yieldEveryMs, onVsaProgress, vsaProgressEveryMs }) {
  const mapper = createNromMapper({ prgSize: prgBytes.length });
  const cdlOverlay = deriveCdlEvidenceAndSeeds({ cdlPrg, mapper, prgSize: prgBytes.length, cdlFormat: cdlMeta?.format || NES_CDL_FORMAT_MESEN2 });
  const vectorSeedItemsByFamily = buildVectorSeedItemsByFamily({ prgBytes, vectors, mapper });
  const baseCertainSeeds = flattenVectorSeedItemsByFamily(vectorSeedItemsByFamily);
  const cdlSeedItems = cdlOverlay?.seedItems || [];
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

function buildAnalysisProfileMmc1({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides, cdlPrg = null, cdlChr = null, cdlMeta = null }) {
  const mapper = createMmc1Mapper({ prgBytes, mapperMeta });
  const cdlOverlay = deriveCdlEvidenceAndSeeds({ cdlPrg, mapper, prgSize: prgBytes.length, cdlFormat: cdlMeta?.format || NES_CDL_FORMAT_MESEN2 });
  const vectorSeedItemsByFamily = buildVectorSeedItemsByFamily({ prgBytes, vectors, mapper });
  const baseCertainSeeds = flattenVectorSeedItemsByFamily(vectorSeedItemsByFamily);
  return {
    prgBytes,
    vectors,
    mapper,
    mapperKind,
    mapperMeta,
    vectorSeedItemsByFamily,
    initialSeedItems: [...baseCertainSeeds, ...(cdlOverlay?.seedItems || [])],
    probableCfg: buildProbableConfigFixedSwitch16K(probableConfigOverrides),
    computeScanBitmap: (bitmap) => overlayDataEvidence(bitmap, cdlOverlay?.dataOnly01 || null),
    computeFinalBitmap: (bitmap) => overlayDataEvidence(bitmap, cdlOverlay?.dataOnly01 || null),
    cdlResult: cdlOverlay ? { meta: cdlMeta, prg: cdlPrg, chr: cdlChr, summary: cdlOverlay.summary } : null,
    debugExtras: buildVectorSeedDebug(mapper, baseCertainSeeds)
  };
}

function buildAnalysisProfileMmc3({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides, cdlPrg = null, cdlChr = null, cdlMeta = null }) {
  const mapper = createMmc3Mapper({ prgBytes, mapperMeta });
  const cdlOverlay = deriveCdlEvidenceAndSeeds({ cdlPrg, mapper, prgSize: prgBytes.length, cdlFormat: cdlMeta?.format || NES_CDL_FORMAT_MESEN2 });
  const vectorSeedItemsByFamily = buildVectorSeedItemsByFamily({ prgBytes, vectors, mapper });
  const baseCertainSeeds = flattenVectorSeedItemsByFamily(vectorSeedItemsByFamily);
  return {
    prgBytes,
    vectors,
    mapper,
    mapperKind,
    mapperMeta,
    vectorSeedItemsByFamily,
    initialSeedItems: [...baseCertainSeeds, ...(cdlOverlay?.seedItems || [])],
    probableCfg: buildProbableConfigFixedSwitch16K(probableConfigOverrides),
    computeScanBitmap: (bitmap) => overlayDataEvidence(bitmap, cdlOverlay?.dataOnly01 || null),
    computeFinalBitmap: (bitmap) => overlayDataEvidence(bitmap, cdlOverlay?.dataOnly01 || null),
    cdlResult: cdlOverlay ? { meta: cdlMeta, prg: cdlPrg, chr: cdlChr, summary: cdlOverlay.summary } : null,
    debugExtras: buildVectorSeedDebug(mapper, baseCertainSeeds)
  };
}

function buildAnalysisProfileFixedSwitch16k({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides, cdlPrg = null, cdlChr = null, cdlMeta = null }) {
  const mapperNumber = mapperMeta?.mapperFamily === 'UN1ROM' || mapperKind === 'UN1ROM' ? 94 : 2;
  const mapper = createFixedSwitch16kMapper({ prgBytes, mapperMeta, mapperNumber });
  const cdlOverlay = deriveCdlEvidenceAndSeeds({ cdlPrg, mapper, prgSize: prgBytes.length, cdlFormat: cdlMeta?.format || NES_CDL_FORMAT_MESEN2 });
  const vectorSeedItemsByFamily = buildVectorSeedItemsByFamily({ prgBytes, vectors, mapper });
  const baseCertainSeeds = flattenVectorSeedItemsByFamily(vectorSeedItemsByFamily);
  return {
    prgBytes,
    vectors,
    mapper,
    mapperKind,
    mapperMeta,
    vectorSeedItemsByFamily,
    initialSeedItems: [...baseCertainSeeds, ...(cdlOverlay?.seedItems || [])],
    probableCfg: buildProbableConfigFixedSwitch16K(probableConfigOverrides),
    computeScanBitmap: (bitmap) => overlayDataEvidence(bitmap, cdlOverlay?.dataOnly01 || null),
    computeFinalBitmap: (bitmap) => overlayDataEvidence(bitmap, cdlOverlay?.dataOnly01 || null),
    cdlResult: cdlOverlay ? { meta: cdlMeta, prg: cdlPrg, chr: cdlChr, summary: cdlOverlay.summary } : null
  };
}

function buildAnalysisProfileFixedSwitch32k({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides, cdlPrg = null, cdlChr = null, cdlMeta = null }) {
  const mapperNumber = mapperMeta?.mapperFamily === 'BNROM' ? 34 : mapperMeta?.mapperFamily === 'GxROM' ? 66 : 7;
  const mapper = createFixedSwitch32kMapper({ prgBytes, mapperMeta, mapperNumber });
  const cdlOverlay = deriveCdlEvidenceAndSeeds({ cdlPrg, mapper, prgSize: prgBytes.length, cdlFormat: cdlMeta?.format || NES_CDL_FORMAT_MESEN2 });
  const vectorSeedItemsByFamily = buildVectorSeedItemsByFamily({ prgBytes, vectors, mapper });
  const baseCertainSeeds = flattenVectorSeedItemsByFamily(vectorSeedItemsByFamily);
  return {
    prgBytes,
    vectors,
    mapper,
    mapperKind,
    mapperMeta,
    vectorSeedItemsByFamily,
    initialSeedItems: [...baseCertainSeeds, ...(cdlOverlay?.seedItems || [])],
    probableCfg: buildProbableConfigFixedSwitch32K(probableConfigOverrides),
    computeScanBitmap: (bitmap) => overlayDataEvidence(bitmap, cdlOverlay?.dataOnly01 || null),
    computeFinalBitmap: (bitmap) => overlayDataEvidence(bitmap, cdlOverlay?.dataOnly01 || null),
    cdlResult: cdlOverlay ? { meta: cdlMeta, prg: cdlPrg, chr: cdlChr, summary: cdlOverlay.summary } : null,
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
  probableConfigOverrides = null,
  cdlPrg = null,
  cdlChr = null,
  cdlMeta = null
}) {
  return runStaticAnalysisPipeline(buildAnalysisProfileMmc1({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides, cdlPrg, cdlChr, cdlMeta }));
}

export async function analyzeStaticMmc3({
  prgBytes,
  vectors,
  mapperKind = 'MMC3',
  mapperMeta = null,
  probableConfigOverrides = null,
  cdlPrg = null,
  cdlChr = null,
  cdlMeta = null
}) {
  return runStaticAnalysisPipeline(buildAnalysisProfileMmc3({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides, cdlPrg, cdlChr, cdlMeta }));
}

export async function analyzeStaticFixedSwitch16k({
  prgBytes,
  vectors,
  mapperKind = 'UxROM',
  mapperMeta = null,
  probableConfigOverrides = null,
  cdlPrg = null,
  cdlChr = null,
  cdlMeta = null
}) {
  return runStaticAnalysisPipeline(buildAnalysisProfileFixedSwitch16k({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides, cdlPrg, cdlChr, cdlMeta }));
}

export async function analyzeStaticFixedSwitch32k({
  prgBytes,
  vectors,
  mapperKind = 'AxROM',
  mapperMeta = null,
  probableConfigOverrides = null,
  cdlPrg = null,
  cdlChr = null,
  cdlMeta = null
}) {
  return runStaticAnalysisPipeline(buildAnalysisProfileFixedSwitch32k({ prgBytes, vectors, mapperKind, mapperMeta, probableConfigOverrides, cdlPrg, cdlChr, cdlMeta }));
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
    prgOccupancy: null,
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

function deriveCdlEvidenceAndSeeds({ cdlPrg, mapper, prgSize, cdlFormat = NES_CDL_FORMAT_MESEN2 }) {
  if (!cdlPrg) return null;
  const limit = Math.min(prgSize, cdlPrg.length);
  const dataOnly01 = new Uint8Array(prgSize);
  const seedItems = [];
  const seen = new Set();
  const summary = { present: true, prgByteCount: limit, execByteCount: 0, dataByteCount: 0, subEntrySeedCount: 0, jumpTargetSeedCount: 0, execRunSeedCount: 0, totalSeedCount: 0 };
  let prevExec = false;

  for (let romOff = 0; romOff < limit; romOff++) {
    const flags = decodePrgCdlByte(cdlPrg[romOff], cdlFormat);
    if (flags.exec) summary.execByteCount++;
    if (isPrgDataObserved(flags, cdlFormat) && !flags.exec) {
      dataOnly01[romOff] = 1;
      summary.dataByteCount++;
    }
    if (flags.exec && !prevExec) {
      if (addSeedsForRomOff(romOff)) summary.execRunSeedCount++;
    }
    if (flags.subEntryPoint) {
      if (addSeedsForRomOff(romOff)) summary.subEntrySeedCount++;
    }
    if (flags.jumpTarget) {
      if (addSeedsForRomOff(romOff)) summary.jumpTargetSeedCount++;
    }
    prevExec = !!flags.exec;
  }

  summary.totalSeedCount = seedItems.length;
  return { seedItems, dataOnly01, summary };

  function addSeedsForRomOff(romOff) {
    const candidates = typeof mapper?.seedSitesForRomOff === 'function'
      ? mapper.seedSitesForRomOff(romOff)
      : [];
    let added = false;
    for (const site of candidates || []) {
      if (typeof site?.cpuAddr !== 'number') continue;
      const cpu = site.cpuAddr & 0xffff;
      if (cpu < 0x8000) continue;
      const fetchCtx = site.fetchCtx || mapper?.initialFetchCtx?.() || null;
      const ctxKey = mapper?.fetchCtxKey ? mapper.fetchCtxKey(fetchCtx) : 'default';
      const key = `${ctxKey}:${cpu}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seedItems.push({ cpuAddr: cpu, fetchCtx, confidence: 'certain' });
      added = true;
    }
    return added;
  }
}
