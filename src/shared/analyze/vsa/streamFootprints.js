import { normalizePhysicalRom } from '../../utils/romIdentityUtils.js';
import { rangeFromOffsets } from '../../utils/rangeUtils.js';
import { intersectAllOffsetSets, unionAllOffsetSets } from '../../utils/setMathUtils.js';
import { uniqNums, uniqObjectsByKey, uniqStrings } from '../../utils/uniqueUtils.js';

function footprintPattern(memberRomOffsets) {
  const offs = uniqNums(memberRomOffsets);
  if (!offs.length) return 'unknown';
  if (offs.length === 1) return 'sparse';
  let contiguous = true;
  const diffs = [];
  for (let i = 1; i < offs.length; i++) {
    const d = offs[i] - offs[i - 1];
    diffs.push(d);
    if (d !== 1) contiguous = false;
  }
  if (contiguous) return 'contiguous';
  const stride = diffs[0];
  if (stride > 1 && diffs.every((d) => d === stride)) return 'strided';
  return 'sparse';
}

function scopeKey(obs) {
  if (typeof obs?.rawBlockId === 'string' && obs.rawBlockId) return `block:${obs.rawBlockId}`;
  if (Array.isArray(obs?.functionIds) && obs.functionIds.length) return `fn:${obs.functionIds[0]}`;
  return `pc:${typeof obs?.atRomOff === 'number' ? (obs.atRomOff >>> 0) : 'unknown'}`;
}

function collectRomReadLikeObservations(observations) {
  const out = [];
  for (const obs of observations || []) {
    if (obs?.kind === 'read8' && obs?.src?.space === 'rom') {
      const physicalRom = normalizePhysicalRom(obs.src.physicalRom || (typeof obs.src.romOff === 'number' ? { kind: 'exact', romOffsets: [obs.src.romOff >>> 0] } : null));
      if (physicalRom.kind === 'unknown') continue;
      out.push({
        observation: obs,
        kind: 'read8',
        scopeKey: scopeKey(obs),
        physicalRom,
        dstReg: obs.dstReg || null,
        indexSource: obs.src.indexSource || null,
        ptrZp: typeof obs.src.ptrZp === 'number' ? (obs.src.ptrZp & 0xff) : null,
        baseCpuAddr: typeof obs.src.baseCpuAddr === 'number' ? (obs.src.baseCpuAddr & 0xffff) : null,
        atRomOff: typeof obs.atRomOff === 'number' ? (obs.atRomOff >>> 0) : null,
        rawBlockId: obs.rawBlockId || null,
        functionIds: Array.isArray(obs.functionIds) ? [...obs.functionIds] : [],
        entryFamilies: Array.isArray(obs.entryFamilies) ? [...obs.entryFamilies] : []
      });
      continue;
    }
    if (obs?.kind === 'cmp8' && obs?.rhs?.kind === 'mem' && obs?.rhs?.src?.space === 'rom') {
      const physicalRom = normalizePhysicalRom(obs.rhs.src.physicalRom || (typeof obs.rhs.src.romOff === 'number' ? { kind: 'exact', romOffsets: [obs.rhs.src.romOff >>> 0] } : null));
      if (physicalRom.kind === 'unknown') continue;
      out.push({
        observation: obs,
        kind: 'cmpRom',
        scopeKey: scopeKey(obs),
        physicalRom,
        dstReg: obs.reg || null,
        indexSource: obs.rhs.src.indexSource || null,
        ptrZp: typeof obs.rhs.src.ptrZp === 'number' ? (obs.rhs.src.ptrZp & 0xff) : null,
        baseCpuAddr: typeof obs.rhs.src.baseCpuAddr === 'number' ? (obs.rhs.src.baseCpuAddr & 0xffff) : null,
        atRomOff: typeof obs.atRomOff === 'number' ? (obs.atRomOff >>> 0) : null,
        rawBlockId: obs.rawBlockId || null,
        functionIds: Array.isArray(obs.functionIds) ? [...obs.functionIds] : [],
        entryFamilies: Array.isArray(obs.entryFamilies) ? [...obs.entryFamilies] : []
      });
    }
  }
  return out;
}

function buildGraph(blocks, edges) {
  const blockById = new Map();
  const indexById = new Map();
  (blocks || []).forEach((block, index) => {
    if (!block?.id) return;
    blockById.set(block.id, block);
    indexById.set(block.id, index);
  });
  const preds = new Map();
  const succs = new Map();
  for (const edge of edges || []) {
    if (!edge?.from || !edge?.to) continue;
    if (!blockById.has(edge.from) || !blockById.has(edge.to)) continue;
    if (!preds.has(edge.to)) preds.set(edge.to, []);
    preds.get(edge.to).push(edge.from);
    if (!succs.has(edge.from)) succs.set(edge.from, []);
    succs.get(edge.from).push(edge.to);
  }
  return { blockById, indexById, preds, succs };
}

