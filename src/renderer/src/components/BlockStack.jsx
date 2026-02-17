import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { BlockCard } from './BlockCard.jsx';
import { hex6 } from '../util/hex.js';
import { GapCard } from './GapCard.jsx';

export function BlockStack({
  timeline,
  blocksById,
  focusLocation,
  markedPoiSpan,
  onFocused,
  onNavigateToCpuAddr,
  canNavigateCpuAddr,
  resolveBlockIdForCpuAddr,
  labelsByRomOff,
  labelsByAddr,
  onHoverLine,
  onContextMenuLine,
  onContextMenuBlock,
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

        const anchorRomOff = focusLocation?.anchorRomOff;
        if (typeof anchorRomOff === 'number') {
          const blockEl = document.getElementById(`nv-block-${blockId}`);
          const container = parentRef.current;
          if (blockEl && container) {
            // Match the romOff column text (hex6), since we don't have an explicit data attribute.
            const targetText = hex6(anchorRomOff);
            const cells = blockEl.querySelectorAll('.nv-col-romoff');
            let targetEl = null;
            for (const c of cells) {
              if ((c.textContent || '').trim() === targetText) {
                targetEl = c;
                break;
              }
            }

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
        <div className="nv-empty-title">No analysis yet</div>
        <div className="nv-empty-sub">Load a ROM, then run static analysis to see discovered blocks.</div>
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
                <GapCard item={item} />
              </div>
            );
          }

          const blockId = item.blockId;
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
                markedPoiSpan={markedPoiSpan}
                onNavigateToCpuAddr={onNavigateToCpuAddr}
                canNavigateCpuAddr={canNavigateCpuAddr}
                resolveBlockIdForCpuAddr={resolveBlockIdForCpuAddr}
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
