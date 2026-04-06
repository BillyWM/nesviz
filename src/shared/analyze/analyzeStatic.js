import { createNromMapper } from './map/nrom.js';
import { createFixedSwitch16kMapper } from './map/fixedSwitch16k.js';
import { createFixedSwitch32kMapper } from './map/fixedSwitch32k.js';
import { createMmc1Mapper } from './map/mmc1.js';
import { discoverCfg } from './discover/cfg.js';
import { buildTimeline } from './discover/timeline.js';
import { runVsa } from './vsa/run.js';
import { runVsaFacts } from './vsa/runFacts.js';
import { recognizeJumpTables } from './recognize/jumpTables.js';
import { DEFAULT_PROBABLE_CONFIG_NROM, DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH16K, DEFAULT_PROBABLE_CONFIG_FIXED_SWITCH32K, buildProbableConfigFixedSwitch16K, buildProbableConfigFixedSwitch32K } from './probable/config.js';
import { scanProbableCode } from './probable/scanUnknown.js';
import { buildProbableInterruptRootSet } from './probable/rtiVectorHeuristic.js';
import { deriveProbableSeedItems } from './probable/deriveSeeds.js';
import { cpuAddrForRomOffUsingSlot, decodePrgCdlByte, isPrgDataObserved } from './cdl/nesCdl.js';

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
  const mapper = createNromMapper({ prgSize: prgBytes.length });
  const entrypoints = collectEntrypoints(vectors);
  const mk = (typeof mapperKind === 'string' && mapperKind) ? mapperKind : 'NROM';
  const fetchCtx = mapper.initialFetchCtx();
  const cdlOverlay = deriveCdlOverlay({ cdlPrg, mapper, prgSize: prgBytes.length });
  let vsaRunSeq = 0;

  async function runFixpoint({ baseSeeds }) {
    const extraEntrypoints = new Set();
    let syntheticEdges = [];
    let artifacts = [];
    let lastCfg = null;

    for (let iter = 0; iter < 4; iter++) {
      const seedItems = [...baseSeeds, ...Array.from(extraEntrypoints).map((cpuAddr) => ({ cpuAddr, confidence: 'certain', fetchCtx }))];
      const cfg = discoverCfg({ prgBytes, mapper, fetchCtx, seedItems, cdlPrg, probableConfig: DEFAULT_PROBABLE_CONFIG_NROM });
      lastCfg = cfg;

      const blocksById = new Map(cfg.blocks.map((b) => [b.id, b]));
      const seedCpuSet = new Set(seedItems.map((s) => s.cpuAddr & 0xffff));
      const entryBlockIds = cfg.blocks
        .filter((b) => b.instances?.some((i) => seedCpuSet.has(i.cpuStart & 0xffff)))
        .map((b) => b.id);
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

      const jt = recognizeJumpTables({
        prgBytes,
        mapper,
        blocksById,
        unresolvedSites: cfg.unresolvedSites,
        siteStatesByPc: vsa.siteStatesByPc
      });

      artifacts = jt.artifacts;
      syntheticEdges = jt.syntheticEdges;

      let added = 0;
      for (const a of jt.newEntrypointsCpuAddrs) {
        const key = a & 0xffff;
        if (!extraEntrypoints.has(key)) {
          extraEntrypoints.add(key);
          added++;
        }
      }
      if (!added) break;
    }

    return { cfg: lastCfg, artifacts, syntheticEdges, extraEntrypointsCpuAddrs: Array.from(extraEntrypoints) };
  }

  const baseCertainSeeds = entrypoints.map((cpuAddr) => ({ cpuAddr, confidence: 'certain', fetchCtx }));
  const cdlSeedItems = (cdlOverlay?.seedItems || []).map((s) => ({ ...s, fetchCtx }));
  const phase1 = await runFixpoint({ baseSeeds: [...baseCertainSeeds, ...cdlSeedItems] });
  const cfg1 = phase1.cfg;
  if (!cfg1) return emptyResult();

  const scanBitmap1 = overlayDataEvidence(cfg1.codeBitmap, cdlOverlay?.dataOnly01 || null);
  const probableCfg = DEFAULT_PROBABLE_CONFIG_NROM;
  const probableContext = { ...buildProbableInterruptRootSet({ mapper, vectors, prgBytes }), mapper };
  const probableScan = probableCfg.enabled ? scanProbableCode({ prgBytes, mapper, codeBitmap: scanBitmap1, config: probableCfg, probableContext }) : { kept: [], regionStats: [] };
  const probableKeptAll = probableScan.kept || [];
  const probableKept = probableKeptAll.slice(0, Math.max(0, probableCfg.maxPromotedChunks | 0));
  const probableSeeds = (probableCfg.enabled && probableCfg.promoteToCfg)
    ? deriveProbableSeedItems({ keptChunks: probableKept, mapper, maxChunks: probableCfg.maxPromotedChunks })
    : [];

  const phase2Base = [...baseCertainSeeds, ...cdlSeedItems, ...probableSeeds, ...phase1.extraEntrypointsCpuAddrs.map((cpuAddr) => ({ cpuAddr, confidence: 'certain', fetchCtx }))];
  const phase2 = probableSeeds.length ? await runFixpoint({ baseSeeds: phase2Base }) : phase1;
  const cfg = phase2.cfg;

  const seedCpuSet = new Set(phase2Base.map((s) => (s.cpuAddr & 0xffff)));
  const entryBlockIds = cfg.blocks
    .filter((b) => b.instances?.some((i) => seedCpuSet.has(i.cpuStart & 0xffff)))
    .map((b) => b.id);

  const vsaFactsRunId = ++vsaRunSeq;
  const vsaFactsOnProgress = (typeof onVsaProgress === 'function')
    ? (p) => onVsaProgress({ ...(p || {}), runId: vsaFactsRunId })
    : null;
  if (vsaFactsOnProgress && (vsaProgressEveryMs > 0)) {
    vsaFactsOnProgress({ stableBlocks: 0, totalBlocks: cfg.blocks.length });
  }

  const vsaFacts = await runVsaFacts({
    prgBytes,
    mapper,
    blocks: cfg.blocks,
    edges: [...cfg.edges, ...phase2.syntheticEdges],
    entryBlockIds,
    yieldEveryMs,
    onProgress: vsaFactsOnProgress,
    progressEveryMs: vsaProgressEveryMs
  });

  const finalBitmap = overlayDataEvidence(cfg.codeBitmap, cdlOverlay?.dataOnly01 || null);
  const timeline = buildTimeline({ prgSize: prgBytes.length, blocks: cfg.blocks, bitmap: finalBitmap });
  const probableBlockCount = cfg.blocks.filter((b) => b.confidence === 'probable').length;
  const determinedByteCount = countNonZero(finalBitmap);
  const coveragePct = prgBytes.length ? (determinedByteCount * 100) / prgBytes.length : 0;

  return {
    mapper: { kind: mk, prgSize: prgBytes.length, meta: mapperMeta || null },
    blocks: cfg.blocks,
    edges: [...cfg.edges, ...phase2.syntheticEdges],
    timeline,
    artifacts: phase2.artifacts,
    vsaFacts,
    unresolvedSites: cfg.unresolvedSites,
    probable: {
      keptChunkCount: probableKeptAll.length,
      promotedChunkCount: probableKept.length,
      promotedSeedCount: probableSeeds.length,
      maxPromotedChunks: probableCfg.maxPromotedChunks,
      globalCapHit: probableKeptAll.length > probableKept.length,
      regionSummaries: summarizeProbableRegions(probableScan.regionStats || [], mapper, prgBytes.length)
    },
    cdl: cdlOverlay ? {
      meta: cdlMeta,
      prg: cdlPrg,
      chr: cdlChr,
      summary: cdlOverlay.summary
    } : null,
    debug: {
      cfg: cfg.debug || null,
      decodeFailuresByPc: cfg.decodeFailuresByPc || []
    },
    stats: {
      instructionCount: cfg.instructionCount,
      blockCount: cfg.blocks.length,
      probableBlockCount,
      determinedByteCount,
      coveragePct
    }
  };
}