function naturalLoop(rawHeaderBlockId, rawTailBlockId, preds, blockById) {
  const loop = new Set([rawHeaderBlockId, rawTailBlockId]);
  const work = [rawTailBlockId];
  const headerCtx = blockById.get(rawHeaderBlockId)?.ctxKey || null;
  while (work.length) {
    const cur = work.pop();
    for (const pred of preds.get(cur) || []) {
      if (loop.has(pred)) continue;
      if ((blockById.get(pred)?.ctxKey || null) !== headerCtx) continue;
      loop.add(pred);
      work.push(pred);
    }
  }
  return Array.from(loop);
}

function discoverLoops(blocks, edges) {
  const { blockById, indexById, preds, succs } = buildGraph(blocks, edges);
  const loops = [];
  const seen = new Set();
  for (const edge of edges || []) {
    if (!edge?.from || !edge?.to) continue;
    const fromIndex = indexById.get(edge.from);
    const toIndex = indexById.get(edge.to);
    if (fromIndex == null || toIndex == null) continue;
    if (toIndex > fromIndex) continue;
    const fromBlock = blockById.get(edge.from);
    const toBlock = blockById.get(edge.to);
    if (!fromBlock || !toBlock) continue;
    if ((fromBlock.ctxKey || null) !== (toBlock.ctxKey || null)) continue;
    const rawBlockIds = naturalLoop(edge.to, edge.from, preds, blockById).sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0));
    if (rawBlockIds.length < 1 || rawBlockIds.length > 24) continue;
    const key = `${edge.to}|${rawBlockIds.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    loops.push({
      id: `loop:${loops.length + 1}`,
      rawHeaderBlockId: edge.to,
      rawTailBlockId: edge.from,
      ctxKey: toBlock.ctxKey || null,
      backEdge: { from: edge.from, to: edge.to },
      rawBlockIds,
      depth: 1,
      parentId: null,
      exitEdges: [],
      entryPredIds: []
    });
  }
  for (const loop of loops) {
    const members = new Set(loop.rawBlockIds);
    for (const edge of edges || []) {
      if (!edge?.from || !edge?.to) continue;
      if (!members.has(edge.from) || members.has(edge.to)) continue;
      loop.exitEdges.push({ from: edge.from, to: edge.to });
    }
    for (const edge of edges || []) {
      if (!edge?.from || !edge?.to) continue;
      if (edge.to !== loop.rawHeaderBlockId || members.has(edge.from)) continue;
      loop.entryPredIds.push(edge.from);
    }
  }
  for (const loop of loops) {
    let bestParent = null;
    for (const other of loops) {
      if (other === loop) continue;
      if (other.ctxKey !== loop.ctxKey) continue;
      if (other.rawBlockIds.length <= loop.rawBlockIds.length) continue;
      if (!loop.rawBlockIds.every((id) => other.rawBlockIds.includes(id))) continue;
      if (!bestParent || other.rawBlockIds.length < bestParent.rawBlockIds.length) bestParent = other;
    }
    loop.parentId = bestParent ? bestParent.id : null;
    loop.depth = bestParent ? 2 : 1;
  }
  return { loops, blockById, indexById, preds, succs };
}

function observationLoopItems(loop, romReads) {
  const rawBlockIds = new Set(loop.rawBlockIds);
  return romReads.filter((item) => item.rawBlockId && rawBlockIds.has(item.rawBlockId));
}

function loopLines(loop, blockById, indexById) {
  const lines = [];
  const sortedBlockIds = [...loop.rawBlockIds].sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0));
  for (const rawBlockId of sortedBlockIds) {
    const block = blockById.get(rawBlockId);
    const blockLines = Array.isArray(block?.lines) ? block.lines : [];
    for (let i = 0; i < blockLines.length; i++) {
      const line = blockLines[i];
      lines.push({ ...line, rawBlockId, lineIndexInBlock: i, blockLineCount: blockLines.length });
    }
  }
  return lines;
}

function inferReadFamily(item) {
  if (item.ptrZp != null && item.indexSource === 'Y') return 'ptrY';
  if (item.baseCpuAddr != null && item.indexSource === 'X') return 'absX';
  if (item.baseCpuAddr != null && item.indexSource === 'Y') return 'absY';
  return 'other';
}

function collectLoopReadFamilies(loop, romReads) {
  const loopItems = observationLoopItems(loop, romReads).filter((item) => item.kind === 'read8');
  const byKey = new Map();
  for (const item of loopItems) {
    const family = inferReadFamily(item);
    if (family === 'other') continue;
    const key = [family, item.indexSource || 'none', item.ptrZp != null ? `ptr:${item.ptrZp}` : 'noptr', item.baseCpuAddr != null ? `base:${item.baseCpuAddr}` : 'nobase', item.dstReg || 'nodst'].join('|');
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        family,
        indexReg: item.indexSource || null,
        ptrZp: item.ptrZp,
        baseCpuAddr: item.baseCpuAddr,
        dstReg: item.dstReg || null,
        observedRomOffsets: new Set(),
        basisKind: 'exact',
        touchingRawBlockIds: new Set(),
        touchingFunctionIds: new Set(),
        entryFamilies: new Set(),
        observationIds: new Set(),
        items: []
      };
      byKey.set(key, acc);
    }
    acc.items.push(item);
    for (const off of item.physicalRom.romOffsets || []) acc.observedRomOffsets.add(off >>> 0);
    if (item.physicalRom.kind !== 'exact') acc.basisKind = 'set';
    if (item.rawBlockId) acc.touchingRawBlockIds.add(item.rawBlockId);
    for (const id of item.functionIds || []) acc.touchingFunctionIds.add(id);
    for (const fam of item.entryFamilies || []) acc.entryFamilies.add(fam);
    acc.observationIds.add(String(item.observation.id));
  }
  return Array.from(byKey.values()).map((family) => ({
    ...family,
    observedRomOffsets: uniqNums(Array.from(family.observedRomOffsets)),
    touchingRawBlockIds: uniqStrings(Array.from(family.touchingRawBlockIds)),
    touchingFunctionIds: uniqStrings(Array.from(family.touchingFunctionIds)),
    entryFamilies: uniqStrings(Array.from(family.entryFamilies)),
    observationIds: uniqStrings(Array.from(family.observationIds))
  })).filter((family) => family.observedRomOffsets.length > 0 && (family.indexReg === 'X' || family.indexReg === 'Y'));
}

function inferLoopRegStep(lines, reg) {
  let step = 0;
  const inc = reg === 'X' ? 'INX' : 'INY';
  const dec = reg === 'X' ? 'DEX' : 'DEY';
  const toA = reg === 'X' ? 'TXA' : 'TYA';
  const fromA = reg === 'X' ? 'TAX' : 'TAY';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.mnemonic || null;
    if (m === inc) step += 1;
    else if (m === dec) step -= 1;
  }
  for (let i = 0; i + 3 < lines.length; i++) {
    const l0 = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    const l3 = lines[i + 3];
    if (l0?.mnemonic !== toA || l3?.mnemonic !== fromA) continue;
    if (!(l1?.mnemonic === 'CLC' || l1?.mnemonic === 'SEC')) continue;
    if (!Array.isArray(l2?.bytes) || l2.bytes.length < 2) continue;
    if (l2.mnemonic === 'ADC' && l1.mnemonic === 'CLC' && l2.mode === 'imm') step += (l2.bytes[1] & 0xff);
    else if (l2.mnemonic === 'SBC' && l1.mnemonic === 'SEC' && l2.mode === 'imm') step -= (l2.bytes[1] & 0xff);
  }
  return step || null;
}

function buildObservationIndex(observations) {
  const byBlock = new Map();
  const byBlockAt = new Map();
  for (const obs of observations || []) {
    if (typeof obs?.rawBlockId !== 'string' || !obs.rawBlockId) continue;
    if (!byBlock.has(obs.rawBlockId)) byBlock.set(obs.rawBlockId, []);
    byBlock.get(obs.rawBlockId).push(obs);
    const at = typeof obs.atRomOff === 'number' ? (obs.atRomOff >>> 0) : null;
    if (at != null) {
      const key = `${obs.rawBlockId}|${at}`;
      if (!byBlockAt.has(key)) byBlockAt.set(key, []);
      byBlockAt.get(key).push(obs);
    }
  }
  return { byBlock, byBlockAt };
}

function enumerateAbsValues(abs, cap = 64) {
  if (!abs || typeof abs !== 'object') return null;
  if (abs.kind === 'const') return [abs.v & 0xff];
  if (abs.kind === 'set' && Array.isArray(abs.values)) {
    if (!abs.values.length || abs.values.length > cap) return null;
    return uniqNums(abs.values.map((v) => v & 0xff));
  }
  if (abs.kind === 'range' && Number.isFinite(abs.lo) && Number.isFinite(abs.hi)) {
    const lo = abs.lo & 0xff;
    const hi = abs.hi & 0xff;
    if (hi < lo) return null;
    const size = hi - lo + 1;
    if (size > cap) return null;
    const out = [];
    for (let v = lo; v <= hi; v++) out.push(v & 0xff);
    return out;
  }
  return null;
}

function getAtObservations(obsIndex, rawBlockId, line) {
  const at = typeof line?.romOff === 'number' ? (line.romOff >>> 0) : null;
  if (!rawBlockId || at == null) return [];
  return obsIndex.byBlockAt.get(`${rawBlockId}|${at}`) || [];
}

function getReadValueCandidatesAt(obsIndex, rawBlockId, line, dstReg, sourceSpaces) {
  const srcSet = new Set(sourceSpaces || []);
  for (const obs of getAtObservations(obsIndex, rawBlockId, line)) {
    if (obs?.kind !== 'read8') continue;
    if (obs.dstReg !== dstReg) continue;
    if (!srcSet.has(obs?.src?.space)) continue;
    const vals = enumerateAbsValues(obs?.value?.abs, 64);
    if (vals && vals.length) return vals;
  }
  return null;
}

function findInitValueInfo(reg, loop, blockById, obsIndex) {
  const setter = reg === 'X' ? 'LDX' : 'LDY';
  const transfer = reg === 'X' ? 'TAX' : 'TAY';
  const scanBlockIds = [...(loop.entryPredIds || []), loop.rawHeaderBlockId].filter(Boolean);
  for (const rawBlockId of scanBlockIds) {
    const lines = Array.isArray(blockById.get(rawBlockId)?.lines) ? blockById.get(rawBlockId).lines : [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line?.mnemonic === setter) {
        if (line?.mode === 'imm' && Array.isArray(line.bytes) && line.bytes.length >= 2) {
          return { kind: 'immediate', values: [line.bytes[1] & 0xff], sourceLine: line };
        }
        const vals = getReadValueCandidatesAt(obsIndex, rawBlockId, line, reg, ['zp', 'ram', 'prgram']);
        if (vals && vals.length) return { kind: 'memory', values: vals, sourceLine: line };
      }
      if (line?.mnemonic === transfer) {
        const prev = i > 0 ? lines[i - 1] : null;
        if (prev?.mnemonic === 'LDA' && prev?.mode === 'imm' && Array.isArray(prev.bytes) && prev.bytes.length >= 2) {
          return { kind: 'immediateViaA', values: [prev.bytes[1] & 0xff], sourceLine: prev, transferLine: line };
        }
        const vals = prev ? getReadValueCandidatesAt(obsIndex, rawBlockId, prev, 'A', ['zp', 'ram', 'prgram']) : null;
        if (vals && vals.length) {
          return { kind: 'memoryViaA', values: vals, sourceLine: prev, transferLine: line };
        }
      }
    }
  }
  return null;
}

function branchMnemonicSet() {
  return new Set(['BCC', 'BCS', 'BEQ', 'BNE', 'BMI', 'BPL', 'BVC', 'BVS']);
}

function findLoopExitCompare(loop, blockById, succs, obsIndex) {
  const branchSet = branchMnemonicSet();
  const members = new Set(loop.rawBlockIds);
  let best = null;
  for (const rawBlockId of loop.rawBlockIds) {
    const block = blockById.get(rawBlockId);
    const lines = Array.isArray(block?.lines) ? block.lines : [];
    if (!lines.length) continue;
    const last = lines[lines.length - 1];
    if (!branchSet.has(last?.mnemonic)) continue;
    const outs = (succs.get(rawBlockId) || []).filter((to) => !members.has(to));
    const ins = (succs.get(rawBlockId) || []).filter((to) => members.has(to));
    if (!outs.length || !ins.length) continue;
    for (let i = lines.length - 2; i >= Math.max(0, lines.length - 5); i--) {
      const line = lines[i];
      if (line?.mnemonic !== 'CPX' && line?.mnemonic !== 'CPY') continue;
      const reg = line.mnemonic === 'CPX' ? 'X' : 'Y';
      let values = null;
      let kind = 'unknown';
      if (line.mode === 'imm' && Array.isArray(line.bytes) && line.bytes.length >= 2) {
        values = [line.bytes[1] & 0xff];
        kind = 'imm';
      } else {
        for (const obs of getAtObservations(obsIndex, rawBlockId, line)) {
          if (obs?.kind !== 'cmp8' || obs.reg !== reg) continue;
          if (obs?.rhs?.kind !== 'mem') continue;
          if (!['zp', 'ram', 'prgram'].includes(obs?.rhs?.src?.space)) continue;
          const vals = enumerateAbsValues(obs?.rhsValue?.abs, 64);
          if (vals && vals.length) {
            values = vals;
            kind = 'ram';
            break;
          }
        }
      }
      if (!values || !values.length) continue;
      const cand = { reg, values, kind, rawBlockId, compareLine: line, branchLine: last };
      if (!best || rawBlockId === loop.rawTailBlockId || kind === 'ram') best = cand;
    }
  }
  return best;
}

function buildBoundTerminationModel(loop, blockById, succs, lines, reg, step, obsIndex) {
  const initInfo = findInitValueInfo(reg, loop, blockById, obsIndex);
  const initValues = uniqNums(initInfo?.values || []);
  const exitCmp = findLoopExitCompare(loop, blockById, succs, obsIndex);
  if (exitCmp && exitCmp.reg === reg) {
    const endValues = uniqNums(exitCmp.values || []);
    if (endValues.length) {
      const starts = initValues.length ? initValues : (step > 0 ? [0] : []);
      const countPlans = [];
      for (const start of starts) {
        for (const end of endValues) {
          if (step > 0 && end > start) {
            const count = Math.ceil((end - start) / Math.abs(step));
            if (count > 0 && count <= 256) countPlans.push({ start, count });
          }
          if (step < 0 && start > end) {
            const count = Math.ceil((start - end) / Math.abs(step));
            if (count > 0 && count <= 256) countPlans.push({ start, count });
          }
        }
      }
      const plans = uniqObjectsByKey(countPlans, (plan) => `${plan.start}|${plan.count}`);
      if (plans.length) {
        return {
          kind: exitCmp.kind === 'ram' ? (initValues.length ? 'cmpRam' : 'cmpRamAssumeZero') : (initValues.length ? 'cmpImm' : 'cmpImmAssumeZero'),
          terminationKind: 'bound',
          reg,
          step,
          initValues,
          compareValues: endValues,
          compareLine: exitCmp.compareLine,
          branchLine: exitCmp.branchLine,
          plans,
          exact: plans.length === 1 && endValues.length === 1 && initValues.length <= 1
        };
      }
    }
  }

  if (step < 0 && initValues.length) {
    const dec = reg === 'X' ? 'DEX' : 'DEY';
    const hasDec = lines.some((line) => line?.mnemonic === dec);
    const tailBlock = blockById.get(loop.rawTailBlockId);
    const tailLines = Array.isArray(tailBlock?.lines) ? tailBlock.lines : [];
    const last = tailLines[tailLines.length - 1] || null;
    if (hasDec && last && (last.mnemonic === 'BNE' || last.mnemonic === 'BPL')) {
      const plans = uniqObjectsByKey(initValues
        .map((start) => ({ start, count: Math.ceil(start / Math.abs(step)) }))
        .filter((plan) => plan.count > 0 && plan.count <= 256), (plan) => `${plan.start}|${plan.count}`);
      if (plans.length) {
        return {
          kind: initInfo?.kind?.includes('memory') ? 'decrementRamLoop' : 'decrementLoop',
          terminationKind: 'bound',
          reg,
          step,
          initValues,
          compareValues: [0],
          compareLine: null,
          branchLine: last,
          plans,
          exact: plans.length === 1 && initValues.length === 1
        };
      }
    }
  }

  return null;
}

function trailingCompareImmediates(loop, blockById, succs) {
  const branchSet = branchMnemonicSet();
  const members = new Set(loop.rawBlockIds);
  const out = [];
  for (const rawBlockId of loop.rawBlockIds) {
    const block = blockById.get(rawBlockId);
    const lines = Array.isArray(block?.lines) ? block.lines : [];
    if (!lines.length) continue;
    const ins = (succs.get(rawBlockId) || []).filter((to) => members.has(to));
    const outs = (succs.get(rawBlockId) || []).filter((to) => !members.has(to));
    if (!ins.length || !outs.length) continue;
    const startIndex = Math.max(0, lines.length - 8);
    const trailing = lines.slice(startIndex);
    for (let i = 0; i < trailing.length; i++) {
      const line = trailing[i];
      if (line?.mnemonic !== 'CMP' || line?.mode !== 'imm' || !Array.isArray(line.bytes) || line.bytes.length < 2) continue;
      const hasNearbyBranch = trailing.slice(i + 1, Math.min(trailing.length, i + 3)).some((next) => branchSet.has(next?.mnemonic));
      if (!hasNearbyBranch) continue;
      out.push({
        rawBlockId,
        compareLine: line,
        value: line.bytes[1] & 0xff
      });
    }
  }
  return out;
}

function extractSentinelModels(loop, family, blockById, succs) {
  if (family.dstReg !== 'A') return [];
  const compares = trailingCompareImmediates(loop, blockById, succs);
  if (!compares.length) return [];
  const models = [];
  const first = compares[0];
  models.push({
    kind: 'sentinel1',
    bytes: [first.value],
    entryWidth: 1,
    rawBlockId: first.rawBlockId,
    compareLines: [first.compareLine]
  });
  if (compares.length >= 2) {
    const second = compares[1];
    models.push({
      kind: 'sentinel2',
      bytes: [first.value, second.value],
      entryWidth: 2,
      rawBlockId: second.rawBlockId,
      compareLines: [first.compareLine, second.compareLine]
    });
  }
  return uniqObjectsByKey(models, (model) => `${model.kind}|${model.bytes.join(',')}`);
}

function chooseEntryWidth(family, step, sentinelModel = null) {
  if (sentinelModel?.entryWidth) return sentinelModel.entryWidth;
  const stride = Math.abs(step || 1);
  if (stride > 1 && stride <= 4) return 1;
  return 1;
}

function expandEntryOffsets(base, start, count, step, entryWidth, prgBytesLength) {
  const members = new Set();
  if (!Number.isFinite(base) || !Number.isFinite(start) || !Number.isFinite(count) || !Number.isFinite(step)) return [];
  for (let i = 0; i < count; i++) {
    const entryStart = base + start + (i * step);
    if (!Number.isFinite(entryStart)) break;
    for (let j = 0; j < entryWidth; j++) {
      const off = entryStart + j;
      if (off < 0 || off >= prgBytesLength) break;
      members.add(off >>> 0);
    }
  }
  return uniqNums(Array.from(members));
}

function computeCoverageScore(offsets, observedOffsets) {
  const members = new Set(offsets || []);
  let hits = 0;
  for (const off of observedOffsets || []) {
    if (members.has(off >>> 0)) hits += 1;
  }
  return hits;
}

function inferCandidateBases(observedOffsets, planStarts, step, prgBytesLength, iterCap = 64) {
  const observed = uniqNums(observedOffsets || []);
  const starts = uniqNums(planStarts || []);
  if (!observed.length || !starts.length) return [];
  const candidates = new Map();
  for (const off of observed) {
    for (const start of starts) {
      for (let iter = 0; iter < iterCap; iter++) {
        const base = off - (start + (iter * step));
        if (!Number.isFinite(base) || base < 0 || base >= prgBytesLength) continue;
        const normBase = base >>> 0;
        const score = (candidates.get(normBase) || 0) + 1;
        candidates.set(normBase, score);
      }
    }
  }
  return Array.from(candidates.entries())
    .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
    .map(([base]) => base >>> 0)
    .slice(0, 8);
}

function buildCountMaterializationCandidates(family, boundModel, step, prgBytesLength) {
  if (!boundModel?.plans?.length) return [];
  const starts = uniqNums(boundModel.plans.map((plan) => plan.start));
  const bases = inferCandidateBases(family.observedRomOffsets, starts, step, prgBytesLength, Math.min(64, Math.max(...boundModel.plans.map((plan) => plan.count), 1)));
  if (!bases.length) return [];
  const entryWidth = chooseEntryWidth(family, step, null);
  const candidates = [];
  for (const base of bases) {
    for (const plan of boundModel.plans) {
      const offsets = expandEntryOffsets(base, plan.start, plan.count, step, entryWidth, prgBytesLength);
      if (!offsets.length) continue;
      candidates.push({ base, start: plan.start, count: plan.count, entryWidth, offsets, coverage: computeCoverageScore(offsets, family.observedRomOffsets) });
    }
  }
  return candidates.sort((a, b) => (b.coverage - a.coverage) || (a.base - b.base) || (a.start - b.start));
}

function scanSentinelCount({ base, start, step, entryWidth, sentinelBytes, prgBytes, maxEntries }) {
  if (!Array.isArray(sentinelBytes) || !sentinelBytes.length) return null;
  for (let iter = 0; iter < maxEntries; iter++) {
    const entryStart = base + start + (iter * step);
    if (!Number.isFinite(entryStart) || entryStart < 0 || (entryStart + Math.max(entryWidth, sentinelBytes.length) - 1) >= prgBytes.length) break;
    let matched = true;
    for (let i = 0; i < sentinelBytes.length; i++) {
      if ((prgBytes[entryStart + i] & 0xff) !== (sentinelBytes[i] & 0xff)) {
        matched = false;
        break;
      }
    }
    if (matched) return iter + 1;
  }
  return null;
}

function buildSentinelMaterializationCandidates(family, sentinelModel, startCandidates, step, prgBytes) {
  const starts = uniqNums(startCandidates || []);
  if (!starts.length) return [];
  const bases = inferCandidateBases(family.observedRomOffsets, starts, step, prgBytes.length, 64);
  if (!bases.length) return [];
  const entryWidth = chooseEntryWidth(family, step, sentinelModel);
  const candidates = [];
  for (const base of bases) {
    for (const start of starts) {
      const count = scanSentinelCount({
        base,
        start,
        step,
        entryWidth,
        sentinelBytes: sentinelModel.bytes,
        prgBytes,
        maxEntries: 128
      });
      if (!count) continue;
      const offsets = expandEntryOffsets(base, start, count, step, entryWidth, prgBytes.length);
      if (!offsets.length) continue;
      candidates.push({ base, start, count, entryWidth, offsets, coverage: computeCoverageScore(offsets, family.observedRomOffsets) });
    }
  }
  return candidates.sort((a, b) => (b.coverage - a.coverage) || (a.count - b.count) || (a.base - b.base));
}

function finalizeOffsetsFromCandidates(candidates) {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => (b.coverage - a.coverage) || (a.base - b.base) || (a.start - b.start));
  const limited = sorted.slice(0, 4);
  const offsetSets = limited.map((candidate) => candidate.offsets);
  const union = unionAllOffsetSets(offsetSets);
  const definite = limited.length === 1 ? union : intersectAllOffsetSets(offsetSets);
  const possible = union.filter((off) => !definite.includes(off));
  const bases = uniqNums(limited.map((candidate) => candidate.base));
  const starts = uniqNums(limited.map((candidate) => candidate.start));
  const counts = uniqNums(limited.map((candidate) => candidate.count));
  return {
    candidates: limited,
    basisKind: bases.length === 1 ? 'exact' : 'set',
    basisOffsets: bases,
    startCandidates: starts,
    countCandidates: counts,
    entryWidth: limited[0].entryWidth || 1,
    memberRomOffsets: definite,
    possibleRomOffsets: possible,
    boundingRange: rangeFromOffsets(union),
    patternKind: footprintPattern(union),
    coverageHits: limited[0].coverage || 0
  };
}

function evidenceQualityForMaterialization({ terminationKind, basisKind, exactPlan, hasSentinelMatch }) {
  if (terminationKind === 'sentinel2' && hasSentinelMatch && basisKind === 'exact' && exactPlan) return 'exact';
  if ((terminationKind === 'sentinel1' || terminationKind === 'sentinel2') && hasSentinelMatch && basisKind === 'exact') return 'bounded';
  if (basisKind === 'exact' && exactPlan) return 'bounded';
  if (hasSentinelMatch) return 'partial';
  return 'partial';
}

function makeFootprintFromMaterialization({ id, family, loop, step, terminationModel, materialized }) {
  const exactPlan = materialized.startCandidates.length === 1 && materialized.countCandidates.length === 1;
  const hasSentinel = terminationModel.terminationKind === 'sentinel1' || terminationModel.terminationKind === 'sentinel2';
  return {
    id,
    kind: hasSentinel ? 'sentinelTerminatedLoopTable' : 'synthesizedLoopTable',
    space: 'rom',
    basis: { kind: materialized.basisKind, romOffsets: materialized.basisOffsets },
    memberRomOffsets: materialized.memberRomOffsets,
    possibleRomOffsets: materialized.possibleRomOffsets,
    boundingRange: materialized.boundingRange,
    patternKind: materialized.patternKind,
    evidenceQuality: evidenceQualityForMaterialization({
      terminationKind: terminationModel.terminationKind,
      basisKind: materialized.basisKind,
      exactPlan,
      hasSentinelMatch: hasSentinel
    }),
    touchingRawBlockIds: uniqStrings([...family.touchingRawBlockIds, loop.rawHeaderBlockId, loop.rawTailBlockId]),
    touchingFunctionIds: uniqStrings(family.touchingFunctionIds),
    entryFamilies: uniqStrings(family.entryFamilies),
    observationIds: uniqStrings(family.observationIds),
    traceIds: [],
    addressFamily: family.family,
    terminationKind: terminationModel.terminationKind,
    terminationEvidence: {
      modelKind: terminationModel.kind,
      compareValues: Array.isArray(terminationModel.compareValues) ? [...terminationModel.compareValues] : [],
      sentinelBytes: Array.isArray(terminationModel.bytes) ? [...terminationModel.bytes] : [],
      compareLineRomOffs: (terminationModel.compareLines || []).map((line) => (typeof line?.romOff === 'number' ? (line.romOff >>> 0) : null)).filter((v) => v != null)
    },
    sentinelValue: Array.isArray(terminationModel.bytes) && terminationModel.bytes.length === 1 ? terminationModel.bytes[0] : null,
    sentinelBytes: Array.isArray(terminationModel.bytes) ? [...terminationModel.bytes] : null,
    lengthBound: materialized.countCandidates.length === 1 ? materialized.countCandidates[0] : null,
    loopInfo: {
      loopId: loop.id,
      rawHeaderBlockId: loop.rawHeaderBlockId || null,
      rawTailBlockId: loop.rawTailBlockId || null,
      depth: loop.depth,
      indexReg: family.indexReg,
      step,
      startCandidates: materialized.startCandidates,
      countCandidates: materialized.countCandidates,
      entryWidth: materialized.entryWidth,
      boundKind: terminationModel.kind,
      parentId: loop.parentId || null
    }
  };
}

function scoreFootprint(fp) {
  let score = 0;
  if (fp.evidenceQuality === 'exact') score += 80;
  else if (fp.evidenceQuality === 'bounded') score += 60;
  else if (fp.evidenceQuality === 'partial') score += 40;
  else score += 20;
  if (fp.terminationKind === 'sentinel2') score += 30;
  else if (fp.terminationKind === 'sentinel1') score += 20;
  else if (fp.terminationKind === 'bound') score += 10;
  score += (fp.memberRomOffsets?.length || 0);
  score += Math.min(16, fp.observationIds?.length || 0);
  return score;
}

function synthesizeFamilyFootprints(loop, family, loopsInfo, observations, prgBytes) {
  const { blockById, indexById, succs } = loopsInfo;
  const obsIndex = buildObservationIndex(observations);
  const lines = loopLines(loop, blockById, indexById);
  const reg = family.indexReg;
  const step = inferLoopRegStep(lines, reg);
  if (!step) return [];

  const out = [];
  const boundModel = buildBoundTerminationModel(loop, blockById, succs, lines, reg, step, obsIndex);
  if (boundModel) {
    const countCandidates = buildCountMaterializationCandidates(family, boundModel, step, prgBytes.length);
    const materialized = finalizeOffsetsFromCandidates(countCandidates);
    if (materialized && (materialized.memberRomOffsets.length || materialized.possibleRomOffsets.length)) {
      out.push(makeFootprintFromMaterialization({
        id: `stream:synth:${loop.id}:${family.family}:${out.length + 1}`,
        family,
        loop,
        step,
        terminationModel: boundModel,
        materialized
      }));
    }
  }

  const initInfo = findInitValueInfo(reg, loop, blockById, obsIndex);
  const startCandidates = uniqNums(initInfo?.values?.length ? initInfo.values : [0]);
  const sentinelModels = extractSentinelModels(loop, family, blockById, succs);
  for (const sentinelModel of sentinelModels) {
    const sentinelCandidates = buildSentinelMaterializationCandidates(family, sentinelModel, startCandidates, step, prgBytes);
    const materialized = finalizeOffsetsFromCandidates(sentinelCandidates);
    if (!materialized || (!materialized.memberRomOffsets.length && !materialized.possibleRomOffsets.length)) continue;
    out.push(makeFootprintFromMaterialization({
      id: `stream:synth:${loop.id}:${family.family}:${out.length + 1}`,
      family,
      loop,
      step,
      terminationModel: { ...sentinelModel, terminationKind: sentinelModel.kind, kind: sentinelModel.kind },
      materialized
    }));
  }

  return out.sort((a, b) => scoreFootprint(b) - scoreFootprint(a));
}

function dedupeFootprints(footprints) {
  const byKey = new Map();
  for (const fp of footprints || []) {
    const key = [
      fp.kind,
      fp.space,
      (fp.memberRomOffsets || []).join(','),
      (fp.possibleRomOffsets || []).join(','),
      fp.boundingRange ? `${fp.boundingRange.start}-${fp.boundingRange.end}` : 'norange',
      fp.terminationKind || 'noterm',
      Array.isArray(fp.sentinelBytes) ? fp.sentinelBytes.join(',') : 'nosent',
      fp.loopInfo?.step != null ? fp.loopInfo.step : 'nostep',
      fp.loopInfo?.entryWidth != null ? fp.loopInfo.entryWidth : 'nowidth'
    ].join('|');
    const existing = byKey.get(key);
    if (!existing || scoreFootprint(fp) > scoreFootprint(existing)) byKey.set(key, fp);
  }
  return Array.from(byKey.values()).sort((a, b) => scoreFootprint(b) - scoreFootprint(a));
}

export function buildStreamFootprints({ observationsResult, vsaDataflow = null, prgBytes = new Uint8Array(0), blocks = [], edges = [] }) {
  const observations = Array.isArray(observationsResult?.observations) ? observationsResult.observations : [];
  const romReads = collectRomReadLikeObservations(observations);
  const loopsInfo = discoverLoops(blocks || [], edges || []);

  const synthesized = [];
  for (const loop of loopsInfo.loops) {
    const families = collectLoopReadFamilies(loop, romReads);
    for (const family of families) {
      synthesized.push(...synthesizeFamilyFootprints(loop, family, loopsInfo, observations, prgBytes || new Uint8Array(0)));
    }
  }

  const footprints = dedupeFootprints(synthesized);
  return {
    version: 4,
    footprints,
    stats: {
      footprintCount: footprints.length,
      loopCount: loopsInfo.loops.length,
      synthesizedCount: footprints.length,
      sentinelCount: footprints.filter((fp) => fp.terminationKind === 'sentinel1' || fp.terminationKind === 'sentinel2').length,
      boundCount: footprints.filter((fp) => fp.terminationKind === 'bound').length,
      exactBasisCount: footprints.filter((fp) => fp.basis?.kind === 'exact').length,
      setBasisCount: footprints.filter((fp) => fp.basis?.kind === 'set').length
    }
  };
}
