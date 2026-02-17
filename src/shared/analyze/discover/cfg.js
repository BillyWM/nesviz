import { disasmOneAt } from '../../cpu6502/disasm.js';
import { blockIdFromRomOff } from '../model.js';
import { decodePrgCdlByte, isPrgDataObserved } from '../cdl/nesCdl.js';

// This module builds a conservative control-flow graph by decoding from known entrypoints. 🤖
// It does not try to "disassemble the whole ROM"; it only decodes bytes that appear reachable from vectors and resolved targets. 🤖
// Any time we hit an unmapped address or an illegal opcode, we stop following that path (we assume we were wrong about code). 🤖

function confRank(c) {
  return c === 'certain' ? 2 : c === 'probable' ? 1 : 0;
}

function bestOf(a, b) {
  return confRank(a) >= confRank(b) ? a : b;
}

// seedItems: [{ cpuAddr, confidence }]
// If seedItems is omitted, we fall back to entrypointsCpuAddrs/extraEntrypointsCpuAddrs and treat them as "certain". 🤖
export function discoverCfg({
  prgBytes,
  mapper,
  ctxId,
  seedItems = null,
  // Optional PRG CDL overlay. When present, we treat bytes observed as *data-only* (read as data but not executed)
  // as authoritative and refuse to decode instructions starting there. This makes data gaps appear explicitly
  // and prevents static decoding from plowing through tables / literals.
  cdlPrg = null,
  entrypointsCpuAddrs = [],
  extraEntrypointsCpuAddrs = [],
  maxPasses = 3
}) {
  // We iterate because later passes may add new entrypoints (e.g. jump-table targets). 🤖
  const seeds = Array.isArray(seedItems)
    ? seedItems
    : [...entrypointsCpuAddrs.map((cpuAddr) => ({ cpuAddr, confidence: 'certain' })), ...extraEntrypointsCpuAddrs.map((cpuAddr) => ({ cpuAddr, confidence: 'certain' }))];

  const bestConfByPc = new Map(); // pc -> "certain" | "probable" 🤖
  const instrByPc = new Map(); // pc -> decoded instruction 🤖
  const decodeFailuresByPc = new Map(); // start pc -> { pc, reason, romOff, op, bytesText, text } 🤖
  const scheduledStarts = new Set(); // pc values currently queued for decoding 🤖
  const attemptedStarts = new Set(); // pc values we've popped and tried to decode at least once 🤖

  let queued = []; // { pc, conf } (decode-start worklist) 🤖

  function isCdlDataOnlyPc(pc) {
    if (!cdlPrg) return false;
    const romOff = mapper.cpuToRomOff(pc & 0xffff);
    if (romOff == null) return false;
    if (romOff < 0 || romOff >= cdlPrg.length) return false;
    const flags = decodePrgCdlByte(cdlPrg[romOff]);
    // "Code wins" when a byte is both exec+data.
    return isPrgDataObserved(flags) && !flags.exec;
  }

  function markReachable(pc, conf) {
    const p = pc & 0xffff;
    const prev = bestConfByPc.get(p);
    const next = prev ? bestOf(prev, conf) : conf;
    if (prev && prev === next) return false;
    bestConfByPc.set(p, next);
    return true;
  }

  function enqueueStart(pc, conf) {
    const p = pc & 0xffff;
    // Always record reachability, but don't let that suppress scheduling a decode attempt. 🤖
    // We want "JSR $xxxx" and friends to force a decode attempt even if the PC was already marked reachable via some other path. 🤖
    markReachable(p, conf);

    // If we've already decoded an instruction at this address, no need to schedule it again. 🤖
    if (instrByPc.has(p)) return;

    // Avoid infinite churn: only attempt each start PC once per discoverCfg() call. 🤖
    if (attemptedStarts.has(p)) return;

    if (scheduledStarts.has(p)) return;
    scheduledStarts.add(p);
    queued.push({ pc: p, conf: bestConfByPc.get(p) || conf || 'certain' });
  }

  for (const s of seeds) {
    if (s && typeof s.cpuAddr === 'number') enqueueStart(s.cpuAddr, s.confidence || 'certain');
  }
  const unresolvedIndirects = []; // { pc, romOff, ptrAddr } (debug/telemetry) 🤖

  // We use a single worklist so we don't accidentally drop newly discovered entrypoints (e.g. a JSR target)
  // due to an arbitrary "pass" limit. 🤖
  while (queued.length) {
    const item = queued.pop();
    const startPc = (item?.pc ?? item) & 0xffff;
    const startConf = item?.conf || bestConfByPc.get(startPc) || 'certain';

    scheduledStarts.delete(startPc);
    attemptedStarts.add(startPc);

    // Decode linearly until control flow forces us to stop. 🤖
    // We still enqueue branch targets, fallthroughs, and call targets so other code regions get discovered too. 🤖
    let pc = startPc;
    let conf = startConf;
    while (true) {
      if (isCdlDataOnlyPc(pc)) {
        if (pc === startPc && !decodeFailuresByPc.has(startPc)) {
          const romOff = mapper.cpuToRomOff(startPc & 0xffff);
          decodeFailuresByPc.set(startPc, {
            pc: startPc,
            reason: 'cdl_data',
            romOff,
            op: null,
            bytesText: null,
            text: 'CDL marks byte as data-only'
          });
        }
        break;
      }
      // Even if we've already decoded this PC, we still want to propagate improved reachability/confidence forward. 🤖
      // So we fetch the cached instruction when present instead of stopping early. 🤖
      const cached = instrByPc.get(pc);
      const instr = cached || disasmOneAt(prgBytes, mapper, pc);
      if (!instr.ok) {
        // Record why decoding failed at a scheduled entrypoint so we can debug "why didn't this split the unknown gap?" 🤖
        if (pc === startPc && !decodeFailuresByPc.has(startPc)) {
          decodeFailuresByPc.set(startPc, {
            pc: startPc,
            reason: instr?.flow?.type || 'unknown',
            romOff: instr.romOff,
            op: instr.op,
            bytesText: instr.bytesText,
            text: instr.text
          });
        }
        break;
      }
      if (!cached) instrByPc.set(pc, instr);

      // Mark this instruction as reachable under this confidence. 🤖
      markReachable(pc, conf);

      const f = instr.flow;
      if (f.type === 'branch') {
        enqueueStart(f.target, conf);
        markReachable(f.fallthrough, conf);
        // Keep decoding fallthrough linearly too; if we stop early here we'd need a separate pass to get straight-line code. 🤖
        pc = f.fallthrough;
        continue;
      }

      if (f.type === 'call') {
        enqueueStart(f.target, conf);
        // Calls return; keep decoding the next instruction as well. 🤖
        pc = f.fallthrough;
        continue;
      }

      if (f.type === 'jump') {
        enqueueStart(f.target, conf);
        break;
      }

      if (f.type === 'jmp_ind') {
        unresolvedIndirects.push({ pc, romOff: instr.romOff, ptrAddr: f.ptrAddr });
        break;
      }

      if (f.type === 'stop' || f.type === 'illegal') {
        break;
      }

      // Default fallthrough. 🤖
      pc = (pc + instr.len) & 0xffff;
    }
  }


  const leaders = new Set();
  for (const s of seeds) leaders.add((s.cpuAddr ?? s) & 0xffff);

  // Any instruction that can be the target of a branch/jump/call is a leader. 🤖
  for (const instr of instrByPc.values()) {
    const f = instr.flow;
    if (f.type === 'branch') {
      leaders.add(f.target & 0xffff);
      leaders.add(f.fallthrough & 0xffff);
    } else if (f.type === 'call') {
      leaders.add(f.target & 0xffff);
      leaders.add(f.fallthrough & 0xffff); // we split blocks after calls for nicer graphs and easier local reasoning. 🤖
    } else if (f.type === 'jump') {
      leaders.add(f.target & 0xffff);
    }
  }

  // Build blocks from leaders by walking forward until a terminator or another leader. 🤖
  const leaderList = Array.from(leaders).sort((a, b) => a - b);
  const blocksByCpuStart = new Map();
  const blocksById = new Map();

  for (const startPc of leaderList) {
    if (blocksByCpuStart.has(startPc)) continue;
    if (!instrByPc.has(startPc)) continue;

    const firstInstr = instrByPc.get(startPc);
    const romStart = firstInstr.romOff;
    const id = blockIdFromRomOff(romStart);

    // Collect lines. 🤖
    const lines = [];
    let pc = startPc;
    while (true) {
      const instr = instrByPc.get(pc);
      if (!instr) break;
      lines.push({
        cpuAddr: pc,
        romOff: instr.romOff,
        len: instr.len,
        bytesText: instr.bytesText,
        asm: instr.text,
        mnemonic: instr.mnemonic,
        mode: instr.mode,
        flow: instr.flow
      });

      const nextPc = (pc + instr.len) & 0xffff;
      const isTerm = ['branch', 'call', 'jump', 'jmp_ind', 'stop', 'illegal'].includes(instr.flow.type);
      if (isTerm) {
        pc = nextPc;
        break;
      }
      if (leaders.has(nextPc)) {
        pc = nextPc;
        break;
      }
      pc = nextPc;
    }

    const romEnd = lines.length ? lines[lines.length - 1].romOff + lines[lines.length - 1].len : romStart;

    let block = blocksById.get(id);
    if (!block) {
      block = {
        id,
        romStart,
        romEnd,
        confidence: bestConfByPc.get(startPc) || 'certain',
        instances: [],
        lines
      };
      blocksById.set(id, block);
    } else {
      // If we later discover this same physical block from a higher-confidence entrypoint, upgrade it. 🤖
      block.confidence = bestOf(block.confidence, bestConfByPc.get(startPc) || 'certain');
    }

    block.instances.push({ ctxId, cpuStart: startPc });
    blocksByCpuStart.set(startPc, id);
  }

  // Edges at the block level (primarily for callgraph / CFG). 🤖
  const edges = [];
  const unresolved = [];

  for (const block of blocksById.values()) {
    const last = block.lines[block.lines.length - 1];
    if (!last) continue;

    const from = block.id;
    const f = last.flow;

    function addEdge(kind, toPc, extra = {}) {
      const toId = blocksByCpuStart.get(toPc & 0xffff) || null;
      edges.push({ from, to: toId, kind, toPc: toPc & 0xffff, ...extra });
    }

    if (f.type === 'branch') {
      addEdge('branch_taken', f.target, { branch: f.mnemonic });
      addEdge('branch_fallthrough', f.fallthrough, { branch: f.mnemonic });
    } else if (f.type === 'call') {
      addEdge('call', f.target);
      addEdge('fallthrough', f.fallthrough);
    } else if (f.type === 'jump') {
      addEdge('jump', f.target);
    } else if (f.type === 'jmp_ind') {
      unresolved.push({ blockId: block.id, pc: last.cpuAddr, ptrAddr: f.ptrAddr });
    } else {
      // If the block ended because the next instruction was a leader (split), treat as fallthrough. 🤖
      const nextPc = (last.cpuAddr + last.len) & 0xffff;
      if (leaders.has(nextPc)) addEdge('fallthrough', nextPc);
    }
  }

  // Byte-level classification for View A timeline: mark any decoded instruction bytes as code. 🤖
  const codeBitmap = new Uint8Array(prgBytes.length);
  for (const instr of instrByPc.values()) {
    for (let i = 0; i < instr.len; i++) {
      const off = instr.romOff + i;
      if (off >= 0 && off < codeBitmap.length) codeBitmap[off] = 1;
    }
  }


  // Debug: direct control-flow targets that were referenced but never decoded. 🤖
  // This often indicates we hit a hard cap (like max passes) or that the target is truly not code. 🤖
  const unresolvedDirectTargets = [];
  for (const instr of instrByPc.values()) {
    const f = instr.flow;
    if (f.type === 'call' || f.type === 'jump' || f.type === 'branch') {
      const tgt = f.target & 0xffff;
      if (!instrByPc.has(tgt)) {
        unresolvedDirectTargets.push({
          fromPc: instr.pc & 0xffff,
          fromRomOff: instr.romOff,
          kind: f.type,
          target: tgt,
          mnemonic: instr.mnemonic,
          bytesText: instr.bytesText
        });
      }
    }
  }
  if (unresolvedDirectTargets.length > 200) unresolvedDirectTargets.length = 200;
  return {
    blocks: Array.from(blocksById.values()).sort((a, b) => a.romStart - b.romStart),
    edges,
    unresolvedSites: unresolved,
    // unresolvedIndirects is currently unused by the UI, but can be handy for debugging. 🤖
    unresolvedIndirects,
    // decodeFailuresByPc is debugging aid: it records why a scheduled decode-start PC did not decode any instruction. 🤖
    // This is useful when a call/jump target "should" split an unknown region but stays unknown. 🤖
    decodeFailuresByPc: Array.from(decodeFailuresByPc.values()).sort((a, b) => (a.pc | 0) - (b.pc | 0)),
    debug: {
      attemptedStartCount: attemptedStarts.size,
      scheduledStartCount: scheduledStarts.size,
      decodeFailureCount: decodeFailuresByPc.size,
      unresolvedDirectTargetCount: unresolvedDirectTargets.length,
      unresolvedDirectTargets
    },
    instructionCount: instrByPc.size,
    codeBitmap
  };
}