export async function analyzeStaticMmc1({
  prgBytes,
  vectors,
  mapperKind = 'MMC1',
  mapperMeta = null,
  probableConfigOverrides = null
}) {
  const mapper = createMmc1Mapper({ prgBytes, mapperMeta });
  const entrypoints = collectEntrypoints(vectors);
  const fetchCtx = mapper.initialFetchCtx();
  const baseCertainSeeds = entrypoints.map((cpuAddr) => ({ cpuAddr, confidence: 'certain', fetchCtx }));

  const probableCfg = buildProbableConfigFixedSwitch16K(probableConfigOverrides);
  const cfg1 = discoverCfg({ prgBytes, mapper, fetchCtx, seedItems: baseCertainSeeds, cdlPrg: null, probableConfig: probableCfg });
  if (!cfg1) return emptyResult();
  const probableProbeOffsets = cfg1.probableProbeOffsets || [];
  const probableContext = { ...buildProbableInterruptRootSet({ mapper, vectors, prgBytes }), mapper };
  const probableScan = probableCfg.enabled
    ? scanProbableCode({ prgBytes, mapper, codeBitmap: cfg1.codeBitmap, config: probableCfg, seedProbeOffsets: probableProbeOffsets, probableContext })
    : { kept: [], regionStats: [] };
  const probableKeptAll = probableScan.kept || [];
  const probableKept = probableKeptAll.slice(0, Math.max(0, probableCfg.maxPromotedChunks | 0));
  const probableSeeds = (probableCfg.enabled && probableCfg.promoteToCfg)
    ? deriveProbableSeedItems({ keptChunks: probableKept, mapper, maxChunks: probableCfg.maxPromotedChunks })
    : [];

  const cfg = probableSeeds.length
    ? discoverCfg({ prgBytes, mapper, fetchCtx, seedItems: [...baseCertainSeeds, ...probableSeeds], cdlPrg: null, probableConfig: probableCfg })
    : cfg1;

  const timeline = buildTimeline({ prgSize: prgBytes.length, blocks: cfg.blocks, bitmap: cfg.codeBitmap });
  const probableBlockCount = cfg.blocks.filter((b) => b.confidence === 'probable').length;
  const determinedByteCount = countNonZero(cfg.codeBitmap);
  const coveragePct = prgBytes.length ? (determinedByteCount * 100) / prgBytes.length : 0;

  return {
    mapper: { kind: mapperKind, prgSize: prgBytes.length, meta: mapperMeta || null },
    blocks: cfg.blocks,
    edges: cfg.edges,
    timeline,
    artifacts: [],
    vsaFacts: null,
    unresolvedSites: cfg.unresolvedSites,
    probable: {
      keptChunkCount: probableKeptAll.length,
      promotedChunkCount: probableKept.length,
      promotedSeedCount: probableSeeds.length,
      maxPromotedChunks: probableCfg.maxPromotedChunks,
      globalCapHit: probableKeptAll.length > probableKept.length,
      regionSummaries: summarizeProbableRegions(probableScan.regionStats || [], mapper, prgBytes.length)
    },
    cdl: null,
    debug: {
      cfg: cfg.debug || null,
      decodeFailuresByPc: cfg.decodeFailuresByPc || [],
      vectorSeedCount: baseCertainSeeds.length,
      vectorSeedSites: baseCertainSeeds.map((s) => ({ cpuAddr: s.cpuAddr & 0xffff, ctxKey: mapper.fetchCtxKey(s.fetchCtx) }))
    },
    stats: {
      instructionCount: cfg.instructionCount,
      blockCount: cfg.blocks.length,
      probableBlockCount,
      determinedByteCount,
      coveragePct
    }
  };
}

