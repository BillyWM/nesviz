import { vUnknown, vConst8, vSet8, vAnd8, vShl1, vAdd8, vToSet } from './value.js';
import { pUnknown, pConst8, pConst16, pAdd16, pAdd8, pAnd8, pShl1, pReadRom8, pReadZp8 } from './prov.js';
import { cloneState, joinInto, makeState, makeTracked } from './state.js';
import { constrainBranchEdges } from './constraints.js';

// Value-set analysis (VSA) for a small 6502 subset, with provenance. 🤖
// This is purposely conservative: unknown is always allowed, and we only model the pieces we need for early jump-table recovery. 🤖

const WRITES_REG = new Set([
  'LDA', 'LDX', 'LDY',
  'TAX', 'TAY', 'TXA', 'TYA', 'TSX',
  'INX', 'DEX', 'INY', 'DEY',
  'ASL', 'AND'
]);

function read8(prgBytes, romOff, rel) {
  return prgBytes[romOff + rel] & 0xff;
}

function read16(prgBytes, romOff, rel) {
  const lo = prgBytes[romOff + rel] & 0xff;
  const hi = prgBytes[romOff + rel + 1] & 0xff;
  return (lo | (hi << 8)) & 0xffff;
}

function readPrgAtCpu(prgBytes, mapper, cpuAddr) {
  const romOff = mapper.cpuToRomOff(cpuAddr & 0xffff);
  if (romOff == null) return null;
  if (romOff < 0 || romOff >= prgBytes.length) return null;
  return prgBytes[romOff] & 0xff;
}

function setReg(state, reg, abs, prov) {
  state[reg] = makeTracked(abs, prov);
}

function getReg(state, reg) {
  return state[reg] || makeTracked();
}

function getZp(state, addr) {
  const a = addr & 0xff;
  return state.zp.get(a) || makeTracked();
}

function setZp(state, addr, tracked) {
  const a = addr & 0xff;
  if (!state.zp.has(a)) return; // only track specific ZP addrs (pointer bytes etc). 🤖
  state.zp.set(a, tracked);
}

function maybeReadRom8(prgBytes, mapper, cpuAddr, indexProv, indexSource) {
  const b = readPrgAtCpu(prgBytes, mapper, cpuAddr);
  const addrExpr = indexProv ? pAdd16(pConst16(cpuAddr & 0xffff), indexProv) : pConst16(cpuAddr & 0xffff);
  const prov = pReadRom8(addrExpr, indexSource);
  if (b == null) return { abs: vUnknown(), prov };
  return { abs: vConst8(b), prov };
}

function readRomIndexed(prgBytes, mapper, baseAddr, indexTracked, indexSource) {
  const base = baseAddr & 0xffff;
  const idxSet = vToSet(indexTracked.abs);

  const addrExpr = pAdd16(pConst16(base), indexTracked.prov);
  const prov = pReadRom8(addrExpr, indexSource);

  if (!idxSet) {
    return makeTracked(vUnknown(), prov);
  }

  const outVals = [];
  for (const i of idxSet) {
    const b = readPrgAtCpu(prgBytes, mapper, (base + i) & 0xffff);
    if (b == null) return makeTracked(vUnknown(), prov);
    outVals.push(b);
  }

  return makeTracked(vSet8(outVals), prov);
}

