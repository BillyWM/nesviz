import { disasmOneAtCtx } from '../../cpu6502/disasm.js';
import { evaluateProbableSemanticRepeats } from '../probable/semanticRepeats.js';
import { blockIdFromRomOff, blockInstanceId } from '../model.js';
import { decodePrgCdlByte, isPrgDataObserved } from '../cdl/nesCdl.js';
import { fetchCtxKey, siteKeyFor } from '../fetchContext.js';
import { evalInstructionIntoRegisterState, initialRegisterState, valueStateForStore } from './registerState.js';

function confRank(c) {
  return c === 'certain' ? 2 : c === 'probable' ? 1 : 0;
}

function bestOf(a, b) {
  return confRank(a) >= confRank(b) ? a : b;
}

function u16le(bytes, off = 1) {
  return ((bytes?.[off] || 0) | ((bytes?.[off + 1] || 0) << 8)) & 0xffff;
}

function isMemoryWriteMnemonic(mnemonic) {
  return ['STA', 'STX', 'STY', 'INC', 'DEC', 'ASL', 'LSR', 'ROL', 'ROR'].includes(mnemonic);
}

function getExactWriteCpuAddr(instr, regState) {
  if (!instr || !Array.isArray(instr.bytes)) return null;
  if (!isMemoryWriteMnemonic(instr.mnemonic)) return null;
  const mode = instr.mode || null;
  if (mode === 'abs') return u16le(instr.bytes, 1);
  if (mode === 'abs_x') {
    const base = u16le(instr.bytes, 1);
    const x = regState?.X;
    if (x?.kind === 'exact') return (base + (x.value & 0xff)) & 0xffff;
    return null;
  }
  if (mode === 'abs_y') {
    const base = u16le(instr.bytes, 1);
    const y = regState?.Y;
    if (y?.kind === 'exact') return (base + (y.value & 0xff)) & 0xffff;
    return null;
  }
  return null;
}

function isFixedMapper(mapper) {
  return mapper?.id === 'nrom';
}

function isCertainHardLeaderReason(reason) {
  const kind = reason?.kind || null;
  return kind === 'branch_target'
    || kind === 'jump_target'
    || kind === 'call_target'
    || kind === 'mapper_split'
    || kind === 'seed_entry';
}