export async function analyzeStaticFixedSwitch16k({
  prgBytes,
  vectors,
  mapperKind = 'UxROM',
  mapperMeta = null,
  probableConfigOverrides = null
}) {
  const mapperNumber = mapperMeta?.mapperFamily === 'UN1ROM' || mapperKind === 'UN1ROM' ? 94 : 2;
  const mapper = createFixedSwitch16kMapper({ prgBytes, mapperMeta, mapperNumber });
  const entrypoints = collectEntrypoints(vectors);
  const fetchCtx = mapper.initialFetchCtx();
  const baseCertainSeeds = entrypoints.map((cpuAddr) => ({ cpuAddr, confidence: 'certain', fetchCtx }));

  const probableCfg = buildProbableConfigFixedSwitch16K(probableConfigOverrides);
  const cfg1 = discoverCfg({ prgBytes, mapper, fetchCtx, seedItems: baseCertainSeeds, cdlPrg: null, probableConfig: probableCfg });
  if (!cfg1) return emptyResult();
  const probableProbeOffsets = cfg1.probableProbeOffsets || [];
  const probableContext = { ...buildProbableInterruptRootSet({ mapper, vectors, prgBytes }), mapper };
  const probableScan = probableCfg.enabled
    ? scanProbableCode({ prgBytes, mapper, codeBitmap: cfg1.codeBitmap, config: probableCfg, seedProbeOffsets: probableProbeOffsets, probableContext })
    : { kept: [], regionStats: [] };
  const probableKeptAll = probableScan.kept || [];
  const probableKept = probableKeptAll.slice(0, Math.max(0, probableCfg.maxPromotedChunks | 0));
  const probableSeeds = (probableCfg.enabled && probableCfg.promoteToCfg)
    ? deriveProbableSeedItems({ keptChunks: probableKept, mapper, maxChunks: probableCfg.maxPromotedChunks })
    : [];

  const cfg = probableSeeds.length
    ? discoverCfg({ prgBytes, mapper, fetchCtx, seedItems: [...baseCertainSeeds, ...probableSeeds], cdlPrg: null, probableConfig: probableCfg })
    : cfg1;

  const timeline = buildTimeline({ prgSize: prgBytes.length, blocks: cfg.blocks, bitmap: cfg.codeBitmap });
  const probableBlockCount = cfg.blocks.filter((b) => b.confidence === 'probable').length;
  const determinedByteCount = countNonZero(cfg.codeBitmap);
  const coveragePct = prgBytes.length ? (determinedByteCount * 100) / prgBytes.length : 0;

  return {
    mapper: { kind: mapperKind, prgSize: prgBytes.length, meta: mapperMeta || null },
    blocks: cfg.blocks,
    edges: cfg.edges,
    timeline,
    artifacts: [],
    vsaFacts: null,
    unresolvedSites: cfg.unresolvedSites,
    probable: {
      keptChunkCount: probableKeptAll.length,
      promotedChunkCount: probableKept.length,
      promotedSeedCount: probableSeeds.length,
      maxPromotedChunks: probableCfg.maxPromotedChunks,
      globalCapHit: probableKeptAll.length > probableKept.length,
      regionSummaries: summarizeProbableRegions(probableScan.regionStats || [], mapper, prgBytes.length)
    },
    cdl: null,
    debug: {
      cfg: cfg.debug || null,
      decodeFailuresByPc: cfg.decodeFailuresByPc || []
    },
    stats: {
      instructionCount: cfg.instructionCount,
      blockCount: cfg.blocks.length,
      probableBlockCount,
      determinedByteCount,
      coveragePct
    }
  };
}