function applyInstruction(state, line, ctx) {
  const { prgBytes, mapper } = ctx;
  const m = line.mnemonic;
  const mode = line.mode;
  const romOff = line.romOff;

  // Compare/NZ facts are only trusted for *adjacent* branch filtering. 🤖
  // If the current instruction is not a branch that consumes the fact, we clear the prior fact. 🤖
  const consumesCmp = (m === 'BEQ' || m === 'BNE' || m === 'BCC' || m === 'BCS');
  const consumesNz = (m === 'BEQ' || m === 'BNE' || m === 'BMI' || m === 'BPL');
  if (!(m === 'CMP' || m === 'CPX' || m === 'CPY') && !consumesCmp) state.lastCmp = null;
  if (!consumesNz) state.lastNZ = null;

  if (m === 'LDA' && mode === 'imm') {
    const imm = read8(prgBytes, romOff, 1);
    setReg(state, 'A', vConst8(imm), pConst8(imm));
    state.lastNZ = { reg: 'A' };
    return;
  }

  if (m === 'LDX' && mode === 'imm') {
    const imm = read8(prgBytes, romOff, 1);
    setReg(state, 'X', vConst8(imm), pConst8(imm));
    state.lastNZ = { reg: 'X' };
    return;
  }

  if (m === 'LDY' && mode === 'imm') {
    const imm = read8(prgBytes, romOff, 1);
    setReg(state, 'Y', vConst8(imm), pConst8(imm));
    state.lastNZ = { reg: 'Y' };
    return;
  }

  if (m === 'LDA' && mode === 'zp') {
    const addr = read8(prgBytes, romOff, 1);
    const t = getZp(state, addr);
    setReg(state, 'A', t.abs, pReadZp8(addr));
    state.lastNZ = { reg: 'A' };
    return;
  }

  if (m === 'LDA' && mode === 'abs') {
    const addr = read16(prgBytes, romOff, 1);
    const b = readPrgAtCpu(prgBytes, mapper, addr);
    if (b == null) {
      setReg(state, 'A', vUnknown(), pUnknown());
      return;
    }
    setReg(state, 'A', vConst8(b), pReadRom8(pConst16(addr), null));
    state.lastNZ = { reg: 'A' };
    return;
  }

  if (m === 'LDA' && mode === 'absX') {
    const base = read16(prgBytes, romOff, 1);
    const t = readRomIndexed(prgBytes, mapper, base, getReg(state, 'X'), 'X');
    setReg(state, 'A', t.abs, t.prov);
    state.lastNZ = { reg: 'A' };
    return;
  }

  if (m === 'LDA' && mode === 'absY') {
    const base = read16(prgBytes, romOff, 1);
    const t = readRomIndexed(prgBytes, mapper, base, getReg(state, 'Y'), 'Y');
    setReg(state, 'A', t.abs, t.prov);
    state.lastNZ = { reg: 'A' };
    return;
  }

  if (m === 'LDX' && mode === 'abs') {
    const addr = read16(prgBytes, romOff, 1);
    const b = readPrgAtCpu(prgBytes, mapper, addr);
    if (b == null) {
      setReg(state, 'X', vUnknown(), pUnknown());
      return;
    }
    setReg(state, 'X', vConst8(b), pReadRom8(pConst16(addr), null));
    state.lastNZ = { reg: 'X' };
    return;
  }

  if (m === 'LDY' && mode === 'abs') {
    const addr = read16(prgBytes, romOff, 1);
    const b = readPrgAtCpu(prgBytes, mapper, addr);
    if (b == null) {
      setReg(state, 'Y', vUnknown(), pUnknown());
      return;
    }
    setReg(state, 'Y', vConst8(b), pReadRom8(pConst16(addr), null));
    state.lastNZ = { reg: 'Y' };
    return;
  }

  if (m === 'TAX' && mode === 'imp') {
    const a = getReg(state, 'A');
    setReg(state, 'X', a.abs, a.prov);
    state.lastNZ = { reg: 'X' };
    return;
  }

  if (m === 'TAY' && mode === 'imp') {
    const a = getReg(state, 'A');
    setReg(state, 'Y', a.abs, a.prov);
    state.lastNZ = { reg: 'Y' };
    return;
  }

  if (m === 'TXA' && mode === 'imp') {
    const x = getReg(state, 'X');
    setReg(state, 'A', x.abs, x.prov);
    state.lastNZ = { reg: 'A' };
    return;
  }

  if (m === 'TYA' && mode === 'imp') {
    const y = getReg(state, 'Y');
    setReg(state, 'A', y.abs, y.prov);
    state.lastNZ = { reg: 'A' };
    return;
  }

  if (m === 'TSX' && mode === 'imp') {
    // We do not track SP, so TSX becomes unknown. 🤖
    setReg(state, 'X', vUnknown(), pUnknown());
    state.lastNZ = { reg: 'X' };
    return;
  }

  if (m === 'INX' && mode === 'imp') {
    const x = getReg(state, 'X');
    setReg(state, 'X', vAdd8(x.abs, 1), pAdd8(x.prov, 1));
    state.lastNZ = { reg: 'X' };
    return;
  }

  if (m === 'DEX' && mode === 'imp') {
    const x = getReg(state, 'X');
    setReg(state, 'X', vAdd8(x.abs, -1), pAdd8(x.prov, -1));
    state.lastNZ = { reg: 'X' };
    return;
  }

  if (m === 'INY' && mode === 'imp') {
    const y = getReg(state, 'Y');
    setReg(state, 'Y', vAdd8(y.abs, 1), pAdd8(y.prov, 1));
    state.lastNZ = { reg: 'Y' };
    return;
  }

  if (m === 'DEY' && mode === 'imp') {
    const y = getReg(state, 'Y');
    setReg(state, 'Y', vAdd8(y.abs, -1), pAdd8(y.prov, -1));
    state.lastNZ = { reg: 'Y' };
    return;
  }

  if (m === 'AND' && mode === 'imm') {
    const imm = read8(prgBytes, romOff, 1);
    const a = getReg(state, 'A');
    setReg(state, 'A', vAnd8(a.abs, imm), pAnd8(a.prov, imm));
    state.lastNZ = { reg: 'A' };
    return;
  }

  if (m === 'ASL' && mode === 'acc') {
    const a = getReg(state, 'A');
    setReg(state, 'A', vShl1(a.abs), pShl1(a.prov));
    state.lastNZ = { reg: 'A' };
    return;
  }

  if (m === 'STA' && mode === 'zp') {
    const addr = read8(prgBytes, romOff, 1);
    const a = getReg(state, 'A');
    setZp(state, addr, { ...a });
    return;
  }

  if (m === 'STX' && mode === 'zp') {
    const addr = read8(prgBytes, romOff, 1);
    const x = getReg(state, 'X');
    setZp(state, addr, { ...x });
    return;
  }

  if (m === 'STY' && mode === 'zp') {
    const addr = read8(prgBytes, romOff, 1);
    const y = getReg(state, 'Y');
    setZp(state, addr, { ...y });
    return;
  }

  if ((m === 'CMP' || m === 'CPX' || m === 'CPY') && mode === 'imm') {
    const imm = read8(prgBytes, romOff, 1);
    const reg = m === 'CMP' ? 'A' : m === 'CPX' ? 'X' : 'Y';
    state.lastCmp = { reg, imm };
    state.lastNZ = null;
    return;
  }

  // Anything else: if it writes a tracked register, conservatively forget it. 🤖
  if (WRITES_REG.has(m)) {
    if (m === 'LDA') setReg(state, 'A', vUnknown(), pUnknown());
    if (m === 'LDX') setReg(state, 'X', vUnknown(), pUnknown());
    if (m === 'LDY') setReg(state, 'Y', vUnknown(), pUnknown());
  }
}

