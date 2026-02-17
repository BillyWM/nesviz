import { createNromMapper } from './map/nrom.js';
import { discoverCfg } from './discover/cfg.js';
import { buildTimeline } from './discover/timeline.js';
import { runVsa } from './vsa/run.js';
import { runVsaFacts } from './vsa/runFacts.js';
import { recognizeJumpTables } from './recognize/jumpTables.js';
import { DEFAULT_PROBABLE_CONFIG } from './probable/config.js';
import { scanProbableCode } from './probable/scanUnknown.js';
import { deriveProbableSeedItems } from './probable/deriveSeeds.js';
import { cpuAddrForRomOffUsingSlot, decodePrgCdlByte, isPrgDataObserved } from './cdl/nesCdl.js';

// Static analysis pipeline (initial NROM-focused prototype). 🤖
// High-level idea: decode reachable instructions from seeds -> build CFG -> run VSA to recover table-driven jumps -> feed new targets back. 🤖
// Optionally, a Code/Data Log (CDL) can be imported to add runtime evidence (executed bytes, data reads, known call/jump targets). 🤖

export async function analyzeStaticNrom({
  prgBytes,
  vectors,
  mapperKind = 'NROM',
  cdlPrg = null,
  cdlChr = null,
  cdlMeta = null,
  yieldEveryMs = 0,
  onVsaProgress = null,
  vsaProgressEveryMs = 0
}) {
  const mapper = createNromMapper({ prgSize: prgBytes.length });

  const entrypoints = [vectors?.reset, vectors?.nmi, vectors?.irqBrk]
    .filter((x) => typeof x === 'number')
    .map((x) => x & 0xffff)
    .filter((x) => x >= 0x8000);

  const mk = (typeof mapperKind === 'string' && mapperKind) ? mapperKind : 'NROM';
  const ctxId = mk.toLowerCase();

  const cdlOverlay = deriveCdlOverlay({ cdlPrg, mapper, prgSize: prgBytes.length });

  // VSA runs multiple times during a single analysis (fixpoint iterations, then a facts pass).
  // We tag each VSA run so the renderer can reset its per-run monotonic progress bar.
  let vsaRunSeq = 0;

  async function runFixpoint({ baseSeeds }) {
    const extraEntrypoints = new Set();
    let syntheticEdges = [];
    let artifacts = [];
    let lastCfg = null;

    for (let iter = 0; iter < 4; iter++) {
      const seedItems = [...baseSeeds, ...Array.from(extraEntrypoints).map((cpuAddr) => ({ cpuAddr, confidence: 'certain' }))];

      const cfg = discoverCfg({
        prgBytes,
        mapper,
        ctxId,
        seedItems,
        cdlPrg
      });

      lastCfg = cfg;

      const blocksById = new Map(cfg.blocks.map((b) => [b.id, b]));

      // VSA uses a set of entry blocks to start propagation. For "probable" islands we still want analysis,
      // so we include any block that corresponds to a seed CPU address. 🤖
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
        // Progress UI is driven by the later VSA facts pass (runVsaFacts), which is typically the
        // expensive one. The iterative runVsa passes here can complete quickly and would otherwise
        // pin the UI progress bar at 100% for the remainder of analysis.
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

  const baseCertainSeeds = entrypoints.map((cpuAddr) => ({ cpuAddr, confidence: 'certain' }));
  const cdlSeedItems = cdlOverlay?.seedItems || [];

  // Phase 1: conservative discovery starting from vectors plus any CDL-derived seeds. 🤖
  const phase1 = await runFixpoint({ baseSeeds: [...baseCertainSeeds, ...cdlSeedItems] });
  const cfg1 = phase1.cfg;
  if (!cfg1) {
    return { blocks: [], edges: [], timeline: [], artifacts: [], unresolvedSites: [], stats: { instructionCount: 0, blockCount: 0, probableBlockCount: 0 } };
  }

  // Scan "unknown" regions for high-scoring "probable code" chunks. 🤖
  // If we have a CDL, mark "observed as data" bytes as known so we don't waste scan time there. 🤖
  const scanBitmap1 = overlayDataEvidence(cfg1.codeBitmap, cdlOverlay?.dataOnly01 || null);

  const probableKeptAll = DEFAULT_PROBABLE_CONFIG.enabled ? scanProbableCode({
    prgBytes,
    mapper,
    codeBitmap: scanBitmap1,
    config: DEFAULT_PROBABLE_CONFIG
  }) : [];
  const probableKept = probableKeptAll.slice(0, Math.max(0, DEFAULT_PROBABLE_CONFIG.maxPromotedChunks | 0));

  const probableSeeds = (DEFAULT_PROBABLE_CONFIG.enabled && DEFAULT_PROBABLE_CONFIG.promoteToCfg)
    ? deriveProbableSeedItems({ keptChunks: probableKept, mapper, maxChunks: DEFAULT_PROBABLE_CONFIG.maxPromotedChunks })
    : [];

  // Phase 2: re-run discovery with probable seeds included so we can learn CFG edges into/out of these regions. 🤖
  const phase2Base = [...baseCertainSeeds, ...cdlSeedItems, ...probableSeeds, ...phase1.extraEntrypointsCpuAddrs.map((cpuAddr) => ({ cpuAddr, confidence: 'certain' }))];
  const phase2 = probableSeeds.length ? await runFixpoint({ baseSeeds: phase2Base }) : phase1;

  const cfg = phase2.cfg;
  // VSA "facts" pass: emit high-certainty propagation-derived facts.
  // This is currently the slowest analysis stage; drive the UI progress bar from its convergence.
  const seedCpuSet = new Set(phase2Base.map((s) => (s.cpuAddr & 0xffff)));
  const entryBlockIds = cfg.blocks
    .filter((b) => b.instances?.some((i) => seedCpuSet.has(i.cpuStart & 0xffff)))
    .map((b) => b.id);

  const vsaFactsRunId = ++vsaRunSeq;
  const vsaFactsOnProgress = (typeof onVsaProgress === 'function')
    ? (p) => onVsaProgress({ ...(p || {}), runId: vsaFactsRunId })
    : null;

  // Emit an immediate "start" update so UI can reset right away even if the first timed
  // progress report would arrive later.
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
    mapper: { kind: mk, prgSize: prgBytes.length },
    blocks: cfg.blocks,
    // Edges include the discovered CFG edges plus any synthetic edges from recognized constructs (jump tables, etc). 🤖
    edges: [...cfg.edges, ...phase2.syntheticEdges],
    timeline,
    artifacts: phase2.artifacts,
    vsaFacts,
    unresolvedSites: cfg.unresolvedSites,
    probable: {
      keptChunkCount: probableKeptAll.length,
      promotedChunkCount: probableKept.length,
      promotedSeedCount: probableSeeds.length
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

function countNonZero(u8) {
  if (!u8 || u8.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < u8.length; i++) {
    if (u8[i] !== 0) n++;
  }
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
  // Data-only evidence: bytes observed as data but *not* observed executed. "Code wins" when both apply. 🤖
  const dataOnly01 = new Uint8Array(prgSize);

  const seedItems = [];
  const seen = new Set();

  const summary = {
    present: true,
    prgByteCount: limit,
    execByteCount: 0,
    dataByteCount: 0,
    jsrTargetSeedCount: 0,
    jumpTargetSeedCount: 0,
    execRunSeedCount: 0,
    totalSeedCount: 0
  };

  let prevExec = false;

  for (let romOff = 0; romOff < limit; romOff++) {
    const flags = decodePrgCdlByte(cdlPrg[romOff]);

    if (flags.exec) summary.execByteCount++;

    // Treat "data" as authoritative only when we did NOT observe execution at this byte. 🤖
    if (isPrgDataObserved(flags) && !flags.exec) {
      dataOnly01[romOff] = 1;
      summary.dataByteCount++;
    }

    // Seed the start of an "executed" run. This is a heuristic to turn per-byte execution evidence
    // into instruction-aligned entrypoints for static decoding. 🤖
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
    const key = cpu;
    if (seen.has(key)) return false;
    seen.add(key);
    seedItems.push({ cpuAddr: cpu, confidence: item.confidence || 'certain' });
    return true;
  }
}

function pickCpuAddrForRomOff({ romOff, slot, mapper }) {
  // The CDL records A14/A13 of the most recent access; for NROM this helps disambiguate
  // mirrored 16KiB PRG ($8000-$BFFF vs $C000-$FFFF). 🤖
  const cpuGuess = cpuAddrForRomOffUsingSlot(romOff, slot);
  const back = mapper.cpuToRomOff(cpuGuess);
  if (back === (romOff | 0)) return cpuGuess & 0xffff;

  // Fallback: use the mapper's canonical ROM->CPU mapping if the guess doesn't round-trip. 🤖
  const addrs = mapper.romOffToCpuAddrs(romOff);
  if (addrs.length) return addrs[0] & 0xffff;

  return cpuGuess & 0xffff;
}
