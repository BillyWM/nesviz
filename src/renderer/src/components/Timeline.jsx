import { hex6, hex4 } from '../util/hex.js';

function rangeText(start, end) {
  return `${hex6(start)}–${hex6(end)}`;
}

function cpuText(cpuStart) {
  return typeof cpuStart === 'number' ? `$${hex4(cpuStart)}` : '';
}

export function Timeline({ timeline, blocksById, selectedBlockId, onSelectBlock, onSelectGap }) {
  return (
    <div className="nv-timeline">
      {timeline.map((item, idx) => {
        if (item.type === 'code') {
          const b = blocksById.get(item.blockId);
          const inst = b?.instances?.[0];
          const firstAsm = b?.firstAsm || b?.lines?.[0]?.asm || '';
          const isSelected = item.blockId === selectedBlockId;
          return (
            <button
              key={`${item.type}:${item.blockId}:${idx}`}
              className={`nv-tile ${isSelected ? 'is-selected' : ''}`}
              onClick={() => onSelectBlock?.(item.blockId)}
            >
              <div className="nv-tile-row">
                <div className="nv-tile-title">Code</div>
                <div className="nv-tile-range">{rangeText(item.romStart, item.romEnd)}</div>
              </div>
              <div className="nv-tile-sub">
                {inst ? `CPU ${cpuText(inst.cpuStart)} · ${item.byteLen} bytes` : `${item.byteLen} bytes`}
              </div>
              {firstAsm ? <div className="nv-tile-subline">{firstAsm}</div> : null}
            </button>
          );
        }

        const label = item.type === 'data' ? 'data' : 'unknown';
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
