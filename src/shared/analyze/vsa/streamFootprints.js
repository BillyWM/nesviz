function normalizePhysicalRom(physicalRom) {
  if (!physicalRom || typeof physicalRom !== 'object') return { kind: 'unknown', romOffsets: [] };
  const vals = Array.isArray(physicalRom.romOffsets)
    ? Array.from(new Set(physicalRom.romOffsets
        .map((off) => (typeof off === 'number' ? off : Number(off)))
        .filter((off) => Number.isFinite(off) && off >= 0)
        .map((off) => off >>> 0))).sort((a, b) => a - b)
    : [];
  if (!vals.length) return { kind: 'unknown', romOffsets: [] };
  return { kind: vals.length === 1 ? 'exact' : (physicalRom.kind === 'set' ? 'set' : 'exact'), romOffsets: vals };
}

function uniqNums(values) {
  return Array.from(new Set((values || []).map((v) => (typeof v === 'number' ? v : Number(v))).filter((v) => Number.isFinite(v)).map((v) => v >>> 0))).sort((a, b) => a - b);
}

function uniqStrings(values) {
  return Array.from(new Set((values || []).filter((v) => typeof v === 'string' && v))).sort();
}

function rangeFromOffsets(offsets) {
  const vals = uniqNums(offsets);
  if (!vals.length) return null;
  return { start: vals[0], end: vals[vals.length - 1] };
}

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
  if (typeof obs?.blockId === 'string' && obs.blockId) return `block:${obs.blockId}`;
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
        blockId: obs.blockId || null,
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
        blockId: obs.blockId || null,
        functionIds: Array.isArray(obs.functionIds) ? [...obs.functionIds] : [],
        entryFamilies: Array.isArray(obs.entryFamilies) ? [...obs.entryFamilies] : []
      });
    }
  }
  return out;
}

