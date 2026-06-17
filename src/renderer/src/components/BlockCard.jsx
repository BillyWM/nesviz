import { useEffect, useMemo, useState } from 'react';

import { hex4, hex6 } from '../util/hex.js';
import { CodeLines } from './CodeLines.jsx';

function rangeText(start, end) {
  return `${hex6(start)}–${hex6(end)}`;
}

function cpuText(cpuStart) {
  return typeof cpuStart === 'number' ? `$${hex4(cpuStart)}` : '—';
}

function normalizeBlockConfidence(confidence) {
  if (confidence === 'mixed') return 'mixed';
  if (confidence === 'probable') return 'probable';
  return 'certain';
}

function codeTitle(baseLabel, confidence) {
  const base = baseLabel || 'Code';
  if (confidence === 'mixed') return `${base} (mixed)`;
  if (confidence === 'probable') return `${base} (probable)`;
  return base;
}

function promotionDebugEntries(debug) {
  const entries = Array.isArray(debug?.entries) ? debug.entries : [];
  return entries.filter((entry) => entry && typeof entry === 'object');
}

function promotionReasonText(entry) {
  if (typeof entry?.acceptedReasonLabel === 'string' && entry.acceptedReasonLabel) return entry.acceptedReasonLabel;
  if (typeof entry?.acceptedReason === 'string' && entry.acceptedReason) return entry.acceptedReason;
  return 'accepted as probable code';
}

function promotionEvidenceText(entry) {
  const labels = Array.isArray(entry?.evidenceLabels) ? entry.evidenceLabels : [];
  const kinds = Array.isArray(entry?.evidenceKinds) ? entry.evidenceKinds : [];
  const values = labels.length > 0 ? labels : kinds;
  return values.filter((value) => typeof value === 'string' && value).join(', ');
}


function bankVariantKey(variant, idx) {
  if (variant && typeof variant.blockId === 'string') return variant.blockId;
  if (variant && typeof variant.romStart === 'number') return `rom:${variant.romStart >>> 0}`;
  return `idx:${idx}`;
}

function buildBankVariantSlots(variants) {
  const variantsByBank = new Map();
  for (const variant of variants) {
    if (!variant || !Number.isFinite(variant.bankIndex)) continue;
    const bankIndex = Math.trunc(variant.bankIndex);
    if (bankIndex < 0) continue;
    if (!variantsByBank.has(bankIndex)) variantsByBank.set(bankIndex, variant);
  }

  const bankIndexes = [...variantsByBank.keys()];
  if (bankIndexes.length === 0) return [];

  const maxBankIndex = Math.max(...bankIndexes);
  const slots = [];
  for (let bankIndex = 0; bankIndex <= maxBankIndex; bankIndex += 1) {
    slots.push({ bankIndex, variant: variantsByBank.get(bankIndex) || null });
  }
  return slots;
}

