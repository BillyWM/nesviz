import { siteKeyFor } from '../fetchContext.js';
import { DEFAULT_COALESCE_CONFIG } from './config.js';

function confRank(c) {
  return c === 'certain' ? 2 : c === 'probable' ? 1 : 0;
}

function bestOf(a, b) {
  return confRank(a) >= confRank(b) ? a : b;
}

function isContiguous(a, b) {
  return !!a && !!b && typeof a.romEnd === 'number' && typeof b.romStart === 'number' && a.romEnd === b.romStart;
}

function blockStartSiteKey(block) {
  if (!block || typeof block !== 'object') return null;

  const firstLine = block?.lines?.[0] || null;
  if (typeof firstLine?.siteKey === 'string' && firstLine.siteKey) return firstLine.siteKey;

  const firstInstance = block?.instances?.[0] || null;
  if (typeof firstInstance?.siteKey === 'string' && firstInstance.siteKey) return firstInstance.siteKey;

  const ctxKey = (typeof firstLine?.ctxKey === 'string' && firstLine.ctxKey)
    || (typeof block?.ctxKey === 'string' && block.ctxKey)
    || (typeof firstInstance?.ctxId === 'string' && firstInstance.ctxId)
    || (typeof firstInstance?.fetchCtxKey === 'string' && firstInstance.fetchCtxKey)
    || null;
  const cpuStart = typeof firstLine?.cpuAddr === 'number'
    ? firstLine.cpuAddr
    : (typeof firstInstance?.cpuStart === 'number' ? firstInstance.cpuStart : null);
  if (typeof cpuStart !== 'number') return null;
  return siteKeyFor(ctxKey, cpuStart & 0xffff);
}

function lastLineOf(entity) {
  const lines = entity?.lines;
  return Array.isArray(lines) && lines.length > 0 ? lines[lines.length - 1] : null;
}

function isHardStopLine(ln) {
  if (!ln || typeof ln !== 'object') return false;
  const mnemonic = typeof ln.mnemonic === 'string' ? ln.mnemonic.toUpperCase() : '';
  return mnemonic === 'BRK' || mnemonic === 'JMP' || mnemonic === 'RTS' || mnemonic === 'RTI';
}

function isBareRtsEntity(entity) {
  const lines = entity?.lines;
  if (!Array.isArray(lines) || lines.length !== 1) return false;
  const ln = lines[0];
  return typeof ln?.mnemonic === 'string' && ln.mnemonic.toUpperCase() === 'RTS';
}

function makeMergedEntity(leaderId, members) {
  const memberInstances = new Map();
  const mergedLines = [];
  const rawBlockIds = [];

  let mergedConf = 'certain';
  let romStart = null;
  let romEnd = null;

  for (const member of members) {
    if (!member) continue;
    mergedConf = bestOf(mergedConf, member.confidence || 'certain');
    if (typeof member.romStart === 'number') romStart = romStart === null ? member.romStart : Math.min(romStart, member.romStart);
    if (typeof member.romEnd === 'number') romEnd = romEnd === null ? member.romEnd : Math.max(romEnd, member.romEnd);

    for (const rawId of member.rawBlockIds || []) {
      rawBlockIds.push(rawId);
    }

    for (const inst of member.instances || []) {
      const ctxId = inst?.ctxId || 'nrom';
      const cpuStart = inst?.cpuStart;
      if (typeof cpuStart !== 'number') continue;
      const key = `${ctxId}:${cpuStart & 0xffff}`;
      if (!memberInstances.has(key)) memberInstances.set(key, { ctxId, cpuStart: cpuStart & 0xffff });
    }

    for (const ln of member.lines || []) {
      mergedLines.push({ ...ln });
    }
  }

  const cpuStart = mergedLines?.[0]?.cpuAddr;
  const lastLine = mergedLines?.[mergedLines.length - 1];
  const cpuEnd = lastLine && typeof lastLine.cpuAddr === 'number' && typeof lastLine.len === 'number'
    ? ((lastLine.cpuAddr + lastLine.len) & 0xffff)
    : null;

  return {
    id: leaderId,
    romStart,
    romEnd,
    confidence: mergedConf,
    instances: Array.from(memberInstances.values()),
    rawBlockIds,
    cpuStart: typeof cpuStart === 'number' ? (cpuStart & 0xffff) : null,
    cpuEnd,
    lines: mergedLines
  };
}

