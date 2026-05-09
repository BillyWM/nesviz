import { vEnumerate } from './value.js';

function siteKeyForTarget(mapper, site) {
  if (!site || typeof site.cpuAddr !== 'number') return null;
  const ctxKey = mapper?.fetchCtxKey ? mapper.fetchCtxKey(site.fetchCtx) : (site.fetchCtx?.key || 'default');
  return `${ctxKey}:${(site.cpuAddr & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

function buildStartBlockIndex(mapper, blocks) {
  const out = new Map();
  for (const block of blocks || []) {
    if (!block?.id) continue;
    for (const inst of block.instances || []) {
      if (typeof inst?.siteKey === 'string' && inst.siteKey) out.set(inst.siteKey, block.id);
      else if (typeof inst?.cpuStart === 'number') {
        const key = siteKeyForTarget(mapper, { cpuAddr: inst.cpuStart, fetchCtx: inst.fetchCtx || block.fetchCtx });
        if (key) out.set(key, block.id);
      }
    }
  }
  return out;
}

function roleForBlock(blockRolesByRawBlockId, blockId) {
  return blockRolesByRawBlockId?.get(blockId) === 'candidate' ? 'candidate' : 'confirmed';
}

function resolveTargetSites(mapper, fetchCtx, cpuAddr, maxTargetsPerSite) {
  if (!mapper?.targetSitesForCpuAddr) return { sites: [{ cpuAddr: cpuAddr & 0xffff, fetchCtx }], ambiguous: false };
  return mapper.targetSitesForCpuAddr(fetchCtx, cpuAddr & 0xffff, { maxForks: maxTargetsPerSite });
}

function targetBlocksForSites({ mapper, startBlockBySiteKey, blockRolesByRawBlockId, sites }) {
  const targetBlocks = new Map();
  for (const site of sites || []) {
    const key = siteKeyForTarget(mapper, site);
    const blockId = key ? startBlockBySiteKey.get(key) : null;
    if (!blockId) continue;
    targetBlocks.set(blockId, {
      rawBlockId: blockId,
      role: roleForBlock(blockRolesByRawBlockId, blockId),
      cpuAddr: site.cpuAddr & 0xffff,
      siteKey: key
    });
  }
  return Array.from(targetBlocks.values()).sort((a, b) => a.rawBlockId.localeCompare(b.rawBlockId));
}

function inferPointerTargets({ mapper, site, state, maxTargetsPerSite }) {
  if (!state || site?.kind !== 'jmp_ind') return null;
  const ptrAddr = site.ptrAddr & 0xffff;
  if (ptrAddr > 0x00ff) return null;

  const lo = state.zp.get(ptrAddr & 0xff);
  const hi = state.zp.get((ptrAddr + 1) & 0xff);
  if (!lo || !hi) return null;

  const cap = Math.max(6, maxTargetsPerSite);
  const loVals = vEnumerate(lo.abs, cap);
  const hiVals = vEnumerate(hi.abs, cap);
  if (!loVals?.length || !hiVals?.length) return null;
  if ((loVals.length * hiVals.length) > cap) return null;

  const activeCtx = site.fetchCtx || mapper.initialFetchCtx();
  const sites = [];
  const cpuTargets = [];
  const seenCpu = new Set();
  for (const loByte of loVals) {
    for (const hiByte of hiVals) {
      const targetCpu = ((loByte & 0xff) | ((hiByte & 0xff) << 8)) & 0xffff;
      if (targetCpu < 0x8000) continue;
      const resolved = resolveTargetSites(mapper, activeCtx, targetCpu, maxTargetsPerSite);
      for (const targetSite of resolved?.sites || []) sites.push(targetSite);
      if (!seenCpu.has(targetCpu)) {
        seenCpu.add(targetCpu);
        cpuTargets.push(targetCpu);
      }
    }
  }
  if (!sites.length || sites.length > maxTargetsPerSite) return null;
  return {
    basis: 'pointerState',
    sites,
    targetCpuAddrs: cpuTargets.sort((a, b) => a - b),
    ptrSummary: {
      loKind: lo.abs?.kind || 'unknown',
      hiKind: hi.abs?.kind || 'unknown',
      loCount: loVals.length,
      hiCount: hiVals.length
    }
  };
}

function inferBankedTargets({ mapper, site, maxTargetsPerSite }) {
  if (site?.kind !== 'ambiguous_banked_target') return null;
  if (typeof site?.targetCpuAddr !== 'number' || !site.fetchCtx) return null;
  const resolved = resolveTargetSites(mapper, site.fetchCtx, site.targetCpuAddr & 0xffff, maxTargetsPerSite);
  if (!resolved?.sites?.length || resolved.sites.length > maxTargetsPerSite) return null;
  return {
    basis: 'ambiguousBankedTarget',
    sites: resolved.sites,
    targetCpuAddrs: [site.targetCpuAddr & 0xffff]
  };
}

export function buildIndirectControlFacts({
  mapper,
  blocks = [],
  unresolvedSites = [],
  siteStatesBySiteKey = null,
  blockRolesByRawBlockId = null,
  maxTargetsPerSite = 8
} = {}) {
  const startBlockBySiteKey = buildStartBlockIndex(mapper, blocks);
  const out = [];

  for (const site of unresolvedSites || []) {
    if (!site?.rawBlockId) continue;
    const fromRole = roleForBlock(blockRolesByRawBlockId, site.rawBlockId);
    if (fromRole !== 'candidate') continue;

    const state = site?.kind === 'jmp_ind' && site?.siteKey ? siteStatesBySiteKey?.get(String(site.siteKey)) : null;
    const candidates = [];
    const pointerTargets = inferPointerTargets({ mapper, site, state, maxTargetsPerSite });
    if (pointerTargets) candidates.push(pointerTargets);
    const bankedTargets = inferBankedTargets({ mapper, site, maxTargetsPerSite });
    if (bankedTargets) candidates.push(bankedTargets);

    for (const c of candidates) {
      const targetBlocks = targetBlocksForSites({ mapper, startBlockBySiteKey, blockRolesByRawBlockId, sites: c.sites });
      if (!targetBlocks.length) continue;
      const targetRawBlockIds = targetBlocks.map((t) => t.rawBlockId);
      const targetRoles = Array.from(new Set(targetBlocks.map((t) => t.role))).sort();
      out.push({
        kind: c.basis === 'ambiguousBankedTarget' ? 'vsaBankedTarget' : 'vsaIndirectJumpTarget',
        basis: c.basis,
        fromRawBlockId: site.rawBlockId,
        siteKey: site.siteKey || null,
        sitePc: typeof site.pc === 'number' ? (site.pc & 0xffff) : null,
        siteRomOff: Number.isFinite(site.romOff) ? (site.romOff >>> 0) : null,
        targetCpuAddrs: c.targetCpuAddrs || [],
        targetRawBlockIds,
        targetRoles,
        targetBlocks,
        tight: targetRawBlockIds.length > 0 && targetRawBlockIds.length <= maxTargetsPerSite,
        ptrSummary: c.ptrSummary || null
      });
    }
  }

  return out;
}
