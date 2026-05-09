import { hex4 } from '../../cpu6502/fmt.js';
import { vEnumerate } from '../vsa/value.js';
import { extractJumpTableSignals } from './jumpTableSignals.js';
import { readPrgAtCpu } from '../../utils/romReadUtils.js';

function seedKey(mapper, seed) {
  const ctxKey = mapper?.fetchCtxKey ? mapper.fetchCtxKey(seed.fetchCtx) : 'default';
  return `${ctxKey}:${seed.cpuAddr & 0xffff}`;
}

function normalizeSitesToProbableSeeds(mapper, sites) {
  const out = [];
  for (const s of sites || []) {
    if (typeof s?.cpuAddr !== 'number' || !s.fetchCtx) continue;
    const cpuAddr = s.cpuAddr & 0xffff;
    if (cpuAddr < 0x8000) continue;
    out.push({ cpuAddr, fetchCtx: s.fetchCtx, confidence: 'probable' });
  }
  return out;
}

function resolveTargetSites(mapper, fetchCtx, cpuAddr, maxForks) {
  if (!mapper?.targetSitesForCpuAddr) return { sites: [{ cpuAddr: cpuAddr & 0xffff, fetchCtx }], ambiguous: false };
  return mapper.targetSitesForCpuAddr(fetchCtx, cpuAddr & 0xffff, { maxForks });
}

function inferFromAmbiguousBankedTarget({ mapper, site, maxTargetsPerSite }) {
  if (site?.kind !== 'ambiguous_banked_target') return null;
  if (typeof site?.targetCpuAddr !== 'number' || !site.fetchCtx) return null;
  const resolved = resolveTargetSites(mapper, site.fetchCtx, site.targetCpuAddr & 0xffff, maxTargetsPerSite);
  const seeds = normalizeSitesToProbableSeeds(mapper, resolved.sites || []);
  if (!seeds.length || seeds.length > maxTargetsPerSite) return null;
  return {
    basis: 'ambiguousBankedTarget',
    seeds,
    targetCpuAddrs: Array.from(new Set(seeds.map((s) => s.cpuAddr & 0xffff))).sort((a, b) => a - b)
  };
}

function inferFromPointerState({ mapper, site, state, maxTargetsPerSite }) {
  if (!state || site?.kind !== 'jmp_ind') return null;
  const ptrAddr = site.ptrAddr & 0xffff;
  if (ptrAddr > 0x00ff) return null;

  const lo = state.zp.get(ptrAddr & 0xff);
  const hi = state.zp.get((ptrAddr + 1) & 0xff);
  if (!lo || !hi) return null;

  const loVals = vEnumerate(lo.abs, Math.max(6, maxTargetsPerSite));
  const hiVals = vEnumerate(hi.abs, Math.max(6, maxTargetsPerSite));
  if (!loVals?.length || !hiVals?.length) return null;
  if ((loVals.length * hiVals.length) > Math.max(6, maxTargetsPerSite)) return null;

  const seeds = [];
  const cpuTargets = [];
  const seenCpu = new Set();
  const activeCtx = site.fetchCtx || mapper.initialFetchCtx();

  for (const loByte of loVals) {
    for (const hiByte of hiVals) {
      const targetCpu = ((loByte & 0xff) | ((hiByte & 0xff) << 8)) & 0xffff;
      if (targetCpu < 0x8000) continue;
      const resolved = resolveTargetSites(mapper, activeCtx, targetCpu, maxTargetsPerSite);
      const nextSeeds = normalizeSitesToProbableSeeds(mapper, resolved.sites || []);
      for (const seed of nextSeeds) seeds.push(seed);
      if (!seenCpu.has(targetCpu)) {
        seenCpu.add(targetCpu);
        cpuTargets.push(targetCpu);
      }
    }
  }

  const dedup = new Map();
  for (const seed of seeds) dedup.set(seedKey(mapper, seed), seed);
  const outSeeds = Array.from(dedup.values());
  if (!outSeeds.length || outSeeds.length > maxTargetsPerSite) return null;

  return {
    basis: 'pointerState',
    seeds: outSeeds,
    targetCpuAddrs: cpuTargets.sort((a, b) => a - b),
    ptrSummary: {
      loKind: lo.abs?.kind || 'unknown',
      hiKind: hi.abs?.kind || 'unknown',
      loCount: loVals.length,
      hiCount: hiVals.length
    }
  };
}

