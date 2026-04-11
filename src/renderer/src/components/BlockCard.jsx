import { useEffect, useMemo, useState } from 'react';

import { hex4, hex6 } from '../util/hex.js';
import { CodeLines } from './CodeLines.jsx';
import { UNKNOWN_FETCH_CTX_KEY } from '../../../shared/analyze/fetchContext.js';

function rangeText(start, end) {
  return `${hex6(start)}–${hex6(end)}`;
}

function cpuText(cpuStart) {
  return typeof cpuStart === 'number' ? `$${hex4(cpuStart)}` : '—';
}

export function BlockCard({
  item,
  blockIndex,
  blockFull,
  isExpanded,
  isLoading,
  isFocused,
  markedPoiSpan,
  onNavigateToCpuAddr,
  canNavigateCpuAddr,
  resolveBlockIdForCpuAddr,
  labelsBySite,
  labelsByAddr,
  onToggleExpanded,
  onHoverLine,
  onContextMenuLine,
  onContextMenuBlock
}) {
  const inst = blockIndex?.instances?.[0];
  const ctxId = inst?.ctxId || UNKNOWN_FETCH_CTX_KEY;
  const cpuStart = inst?.cpuStart;
  const romStart = blockIndex?.romStart ?? item.romStart;
  const romEnd = blockIndex?.romEnd ?? item.romEnd;
  const confidence = blockIndex?.confidence || 'certain';
  const pills = Array.isArray(blockIndex?.pills) ? blockIndex.pills : [];
  const firstLine = blockFull?.lines?.[0] || blockIndex?.previewLines?.[0] || null;
  const firstSiteKey = typeof firstLine?.siteKey === 'string' ? firstLine.siteKey : null;
  const firstCtxKey = typeof firstLine?.ctxKey === 'string' ? firstLine.ctxKey : ctxId;
  const label = (firstSiteKey && labelsBySite && typeof labelsBySite === 'object')
    ? (labelsBySite[firstSiteKey]?.label || '')
    : '';

  const lines = useMemo(() => {
    if (isExpanded && blockFull?.lines) return blockFull.lines;
    return blockIndex?.previewLines || [];
  }, [isExpanded, blockFull, blockIndex]);

  const lineCount = blockFull?.lines?.length ?? blockIndex?.lineCount ?? lines.length;
  const showingCount = lines.length;

  const inbound = blockIndex?.inbound;
  const [inboundShown, setInboundShown] = useState(4);

  // Reset truncation when switching to a different block card. 🤖
  useEffect(() => {
    setInboundShown(4);
  }, [item.blockId]);

  const inboundTotal = inbound?.count || 0;
  const inboundSources = inbound?.sources || [];
  const inboundShowN = Math.min(inboundTotal, inboundShown);
  const inboundHidden = Math.max(0, inboundTotal - inboundShowN);

  function onInboundMore() {
    // First click: show 20 more (4 -> 24). Subsequent click uses the "show N more" button.
    setInboundShown((n) => Math.min(inboundTotal, n + 20));
  }

  function onInboundShowAll() {
    setInboundShown(inboundTotal);
  }

  function onTopRowClick() {
    onToggleExpanded();
  }

  function onTopRowKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggleExpanded();
    }
  }

  return (
    <section
      id={`nv-block-${item.blockId}`}
      className={`nv-card nv-code ${confidence === 'probable' ? 'is-probable' : ''} ${isFocused ? 'is-focused' : ''}`}
    >
      <div
        className="nv-card-header nv-code-toprow"
        role="button"
        tabIndex={0}
        onClick={onTopRowClick}
        onKeyDown={onTopRowKeyDown}
        onContextMenu={(e) => {
          if (!onContextMenuBlock) return;
          e.preventDefault();
          e.stopPropagation();
          onContextMenuBlock({ blockId: item.blockId, siteKey: firstSiteKey, ctxKey: firstCtxKey, romOff: firstLine?.romOff ?? romStart, cpuAddr: firstLine?.cpuAddr ?? cpuStart }, e.clientX, e.clientY);
        }}
        aria-label={isExpanded ? 'Collapse block' : 'Expand block'}
        title={isExpanded ? 'Collapse' : 'Expand'}
      >
        <div className="nv-card-header-left">
          <div className="nv-card-title">{(label ? label : 'Code')}{confidence === 'probable' ? ' (probable)' : ''}</div>
        </div>

        <div className="nv-card-actions">
          <button
            type="button"
            className="nv-disclosure"
            onClick={(e) => {
              // Prevent double toggle due to the parent click handler.
              e.stopPropagation();
              onToggleExpanded();
            }}
            aria-label={isExpanded ? 'Collapse block' : 'Expand block'}
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? '▼' : '▶'}
          </button>
        </div>
      </div>

      <div className="nv-code-header-extra">
        <div className="nv-card-sub">
          <span className="nv-sub-rom">{rangeText(romStart, romEnd)}</span>
          <span className="nv-sub-dot">·</span>
          <span className="nv-sub-cpu">CPU {cpuText(cpuStart)}</span>
          <span className="nv-sub-dot">·</span>
          <span className="nv-sub-bytes">{item.byteLen} bytes</span>
        </div>

        {inboundTotal > 0 ? (
          <div className="nv-inbound">
            <div className="nv-inbound-label">Inbound: {inboundTotal}</div>
            <div className="nv-inbound-addrs">
              {inboundSources.slice(0, inboundShowN).map((src, idx) => {
                const fromCpu = src?.fromCpuAddr;
                const fromCtxKey = typeof src?.fromCtxKey === 'string' ? src.fromCtxKey : ctxId;
                const key = String(src?.fromSiteKey ?? src?.fromRomOff ?? fromCpu ?? idx);
                const isLink = typeof fromCpu === 'number' && canNavigateCpuAddr(fromCpu, fromCtxKey);
                return (
                  <button
                    key={key}
                    type="button"
                    className={`nv-inbound-addr ${isLink ? 'nv-link' : ''}`}
                    onClick={() => {
                      if (!isLink) return;
                      onNavigateToCpuAddr(fromCpu, fromCtxKey);
                    }}
                    disabled={!isLink}
                    title={typeof fromCpu === 'number' ? `Go to ${cpuText(fromCpu)}` : 'Unknown CPU address'}
                  >
                    {cpuText(fromCpu)}
                  </button>
                );
              })}

              {inboundHidden > 0 && inboundShown <= 4 ? (
                <button type="button" className="nv-inbound-more nv-link" onClick={onInboundMore}>...</button>
              ) : null}

              {inboundHidden > 0 && inboundShown > 4 ? (
                <button type="button" className="nv-inbound-more nv-link" onClick={onInboundShowAll}>
                  show {inboundHidden} more
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {pills.length > 0 ? (
          <div className="nv-pills">
            {pills.map((p) => (
              <span key={p} className="nv-pill">{p}</span>
            ))}
          </div>
        ) : null}
      </div>

      {isExpanded ? (
        <div className="nv-card-body">
          {isLoading ? <div className="nv-muted">Loading…</div> : null}
          <CodeLines
            lines={lines}
            currentBlockId={item.blockId}
            ctxId={ctxId}
            labelsBySite={labelsBySite}
            labelsByAddr={labelsByAddr}
            onNavigateToCpuAddr={onNavigateToCpuAddr}
            canNavigateCpuAddr={canNavigateCpuAddr}
            resolveBlockIdForCpuAddr={resolveBlockIdForCpuAddr}
            onHoverLine={onHoverLine}
            onContextMenuLine={onContextMenuLine}
            markedPoiSpan={markedPoiSpan}
          />

          {lineCount > showingCount ? (
            <div className="nv-card-footer">
              Showing {showingCount} of {lineCount} lines
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
