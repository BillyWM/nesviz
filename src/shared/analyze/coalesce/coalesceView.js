import { DEFAULT_COALESCE_CONFIG } from './config.js';

function confRank(c) {
  return c === 'certain' ? 2 : c === 'probable' ? 1 : 0;
}

function bestOf(a, b) {
  return confRank(a) >= confRank(b) ? a : b;
}

function isControlFlowOnlyLine(ln) {
  // For the "control-flow run" coalescer, treat only these as control-flow ops:
  // - conditional branches
  // - JSR
  // - JMP absolute
  // (Exclude JMP (ind), stop/illegal, and any unknown/undecoded lines.) 🤖
  if (!ln || typeof ln !== 'object') return false;
  const f = ln.flow;
  if (!f || typeof f.type !== 'string') return false;

  if (f.type === 'branch') return true;
  if (f.type === 'call') return ln.mnemonic === 'JSR';
  if (f.type === 'jump') return ln.mnemonic === 'JMP';
  return false;
}

function isControlFlowOnlyBlock(b) {
  const lines = b?.lines;
  if (!Array.isArray(lines) || lines.length === 0) return false;
  for (const ln of lines) {
    if (!isControlFlowOnlyLine(ln)) return false;
  }
  return true;
}

// Build a *derived* "coalesced" block view for display purposes. 🤖
//
// Motivation:
// - Our true CFG builder splits blocks at every leader (branch targets, call fallthrough, etc.). 🤖
// - That's great for analysis, but noisy for a human "read through" view. 🤖
// - This pass merges adjacent decoded blocks in ROM order using a few conservative heuristics. 🤖
//
// Guarantees:
// - We do not change the underlying analysis; we only produce a copied view. 🤖
// - We never merge across ROM gaps (unknown/data runs). 🤖
// - JSR calls do *not* end a display block (per project rule). 🤖
export function buildCoalescedAnalysisView(rawAnalysis, config = DEFAULT_COALESCE_CONFIG) {
  if (!rawAnalysis) return { analysis: rawAnalysis, blockAliases: {} };

  const rawBlocks = Array.isArray(rawAnalysis.blocks) ? rawAnalysis.blocks : [];
  const sorted = [...rawBlocks].sort((a, b) => (a.romStart ?? 0) - (b.romStart ?? 0));

  // Fast lookup from CPU start -> raw block index. 🤖
  const cpuStartToIndex = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    const cpuStart = b?.lines?.[0]?.cpuAddr;
    if (typeof cpuStart === 'number') cpuStartToIndex.set(cpuStart & 0xffff, i);
  }

  const blockAliases = {}; // rawBlockId -> coalescedBlockId (we use the group leader raw id) 🤖
  const coalescedBlocks = [];

  function isContiguous(a, b) {
    return !!a && !!b && typeof a.romEnd === 'number' && typeof b.romStart === 'number' && a.romEnd === b.romStart;
  }

  function countInstrFromIndexToCpuStart(startIndex, targetCpuStart, maxInstr) {
    // Walk forward in ROM order, counting instructions, until we reach a block starting at targetCpuStart. 🤖
    let count = 0;
    for (let i = startIndex; i < sorted.length; i++) {
      const b = sorted[i];
      if (i > startIndex) {
        const prev = sorted[i - 1];
        if (!isContiguous(prev, b)) return { found: false, count };
      }
      const cpuStart = b?.lines?.[0]?.cpuAddr;
      if (typeof cpuStart === 'number' && ((cpuStart & 0xffff) === (targetCpuStart & 0xffff))) {
        return { found: true, count };
      }
      const n = b?.lines?.length || 0;
      count += n;
      if (count > maxInstr) return { found: false, count };
    }
    return { found: false, count };
  }

  function shouldInlineBranch(endBlock, endIndex) {
    const last = endBlock?.lines?.[endBlock.lines.length - 1];
    const f = last?.flow;
    if (!f || f.type !== 'branch') return false;
    const target = f.target;
    const fallthrough = f.fallthrough;
    if (typeof target !== 'number' || typeof fallthrough !== 'number') return false;

    // Backward branches are commonly loop edges; keeping them inside a display block helps suppress intra-block links. 🤖
    if (((target & 0xffff) < (fallthrough & 0xffff))) return true;

    // Forward branches: inline only if the join point is close to the fallthrough path. 🤖
    const nextIndex = endIndex + 1;
    const expectedFallthroughIndex = cpuStartToIndex.get(fallthrough & 0xffff);
    const startIndex = typeof expectedFallthroughIndex === 'number' ? expectedFallthroughIndex : nextIndex;
    const r = countInstrFromIndexToCpuStart(startIndex, target, config.branchInlineMaxInstr | 0);
    return !!r.found;
  }

  function isSkippableJmpStub(prevBlock, stubBlock, stubIndex) {
    // Detect a tiny unconditional-JMP-only block that is likely part of:
    //   Bxx join
    //   JMP somewhere
    // join:
    // where the JMP can be bypassed by the near branch. 🤖

    if (!prevBlock || !stubBlock) return false;
    const prevLast = prevBlock?.lines?.[prevBlock.lines.length - 1];
    const prevFlow = prevLast?.flow;
    if (!prevFlow || prevFlow.type !== 'branch') return false;
    if (typeof prevFlow.target !== 'number') return false;

    // Only consider very small JMP stub blocks. 🤖
    const stubInstrCount = stubBlock?.lines?.length || 0;
    if (stubInstrCount <= 0 || stubInstrCount > (config.maxJmpStubInstr | 0)) return false;

    const stubFirst = stubBlock?.lines?.[0];
    const stubLast = stubBlock?.lines?.[stubBlock.lines.length - 1];
    if (!stubFirst || !stubLast) return false;
    if (stubFirst.mnemonic !== 'JMP') return false;
    if (!stubLast.flow || stubLast.flow.type !== 'jump') return false;

    // Check that the branch target is very near *after* the JMP stub in ROM order. 🤖
    const afterStubIndex = stubIndex + 1;
    const r = countInstrFromIndexToCpuStart(afterStubIndex, prevFlow.target, config.jmpSkipMaxInstr | 0);
    return !!r.found;
  }

  function isEarlyReturnRtsBlock(prevBlock, rtsBlock, rtsIndex) {
    // Detect a common "guard clause" shape:
    //   ...
    //   Bxx do_work
    //   RTS
    // do_work:
    //   ...
    //   RTS
    //
    // In raw CFG this often becomes:
    //   A: ... Bxx do_work
    //   B: RTS
    //   C: do_work: ... RTS
    //
    // For the coalesced display view, keep A+B+C together so the routine reads
    // as one contiguous unit. We only special-case RTS (not other stops) because
    // RTS "returns" to the caller and is usually a true early-return guard. 🤖

    if (!prevBlock || !rtsBlock) return false;

    const prevLast = prevBlock?.lines?.[prevBlock.lines.length - 1];
    const prevFlow = prevLast?.flow;
    if (!prevFlow || prevFlow.type !== 'branch') return false;
    if (typeof prevFlow.fallthrough !== 'number' || typeof prevFlow.target !== 'number') return false;

    const rtsCpuStart = rtsBlock?.lines?.[0]?.cpuAddr;
    if (typeof rtsCpuStart !== 'number') return false;
    if (((prevFlow.fallthrough & 0xffff) !== (rtsCpuStart & 0xffff))) return false;

    const rtsLast = rtsBlock?.lines?.[rtsBlock.lines.length - 1];
    const rtsFlow = rtsLast?.flow;
    if (!rtsFlow || rtsFlow.type !== 'stop') return false;
    if (rtsLast?.mnemonic !== 'RTS') return false;

    // Require that the branch target is forward and "near" after the early-return.
    // We use the same threshold as the general forward-branch inliner for now. 🤖
    const afterRtsIndex = rtsIndex + 1;
    const r = countInstrFromIndexToCpuStart(afterRtsIndex, prevFlow.target, config.branchInlineMaxInstr | 0);
    return !!r.found;
  }

  function isBareRtsBlock(block) {
    // A "bare RTS" block is a raw CFG block containing exactly one instruction: RTS.
    // We coalesce these into the previous display block for readability.
    const lines = block?.lines;
    if (!Array.isArray(lines) || lines.length !== 1) return false;
    const ln = lines[0];
    return ln?.mnemonic === 'RTS' && ln?.flow?.type === 'stop';
  }

  function findControlFlowRunEndIndex(startIndex) {
    // Find the end index (inclusive) of a ROM-contiguous run of "control-flow only" blocks
    // starting at startIndex. Only activates if the run is at least config.controlFlowRunMinInstr
    // instructions long. This rule is applied late/last to reduce noise in dispatcher-style code. 🤖

    if (!config.enableControlFlowRunCoalesce) return null;
    const minInstr = config.controlFlowRunMinInstr | 0;
    if (minInstr <= 0) return null;

    let instrCount = 0;
    let end = startIndex - 1;

    for (let i = startIndex; i < sorted.length; i++) {
      const b = sorted[i];
      if (!b || !isControlFlowOnlyBlock(b)) break;
      if (i > startIndex) {
        const prev = sorted[i - 1];
        if (!isContiguous(prev, b)) break;
      }

      instrCount += b?.lines?.length || 0;
      end = i;
    }

    if (instrCount >= minInstr && end >= startIndex) return end;
    return null;
  }

  for (let i = 0; i < sorted.length; ) {
    const leader = sorted[i];
    const leaderId = leader?.id;
    if (!leader || !leaderId) {
      i++;
      continue;
    }

    const memberIds = [];
    const memberInstances = new Map(); // key -> instance (dedupe) 🤖
    const mergedLines = [];
    let mergedConf = leader.confidence || 'certain';
    let romStart = leader.romStart;
    let romEnd = leader.romEnd;

    let j = i;
    let controlFlowRunUntil = null; // end index (inclusive) of an active control-flow-only run coalesce. 🤖
    while (j < sorted.length) {
      const b = sorted[j];
      if (!b || !b.id) break;

      memberIds.push(b.id);
      blockAliases[b.id] = leaderId;
      mergedConf = bestOf(mergedConf, b.confidence || 'certain');
      romStart = Math.min(romStart, b.romStart ?? romStart);
      romEnd = Math.max(romEnd, b.romEnd ?? romEnd);

      for (const inst of b.instances || []) {
        const ctxId = inst?.ctxId || 'nrom';
        const cpuStart = inst?.cpuStart;
        if (typeof cpuStart !== 'number') continue;
        const key = `${ctxId}:${cpuStart & 0xffff}`;
        if (!memberInstances.has(key)) memberInstances.set(key, { ctxId, cpuStart: cpuStart & 0xffff });
      }

      // Copy line objects (shallow) so the coalesced view can safely add annotations later without mutating the raw CFG. 🤖
      for (const ln of b.lines || []) {
        mergedLines.push({ ...ln });
      }

      const last = b.lines?.[b.lines.length - 1];
      const f = last?.flow;

      const next = sorted[j + 1];
      const canContinue = isContiguous(b, next);
      if (!canContinue) {
        j++;
        break;
      }

      // Late-stage readability rule: if this is (or begins) a long ROM-contiguous run of nothing-but
      // branches / JMP / JSR, keep the entire run as a single display block. 🤖
      //
      // When active, we ignore normal terminators (branch/jump) until the run ends. 🤖
      if (controlFlowRunUntil !== null) {
        if (j < controlFlowRunUntil) {
          j++;
          continue;
        }
        // End the coalesced block at the end of the run to avoid swallowing subsequent non-control-flow code. 🤖
        if (j === controlFlowRunUntil) {
          // Tweak: if the last instruction in the run is a JSR, treat the next block as part of the
          // same display block. This avoids creating an artificial boundary for "call-heavy" runs,
          // since the JSR is expected to return (usually). 🤖
          const runLast = b?.lines?.[b.lines.length - 1];
          const endsWithJsr = runLast?.mnemonic === 'JSR' && runLast?.flow?.type === 'call';
          if (endsWithJsr) {
            controlFlowRunUntil = null;
            j++;
            continue;
          }

          // Normally we end the coalesced block at the end of the run, but if the next block
          // is a bare RTS (a common alignment/guard oddity), swallow it into this display block.
          // This keeps weird "... JMP ...; RTS" / trailing-RTS artifacts from splitting the view.
          const afterRun = sorted[j + 1];
          if (isBareRtsBlock(afterRun)) {
            j++;
            continue;
          }

          j++;
          break;
        }
        controlFlowRunUntil = null;
      } else {
        const runEnd = findControlFlowRunEndIndex(j);
        if (typeof runEnd === 'number' && runEnd > j) {
          controlFlowRunUntil = runEnd;
          j++;
          continue;
        }
      }

      // Calls never end a coalesced block. 🤖
      if (f?.type === 'call') {
        j++;
        continue;
      }

      // Conditional branches: inline only when heuristics say it's a "local" structure (or a loop). 🤖
      if (f?.type === 'branch') {
        if (shouldInlineBranch(b, j)) {
          j++;
          continue;
        }
        // Even if we end a display block on a branch, swallow a following bare RTS block.
        // These often show up due to alignment or odd compiler/hand-asm artifacts.
        const nextBlock = sorted[j + 1];
        if (isBareRtsBlock(nextBlock)) {
          j++;
          continue;
        }

        j++;
        break;
      }

      // Unconditional JMP: normally ends a display block, except for the common "branch skips a near JMP" pattern. 🤖
      if (f?.type === 'jump') {
        const prev = sorted[j - 1];
        if (isSkippableJmpStub(prev, b, j)) {
          j++;
          continue;
        }
        // Same "bare RTS" swallow rule as above.
        const nextBlock = sorted[j + 1];
        if (isBareRtsBlock(nextBlock)) {
          j++;
          continue;
        }

        j++;
        break;
      }

      // Stops / illegal opcodes / unresolved indirects end the display block. 🤖
      if (f?.type === 'stop' || f?.type === 'illegal' || f?.type === 'jmp_ind') {
        // Special-case: "branch skips early RTS" guard clauses should stay contiguous in the
        // coalesced display view. If the previous block branches over this RTS to nearby code,
        // keep merging so the whole routine reads as one unit. 🤖
        if (f?.type === 'stop' && last?.mnemonic === 'RTS') {
          const prev = sorted[j - 1];
          if (isEarlyReturnRtsBlock(prev, b, j)) {
            j++;
            continue;
          }
        }

        // Always coalesce a following bare-RTS block into the previous display block, regardless
        // of what ended the previous one.
        const nextBlock = sorted[j + 1];
        if (isBareRtsBlock(nextBlock)) {
          j++;
          continue;
        }

        j++;
        break;
      }

      // Default: keep merging straight-line regions. 🤖
      j++;
    }

    const cpuStart = mergedLines?.[0]?.cpuAddr;
    const lastLine = mergedLines?.[mergedLines.length - 1];
    const cpuEnd = lastLine && typeof lastLine.cpuAddr === 'number' && typeof lastLine.len === 'number'
      ? ((lastLine.cpuAddr + lastLine.len) & 0xffff)
      : null;

    coalescedBlocks.push({
      id: leaderId,
      romStart,
      romEnd,
      confidence: mergedConf,
      instances: Array.from(memberInstances.values()),
      memberBlockIds: memberIds,
      cpuStart: typeof cpuStart === 'number' ? (cpuStart & 0xffff) : null,
      cpuEnd,
      lines: mergedLines
    });

    i = j;
  }

  const coalescedTimeline = coalesceTimeline(rawAnalysis.timeline, blockAliases);

  const stats = { ...(rawAnalysis.stats || {}) };
  if (typeof stats.blockCount === 'number') {
    stats.rawBlockCount = stats.blockCount;
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

  return { analysis, blockAliases };
}

function coalesceTimeline(timeline, blockAliases) {
  const inItems = Array.isArray(timeline) ? timeline : [];
  const out = [];

  for (const it of inItems) {
    if (!it || it.type !== 'code') {
      out.push(it);
      continue;
    }

    const mappedId = blockAliases?.[it.blockId] || it.blockId;
    const prev = out[out.length - 1];

    if (
      prev &&
      prev.type === 'code' &&
      prev.blockId === mappedId &&
      typeof prev.romEnd === 'number' &&
      typeof it.romStart === 'number' &&
      prev.romEnd === it.romStart
    ) {
      // Merge consecutive code timeline items that belong to the same coalesced block. 🤖
      prev.romEnd = it.romEnd;
      prev.byteLen = (prev.romEnd - prev.romStart) | 0;
    } else {
      out.push({ ...it, blockId: mappedId });
    }
  }
  return out;
}