function countInstrFromEntityIndexToStartSiteKey(entities, startIndex, targetSiteKey, maxInstr) {
  if (!Array.isArray(entities)) return { found: false, count: 0, index: null };
  if (typeof targetSiteKey !== 'string' || !targetSiteKey) return { found: false, count: 0, index: null };

  let count = 0;
  for (let i = startIndex; i < entities.length; i++) {
    const entity = entities[i];
    if (i > startIndex) {
      const prev = entities[i - 1];
      if (!isContiguous(prev, entity)) return { found: false, count, index: null };
    }

    if (blockStartSiteKey(entity) === targetSiteKey) {
      return { found: true, count, index: i };
    }

    count += entity?.lines?.length || 0;
    if (count > maxInstr) return { found: false, count, index: null };
  }

  return { found: false, count, index: null };
}

function collectBranchOverHardStopTargetIndex(entities, groupIndex, config) {
  const entity = entities[groupIndex];
  if (!entity || !isHardStopLine(lastLineOf(entity))) return null;

  let bestTargetIndex = null;
  const maxInstr = config.branchOverHardStopMaxInstr | 0;
  if (maxInstr < 0) return null;

  for (const ln of entity.lines || []) {
    const flow = ln?.flow;
    if (!flow || flow.type !== 'branch') continue;
    if (typeof flow.target !== 'number' || typeof flow.fallthrough !== 'number') continue;
    if ((flow.target & 0xffff) <= (flow.fallthrough & 0xffff)) continue;

    const targetSiteKey = siteKeyFor(ln?.ctxKey, flow.target & 0xffff);
    const result = countInstrFromEntityIndexToStartSiteKey(entities, groupIndex + 1, targetSiteKey, maxInstr);
    if (!result.found || typeof result.index !== 'number') continue;

    if (bestTargetIndex === null || result.index > bestTargetIndex) {
      bestTargetIndex = result.index;
    }
  }

  return bestTargetIndex;
}

function buildPrimaryGroups(sorted) {
  const groups = [];

  for (let i = 0; i < sorted.length; ) {
    const leader = sorted[i];
    if (!leader || !leader.id) {
      i++;
      continue;
    }

    const members = [];
    let j = i;
    while (j < sorted.length) {
      const block = sorted[j];
      if (!block || !block.id) break;
      members.push(block);

      const next = sorted[j + 1];
      const canContinue = isContiguous(block, next);
      const hardStop = isHardStopLine(lastLineOf(block));
      j++;

      if (!canContinue || hardStop) break;
    }

    groups.push(makeMergedEntity(leader.id, members.map((member) => ({
      ...member,
      rawBlockIds: Array.isArray(member?.rawBlockIds) && member.rawBlockIds.length ? member.rawBlockIds : [member.id]
    }))));
    i = j;
  }

  return groups;
}

function applyBranchOverHardStop(groups, config) {
  const out = [];

  for (let i = 0; i < groups.length; ) {
    let endIndex = i;

    while (endIndex < groups.length) {
      const targetIndex = collectBranchOverHardStopTargetIndex(groups, endIndex, config);
      if (targetIndex === null || targetIndex <= endIndex) break;

      let contiguous = true;
      for (let k = endIndex; k < targetIndex; k++) {
        if (!isContiguous(groups[k], groups[k + 1])) {
          contiguous = false;
          break;
        }
      }
      if (!contiguous) break;

      endIndex = targetIndex;
    }

    const members = groups.slice(i, endIndex + 1);
    out.push(makeMergedEntity(groups[i].id, members));
    i = endIndex + 1;
  }

  return out;
}