function BankVariantSelector({ currentBlockId, bankVariant, bankVariants, onSelectBankVariant }) {
  if (!bankVariant) return null;
  const variants = Array.isArray(bankVariants) && bankVariants.length > 0 ? bankVariants : [bankVariant];
  const slots = buildBankVariantSlots(variants);

  return (
    <div className="nv-bank-row" aria-label="ROM bank variants">
      <span className="nv-bank-row-label">Bank</span>
      <div className="nv-bank-selector">
        {slots.map(({ bankIndex, variant }) => {
          if (!variant) {
            return (
              <span
                key={`missing:${bankIndex}`}
                className="nv-bank-button nv-bank-button-empty"
                aria-hidden="true"
              />
            );
          }

          const label = typeof variant.bankLabel === 'string' && variant.bankLabel ? variant.bankLabel : String(bankIndex);
          const isCurrent = variant.blockId === currentBlockId;
          return (
            <button
              key={bankVariantKey(variant, bankIndex)}
              type="button"
              className={`nv-bank-button ${isCurrent ? 'is-selected' : ''}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!isCurrent && typeof variant.blockId === 'string') {
                  onSelectBankVariant?.(variant);
                }
              }}
              title={typeof variant.romStart === 'number' ? `Bank ${label} · ROM ${hex6(variant.romStart >>> 0)}` : `Bank ${label}`}
              aria-current={isCurrent ? 'true' : undefined}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PromotionDebug({ entries }) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const showNumbers = entries.length > 1;

  return (
    <div className="nv-block-debug">
      {entries.map((entry, idx) => {
        const reason = promotionReasonText(entry);
        const evidence = promotionEvidenceText(entry);
        const prefix = showNumbers ? `${idx + 1}/${entries.length}: ` : '';
        return (
          <div key={`${entry.rawBlockId || 'entry'}:${idx}`} className="nv-block-debug-section">
            <div className="nv-block-debug-line">{prefix}{reason}</div>
            {evidence ? <div className="nv-block-debug-line">Evidence: {evidence}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

export function BlockCard({
  item,
  blockIndex,
  blockFull,
  isExpanded,
  isLoading,
  isFocused,
  markedRomSpan,
  onNavigateToRomOff,
  onSelectBankVariant,
  labelsByRomOff,
  labelsByAddr,
  showDebugInfo = false,
  showNamedConstants = true,
  mapper = null,
  onToggleExpanded,
  onHoverLine,
  onContextMenuLine,
  onContextMenuBlock
}) {
  const cpuStart = blockIndex?.cpuStart;
  const romStart = blockIndex?.romStart ?? item.romStart;
  const romEnd = blockIndex?.romEnd ?? item.romEnd;
  const confidence = normalizeBlockConfidence(blockIndex?.confidence);
  const pills = Array.isArray(blockIndex?.pills) ? blockIndex.pills : [];
  const promotionDebug = blockFull?.probablePromotionDebug || blockIndex?.probablePromotionDebug || null;
  const promotionDebugEntriesForHeader = showDebugInfo && (confidence === 'probable' || confidence === 'mixed')
    ? promotionDebugEntries(promotionDebug)
    : [];
  const firstLine = blockFull?.lines?.[0] || blockIndex?.previewLines?.[0] || null;
  const firstRomOff = typeof firstLine?.romOff === 'number' ? (firstLine.romOff >>> 0) : (typeof romStart === 'number' ? (romStart >>> 0) : null);
  const label = (firstRomOff !== null && labelsByRomOff && typeof labelsByRomOff === 'object')
    ? (labelsByRomOff[String(firstRomOff)]?.label || '')
    : '';

  const lines = useMemo(() => {
    if (isExpanded && blockFull?.lines) return blockFull.lines;
    return blockIndex?.previewLines || [];
  }, [isExpanded, blockFull, blockIndex]);

  const loopGuides = isExpanded && Array.isArray(blockFull?.loopGuides)
    ? blockFull.loopGuides
    : (Array.isArray(blockIndex?.loopGuides) ? blockIndex.loopGuides : []);

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

  function onBlockHeaderContextMenu(e) {
    if (!onContextMenuBlock) return;
    e.preventDefault();
    e.stopPropagation();
    onContextMenuBlock({
      blockId: item.blockId,
      romOff: firstLine?.romOff ?? romStart,
      cpuAddr: firstLine?.cpuAddr ?? cpuStart
    }, e.clientX, e.clientY);
  }

  return (
    <section
      id={`nv-block-${item.blockId}`}
      className={`nv-card nv-code is-${confidence} ${isFocused ? 'is-focused' : ''}`}
    >
      <div
        className="nv-card-header nv-code-toprow"
        role="button"
        tabIndex={0}
        onClick={onTopRowClick}
        onKeyDown={onTopRowKeyDown}
        onContextMenu={onBlockHeaderContextMenu}
        aria-label={isExpanded ? 'Collapse block' : 'Expand block'}
        title={isExpanded ? 'Collapse' : 'Expand'}
      >
        <div className="nv-card-header-left">
          <div className="nv-card-title">{codeTitle(label, confidence)}</div>
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

      <div className="nv-code-header-extra" onContextMenu={onBlockHeaderContextMenu}>
        <BankVariantSelector
          currentBlockId={item.blockId}
          bankVariant={blockIndex?.bankVariant}
          bankVariants={blockIndex?.bankVariants}
          onSelectBankVariant={onSelectBankVariant}
        />

        <div className="nv-card-sub">
          <span className="nv-sub-rom">{rangeText(romStart, romEnd)}</span>
          <span className="nv-sub-dot">·</span>
          <span className="nv-sub-cpu">CPU {cpuText(cpuStart)}</span>
          <span className="nv-sub-dot">·</span>
          <span className="nv-sub-bytes">{item.byteLen} bytes</span>
        </div>

        <PromotionDebug entries={promotionDebugEntriesForHeader} />

        {inboundTotal > 0 ? (
          <div className="nv-inbound">
            <div className="nv-inbound-label">Inbound: {inboundTotal}</div>
            <div className="nv-inbound-addrs">
              {inboundSources.slice(0, inboundShowN).map((src, idx) => {
                const fromCpu = src?.fromCpuAddr;
                const fromRomOff = typeof src?.fromRomOff === 'number' ? (src.fromRomOff >>> 0) : null;
                const isLink = fromRomOff !== null;
                return (
                  <button
                    key={fromRomOff !== null ? `rom:${fromRomOff}` : `idx:${idx}`}
                    type="button"
                    className={`nv-inbound-addr ${isLink ? 'nv-link' : ''}`}
                    onClick={() => {
                      if (!isLink) return;
                      onNavigateToRomOff(fromRomOff);
                    }}
                    disabled={!isLink}
                    title={fromRomOff !== null ? `Go to ROM ${hex6(fromRomOff)}` : 'Unknown ROM offset'}
                  >
                    {typeof fromCpu === 'number' ? cpuText(fromCpu) : (fromRomOff !== null ? hex6(fromRomOff) : '—')}
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
            labelsByRomOff={labelsByRomOff}
            labelsByAddr={labelsByAddr}
            showDebugInfo={showDebugInfo}
            showNamedConstants={showNamedConstants}
            mapper={mapper}
            onNavigateToRomOff={onNavigateToRomOff}
            onHoverLine={onHoverLine}
            onContextMenuLine={onContextMenuLine}
            markedRomSpan={markedRomSpan}
            loopGuides={loopGuides}
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