export function discoverCfg({
  prgBytes,
  mapper,
  fetchCtx,
  seedItems = null,
  cdlPrg = null,
  probableConfig = null,
  entrypointsCpuAddrs = [],
  extraEntrypointsCpuAddrs = []
}) {
  const seeds = Array.isArray(seedItems)
    ? seedItems
    : [
        ...entrypointsCpuAddrs.map((cpuAddr) => ({ cpuAddr, confidence: 'certain', fetchCtx })),
        ...extraEntrypointsCpuAddrs.map((cpuAddr) => ({ cpuAddr, confidence: 'certain', fetchCtx }))
      ];

  const bestConfBySite = new Map();
  const instrBySite = new Map();
  const decodeFailuresBySite = new Map();
  const queuedHard = [];
  const queuedSoft = [];
  const hardLeaderSites = new Set();
  const softLeaderSites = new Set();
  const unresolvedIndirects = [];
  const probableProbeOffsetsSet = new Set();
  const startRecordsBySite = new Map();

  function startSiteKeyFor(pc, ctx) {
    return siteKeyFor(fetchCtxKey(ctx || fetchCtx), pc & 0xffff);
  }

  function getOrCreateStartRecord(pc, ctx) {
    const activeCtx = ctx || fetchCtx;
    const siteKey = startSiteKeyFor(pc, activeCtx);
    let rec = startRecordsBySite.get(siteKey);
    if (!rec) {
      rec = {
        siteKey,
        pc: pc & 0xffff,
        fetchCtx: activeCtx,
        conf: null,
        leaderKind: 'none',
        leaderReasons: [],
        wasScheduled: false,
        wasScheduledEver: false,
        wasAttempted: false,
        wasDecoded: false,
        decodeFailureReason: null,
        isCertainHardLeader: false,
        firstInstrSiteKey: null,
        retryOutcome: null
      };
      startRecordsBySite.set(siteKey, rec);
    } else {
      rec.pc = pc & 0xffff;
      rec.fetchCtx = activeCtx;
    }
    return rec;
  }

  function setLeaderKind(rec, leaderKind) {
    if (!rec) return;
    if (leaderKind === 'hard') {
      rec.leaderKind = 'hard';
      hardLeaderSites.add(rec.siteKey);
      softLeaderSites.delete(rec.siteKey);
    } else if (rec.leaderKind !== 'hard') {
      rec.leaderKind = 'soft';
      softLeaderSites.add(rec.siteKey);
    }
  }

  function addLeaderReason(rec, leaderReason) {
    if (!rec || !leaderReason || typeof leaderReason !== 'object') return;
    const next = { ...leaderReason };
    if (typeof next.fromPc === 'number') next.fromPc &= 0xffff;
    if (typeof next.targetPc === 'number') next.targetPc &= 0xffff;
    const sig = JSON.stringify(next);
    if (rec.leaderReasons.some((r) => JSON.stringify(r) === sig)) return;
    rec.leaderReasons.push(next);
    if (rec.leaderKind === 'hard' && rec.leaderReasons.some((r) => isCertainHardLeaderReason(r))) {
      rec.isCertainHardLeader = true;
    }
  }

  function markReachable(siteKey, conf) {
    const prev = bestConfBySite.get(siteKey);
    const next = prev ? bestOf(prev, conf) : conf;
    if (prev && prev === next) return false;
    bestConfBySite.set(siteKey, next);
    return true;
  }

  function isCdlDataOnlySite(pc, ctx) {
    if (!cdlPrg) return false;
    const resolved = mapper.resolveCodeFetch ? mapper.resolveCodeFetch(ctx || fetchCtx, pc & 0xffff) : null;
    const romOff = resolved?.backing?.kind === 'exact' ? resolved.backing.romOff : null;
    if (romOff == null || romOff < 0 || romOff >= cdlPrg.length) return false;
    const flags = decodePrgCdlByte(cdlPrg[romOff]);
    return isPrgDataObserved(flags) && !flags.exec;
  }

  function queueRecord(rec) {
    if (!rec || rec.wasScheduled) return;
    rec.wasScheduled = true;
    rec.wasScheduledEver = true;
    (rec.leaderKind === 'hard' ? queuedHard : queuedSoft).push(rec.siteKey);
  }

  function enqueueStart(pc, conf, ctx, leaderKind = 'hard', leaderReason = null) {
    const rec = getOrCreateStartRecord(pc, ctx);
    markReachable(rec.siteKey, conf);
    rec.conf = rec.conf ? bestOf(rec.conf, conf || 'certain') : (conf || 'certain');

    const prevLeaderKind = rec.leaderKind;
    const prevCertain = rec.isCertainHardLeader;
    setLeaderKind(rec, leaderKind);
    addLeaderReason(rec, leaderReason);

    if (instrBySite.has(rec.siteKey)) {
      rec.wasDecoded = true;
      rec.firstInstrSiteKey = rec.siteKey;
      return rec;
    }

    const upgradedToCertainHard = !prevCertain && rec.isCertainHardLeader;
    const upgradedToHard = prevLeaderKind !== 'hard' && rec.leaderKind === 'hard';

    if (rec.wasAttempted && !upgradedToCertainHard) {
      return rec;
    }

    if (upgradedToCertainHard) {
      rec.wasAttempted = false;
      rec.wasDecoded = false;
      rec.decodeFailureReason = null;
      decodeFailuresBySite.delete(rec.siteKey);
    }

    if (rec.wasScheduled) {
      if (upgradedToHard) {
        queuedHard.push(rec.siteKey);
      }
      return rec;
    }

    queueRecord(rec);
    return rec;
  }

  for (const s of seeds) {
    if (s && typeof s.cpuAddr === 'number') {
      const confidence = s.confidence || 'certain';
      const leaderKind = s.leaderKind || (confidence === 'probable' ? 'soft' : 'hard');
      const leaderReason = s.leaderReason || (confidence === 'probable'
        ? { kind: 'probable_seed' }
        : { kind: 'seed_entry' });
      enqueueStart(s.cpuAddr, confidence, s.fetchCtx || fetchCtx, leaderKind, leaderReason);
    }
  }

  function decodeFromStart(rec) {
    if (!rec) return { decoded: false, reason: 'missing_record' };
    const startPc = (rec.pc | 0) & 0xffff;
    const startCtx = rec.fetchCtx || fetchCtx;
    const startConf = rec.conf || 'certain';
    const startSiteKey = rec.siteKey;

    let decodedAny = false;
    let stopReason = null;
    let lastCtxKey = fetchCtxKey(startCtx);

    rec.wasAttempted = true;

    let pc = startPc;
    let conf = startConf;
    let curCtx = startCtx;
    let regState = initialRegisterState();

    while (true) {
      const curCtxKey = fetchCtxKey(curCtx);
      lastCtxKey = curCtxKey;
      const curSiteKey = siteKeyFor(curCtxKey, pc);

      if (isCdlDataOnlySite(pc, curCtx)) {
        stopReason = 'cdl_data';
        if (curSiteKey === startSiteKey && !decodeFailuresBySite.has(startSiteKey)) {
          const resolved = mapper.resolveCodeFetch ? mapper.resolveCodeFetch(curCtx, startPc) : null;
          const romOff = resolved?.backing?.kind === 'exact' ? resolved.backing.romOff : null;
          decodeFailuresBySite.set(startSiteKey, {
            siteKey: startSiteKey,
            pc: startPc,
            ctxKey: curCtxKey,
            reason: 'cdl_data',
            romOff,
            op: null,
            bytesText: null,
            text: 'CDL marks byte as data-only'
          });
        }
        break;
      }

      const cached = instrBySite.get(curSiteKey);
      const instr = cached || disasmOneAtCtx(prgBytes, mapper, curCtx, pc);
      if (!instr.ok) {
        stopReason = instr?.flow?.type || 'unknown';
        if (curSiteKey === startSiteKey && !decodeFailuresBySite.has(startSiteKey)) {
          decodeFailuresBySite.set(startSiteKey, {
            siteKey: startSiteKey,
            pc: startPc,
            ctxKey: curCtxKey,
            reason: instr?.flow?.type || 'unknown',
            romOff: instr.romOff,
            op: instr.op,
            bytesText: instr.bytesText,
            text: instr.text
          });
        }
        break;
      }

      decodedAny = true;
      if (!cached) {
        instrBySite.set(curSiteKey, instr);
      }
      markReachable(curSiteKey, conf);
      if (curSiteKey === startSiteKey) {
        rec.wasDecoded = true;
        rec.firstInstrSiteKey = startSiteKey;
      }

      const storeCpuAddr = getExactWriteCpuAddr(instr, regState);
      const nextPc = (pc + instr.len) & 0xffff;
      if (storeCpuAddr != null && mapper.isMapperWriteCpuAddr?.(storeCpuAddr)) {
        const valueState = valueStateForStore(instr, regState);
        const nextCtx = mapper.applyMapperWrite({ ctx: curCtx, cpuAddr: storeCpuAddr, valueState });
        const nextSiteKey = siteKeyFor(fetchCtxKey(nextCtx), nextPc);
        enqueueStart(nextPc, conf, nextCtx, 'hard', { kind: 'mapper_split', fromPc: pc, mnemonic: instr.mnemonic, targetPc: nextPc });
        const enriched = { ...instr, mapperWrite: { cpuAddr: storeCpuAddr, nextFetchCtx: nextCtx, nextSiteKey } };
        instrBySite.set(curSiteKey, enriched);
        stopReason = 'mapper_split';
        break;
      }

      const f = instr.flow;
      if (f.type === 'branch') {
        const takenTargets = mapper.targetSitesForCpuAddr
          ? mapper.targetSitesForCpuAddr(curCtx, f.target, { maxForks: 4 })
          : { sites: [{ cpuAddr: f.target & 0xffff, fetchCtx: curCtx }], ambiguous: false };
        for (const t of takenTargets.sites || []) {
          enqueueStart(t.cpuAddr, conf, t.fetchCtx, 'hard', { kind: 'branch_target', fromPc: pc, mnemonic: instr.mnemonic, targetPc: t.cpuAddr });
        }
        enqueueStart(f.fallthrough, conf, curCtx, 'hard', { kind: 'fallthrough_seed', fromPc: pc, mnemonic: instr.mnemonic, targetPc: f.fallthrough });
        stopReason = 'branch';
        break;
      }

      if (f.type === 'call') {
        const callTargets = mapper.targetSitesForCpuAddr
          ? mapper.targetSitesForCpuAddr(curCtx, f.target, { maxForks: 4 })
          : { sites: [{ cpuAddr: f.target & 0xffff, fetchCtx: curCtx }], ambiguous: false };
        for (const t of callTargets.sites || []) {
          enqueueStart(t.cpuAddr, conf, t.fetchCtx, 'hard', { kind: 'call_target', fromPc: pc, mnemonic: instr.mnemonic, targetPc: t.cpuAddr });
        }
        enqueueStart(f.fallthrough, conf, curCtx, 'hard', { kind: 'fallthrough_seed', fromPc: pc, mnemonic: instr.mnemonic, targetPc: f.fallthrough });
        stopReason = 'call';
        break;
      }

      if (f.type === 'jump') {
        const jumpTargets = mapper.targetSitesForCpuAddr
          ? mapper.targetSitesForCpuAddr(curCtx, f.target, { maxForks: 4 })
          : { sites: [{ cpuAddr: f.target & 0xffff, fetchCtx: curCtx }], ambiguous: false };
        for (const t of jumpTargets.sites || []) {
          enqueueStart(t.cpuAddr, conf, t.fetchCtx, 'hard', { kind: 'jump_target', fromPc: pc, mnemonic: instr.mnemonic, targetPc: t.cpuAddr });
        }
        stopReason = 'jump';
        break;
      }

      if (f.type === 'jmp_ind') {
        unresolvedIndirects.push({ pc, romOff: instr.romOff, ptrAddr: f.ptrAddr, ctxKey: curCtxKey, siteKey: curSiteKey, fetchCtx: curCtx });
        stopReason = 'jmp_ind';
        break;
      }

      if (f.type === 'stop' || f.type === 'illegal' || f.type === 'unmapped') {
        stopReason = f.type;
        break;
      }

      regState = evalInstructionIntoRegisterState(instr, regState);
      const nextSiteKey = siteKeyFor(curCtxKey, nextPc);
      if (hardLeaderSites.has(nextSiteKey)) {
        enqueueStart(nextPc, conf, curCtx, 'hard', { kind: 'fallthrough_seed', fromPc: pc, mnemonic: instr.mnemonic, targetPc: nextPc });
        stopReason = 'hard_leader_boundary';
        break;
      }
      pc = nextPc;
    }

    rec.retryOutcome = decodedAny ? 'decoded' : (stopReason || 'no_progress');
    if (!rec.wasDecoded) {
      rec.decodeFailureReason = decodeFailuresBySite.get(startSiteKey)?.reason || stopReason || null;
    }

    return { decoded: rec.wasDecoded, reason: stopReason, ctxKey: lastCtxKey };
  }

  while (queuedHard.length || queuedSoft.length) {
    const siteKey = queuedHard.length ? queuedHard.pop() : queuedSoft.pop();
    if (!siteKey) break;
    const rec = startRecordsBySite.get(siteKey);
    if (!rec || !rec.wasScheduled) continue;
    rec.wasScheduled = false;
    if (instrBySite.has(siteKey)) {
      rec.wasDecoded = true;
      rec.firstInstrSiteKey = siteKey;
      continue;
    }
    if (rec.wasAttempted) continue;
    decodeFromStart(rec);
  }

  const absorbedSoftLeaderSites = new Set();
  for (const instr of instrBySite.values()) {
    if (!instr || instr.mapperWrite) continue;
    if (instr.backing?.kind !== 'exact') continue;
    const f = instr.flow;
    if (!f || ['branch', 'call', 'jump', 'jmp_ind', 'stop', 'illegal', 'unmapped'].includes(f.type)) continue;
    const nextPc = ((instr.pc | 0) + (instr.len | 0)) & 0xffff;
    const nextSiteKey = siteKeyFor(instr.ctxKey, nextPc);
    if (!softLeaderSites.has(nextSiteKey) || hardLeaderSites.has(nextSiteKey)) continue;
    const nextInstr = instrBySite.get(nextSiteKey);
    if (nextInstr?.backing?.kind === 'exact') absorbedSoftLeaderSites.add(nextSiteKey);
  }

  const materializedStartRecords = Array.from(startRecordsBySite.values())
    .filter((rec) => typeof rec.pc === 'number')
    .filter((rec) => rec.wasDecoded && !!instrBySite.get(rec.siteKey))
    .filter((rec) => !(rec.leaderKind === 'soft' && absorbedSoftLeaderSites.has(rec.siteKey)))
    .sort((a, b) => {
      const ctxCmp = String(fetchCtxKey(a.fetchCtx)).localeCompare(String(fetchCtxKey(b.fetchCtx)));
      if (ctxCmp) return ctxCmp;
      return (a.pc | 0) - (b.pc | 0);
    });

  const blocksByStartSite = new Map();
  const blocksById = new Map();

  function shouldKeepProbableBlock(lines) {
    if (!probableConfig || !Array.isArray(lines) || !lines.length) return { keep: true, semantic: null };
    const decodedBytes = lines.reduce((sum, ln) => sum + ((ln?.len | 0) || 0), 0);
    const semantic = evaluateProbableSemanticRepeats({
      instructions: lines,
      decodedBytes,
      config: probableConfig
    });
    if (semantic.hardRejected) return { keep: false, semantic };
    const threshold = probableConfig.probableCfgSemanticPenaltyRejectThreshold;
    if (typeof threshold === 'number' && (semantic.repeatPatternPenalty || 0) <= threshold) {
      return { keep: false, semantic };
    }
    return { keep: true, semantic };
  }

  for (const rec of materializedStartRecords) {
    if (blocksByStartSite.has(rec.siteKey)) continue;
    const firstInstr = instrBySite.get(rec.siteKey);
    if (!firstInstr) continue;
    const startPc = rec.pc & 0xffff;
    const ctxKey = fetchCtxKey(rec.fetchCtx);
    const exactStart = firstInstr.backing?.kind === 'exact' ? firstInstr.backing.romOff : null;
    const blockId = (isFixedMapper(mapper) && exactStart != null) ? blockIdFromRomOff(exactStart) : blockInstanceId(ctxKey, startPc);
    const instId = blockInstanceId(ctxKey, startPc);

    const lines = [];
    let pc = startPc;
    let curCtx = rec.fetchCtx;
    while (true) {
      const curCtxKey = fetchCtxKey(curCtx);
      const curSiteKey = siteKeyFor(curCtxKey, pc);
      const instr = instrBySite.get(curSiteKey);
      if (!instr) break;
      lines.push({
        cpuAddr: pc,
        ctxKey: curCtxKey,
        siteKey: instr.siteKey,
        backing: instr.backing,
        romOff: instr.romOff,
        len: instr.len,
        bytesText: instr.bytesText,
        asm: instr.text,
        mnemonic: instr.mnemonic,
        mode: instr.mode,
        flow: instr.flow,
        bytes: instr.bytes,
        mapperWrite: instr.mapperWrite || null
      });
      const nextPc = (pc + instr.len) & 0xffff;
      if (instr.mapperWrite) break;
      const isTerm = ['branch', 'call', 'jump', 'jmp_ind', 'stop', 'illegal', 'unmapped'].includes(instr.flow.type);
      if (isTerm) break;
      const nextSiteKey = siteKeyFor(curCtxKey, nextPc);
      if (hardLeaderSites.has(nextSiteKey)) break;
      pc = nextPc;
    }

    const exactRomOffs = lines.map((ln) => (ln.backing?.kind === 'exact' ? ln.backing.romOff : null)).filter((v) => typeof v === 'number');
    const romStart = exactRomOffs.length ? Math.min(...exactRomOffs) : null;
    const romEnd = lines.length && exactRomOffs.length
      ? ((lines[lines.length - 1].backing?.kind === 'exact')
          ? (lines[lines.length - 1].backing.romOff + lines[lines.length - 1].len)
          : (romStart + lines.reduce((n, ln) => n + (ln.len | 0), 0)))
      : null;

    const blockConfidence = bestConfBySite.get(rec.siteKey) || rec.conf || 'certain';
    const probableFilter = (blockConfidence === 'probable') ? shouldKeepProbableBlock(lines) : { keep: true, semantic: null };
    if (!probableFilter.keep) continue;

    const block = {
      id: blockId,
      romStart,
      romEnd,
      confidence: blockConfidence,
      ctxKey,
      fetchCtx: rec.fetchCtx,
      blockInstanceId: instId,
      leaderKind: rec.leaderKind,
      leaderReasons: rec.leaderReasons || [],
      isCertainHardLeader: !!rec.isCertainHardLeader,
      startSiteKey: rec.siteKey,
      rawBlockIds: [blockId],
      instances: [{ ctxId: ctxKey, fetchCtxKey: ctxKey, siteKey: rec.siteKey, fetchCtx: rec.fetchCtx, blockInstanceId: instId, cpuStart: startPc }],
      lines,
      probableSemantic: probableFilter.semantic
    };
    blocksById.set(blockId, block);
    blocksByStartSite.set(rec.siteKey, blockId);
  }

  const edges = [];
  const unresolved = [];

  function addResolvedEdges(fromBlock, targets, kind, extra = {}) {
    for (const t of targets || []) {
      const tCtxKey = fetchCtxKey(t.fetchCtx);
      const tSiteKey = siteKeyFor(tCtxKey, t.cpuAddr);
      const toId = blocksByStartSite.get(tSiteKey) || null;
      edges.push({ from: fromBlock.id, to: toId, kind, ctxKey: fromBlock.ctxKey, toPc: t.cpuAddr & 0xffff, toCtxKey: tCtxKey, toSiteKey: tSiteKey, ...extra });
    }
  }

  for (const block of blocksById.values()) {
    const last = block.lines[block.lines.length - 1];
    if (!last) continue;
    const startRec = startRecordsBySite.get(siteKeyFor(block.ctxKey, block.lines[0].cpuAddr));
    const currentCtx = startRec?.fetchCtx || fetchCtx;
    const f = last.flow;

    if (last.mapperWrite) {
      const nextCtx = last.mapperWrite.nextFetchCtx;
      const nextPc = (last.cpuAddr + last.len) & 0xffff;
      addResolvedEdges(block, [{ cpuAddr: nextPc, fetchCtx: nextCtx }], 'fallthrough');
      continue;
    }

    if (f.type === 'branch') {
      const takenTargets = mapper.targetSitesForCpuAddr ? mapper.targetSitesForCpuAddr(currentCtx, f.target, { maxForks: 4 }) : { sites: [{ cpuAddr: f.target & 0xffff, fetchCtx: currentCtx }], ambiguous: false };
      if (takenTargets.sites?.length) addResolvedEdges(block, takenTargets.sites, 'branch_taken', { branch: f.mnemonic });
      else if (takenTargets.ambiguous) unresolved.push({ kind: 'ambiguous_banked_target', rawBlockId: block.id, ctxKey: block.ctxKey, siteKey: last.siteKey || null, pc: last.cpuAddr, targetCpuAddr: f.target & 0xffff, fetchCtx: currentCtx });
      addResolvedEdges(block, [{ cpuAddr: f.fallthrough & 0xffff, fetchCtx: currentCtx }], 'branch_fallthrough', { branch: f.mnemonic });
    } else if (f.type === 'call') {
      const callTargets = mapper.targetSitesForCpuAddr ? mapper.targetSitesForCpuAddr(currentCtx, f.target, { maxForks: 4 }) : { sites: [{ cpuAddr: f.target & 0xffff, fetchCtx: currentCtx }], ambiguous: false };
      if (callTargets.sites?.length) addResolvedEdges(block, callTargets.sites, 'call');
      else if (callTargets.ambiguous) unresolved.push({ kind: 'ambiguous_banked_target', rawBlockId: block.id, ctxKey: block.ctxKey, siteKey: last.siteKey || null, pc: last.cpuAddr, targetCpuAddr: f.target & 0xffff, fetchCtx: currentCtx });
      addResolvedEdges(block, [{ cpuAddr: f.fallthrough & 0xffff, fetchCtx: currentCtx }], 'fallthrough');
    } else if (f.type === 'jump') {
      const jumpTargets = mapper.targetSitesForCpuAddr ? mapper.targetSitesForCpuAddr(currentCtx, f.target, { maxForks: 4 }) : { sites: [{ cpuAddr: f.target & 0xffff, fetchCtx: currentCtx }], ambiguous: false };
      if (jumpTargets.sites?.length) addResolvedEdges(block, jumpTargets.sites, 'jump');
      else if (jumpTargets.ambiguous) unresolved.push({ kind: 'ambiguous_banked_target', rawBlockId: block.id, ctxKey: block.ctxKey, siteKey: last.siteKey || null, pc: last.cpuAddr, targetCpuAddr: f.target & 0xffff, fetchCtx: currentCtx });
    } else if (f.type === 'jmp_ind') {
      unresolved.push({ kind: 'jmp_ind', rawBlockId: block.id, ctxKey: block.ctxKey, siteKey: last.siteKey || null, pc: last.cpuAddr, romOff: last.romOff, ptrAddr: f.ptrAddr, fetchCtx: currentCtx });
    } else {
      const nextPc = (last.cpuAddr + last.len) & 0xffff;
      const nextSiteKey = siteKeyFor(block.ctxKey, nextPc);
      if (hardLeaderSites.has(nextSiteKey)) addResolvedEdges(block, [{ cpuAddr: nextPc, fetchCtx: currentCtx }], 'fallthrough');
    }
  }

  const unresolvedDirectTargets = [];
  for (const instr of instrBySite.values()) {
    const f = instr.flow;
    if (f.type === 'call' || f.type === 'jump' || f.type === 'branch') {
      const sourceCtx = startRecordsBySite.get(instr.siteKey)?.fetchCtx || fetchCtx;
      const targets = mapper.targetSitesForCpuAddr
        ? mapper.targetSitesForCpuAddr(sourceCtx, f.target, { maxForks: 4 })
        : { sites: [{ cpuAddr: f.target & 0xffff, fetchCtx: sourceCtx }], ambiguous: false };
      if (!targets.sites?.length) {
        unresolvedDirectTargets.push({ fromPc: instr.pc & 0xffff, fromRomOff: instr.romOff, kind: f.type, target: f.target & 0xffff, mnemonic: instr.mnemonic, bytesText: instr.bytesText, ctxKey: instr.ctxKey, siteKey: instr.siteKey });
        continue;
      }
      for (const t of targets.sites) {
        const tSiteKey = siteKeyFor(fetchCtxKey(t.fetchCtx), t.cpuAddr);
        if (!instrBySite.has(tSiteKey)) {
          const targetFetch = mapper.resolveCodeFetch ? mapper.resolveCodeFetch(t.fetchCtx, t.cpuAddr) : null;
          if (targetFetch?.backing?.kind === 'exact') probableProbeOffsetsSet.add(targetFetch.backing.romOff | 0);
          unresolvedDirectTargets.push({
            fromPc: instr.pc & 0xffff,
            fromRomOff: instr.romOff,
            kind: f.type,
            target: t.cpuAddr & 0xffff,
            mnemonic: instr.mnemonic,
            bytesText: instr.bytesText,
            ctxKey: instr.ctxKey,
            siteKey: instr.siteKey,
            targetCtxKey: fetchCtxKey(t.fetchCtx),
            targetSiteKey: tSiteKey
          });
        }
      }
    }
  }
  if (unresolvedDirectTargets.length > 200) unresolvedDirectTargets.length = 200;

  const siteDebugStates = Array.from(startRecordsBySite.values()).map((rec) => {
    const decodedInstr = instrBySite.get(rec.siteKey) || null;
    const failure = decodeFailuresBySite.get(rec.siteKey) || null;
    return {
      siteKey: rec.siteKey,
      pc: rec.pc & 0xffff,
      ctxKey: rec.fetchCtx ? fetchCtxKey(rec.fetchCtx) : (failure?.ctxKey || decodedInstr?.ctxKey || null),
      leaderKind: rec.leaderKind,
      leaderReasons: rec.leaderReasons || [],
      wasScheduled: !!rec.wasScheduledEver,
      wasAttempted: !!rec.wasAttempted,
      wasDecoded: !!rec.wasDecoded,
      decodeFailureReason: rec.decodeFailureReason || failure?.reason || null,
      isCertainHardLeader: !!rec.isCertainHardLeader,
      retryOutcome: rec.retryOutcome || null
    };
  }).sort((a, b) => {
    const aCtx = String(a.ctxKey || '');
    const bCtx = String(b.ctxKey || '');
    if (aCtx !== bCtx) return aCtx.localeCompare(bCtx);
    return ((a.pc ?? 0) | 0) - ((b.pc ?? 0) | 0);
  });

  const blocks = Array.from(blocksById.values()).sort((a, b) => {
    const aRom = typeof a.romStart === 'number' ? a.romStart : Number.MAX_SAFE_INTEGER;
    const bRom = typeof b.romStart === 'number' ? b.romStart : Number.MAX_SAFE_INTEGER;
    if (aRom !== bRom) return aRom - bRom;
    const ctxCmp = String(a.ctxKey || '').localeCompare(String(b.ctxKey || ''));
    if (ctxCmp) return ctxCmp;
    const aCpu = a.lines?.[0]?.cpuAddr ?? 0;
    const bCpu = b.lines?.[0]?.cpuAddr ?? 0;
    return (aCpu | 0) - (bCpu | 0);
  });

  const codeBitmap = new Uint8Array(prgBytes.length);
  for (const block of blocks) {
    for (const line of block.lines || []) {
      if (line.backing?.kind !== 'exact') continue;
      for (let i = 0; i < (line.len | 0); i++) {
        const off = line.backing.romOff + i;
        if (off >= 0 && off < codeBitmap.length) codeBitmap[off] = 1;
      }
    }
  }

  return {
    blocks,
    edges,
    unresolvedSites: unresolved,
    unresolvedIndirects,
    decodeFailuresByPc: Array.from(decodeFailuresBySite.values()).sort((a, b) => (a.pc | 0) - (b.pc | 0)),
    debug: {
      attemptedStartCount: Array.from(startRecordsBySite.values()).filter((r) => r.wasAttempted).length,
      scheduledStartCount: Array.from(startRecordsBySite.values()).filter((r) => r.wasScheduled).length,
      decodeFailureCount: decodeFailuresBySite.size,
      unresolvedDirectTargetCount: unresolvedDirectTargets.length,
      unresolvedDirectTargets,
      siteDebugStates
    },
    instructionCount: instrBySite.size,
    codeBitmap,
    probableProbeOffsets: Array.from(probableProbeOffsetsSet).sort((a, b) => a - b)
  };
}