function applyBareRtsFixedPoint(groups) {
  let current = Array.isArray(groups) ? groups : [];

  while (true) {
    const next = [];
    let changed = false;

    for (let i = 0; i < current.length; i++) {
      const entity = current[i];
      if (i > 0 && isBareRtsEntity(entity) && isContiguous(next[next.length - 1], entity)) {
        const prev = next.pop();
        next.push(makeMergedEntity(prev.id, [prev, entity]));
        changed = true;
        continue;
      }
      next.push(entity);
    }

    if (!changed) return next;
    current = next;
  }
}

// Build a *derived* "coalesced" block view for display purposes. 🤖
//
// The display coalescer now intentionally uses a very small rule set:
// 1. Merge through ROM-contiguous code until a hard-stop instruction (BRK/JMP/RTS/RTI). 🤖
// 2. Allow a nearby forward branch to merge across an intervening hard-stop region. 🤖
// 3. Repeatedly swallow bare RTS blocks into the previous display block. 🤖
export function buildCoalescedAnalysisView(rawAnalysis, config = DEFAULT_COALESCE_CONFIG) {
  if (!rawAnalysis) return { analysis: rawAnalysis, rawToDisplayBlockIds: {} };

  const rawBlocks = Array.isArray(rawAnalysis.blocks) ? rawAnalysis.blocks : [];
  const sorted = [...rawBlocks].sort((a, b) => (a.romStart ?? 0) - (b.romStart ?? 0));

  const primaryGroups = buildPrimaryGroups(sorted);
  const branchMergedGroups = applyBranchOverHardStop(primaryGroups, config);
  const coalescedBlocks = applyBareRtsFixedPoint(branchMergedGroups);

  const rawToDisplayBlockIds = {};
  for (const block of coalescedBlocks) {
    for (const rawId of block.rawBlockIds || []) {
      rawToDisplayBlockIds[rawId] = block.id;
    }
  }

  const coalescedTimeline = coalesceTimeline(rawAnalysis.timeline, rawToDisplayBlockIds);

  const stats = { ...(rawAnalysis.stats || {}) };
  if (typeof stats.blockCount === 'number') {
    stats.resolvedRawBlockCount = stats.blockCount;
    if (typeof stats.rawBlockCount !== 'number') stats.rawBlockCount = stats.blockCount;
  }
  stats.blockCount = coalescedBlocks.length;

  const analysis = {
    ...rawAnalysis,
    blocks: coalescedBlocks,
    timeline: coalescedTimeline,
    stats,
    debug: {
      ...(rawAnalysis.debug || {}),
      coalesced: {
        config,
        rawBlockCount: rawBlocks.length,
        coalescedBlockCount: coalescedBlocks.length
      }
    }
  };

  return { analysis, rawToDisplayBlockIds };
}

function coalesceTimeline(timeline, rawToDisplayBlockIds) {
  const inItems = Array.isArray(timeline) ? timeline : [];
  const out = [];

  for (const it of inItems) {
    if (!it || it.type !== 'code') {
      out.push(it);
      continue;
    }

    const mappedId = rawToDisplayBlockIds?.[it.blockId] ?? null;
    if (!mappedId) throw new Error(`Missing display block mapping for raw timeline block ${it.blockId}`);
    const prev = out[out.length - 1];

    if (
      prev &&
      prev.type === 'code' &&
      prev.blockId === mappedId &&
      typeof prev.romEnd === 'number' &&
      typeof it.romStart === 'number' &&
      prev.romEnd === it.romStart
    ) {
      prev.romEnd = it.romEnd;
      prev.byteLen = (prev.romEnd - prev.romStart) | 0;
    } else {
      out.push({ ...it, blockId: mappedId });
    }
  }
  return out;
}
