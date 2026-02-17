import { hex6 } from '../util/hex.js';

function rangeText(start, end) {
  return `${hex6(start)}–${hex6(end)}`;
}

export function GapCard({ item }) {
  const label = item.type === 'data' ? 'data' : 'unknown';
  return (
    <div className={`nv-card nv-gap size-${item.sizeClass}`}>
      <div className="nv-card-header">
        <div className="nv-card-title">{label} ({item.byteLen} bytes)</div>
        <div className="nv-card-meta">{rangeText(item.romStart, item.romEnd)}</div>
      </div>
    </div>
  );
}
