import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { BlockCard } from './BlockCard.jsx';
import { hex4 } from '../util/hex.js';
import { GapCard } from './GapCard.jsx';

export function BlockStack({
  timeline,
  blocksById,
  focusLocation,
  markedRomSpan,
  isLoadingCachedAnalysis = false,
  onFocused,
  onNavigateToRomOff,
  labelsByRomOff,
  labelsByAddr,
  onHoverLine,
  onContextMenuLine,
  onContextMenuBlock,
  onContextMenuGap,
  shownGapBytesByKey,
  gapBytesByKey,
  gapBytesLoadingByKey,
  analysisDebug,
  showDebugInfo = false,
  apiRef
}) {
  const [expandedById, setExpandedById] = useState({});
  const [loadingById, setLoadingById] = useState({});
  const [blockCache, setBlockCache] = useState({});
  const [flashId, setFlashId] = useState(null);

  const prefetchSeenRef = useRef(new Set());
  const parentRef = useRef(null);

  const codeItems = useMemo(() => timeline.filter((t) => t.type === 'code'), [timeline]);
  const hasAny = timeline && timeline.length > 0;
  const hasCode = codeItems.length > 0;


  function parseBytesLen(bytesText) {
    if (typeof bytesText !== 'string') return 0;
    return bytesText.trim().split(/\s+/).filter(Boolean).length;
  }

  function findPrevCodeItem(index) {
    for (let i = index - 1; i >= 0; i -= 1) {
      const it = timeline[i];
      if (it?.type === 'code') return it;
    }
    return null;
  }

  function mapDecodeFailureReason(reason) {
    if (reason === 'cdl_data') return 'start site is marked data-only by CDL';
    if (reason === 'unmapped' || reason === 'non_exact_backing') return 'start site did not have exact fetch backing';
    if (reason === 'illegal') return 'start site decode failed immediately';
    if (reason) return `attempted start failed (${reason})`;
    return 'attempted start failed';
  }

  function leaderReasonPriority(reason) {
    switch (reason?.kind) {
      case 'branch_target': return 0;
      case 'jump_target': return 1;
      case 'call_target': return 2;
      case 'mapper_split': return 3;
      case 'seed_entry': return 4;
      case 'probable_seed': return 5;
      case 'fallthrough_seed': return 6;
      default: return 99;
    }
  }

  function formatLeaderReason(reason, nextCpu) {
    if (!reason || typeof reason !== 'object') return null;
    const src = typeof reason.fromPc === 'number' ? `$${hex4(reason.fromPc)}` : 'an unknown site';
    const dst = `$${hex4(typeof reason.targetPc === 'number' ? reason.targetPc : nextCpu)}`;
    const mnemonic = typeof reason.mnemonic === 'string' && reason.mnemonic ? reason.mnemonic : 'flow';
    switch (reason.kind) {
      case 'branch_target':
        return `Marked hard because ${mnemonic} at ${src} targets ${dst}.`;
      case 'jump_target':
        return `Marked hard because ${mnemonic} at ${src} jumps to ${dst}.`;
      case 'call_target':
        return `Marked hard because ${mnemonic} at ${src} calls ${dst}.`;
      case 'mapper_split':
        return `Marked hard because a mapper-write split after ${mnemonic} at ${src} starts a new block at ${dst}.`;
      case 'seed_entry':
        return `Marked hard because ${dst} was seeded as an entry/start site.`;
      case 'probable_seed':
        return `Marked hard because ${dst} was promoted as a probable start site.`;
      case 'fallthrough_seed':
        return `Marked hard because control flow from ${src} explicitly scheduled fallthrough to ${dst}.`;
      default:
        return null;
    }
  }

  function synthesizeGapDebugReason(item, index) {
    if (!showDebugInfo) return [];
    const prevItem = findPrevCodeItem(index);
    if (!prevItem) return ['No preceding decoded block to infer a likely start location.'];
    const prevFull = blockCache[prevItem.blockId] || null;
    const prevLines = Array.isArray(prevFull?.lines) ? prevFull.lines : [];
    const lastLine = prevLines.length ? prevLines[prevLines.length - 1] : null;
    if (!lastLine) return ['Preceding block is not fully loaded yet.'];

    const lastRomOff = typeof lastLine.romOff === 'number' ? (lastLine.romOff >>> 0) : null;
    const lastLen = parseBytesLen(lastLine.bytesText);
    if (lastRomOff === null || !(lastLen > 0)) return ['Could not infer the next ROM location after the preceding block.'];

    const nextRomOff = (lastRomOff + lastLen) >>> 0;
    const flowType = lastLine?.flow?.type || null;
    if (flowType === 'next') {
      return [`Likely split near ROM ${hex4(nextRomOff & 0xffff)} that did not materialize as a block.`];
    }
    return ['Likely an undecoded island between discovered blocks.'];
  }

  const blockIdToTimelineIndex = useMemo(() => {
    const m = new Map();
    for (let i = 0; i < timeline.length; i++) {
      const it = timeline[i];
      if (it?.type === 'code' && it.blockId) {
        m.set(it.blockId, i);
      }
    }
    return m;
  }, [timeline]);

  const rowVirtualizer = useVirtualizer({
    count: timeline.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const it = timeline[index];
      if (!it) return 160;
      // Rough estimates; dynamic heights are measured via measureElement.
      return it.type === 'code' ? 260 : 70;
    },
    overscan: 10,
    getItemKey: (index) => {
      const it = timeline[index];
      if (!it) return `idx:${index}`;
      if (it.type === 'code') return `code:${it.blockId}`;
      return `gap:${it.type}:${it.romStart}:${it.romEnd}`;
    }
  });

  // Expose a tiny imperative API so the app can snapshot "where you are" at click time
  // (used for the backspace navigation stack). This is intentionally independent of
  // focusBlockId and does NOT update during normal scrolling.
  useEffect(() => {
    if (!apiRef) return;
    if (!apiRef.current) apiRef.current = {};

    apiRef.current.getTopVisibleBlockId = () => {
      const el = parentRef.current;
      if (!el) return null;
      const scrollTop = el.scrollTop;
      const vitems = rowVirtualizer.getVirtualItems();
      if (!vitems || vitems.length === 0) return null;

      // Find the first row whose bottom edge is below the top of the viewport.
      // (Overscan means vitems[0] may start above the viewport.)
      let candidate = null;
      for (const vr of vitems) {
        const bottom = (vr.start || 0) + (vr.size || 0);
        if (bottom > scrollTop) {
          candidate = vr;
          break;
        }
      }
      if (!candidate) candidate = vitems[0];

      // Prefer a code item; if this is a gap row, pick the nearest code row after it.
      let idx = candidate.index;
      while (idx < timeline.length && timeline[idx]?.type !== 'code') idx++;
      if (idx >= timeline.length) {
        idx = candidate.index;
        while (idx >= 0 && timeline[idx]?.type !== 'code') idx--;
      }
      const it = idx >= 0 ? timeline[idx] : null;
      return it?.type === 'code' ? it.blockId : null;
    };

    return () => {
      if (apiRef?.current?.getTopVisibleBlockId) {
        delete apiRef.current.getTopVisibleBlockId;
      }
    };
    // We want the closure to see fresh timeline + virtualizer.
  }, [apiRef, rowVirtualizer, timeline]);

  useEffect(() => {
    // After a new analysis run, default to expanded blocks and prefetch full block lines. 🤖
    // The previewLines can be empty depending on backend shaping; full blocks are authoritative. 🤖
    if (!hasCode) return;

    // Reset caches when the timeline changes (new analysis). 🤖
    prefetchSeenRef.current = new Set();
    setBlockCache({});
    setLoadingById({});

    // Expand everything by default (user can collapse if desired). 🤖
    setExpandedById(() => {
      const next = {};
      for (const it of codeItems) next[it.blockId] = true;
      return next;
    });

    let cancelled = false;
    (async () => {
      const allIds = [];
      for (const it of codeItems) {
        const blockId = it.blockId;
        if (!blockId) continue;
        if (prefetchSeenRef.current.has(blockId)) continue;
        prefetchSeenRef.current.add(blockId);
        allIds.push(blockId);
      }

      // Fetch blocks in batches to reduce IPC overhead while still eagerly loading all data. 🤖
      const CHUNK = 100;
      for (let i = 0; i < allIds.length; i += CHUNK) {
        if (cancelled) return;
        const batch = allIds.slice(i, i + CHUNK);

        setLoadingById((p) => {
          const n = { ...p };
          for (const id of batch) n[id] = true;
          return n;
        });

        try {
          const res = await window.nesviz.getBlocks(batch);
          if (cancelled) return;
          if (res.ok && Array.isArray(res.blocks)) {
            setBlockCache((p) => {
              const n = { ...p };
              for (const b of res.blocks) {
                if (b?.id) n[b.id] = b;
              }
              return n;
            });
          }
        } finally {
          setLoadingById((p) => {
            const n = { ...p };
            for (const id of batch) delete n[id];
            return n;
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasCode, codeItems]);

  async function ensureBlockLoaded(blockId) {
    if (!blockId) return;
    if (blockCache[blockId]) return;
    if (loadingById[blockId]) return;

    setLoadingById((p) => ({ ...p, [blockId]: true }));
    const res = await window.nesviz.getBlock(blockId);
    if (res.ok) {
      setBlockCache((p) => ({ ...p, [blockId]: res.block }));
    }
    setLoadingById((p) => {
      const n = { ...p };
      delete n[blockId];
      return n;
    });
  }

  function setExpanded(blockId, value) {
    setExpandedById((p) => ({ ...p, [blockId]: value }));
  }

  useEffect(() => {
    const blockId = focusLocation?.blockId;
    if (!blockId) return;

    let cancelled = false;

    async function go() {
      // If an artifact navigates to a block, expand it and try to load the full lines.
      setExpanded(blockId, true);

      const idx = blockIdToTimelineIndex.get(blockId);
      await ensureBlockLoaded(blockId);
      if (cancelled) return;

      if (typeof idx === 'number') {
        // First jump (uses estimates for far-away rows).
        rowVirtualizer.scrollToIndex(idx, { align: 'start', behavior: 'auto' });

        // Wait until the row is actually rendered.
        for (let i = 0; i < 10; i++) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => window.requestAnimationFrame(r));
          if (cancelled) return;
          const el = document.getElementById(`nv-block-${blockId}`);
          if (el) break;
          // Nudge again after a couple frames in case measurement drift pushed it away.
          if (i === 2 || i === 6) {
            rowVirtualizer.scrollToIndex(idx, { align: 'start', behavior: 'auto' });
          }
        }

        // Second jump after measurement stabilizes (very important for expandable rows).
        rowVirtualizer.scrollToIndex(idx, { align: 'start', behavior: 'auto' });

        // Give React a tick to render the expanded lines.
        await new Promise((r) => window.requestAnimationFrame(r));
        if (cancelled) return;

        const focusRomOff = focusLocation?.focusRomOff;
        if (typeof focusRomOff === 'number') {
          const blockEl = document.getElementById(`nv-block-${blockId}`);
          const container = parentRef.current;
          if (blockEl && container) {
            const targetEl = blockEl.querySelector(`.nv-line[data-rom-off="${focusRomOff >>> 0}"]`);

            if (targetEl) {
              const cRect = container.getBoundingClientRect();
              const tRect = targetEl.getBoundingClientRect();
              const delta = tRect.top - cRect.top;
              // Keep a small breathing room at the top.
              container.scrollTop += (delta - 8);
            }
          }
        }

        setFlashId(blockId);
        window.setTimeout(() => setFlashId(null), 1200);
      }

      onFocused?.();
    }

    go();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLocation]);

  if (!hasAny) {
    return (
      <div className="nv-empty">
        <div className="nv-empty-title">{isLoadingCachedAnalysis ? 'Loading cached analysis' : 'No analysis yet'}</div>
        <div className="nv-empty-sub">
          {isLoadingCachedAnalysis
            ? 'Cached analysis was detected for this ROM and is loading now.'
            : 'Load a ROM, then run static analysis to see discovered blocks.'}
        </div>
      </div>
    );
  }

  if (!hasCode) {
    return (
      <div className="nv-empty">
        <div className="nv-empty-title">No code discovered</div>
        <div className="nv-empty-sub">Try a different ROM, or verify the reset vector is valid for mapper 0.</div>
      </div>
    );
  }

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="nv-stack" ref={parentRef}>
      <div className="nv-virt-inner" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {virtualItems.map((vr) => {
          const item = timeline[vr.index];
          if (!item) return null;

          const rowStyle = {
            transform: `translateY(${vr.start}px)`
          };

          if (item.type !== 'code') {
            return (
              <div
                key={vr.key}
                data-index={vr.index}
                ref={rowVirtualizer.measureElement}
                className="nv-virt-row"
                style={rowStyle}
              >
                <GapCard
                  item={item}
                  showBytes={!!shownGapBytesByKey?.[item.gapKey || `gap:${item.type}:${item.romStart}:${item.romEnd}`]}
                  bytesText={gapBytesByKey?.[item.gapKey || `gap:${item.type}:${item.romStart}:${item.romEnd}`] || ''}
                  isLoadingBytes={!!gapBytesLoadingByKey?.[item.gapKey || `gap:${item.type}:${item.romStart}:${item.romEnd}`]}
                  onContextMenuGap={onContextMenuGap}
                  showDebugInfo={showDebugInfo}
                  debugReasons={synthesizeGapDebugReason(item, vr.index)}
                />
              </div>
            );
          }

          const blockId = item.blockId;
          if (!blockId) {
            return (
              <div
                key={vr.key}
                data-index={vr.index}
                ref={rowVirtualizer.measureElement}
                className="nv-virt-row"
                style={rowStyle}
              >
                <GapCard
                  item={item}
                  showBytes={!!shownGapBytesByKey?.[item.gapKey || `gap:${item.type}:${item.romStart}:${item.romEnd}`]}
                  bytesText={gapBytesByKey?.[item.gapKey || `gap:${item.type}:${item.romStart}:${item.romEnd}`] || ''}
                  isLoadingBytes={!!gapBytesLoadingByKey?.[item.gapKey || `gap:${item.type}:${item.romStart}:${item.romEnd}`]}
                  onContextMenuGap={onContextMenuGap}
                  showDebugInfo={showDebugInfo}
                  debugReasons={synthesizeGapDebugReason(item, vr.index)}
                />
              </div>
            );
          }
          const b = blocksById.get(blockId);
          const full = blockCache[blockId];
          const isExpanded = !!expandedById[blockId];
          const isLoading = !!loadingById[blockId];
          const isFocused = flashId === blockId;

          return (
            <div
                key={vr.key}
                data-index={vr.index}
                ref={rowVirtualizer.measureElement}
                className="nv-virt-row"
                style={rowStyle}
              >
              <BlockCard
                item={item}
                blockIndex={b}
                blockFull={full}
                isExpanded={isExpanded}
                isLoading={isLoading}
                isFocused={isFocused}
                markedRomSpan={markedRomSpan}
                onNavigateToRomOff={onNavigateToRomOff}
                labelsByRomOff={labelsByRomOff}
                labelsByAddr={labelsByAddr}
                onHoverLine={onHoverLine}
                onContextMenuLine={onContextMenuLine}
                onContextMenuBlock={onContextMenuBlock}
                onToggleExpanded={async () => {
                  const next = !isExpanded;
                  setExpanded(blockId, next);
                  if (next) {
                    await ensureBlockLoaded(blockId);
                  }
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
