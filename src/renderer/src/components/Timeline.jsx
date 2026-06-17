import { hex6, hex4 } from '../util/hex.js';

function rangeText(start, end) {
  return `${hex6(start)}–${hex6(end)}`;
}

function cpuText(cpuStart) {
  return typeof cpuStart === 'number' ? `$${hex4(cpuStart)}` : '';
}



function isVisibleTimelineItem(item, blocksById) {
  if (!item || item.type !== 'code' || !item.blockId) return true;
  const blockIndex = blocksById?.get?.(item.blockId);
  const anchorBlockId = blockIndex?.bankVariantAnchorBlockId;
  return !anchorBlockId || anchorBlockId === item.blockId;
}

function selectedTimelineBlockId(selectedBlockId, blocksById) {
  if (!selectedBlockId) return null;
  const blockIndex = blocksById?.get?.(selectedBlockId);
  return blockIndex?.bankVariantAnchorBlockId || selectedBlockId;
}

function TimelineBankBadge({ bankVariant }) {
  if (!bankVariant) return null;
  const label = typeof bankVariant.bankLabel === 'string' && bankVariant.bankLabel ? bankVariant.bankLabel : String(bankVariant.bankIndex ?? '?');
  return <span className="nv-bank-button nv-bank-button-tile is-selected">{label}</span>;
}

export function Timeline({ timeline, blocksById, selectedBlockId, onSelectBlock, onSelectGap }) {
  const visibleTimeline = timeline.filter((item) => isVisibleTimelineItem(item, blocksById));
  const visibleSelectedBlockId = selectedTimelineBlockId(selectedBlockId, blocksById);

  return (
    <div className="nv-timeline">
      {visibleTimeline.map((item, idx) => {
        if (item.type === 'code' && item.blockId) {
          const b = blocksById.get(item.blockId);
          const cpuStart = b?.cpuStart;
          const firstAsm = b?.firstAsm || b?.lines?.[0]?.asm || '';
          const isSelected = item.blockId === visibleSelectedBlockId;
          return (
            <button
              key={`${item.type}:${item.blockId}:${idx}`}
              className={`nv-tile ${isSelected ? 'is-selected' : ''}`}
              onClick={() => onSelectBlock?.(item.blockId)}
            >
              <div className="nv-tile-row">
                <div className="nv-tile-title"><TimelineBankBadge bankVariant={b?.bankVariant} />Code</div>
                <div className="nv-tile-range">{rangeText(item.romStart, item.romEnd)}</div>
              </div>
              <div className="nv-tile-sub">
                {typeof cpuStart === 'number' ? `CPU ${cpuText(cpuStart)} · ${item.byteLen} bytes` : `${item.byteLen} bytes`}
              </div>
              {firstAsm ? <div className="nv-tile-subline">{firstAsm}</div> : null}
            </button>
          );
        }

        const label = item.type === 'code' ? 'Code' : item.type === 'data' ? 'Data' : 'Unknown';
        return (
          <div
            key={`${item.type}:${item.romStart}:${idx}`}
            className={`nv-tile is-gap size-${item.sizeClass}`}
            role="button"
            tabIndex={0}
            onClick={() => onSelectGap?.(item)}
          >
            <div className="nv-tile-row">
              <div className="nv-tile-title">{label} ({item.byteLen} bytes)</div>
              <div className="nv-tile-range">{rangeText(item.romStart, item.romEnd)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