function inferFromTableLikeDispatch({ prgBytes, mapper, site, state, maxTargetsPerSite }) {
  if (!state || site?.kind !== 'jmp_ind') return null;
  const signals = extractJumpTableSignals({ prgBytes, mapper, site, state, enumCap: Math.max(8, maxTargetsPerSite) });
  if (!signals || !signals.idxEnumerable || !signals.baseReadable) return null;
  if (!signals.indexSource || !signals.sameIndexSource) return null;
  if (!Array.isArray(signals.idxEnum) || !signals.idxEnum.length) return null;
  if (signals.idxEnum.length > maxTargetsPerSite) return null;
  // The exact recognizer already handles the fully aligned case; this pass is for weaker-but-plausible shapes.
  if (signals.decodeOk) return null;
  if (typeof signals.baseLo !== 'number' || typeof signals.baseHi !== 'number') return null;

  const seeds = [];
  const cpuTargets = [];
  const seenCpu = new Set();
  const activeCtx = site.fetchCtx || mapper.initialFetchCtx();

  for (const i of signals.idxEnum) {
    const loByte = readPrgAtCpu(prgBytes, mapper, (signals.baseLo + i) & 0xffff, activeCtx);
    const hiByte = readPrgAtCpu(prgBytes, mapper, (signals.baseHi + i) & 0xffff, activeCtx);
    if (loByte == null || hiByte == null) continue;
    const targetCpu = ((loByte & 0xff) | ((hiByte & 0xff) << 8)) & 0xffff;
    if (targetCpu < 0x8000) continue;
    const resolved = resolveTargetSites(mapper, activeCtx, targetCpu, maxTargetsPerSite);
    const nextSeeds = normalizeSitesToProbableSeeds(mapper, resolved.sites || []);
    for (const seed of nextSeeds) seeds.push(seed);
    if (!seenCpu.has(targetCpu)) {
      seenCpu.add(targetCpu);
      cpuTargets.push(targetCpu);
    }
  }

  const dedup = new Map();
  for (const seed of seeds) dedup.set(seedKey(mapper, seed), seed);
  const outSeeds = Array.from(dedup.values());
  if (!outSeeds.length || outSeeds.length > maxTargetsPerSite) return null;

  return {
    basis: 'tableLikeDispatch',
    seeds: outSeeds,
    targetCpuAddrs: cpuTargets.sort((a, b) => a - b),
    indexSource: signals.indexSource,
    shape: signals.shape,
    decodeBlockedBy: signals.decodeBlockedBy || []
  };
}

export function inferSpeculativeDispatchTargets({
  prgBytes,
  mapper,
  unresolvedSites,
  siteStatesBySiteKey,
  maxTargetsPerSite = 8,
  maxTotalSeedItems = 128
}) {
  const artifacts = [];
  const seedMap = new Map();

  for (const site of unresolvedSites || []) {
    if (seedMap.size >= maxTotalSeedItems) break;
    const pc = site?.pc & 0xffff;
    const state = site?.kind === 'jmp_ind' && site?.siteKey ? siteStatesBySiteKey?.get(String(site.siteKey)) : null;

    const candidates = [];
    const ambiguousBanked = inferFromAmbiguousBankedTarget({ mapper, site, maxTargetsPerSite });
    if (ambiguousBanked) candidates.push(ambiguousBanked);
    const ptrState = inferFromPointerState({ mapper, site, state, maxTargetsPerSite });
    if (ptrState) candidates.push(ptrState);
    const tableLike = inferFromTableLikeDispatch({ prgBytes, mapper, site, state, maxTargetsPerSite });
    if (tableLike) candidates.push(tableLike);

    if (!candidates.length) continue;

    const seedKeysBefore = seedMap.size;
    const targetCpuAddrs = Array.from(new Set(candidates.flatMap((c) => c.targetCpuAddrs || []))).sort((a, b) => a - b);
    for (const c of candidates) {
      for (const seed of c.seeds || []) {
        if (seedMap.size >= maxTotalSeedItems) break;
        const key = seedKey(mapper, seed);
        const prev = seedMap.get(key);
        const leaderReason = {
          kind: 'speculative_dispatch_seed',
          basis: c.basis || 'unknown',
          sitePc: pc,
          siteRomOff: Number.isFinite(site?.romOff) ? (site.romOff >>> 0) : null,
          siteKind: site?.kind || null,
          targetCpuAddrs
        };
        const next = {
          ...seed,
          confidence: 'probable',
          leaderKind: 'soft',
          leaderReasons: [...(prev?.leaderReasons || []), ...(seed.leaderReasons || []), leaderReason]
        };
        seedMap.set(key, next);
      }
    }
    if (seedMap.size === seedKeysBefore) continue;

    if (!Number.isFinite(site?.romOff)) continue;
    const siteRomOff = site.romOff >>> 0;
    artifacts.push({
      id: `specdisp:${siteRomOff}:${site.kind}`,
      kind: 'speculativeDispatch',
      confidence: 'probable',
      sitePc: pc,
      siteRomOff,
      siteKind: site.kind,
      bases: candidates.map((c) => c.basis),
      ptrAddr: typeof site.ptrAddr === 'number' ? (site.ptrAddr & 0xffff) : null,
      targetCpuAddrs,
      seedCount: targetCpuAddrs.length,
      details: candidates
    });
  }

  return {
    artifacts,
    seedItems: Array.from(seedMap.values())
  };
}