export async function analyzeStaticFixedSwitch32k({
  prgBytes,
  vectors,
  mapperKind = 'AxROM',
  mapperMeta = null,
  probableConfigOverrides = null
}) {
  const mapperNumber = mapperMeta?.mapperFamily === 'BNROM' ? 34 : mapperMeta?.mapperFamily === 'GxROM' ? 66 : 7;
  const mapper = createFixedSwitch32kMapper({ prgBytes, mapperMeta, mapperNumber });
  const baseCertainSeeds = collect32kVectorSeeds({ prgBytes, mapper }).map((s) => ({ ...s, confidence: 'certain' }));
  const fetchCtx = mapper.initialFetchCtx();

  const probableCfg = buildProbableConfigFixedSwitch32K(probableConfigOverrides);
  const cfg1 = discoverCfg({ prgBytes, mapper, fetchCtx, seedItems: baseCertainSeeds, cdlPrg: null, probableConfig: probableCfg });
  if (!cfg1) return emptyResult();
  const probableProbeOffsets = cfg1.probableProbeOffsets || [];
  const probableContext = { ...buildProbableInterruptRootSet({ mapper, vectors, prgBytes }), mapper };
  const probableScan = probableCfg.enabled
    ? scanProbableCode({ prgBytes, mapper, codeBitmap: cfg1.codeBitmap, config: probableCfg, seedProbeOffsets: probableProbeOffsets, probableContext })
    : { kept: [], regionStats: [] };
  const probableKeptAll = probableScan.kept || [];
  const probableKept = probableKeptAll.slice(0, Math.max(0, probableCfg.maxPromotedChunks | 0));
  const probableSeeds = (probableCfg.enabled && probableCfg.promoteToCfg)
    ? deriveProbableSeedItems({ keptChunks: probableKept, mapper, maxChunks: probableCfg.maxPromotedChunks })
    : [];

  const cfg = probableSeeds.length
    ? discoverCfg({ prgBytes, mapper, fetchCtx, seedItems: [...baseCertainSeeds, ...probableSeeds], cdlPrg: null, probableConfig: probableCfg })
    : cfg1;

  const timeline = buildTimeline({ prgSize: prgBytes.length, blocks: cfg.blocks, bitmap: cfg.codeBitmap });
  const probableBlockCount = cfg.blocks.filter((b) => b.confidence === 'probable').length;
  const determinedByteCount = countNonZero(cfg.codeBitmap);
  const coveragePct = prgBytes.length ? (determinedByteCount * 100) / prgBytes.length : 0;

  return {
    mapper: { kind: mapperKind, prgSize: prgBytes.length, meta: mapperMeta || null },
    blocks: cfg.blocks,
    edges: cfg.edges,
    timeline,
    artifacts: [],
    vsaFacts: null,
    unresolvedSites: cfg.unresolvedSites,
    probable: {
      keptChunkCount: probableKeptAll.length,
      promotedChunkCount: probableKept.length,
      promotedSeedCount: probableSeeds.length,
      maxPromotedChunks: probableCfg.maxPromotedChunks,
      globalCapHit: probableKeptAll.length > probableKept.length,
      regionSummaries: summarizeProbableRegions(probableScan.regionStats || [], mapper, prgBytes.length)
    },
    cdl: null,
    debug: {
      cfg: cfg.debug || null,
      decodeFailuresByPc: cfg.decodeFailuresByPc || [],
      vectorSeedCount: baseCertainSeeds.length,
      vectorSeedSites: baseCertainSeeds.map((s) => ({ cpuAddr: s.cpuAddr & 0xffff, ctxKey: mapper.fetchCtxKey(s.fetchCtx) }))
    },
    stats: {
      instructionCount: cfg.instructionCount,
      blockCount: cfg.blocks.length,
      probableBlockCount,
      determinedByteCount,
      coveragePct
    }
  };
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


function collect32kVectorSeeds({ prgBytes, mapper }) {
  const seeds = [];
  const seen = new Set();
  const bankCount = Math.max(1, mapper?.bankCount | 0);
  const bankSize = 32 * 1024;
  for (let bank = 0; bank < bankCount; bank++) {
    const base = bank * bankSize;
    if (base + 0x7fff >= prgBytes.length) break;
    const fetchCtx = typeof mapper.ctxForBank === 'function' ? mapper.ctxForBank(bank) : mapper.initialFetchCtx();
    const targets = [
      (prgBytes[base + 0x7ffc] | (prgBytes[base + 0x7ffd] << 8)) & 0xffff,
      (prgBytes[base + 0x7ffa] | (prgBytes[base + 0x7ffb] << 8)) & 0xffff,
      (prgBytes[base + 0x7ffe] | (prgBytes[base + 0x7fff] << 8)) & 0xffff
    ];
    for (const cpuAddr of targets) {
      if (cpuAddr < 0x8000) continue;
      const resolved = mapper.resolveCodeFetch(fetchCtx, cpuAddr);
      if (resolved?.backing?.kind !== 'exact') continue;
      const key = `${mapper.fetchCtxKey(fetchCtx)}:${cpuAddr & 0xffff}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seeds.push({ cpuAddr: cpuAddr & 0xffff, fetchCtx });
    }
  }
  return seeds;
}


function collectEntrypoints(vectors) {
  return [vectors?.reset, vectors?.nmi, vectors?.irqBrk]
    .filter((x) => typeof x === 'number')
    .map((x) => x & 0xffff)
    .filter((x) => x >= 0x8000);
}

function emptyResult() {
  return { blocks: [], edges: [], timeline: [], artifacts: [], unresolvedSites: [], stats: { instructionCount: 0, blockCount: 0, probableBlockCount: 0 } };
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
  const back = mapper.cpuToRomOff ? mapper.cpuToRomOff(cpuGuess) : null;
  if (back === (romOff | 0)) return cpuGuess & 0xffff;
  const addrs = mapper.romOffToCpuAddrs ? mapper.romOffToCpuAddrs(romOff) : [];
  if (addrs.length) return addrs[0] & 0xffff;
  return cpuGuess & 0xffff;
}