async function yieldToEventLoop() {
  // setImmediate yields within the Node/Electron main process without an arbitrary timer delay.
  // Fallback to setTimeout(0) in environments that don't provide setImmediate.
  await new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

export async function runVsa({
  prgBytes,
  mapper,
  blocks,
  edges,
  entryBlockIds,
  unresolvedSites,
  yieldEveryMs = 0,
  onProgress = null,
  progressEveryMs = 0
}) {
  // Track the pointer bytes used by JMP (addr) sites that live in zero page; anything else is too costly to track up front. 🤖
  const trackedZp = new Set();
  for (const s of unresolvedSites) {
    const ptr = s.ptrAddr & 0xffff;
    if (ptr <= 0x00ff) {
      trackedZp.add(ptr & 0xff);
      trackedZp.add((ptr + 1) & 0xff);
    }
  }

  const byId = new Map(blocks.map((b) => [b.id, b]));
  const succs = new Map();
  for (const e of edges) {
    if (!e.to) continue;
    if (!succs.has(e.from)) succs.set(e.from, []);
    succs.get(e.from).push(e);
  }

  const inStates = new Map();
  for (const b of blocks) inStates.set(b.id, makeState(trackedZp));

  const work = [...new Set(entryBlockIds)];
  // Progress metric: blocks that have been processed since their last IN change.
  // We treat unseen blocks as unstable.
  const totalBlocks = blocks.length;
  const seen = new Set();
  const dirty = new Set(work);
  let seenCount = 0;
  let dirtySeenCount = 0;

  function markDirty(bid) {
    if (dirty.has(bid)) return;
    dirty.add(bid);
    if (seen.has(bid)) dirtySeenCount++;
  }

  function markProcessed(bid) {
    if (!seen.has(bid)) {
      seen.add(bid);
      seenCount++;
      // If it was dirty while being processed, it temporarily counts as dirty-seen.
      if (dirty.has(bid)) dirtySeenCount++;
    }
    if (dirty.delete(bid)) {
      if (seen.has(bid)) dirtySeenCount--;
    }
  }

  let lastProgressAt = Date.now();
  function maybeReportProgress(force = false) {
    if (typeof onProgress !== 'function') return;
    if (!(progressEveryMs > 0)) return;
    const now = Date.now();
    if (!force && (now - lastProgressAt) < progressEveryMs) return;
    lastProgressAt = now;
    const stableBlocks = seenCount - dirtySeenCount;
    onProgress({
      stableBlocks,
      totalBlocks
    });
  }
  const siteStates = new Map();

  let lastYieldAt = Date.now();
  async function maybeYield() {
    if (!(yieldEveryMs > 0)) return;
    const now = Date.now();
    if (now - lastYieldAt >= yieldEveryMs) {
      await yieldToEventLoop();
      lastYieldAt = Date.now();
    }
  }

  while (work.length) {
    maybeReportProgress();
    await maybeYield();
    const bid = work.pop();
    const block = byId.get(bid);
    if (!block) continue;

    const inState = inStates.get(bid) || makeState(trackedZp);
    const cur = cloneState(inState);

    let branchMnemonic = null;

    let lineIdx = 0;
    for (const line of block.lines) {
      if ((lineIdx++ & 63) === 0) {
        maybeReportProgress();
        await maybeYield();
      }
      if (line.flow.type === 'jmp_ind') {
        // We want the state immediately *before* executing the indirect jump. 🤖
        siteStates.set(line.cpuAddr & 0xffff, cloneState(cur));
      }

      applyInstruction(cur, line, { prgBytes, mapper });

      if (line.flow.type === 'branch') {
        branchMnemonic = line.mnemonic;
      }
    }

    const { taken, fall } = branchMnemonic ? constrainBranchEdges(cur, branchMnemonic) : { taken: null, fall: null };

    const outs = succs.get(bid) || [];
    for (const e of outs) {
      const outState =
        e.kind === 'branch_taken' && taken ? taken :
        e.kind === 'branch_fallthrough' && fall ? fall :
        cur;

      const next = inStates.get(e.to) || makeState(trackedZp);
      const merged = cloneState(next);
      const changed = joinInto(merged, outState);
      if (changed) {
        inStates.set(e.to, merged);
        markDirty(e.to);
        work.push(e.to);
      }
    }

    // This block is now "stable" until/unless some predecessor updates its IN state again.
    markProcessed(bid);
  }

  // Force a final "complete" update so the bar can hit 100% before disappearing.
  if (typeof onProgress === 'function' && (progressEveryMs > 0)) {
    onProgress({ stableBlocks: totalBlocks, totalBlocks });
  }

  return {
    siteStatesByPc: siteStates,
    inStatesByBlockId: inStates
  };
}
