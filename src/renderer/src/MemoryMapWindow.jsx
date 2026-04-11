import { useCallback, useEffect, useMemo, useState } from 'react';

const ROW_HEIGHT = 16;
const SECTION_GAP = 18;

function fmtHex(value, width) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '?'.repeat(width);
  return (value >>> 0).toString(16).toUpperCase().padStart(width, '0');
}

function buildRows(sizeBytes, occupiedRanges, rowWidthBytes) {
  const rows = [];
  const ranges = Array.isArray(occupiedRanges) ? occupiedRanges.slice() : [];
  let rangeIndex = 0;
  for (let rowStart = 0; rowStart < sizeBytes; rowStart += rowWidthBytes) {
    const rowEnd = Math.min(sizeBytes, rowStart + rowWidthBytes);
    while (rangeIndex < ranges.length && (ranges[rangeIndex]?.end ?? 0) <= rowStart) rangeIndex++;
    const spans = [];
    let cursor = rowStart;
    let idx = rangeIndex;
    while (idx < ranges.length) {
      const range = ranges[idx];
      const start = Number(range?.start);
      const end = Number(range?.end);
      const type = String(range?.type || 'group');
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        idx++;
        continue;
      }
      if (start >= rowEnd) break;
      const overlapStart = Math.max(rowStart, start);
      const overlapEnd = Math.min(rowEnd, end);
      if (overlapEnd > overlapStart) {
        if (cursor < overlapStart) spans.push({ start: cursor - rowStart, end: overlapStart - rowStart, type: 'empty' });
        spans.push({ start: overlapStart - rowStart, end: overlapEnd - rowStart, type });
        cursor = overlapEnd;
      }
      if (end <= rowEnd) idx++;
      else break;
    }
    if (cursor < rowEnd) spans.push({ start: cursor - rowStart, end: rowEnd - rowStart, type: 'empty' });
    rows.push({ start: rowStart, end: rowEnd, spans });
  }
  return rows;
}

function spanClassName(type) {
  switch (type) {
    case 'code':
      return 'memory-map-span memory-map-span--code';
    case 'codeLight':
      return 'memory-map-span memory-map-span--codeLight';
    case 'romData':
      return 'memory-map-span memory-map-span--romData';
    case 'romDataLight':
      return 'memory-map-span memory-map-span--romDataLight';
    case 'group':
      return 'memory-map-span memory-map-span--group';
    case 'groupLight':
      return 'memory-map-span memory-map-span--groupLight';
    default:
      return 'memory-map-span';
  }
}

function MemorySection({ title, baseLabel, rows, cellSizePx, extraTop = 0 }) {
  const labelWidth = 88;
  return (
    <section className="memory-map-section" style={{ '--memory-map-section-top': `${extraTop}px` }}>
      {title ? <div className="memory-map-section-title">{title}</div> : null}
      <div className="memory-map-rows">
        {rows.map((row) => {
          const rowByteCount = row.end - row.start;
          const rowWidthPx = rowByteCount * cellSizePx;
          const absoluteStart = baseLabel + row.start;
          return (
            <div key={`${title}:${row.start}`} className="memory-map-row">
              <div className="memory-map-row-label" style={{ width: `${labelWidth}px` }}>
                {fmtHex(absoluteStart, absoluteStart > 0xFFFF ? 6 : 4)}
              </div>
              <div
                className="memory-map-row-grid"
                style={{
                  '--memory-map-row-width': `${rowWidthPx}px`,
                  '--memory-map-cell-size': `${cellSizePx}px`
                }}
              >
                {row.spans.map((span, index) => {
                  const width = (span.end - span.start) * cellSizePx;
                  if (width <= 0) return null;
                  return (
                    <div
                      key={index}
                      className={spanClassName(span.type)}
                      style={{
                        '--memory-map-span-left': `${span.start * cellSizePx}px`,
                        '--memory-map-span-width': `${width}px`
                      }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function MemoryMapWindow() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('');

  const reload = useCallback(async () => {
    setStatus('');
    try {
      const res = await window.nesviz?.getMemoryMapData?.();
      if (!res?.ok) {
        setStatus(res?.error || 'Failed to load memory map');
        return;
      }
      setData(res);
    } catch (e) {
      setStatus(`Failed to load memory map: ${e?.message ?? String(e)}`);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!window?.nesviz?.onMemoryMapDataChanged) return undefined;
    return window.nesviz.onMemoryMapDataChanged(() => {
      reload();
    });
  }, [reload]);

  const rowWidthBytes = Number(data?.rowWidthBytes) > 0 ? (data.rowWidthBytes | 0) : 64;
  const cellSizePx = Number(data?.cellSizePx) > 0 ? (data.cellSizePx | 0) : 16;

  const ramRows = useMemo(() => {
    const sizeBytes = Number(data?.ram?.sizeBytes) > 0 ? (data.ram.sizeBytes | 0) : 0;
    const occupiedRanges = Array.isArray(data?.ram?.occupiedRanges) ? data.ram.occupiedRanges : [];
    return buildRows(sizeBytes, occupiedRanges, rowWidthBytes);
  }, [data, rowWidthBytes]);

  const prgRegions = useMemo(() => {
    const regions = Array.isArray(data?.prg?.regions) ? data.prg.regions : [];
    return regions.map((region) => ({
      ...region,
      sizeBytes: (region.end | 0) - (region.start | 0),
      rows: buildRows((region.end | 0) - (region.start | 0), region.occupiedRanges || [], rowWidthBytes)
    }));
  }, [data, rowWidthBytes]);

  if (!data?.hasRom) {
    return <div className="memory-map-empty-view">{status || 'No ROM loaded'}</div>;
  }

  const gridWidth = rowWidthBytes * cellSizePx;

  return (
    <div className="memory-map-window">
      <div className="memory-map-header">
        <div className="memory-map-header-title">{data?.rom?.filename || 'Memory Map'}</div>
      </div>

      <div className="memory-map-scroller">
        {status ? <div className="memory-map-status">{status}</div> : null}

        <div className="memory-map-root" style={{ '--memory-map-grid-width': `${gridWidth}px` }}>
          <MemorySection
            title="RAM"
            baseLabel={0}
            rows={ramRows}
            cellSizePx={cellSizePx}
          />

          <div className="memory-map-gap" style={{ height: `${SECTION_GAP}px` }} />

          <section className="memory-map-section">
            <div className="memory-map-section-title">PRG</div>
            <div className="memory-map-region-list">
              {prgRegions.map((region) => (
                <div key={`region:${region.index}`}>
                  <div className="memory-map-region-label">
                    {fmtHex(region.start, 6)}–{fmtHex(region.end - 1, 6)}
                  </div>
                  <MemorySection
                    title=""
                    baseLabel={region.start}
                    rows={region.rows}
                    cellSizePx={cellSizePx}
                  />
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
