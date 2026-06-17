import { hex6 } from '../util/hex.js';

function rangeText(start, end) {
  return `${hex6(start)}–${hex6(end)}`;
}

export function GapCard({ item, showBytes = false, bytesText = '', isLoadingBytes = false, onContextMenuGap, showDebugInfo = false, debugReasons = [] }) {
  const label = item.type === 'code' ? 'Code' : item.type === 'data' ? 'Data' : 'Unknown';
  return (
    <div
      className={`nv-card nv-gap size-${item.sizeClass}`}
      onContextMenu={(e) => {
        if (!onContextMenuGap) return;
        e.preventDefault();
        e.stopPropagation();
        onContextMenuGap(item, e.clientX, e.clientY);
      }}
    >
      <div className="nv-card-header">
        <div className="nv-card-title">{label} ({item.byteLen} bytes)</div>
        <div className="nv-card-meta">{rangeText(item.romStart, item.romEnd)}</div>
      </div>

      {showDebugInfo && Array.isArray(debugReasons) && debugReasons.length ? (
        <div className="nv-gap-debug">
          {debugReasons.map((reason, idx) => (
            <div key={idx}>{idx === 0 ? 'Likely reason: ' : ''}{reason}</div>
          ))}
        </div>
      ) : null}

      {showBytes ? (
        <div className="nv-gap-bytes-wrap">
          {isLoadingBytes ? (
            <div className="nv-muted">Loading bytes…</div>
          ) : (
            <pre className="nv-gap-bytes">{bytesText || '(no bytes)'}</pre>
          )}
        </div>
      ) : null}
    </div>
  );
}