function buildGroupedFootprints(romReads) {
  const byKey = new Map();
  for (const item of romReads) {
    const key = [item.scopeKey, item.indexSource || 'none', item.ptrZp != null ? `ptr:${item.ptrZp}` : 'noptr', item.baseCpuAddr != null ? `base:${item.baseCpuAddr}` : 'nobase'].join('|');
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        scopeKey: item.scopeKey,
        indexSource: item.indexSource,
        ptrZp: item.ptrZp,
        baseCpuAddr: item.baseCpuAddr,
        observationIds: new Set(),
        memberRomOffsets: new Set(),
        touchingBlockIds: new Set(),
        touchingFunctionIds: new Set(),
        entryFamilies: new Set(),
        exactCount: 0,
        possibleCount: 0
      };
      byKey.set(key, acc);
    }
    acc.observationIds.add(String(item.observation.id));
    for (const off of item.physicalRom.romOffsets || []) acc.memberRomOffsets.add(off >>> 0);
    if (item.blockId) acc.touchingBlockIds.add(item.blockId);
    for (const id of item.functionIds || []) acc.touchingFunctionIds.add(id);
    for (const fam of item.entryFamilies || []) acc.entryFamilies.add(fam);
    if (item.physicalRom.kind === 'exact') acc.exactCount++; else acc.possibleCount++;
  }

  const out = [];
  let seq = 0;
  for (const acc of byKey.values()) {
    const memberRomOffsets = uniqNums(Array.from(acc.memberRomOffsets));
    if (!memberRomOffsets.length) continue;
    const hasIndexing = !!acc.indexSource || acc.ptrZp != null;
    if (!hasIndexing && memberRomOffsets.length < 2) continue;
    seq++;
    out.push({
      id: `stream:grouped:${seq}`,
      kind: acc.ptrZp != null ? 'pointerIndexedStream' : 'indexedTable',
      space: 'rom',
      basis: { kind: acc.possibleCount ? 'set' : 'exact', romOffsets: memberRomOffsets },
      memberRomOffsets,
      boundingRange: rangeFromOffsets(memberRomOffsets),
      patternKind: footprintPattern(memberRomOffsets),
      evidenceQuality: acc.possibleCount ? 'bounded' : (memberRomOffsets.length > 1 ? 'exact' : 'partial'),
      touchingBlockIds: uniqStrings(Array.from(acc.touchingBlockIds)),
      touchingFunctionIds: uniqStrings(Array.from(acc.touchingFunctionIds)),
      entryFamilies: uniqStrings(Array.from(acc.entryFamilies)),
      observationIds: uniqStrings(Array.from(acc.observationIds)),
      traceIds: [],
      sentinelValue: null,
      lengthBound: null,
      loopInfo: null
    });
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

function naturalLoop(headerId, tailId, preds, blockById) {
  const loop = new Set([headerId, tailId]);
  const work = [tailId];
  const headerCtx = blockById.get(headerId)?.ctxKey || null;
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
    const blockIds = naturalLoop(edge.to, edge.from, preds, blockById).sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0));
    if (blockIds.length < 1 || blockIds.length > 24) continue;
    const key = `${edge.to}|${blockIds.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    loops.push({
      id: `loop:${loops.length + 1}`,
      headerId: edge.to,
      tailId: edge.from,
      ctxKey: toBlock.ctxKey || null,
      backEdge: { from: edge.from, to: edge.to },
      blockIds,
      depth: 1,
      parentId: null,
      exitEdges: [],
      entryPredIds: []
    });
  }
  for (const loop of loops) {
    const members = new Set(loop.blockIds);
    for (const edge of edges || []) {
      if (!edge?.from || !edge?.to) continue;
      if (!members.has(edge.from) || members.has(edge.to)) continue;
      loop.exitEdges.push({ from: edge.from, to: edge.to });
    }
    for (const edge of edges || []) {
      if (!edge?.from || !edge?.to) continue;
      if (edge.to !== loop.headerId || members.has(edge.from)) continue;
      loop.entryPredIds.push(edge.from);
    }
  }
  for (const loop of loops) {
    let bestParent = null;
    for (const other of loops) {
      if (other === loop) continue;
      if (other.ctxKey !== loop.ctxKey) continue;
      if (other.blockIds.length <= loop.blockIds.length) continue;
      if (!loop.blockIds.every((id) => other.blockIds.includes(id))) continue;
      if (!bestParent || other.blockIds.length < bestParent.blockIds.length) bestParent = other;
    }
    loop.parentId = bestParent ? bestParent.id : null;
    loop.depth = bestParent ? 2 : 1;
  }
  return { loops, blockById, indexById, preds, succs };
}

function observationLoopItems(loop, romReads) {
  const blockIds = new Set(loop.blockIds);
  return romReads.filter((item) => item.blockId && blockIds.has(item.blockId));
}

function loopObservations(loop, observations) {
  const blockIds = new Set(loop.blockIds);
  return (observations || []).filter((obs) => obs?.blockId && blockIds.has(obs.blockId));
}

function loopLines(loop, blockById, indexById) {
  const lines = [];
  const sortedBlockIds = [...loop.blockIds].sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0));
  for (const blockId of sortedBlockIds) {
    const block = blockById.get(blockId);
    const blockLines = Array.isArray(block?.lines) ? block.lines : [];
    for (let i = 0; i < blockLines.length; i++) {
      const line = blockLines[i];
      lines.push({ ...line, blockId, lineIndexInBlock: i, blockLineCount: blockLines.length });
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

function collectLoopReadGroups(loop, romReads) {
  const loopItems = observationLoopItems(loop, romReads).filter((item) => item.kind === 'read8');
  const byKey = new Map();
  for (const item of loopItems) {
    const family = inferReadFamily(item);
    const key = [family, item.indexSource || 'none', item.ptrZp != null ? `ptr:${item.ptrZp}` : 'noptr', item.baseCpuAddr != null ? `base:${item.baseCpuAddr}` : 'nobase', item.dstReg || 'nodst'].join('|');
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        family,
        indexReg: item.indexSource || null,
        ptrZp: item.ptrZp,
        baseCpuAddr: item.baseCpuAddr,
        dstReg: item.dstReg || null,
        memberRomOffsets: new Set(),
        basisKind: 'exact',
        touchingBlockIds: new Set(),
        touchingFunctionIds: new Set(),
        entryFamilies: new Set(),
        observationIds: new Set(),
        items: []
      };
      byKey.set(key, acc);
    }
    acc.items.push(item);
    for (const off of item.physicalRom.romOffsets || []) acc.memberRomOffsets.add(off >>> 0);
    if (item.physicalRom.kind !== 'exact') acc.basisKind = 'set';
    if (item.blockId) acc.touchingBlockIds.add(item.blockId);
    for (const id of item.functionIds || []) acc.touchingFunctionIds.add(id);
    for (const fam of item.entryFamilies || []) acc.entryFamilies.add(fam);
    acc.observationIds.add(String(item.observation.id));
  }
  return Array.from(byKey.values()).map((group) => ({
    ...group,
    memberRomOffsets: uniqNums(Array.from(group.memberRomOffsets)),
    touchingBlockIds: uniqStrings(Array.from(group.touchingBlockIds)),
    touchingFunctionIds: uniqStrings(Array.from(group.touchingFunctionIds)),
    entryFamilies: uniqStrings(Array.from(group.entryFamilies)),
    observationIds: uniqStrings(Array.from(group.observationIds))
  })).filter((group) => group.memberRomOffsets.length > 0 && group.indexReg && group.family !== 'other');
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
    if (typeof obs?.blockId !== 'string' || !obs.blockId) continue;
    if (!byBlock.has(obs.blockId)) byBlock.set(obs.blockId, []);
    byBlock.get(obs.blockId).push(obs);
    const at = typeof obs.atRomOff === 'number' ? (obs.atRomOff >>> 0) : null;
    if (at != null) {
      const key = `${obs.blockId}|${at}`;
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

function getAtObservations(obsIndex, blockId, line) {
  const at = typeof line?.romOff === 'number' ? (line.romOff >>> 0) : null;
  if (!blockId || at == null) return [];
  return obsIndex.byBlockAt.get(`${blockId}|${at}`) || [];
}

function getReadValueCandidatesAt(obsIndex, blockId, line, dstReg, sourceSpaces) {
  const srcSet = new Set(sourceSpaces || []);
  for (const obs of getAtObservations(obsIndex, blockId, line)) {
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
  const scanBlockIds = [...(loop.entryPredIds || []), loop.headerId].filter(Boolean);
  for (const blockId of scanBlockIds) {
    const lines = Array.isArray(blockById.get(blockId)?.lines) ? blockById.get(blockId).lines : [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line?.mnemonic === setter) {
        if (line?.mode === 'imm' && Array.isArray(line.bytes) && line.bytes.length >= 2) {
          return { kind: 'immediate', values: [line.bytes[1] & 0xff], sourceLine: line };
        }
        const vals = getReadValueCandidatesAt(obsIndex, blockId, line, reg, ['zp', 'ram', 'prgram']);
        if (vals && vals.length) return { kind: 'memory', values: vals, sourceLine: line };
      }
      if (line?.mnemonic === transfer) {
        const prev = i > 0 ? lines[i - 1] : null;
        if (prev?.mnemonic === 'LDA' && prev?.mode === 'imm' && Array.isArray(prev.bytes) && prev.bytes.length >= 2) {
          return { kind: 'immediateViaA', values: [prev.bytes[1] & 0xff], sourceLine: prev, transferLine: line };
        }
        const vals = prev ? getReadValueCandidatesAt(obsIndex, blockId, prev, 'A', ['zp', 'ram', 'prgram']) : null;
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
  const members = new Set(loop.blockIds);
  let best = null;
  for (const blockId of loop.blockIds) {
    const block = blockById.get(blockId);
    const lines = Array.isArray(block?.lines) ? block.lines : [];
    if (!lines.length) continue;
    const last = lines[lines.length - 1];
    if (!branchSet.has(last?.mnemonic)) continue;
    const outs = (succs.get(blockId) || []).filter((to) => !members.has(to));
    const ins = (succs.get(blockId) || []).filter((to) => members.has(to));
    if (!outs.length || !ins.length) continue;
    for (let i = lines.length - 2; i >= Math.max(0, lines.length - 4); i--) {
      const line = lines[i];
      if ((line?.mnemonic === 'CPX' || line?.mnemonic === 'CPY')) {
        const reg = line.mnemonic === 'CPX' ? 'X' : 'Y';
        let values = null;
        let kind = 'unknown';
        if (line.mode === 'imm' && Array.isArray(line.bytes) && line.bytes.length >= 2) {
          values = [line.bytes[1] & 0xff];
          kind = 'imm';
        } else {
          for (const obs of getAtObservations(obsIndex, blockId, line)) {
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
        if (values && values.length) {
          const cand = { reg, values, kind, blockId, compareLine: line, branchLine: last };
          if (!best || blockId === loop.tailId || kind === 'ram') best = cand;
        }
      }
    }
  }
  return best;
}

function inferLoopBound(loop, blockById, succs, lines, reg, step, obsIndex) {
  const initInfo = findInitValueInfo(reg, loop, blockById, obsIndex);
  const initValues = uniqNums(initInfo?.values || []);
  const exitCmp = findLoopExitCompare(loop, blockById, succs, obsIndex);
  if (exitCmp && exitCmp.reg === reg) {
    const endValues = uniqNums(exitCmp.values || []);
    if (endValues.length) {
      if (step > 0) {
        const start = initValues.length ? initValues[0] : 0;
        const end = endValues[endValues.length - 1];
        if (end > start) {
          const count = Math.ceil((end - start) / Math.abs(step));
          if (count > 0 && count <= 256) {
            return { kind: exitCmp.kind === 'ram' ? (initValues.length ? 'cmpRam' : 'cmpRamAssumeZero') : (initValues.length ? 'cmpImm' : 'cmpImmAssumeZero'), start, count, compareValues: endValues, compareLine: exitCmp.compareLine, branchLine: exitCmp.branchLine, initValues, exact: initValues.length <= 1 && endValues.length <= 1 };
          }
        }
      }
      if (step < 0 && initValues.length) {
        const start = initValues[initValues.length - 1];
        const end = endValues[0];
        if (start > end) {
          const count = Math.ceil((start - end) / Math.abs(step));
          if (count > 0 && count <= 256) {
            return { kind: exitCmp.kind === 'ram' ? 'cmpRam' : 'cmpImm', start, count, compareValues: endValues, compareLine: exitCmp.compareLine, branchLine: exitCmp.branchLine, initValues, exact: initValues.length <= 1 && endValues.length <= 1 };
          }
        }
      }
    }
  }
  if (step < 0 && initValues.length) {
    const dec = reg === 'X' ? 'DEX' : 'DEY';
    const hasDec = lines.some((line) => line?.mnemonic === dec);
    const tailBlock = blockById.get(loop.tailId);
    const tailLines = Array.isArray(tailBlock?.lines) ? tailBlock.lines : [];
    const last = tailLines[tailLines.length - 1] || null;
    if (hasDec && last && (last.mnemonic === 'BNE' || last.mnemonic === 'BPL')) {
      const start = initValues[initValues.length - 1];
      const count = Math.ceil(start / Math.abs(step));
      if (count > 0 && count <= 256) {
        return { kind: initInfo?.kind?.includes('memory') ? 'decrementRamLoop' : 'decrementLoop', start, count, compareValues: [0], compareLine: null, branchLine: last, initValues, exact: initValues.length <= 1 };
      }
    }
  }
  return null;
}

function expandPattern(baseOffsets, start, count, step, prgBytesLength) {
  const members = new Set();
  for (const base of baseOffsets || []) {
    for (let i = 0; i < count; i++) {
      const off = (base + start + (i * step)) >>> 0;
      if (off >= prgBytesLength) break;
      members.add(off);
    }
  }
  return uniqNums(Array.from(members));
}

function scoreCandidateBase(base, observedOffsets, start, count, step, prgBytesLength) {
  if (!Number.isFinite(base)) return -1;
  const members = new Set(expandPattern([base >>> 0], start, count, step, prgBytesLength));
  if (!members.size) return -1;
  let score = 0;
  for (const off of observedOffsets || []) {
    if (members.has(off >>> 0)) score += 1;
  }
  return score;
}

function inferCandidateBaseOffsets(group, bound, step, prgBytesLength) {
  const observed = uniqNums(group.memberRomOffsets || []);
  if (!observed.length) return [];
  const start = Number.isFinite(bound?.start) ? (bound.start >>> 0) : 0;
  const count = Number.isFinite(bound?.count) ? Math.max(1, bound.count >>> 0) : 1;
  const stride = Number.isFinite(step) ? step : 1;
  const iterCap = Math.min(Math.max(count, 1), 64);
  const candidates = new Map();
  for (const off of observed) {
    for (let iter = 0; iter < iterCap; iter++) {
      const base = off - (start + (iter * stride));
      if (!Number.isFinite(base) || base < 0 || base >= prgBytesLength) continue;
      const normBase = base >>> 0;
      if (!candidates.has(normBase)) {
        const score = scoreCandidateBase(normBase, observed, start, count, stride, prgBytesLength);
        if (score > 0) candidates.set(normBase, score);
      }
    }
  }
  if (!candidates.size) {
    const fallback = observed[0] - start;
    if (Number.isFinite(fallback) && fallback >= 0 && fallback < prgBytesLength) {
      candidates.set(fallback >>> 0, 1);
    }
  }
  const sorted = Array.from(candidates.entries())
    .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
    .map(([base]) => base >>> 0);
  const limit = group.basisKind === 'exact' ? 1 : 4;
  return sorted.slice(0, limit);
}

function buildLoopRunFootprints(loopsInfo, observations, romReads, prgBytes) {
  const { loops, blockById, indexById, succs } = loopsInfo;
  const obsIndex = buildObservationIndex(observations);
  const out = [];
  let seq = 300000;
  for (const loop of loops) {
    const groups = collectLoopReadGroups(loop, romReads);
    if (!groups.length) continue;
    const lines = loopLines(loop, blockById, indexById);
    for (const group of groups) {
      const reg = group.indexReg;
      if (!(reg === 'X' || reg === 'Y')) continue;
      const step = inferLoopRegStep(lines, reg);
      if (!step) continue;
      const bound = inferLoopBound(loop, blockById, succs, lines, reg, step, obsIndex);
      if (!bound) continue;
      const basisOffsets = inferCandidateBaseOffsets(group, bound, step, prgBytes.length);
      if (!basisOffsets.length) continue;
      const expanded = expandPattern(basisOffsets, bound.start || 0, bound.count, step, prgBytes.length);
      if (!expanded.length) continue;
      seq++;
      const evidenceQuality = (group.basisKind === 'exact' && bound?.exact)
        ? (basisOffsets.length === 1 ? 'bounded' : 'partial')
        : 'partial';
      const patternKind = (Math.abs(step) === 1) ? 'contiguous' : (bound.count > 1 ? 'strided' : footprintPattern(expanded));
      out.push({
        id: `stream:loop:${seq}`,
        kind: group.family === 'ptrY' ? 'loopPointerIndexedStream' : 'loopIndexedTable',
        space: 'rom',
        basis: { kind: basisOffsets.length === 1 ? 'exact' : 'set', romOffsets: basisOffsets },
        memberRomOffsets: expanded,
        boundingRange: rangeFromOffsets(expanded),
        patternKind,
        evidenceQuality,
        touchingBlockIds: uniqStrings([...group.touchingBlockIds, loop.headerId, loop.tailId]),
        touchingFunctionIds: uniqStrings(group.touchingFunctionIds),
        entryFamilies: uniqStrings(group.entryFamilies),
        observationIds: uniqStrings(group.observationIds),
        traceIds: [],
        sentinelValue: null,
        lengthBound: bound.count,
        loopInfo: {
          loopId: loop.id,
          depth: loop.depth,
          indexReg: reg,
          startValue: bound.start,
          step,
          boundKind: bound.kind,
          compareImm: Array.isArray(bound.compareValues) && bound.compareValues.length === 1 ? bound.compareValues[0] : null,
          parentId: loop.parentId || null
        }
      });
    }
  }
  return out;
}

function findStructuralSentinel(loop, group, blockById, succs) {
  const members = new Set(loop.blockIds);
  for (const blockId of loop.blockIds) {
    const block = blockById.get(blockId);
    const lines = Array.isArray(block?.lines) ? block.lines : [];
    if (lines.length < 2) continue;
    const last = lines[lines.length - 1];
    const outs = (succs.get(blockId) || []).filter((to) => !members.has(to));
    const ins = (succs.get(blockId) || []).filter((to) => members.has(to));
    if (!outs.length || !ins.length) continue;
    const compare = lines[lines.length - 2];
    if (!(compare?.mnemonic === 'CMP' && compare?.mode === 'imm' && Array.isArray(compare.bytes) && compare.bytes.length >= 2)) continue;
    if (group.dstReg !== 'A') continue;
    return { value: compare.bytes[1] & 0xff, blockId, compareLine: compare, branchLine: last };
  }
  return null;
}

function buildLoopSentinelFootprints(loopsInfo, romReads, prgBytes) {
  const { loops, blockById, indexById, succs } = loopsInfo;
  const out = [];
  let seq = 400000;
  const maxScan = 128;
  for (const loop of loops) {
    const groups = collectLoopReadGroups(loop, romReads);
    if (!groups.length) continue;
    const lines = loopLines(loop, blockById, indexById);
    for (const group of groups) {
      const reg = group.indexReg;
      if (!(reg === 'X' || reg === 'Y')) continue;
      const step = inferLoopRegStep(lines, reg) || 1;
      const sentinel = findStructuralSentinel(loop, group, blockById, succs);
      if (!sentinel) continue;
      const scanned = new Set();
      let foundAny = false;
      const stride = Math.max(1, Math.abs(step));
      for (const off of group.memberRomOffsets) {
        if (off >= prgBytes.length) continue;
        for (let i = 0; i < maxScan && (off + (i * stride)) < prgBytes.length; i++) {
          const cur = (off + (i * stride)) >>> 0;
          scanned.add(cur);
          if ((prgBytes[cur] & 0xff) === sentinel.value) {
            foundAny = true;
            break;
          }
        }
      }
      if (!scanned.size) continue;
      const scannedOffsets = uniqNums(Array.from(scanned));
      seq++;
      out.push({
        id: `stream:sentinel:${seq}`,
        kind: 'sentinelBoundedStream',
        space: 'rom',
        basis: { kind: group.basisKind, romOffsets: group.memberRomOffsets },
        memberRomOffsets: group.basisKind === 'exact' && foundAny ? scannedOffsets : group.memberRomOffsets,
        boundingRange: rangeFromOffsets(scannedOffsets),
        patternKind: stride === 1 ? 'contiguous' : 'strided',
        evidenceQuality: foundAny ? (group.basisKind === 'exact' ? 'bounded' : 'partial') : 'weak',
        touchingBlockIds: uniqStrings([...group.touchingBlockIds, loop.headerId, loop.tailId, sentinel.blockId]),
        touchingFunctionIds: uniqStrings(group.touchingFunctionIds),
        entryFamilies: uniqStrings(group.entryFamilies),
        observationIds: uniqStrings(group.observationIds),
        traceIds: [],
        sentinelValue: sentinel.value,
        lengthBound: null,
        loopInfo: { loopId: loop.id, depth: loop.depth, indexReg: reg, step, parentId: loop.parentId || null }
      });
    }
  }
  return out;
}

function liftNestedLoopFootprints(loopsInfo, loopFootprints, prgBytesLength) {
  const { loops } = loopsInfo;
  const byLoopId = new Map();
  for (const fp of loopFootprints || []) {
    const loopId = fp?.loopInfo?.loopId;
    if (!loopId) continue;
    if (!byLoopId.has(loopId)) byLoopId.set(loopId, []);
    byLoopId.get(loopId).push(fp);
  }
  const out = [];
  let seq = 500000;
  for (const loop of loops) {
    if (!loop.parentId) continue;
    const children = byLoopId.get(loop.id) || [];
    if (!children.length) continue;
    const parent = loops.find((l) => l.id === loop.parentId);
    if (!parent) continue;
    const parentBlocks = new Set(parent.blockIds);
    const parentOnly = children.filter((fp) => (fp.touchingBlockIds || []).some((id) => parentBlocks.has(id)));
    const src = parentOnly.length ? parentOnly : children;
    for (const fp of src) {
      const members = uniqNums(fp.memberRomOffsets || []);
      if (members.length < 2) continue;
      seq++;
      out.push({
        id: `stream:nested:${seq}`,
        kind: 'nestedLoopStream',
        space: 'rom',
        basis: fp.basis,
        memberRomOffsets: members,
        boundingRange: rangeFromOffsets(members),
        patternKind: fp.patternKind === 'contiguous' ? 'repeatedRuns' : fp.patternKind,
        evidenceQuality: fp.evidenceQuality === 'exact' ? 'bounded' : fp.evidenceQuality,
        touchingBlockIds: uniqStrings(fp.touchingBlockIds),
        touchingFunctionIds: uniqStrings(fp.touchingFunctionIds),
        entryFamilies: uniqStrings(fp.entryFamilies),
        observationIds: uniqStrings(fp.observationIds),
        traceIds: [],
        sentinelValue: fp.sentinelValue ?? null,
        lengthBound: fp.lengthBound ?? null,
        loopInfo: { ...(fp.loopInfo || {}), parentId: parent.id, depth: 2 }
      });
    }
  }
  return out;
}

function dedupeFootprints(footprints) {
  const byKey = new Map();
  for (const fp of footprints || []) {
    const key = [
      fp.kind,
      fp.space,
      (fp.memberRomOffsets || []).join(','),
      fp.boundingRange ? `${fp.boundingRange.start}-${fp.boundingRange.end}` : 'norange',
      fp.sentinelValue != null ? fp.sentinelValue : 'nosent',
      fp.lengthBound != null ? fp.lengthBound : 'nolen',
      fp.loopInfo?.step != null ? fp.loopInfo.step : 'nostep'
    ].join('|');
    if (!byKey.has(key)) byKey.set(key, fp);
  }
  return Array.from(byKey.values());
}

export function buildStreamFootprints({ observationsResult, vsaDataflow = null, prgBytes = new Uint8Array(0), blocks = [], edges = [] }) {
  const observations = Array.isArray(observationsResult?.observations) ? observationsResult.observations : [];
  const romReads = collectRomReadLikeObservations(observations);
  const grouped = buildGroupedFootprints(romReads);
  const loopsInfo = discoverLoops(blocks || [], edges || []);
  const loopRuns = buildLoopRunFootprints(loopsInfo, observations, romReads, prgBytes || new Uint8Array(0));
  const loopSentinel = buildLoopSentinelFootprints(loopsInfo, romReads, prgBytes || new Uint8Array(0));
  const nested = liftNestedLoopFootprints(loopsInfo, loopRuns, prgBytes?.length || 0);
  const footprints = dedupeFootprints([...grouped, ...loopRuns, ...loopSentinel, ...nested]);
  return {
    version: 3,
    footprints,
    stats: {
      footprintCount: footprints.length,
      groupedCount: grouped.length,
      loopCount: loopsInfo.loops.length,
      loopRunCount: loopRuns.length,
      sentinelBoundedCount: loopSentinel.length,
      nestedLoopCount: nested.length
    }
  };
}
