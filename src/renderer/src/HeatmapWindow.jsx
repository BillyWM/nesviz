import { useCallback, useEffect, useMemo, useState } from 'react';
import { fmtHex } from '../../shared/utils/hexUtils.js';
import { lerpChannel } from '../../shared/utils/colorUtils.js';

const SECTION_GAP = 18;

const ENTROPY_COLOR_STOPS = [
  { entropy: 0.0, rgb: [0, 0, 0] },
  { entropy: 0.5, rgb: [24, 0, 0] },
  { entropy: 1.0, rgb: [48, 0, 0] },
  { entropy: 1.5, rgb: [90, 10, 0] },
  { entropy: 2.0, rgb: [138, 0, 0] },
  { entropy: 2.5, rgb: [191, 18, 0] },
  { entropy: 3.0, rgb: [238, 28, 0] },
  { entropy: 3.5, rgb: [255, 74, 0] },
  { entropy: 4.0, rgb: [255, 114, 0] },
  { entropy: 4.5, rgb: [255, 141, 0] },
  { entropy: 5.0, rgb: [255, 163, 0] },
  { entropy: 5.5, rgb: [255, 184, 0] },
  { entropy: 6.0, rgb: [255, 203, 26] },
  { entropy: 6.5, rgb: [255, 216, 74] },
  { entropy: 7.0, rgb: [255, 227, 122] },
  { entropy: 7.5, rgb: [255, 236, 170] },
  { entropy: 8.0, rgb: [255, 246, 214] }
];

function entropyCellColor(value) {
  const entropy = Math.max(0, Math.min(8, ((Math.max(0, Math.min(255, Number(value) || 0)) / 255) * 8)));
  for (let i = 0; i < ENTROPY_COLOR_STOPS.length - 1; i += 1) {
    const start = ENTROPY_COLOR_STOPS[i];
    const end = ENTROPY_COLOR_STOPS[i + 1];
    if (entropy > end.entropy) continue;
    const span = Math.max(0.000001, end.entropy - start.entropy);
    const t = Math.max(0, Math.min(1, (entropy - start.entropy) / span));
    const r = lerpChannel(start.rgb[0], end.rgb[0], t);
    const g = lerpChannel(start.rgb[1], end.rgb[1], t);
    const b = lerpChannel(start.rgb[2], end.rgb[2], t);
    return `rgb(${r} ${g} ${b})`;
  }
  const last = ENTROPY_COLOR_STOPS[ENTROPY_COLOR_STOPS.length - 1];
  return `rgb(${last.rgb[0]} ${last.rgb[1]} ${last.rgb[2]})`;
}

function buildCellRows(cells, rowCellCount) {
  const safeCells = Array.isArray(cells) ? cells : [];
  const width = Math.max(1, rowCellCount | 0);
  const rows = [];
  for (let rowStart = 0; rowStart < safeCells.length; rowStart += width) {
    rows.push({
      cellStart: rowStart,
      cellEnd: Math.min(safeCells.length, rowStart + width),
      cells: safeCells.slice(rowStart, Math.min(safeCells.length, rowStart + width))
    });
  }
  return rows;
}

function buildOverlayRows(overlayRanges, regionStart, regionEnd, granularity, rowCellCount) {
  const rows = [];
  const safeRanges = Array.isArray(overlayRanges) ? overlayRanges : [];
  const safeGranularity = Math.max(1, granularity | 0);
  const totalCells = Math.ceil(Math.max(0, (regionEnd | 0) - (regionStart | 0)) / safeGranularity);
  const width = Math.max(1, rowCellCount | 0);

  for (let rowCellStart = 0; rowCellStart < totalCells; rowCellStart += width) {
    const rowCellEnd = Math.min(totalCells, rowCellStart + width);
    const rowByteStart = (regionStart | 0) + (rowCellStart * safeGranularity);
    const rowByteEnd = Math.min(regionEnd | 0, (regionStart | 0) + (rowCellEnd * safeGranularity));
    const spans = [];

    for (const range of safeRanges) {
      const start = (regionStart | 0) + (Number(range?.start) | 0);
      const end = (regionStart | 0) + (Number(range?.end) | 0);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= rowByteStart || start >= rowByteEnd) continue;
      const overlapStart = Math.max(rowByteStart, start);
      const overlapEnd = Math.min(rowByteEnd, end);
      if (overlapEnd <= overlapStart) continue;
      const cellStart = Math.max(0, Math.floor((overlapStart - rowByteStart) / safeGranularity));
      const cellEnd = Math.min(rowCellEnd - rowCellStart, Math.ceil((overlapEnd - rowByteStart) / safeGranularity));
      if (cellEnd > cellStart) spans.push({ start: cellStart, end: cellEnd });
    }

    rows.push({ rowCellStart, rowCellEnd, spans });
  }

  return rows;
}

function HeatmapSection({
  title,
  sectionClassName,
  baseLabel,
  regions,
  rowCellCount,
  granularity,
  codeOverlayByRegion,
  extraTop = 0
}) {

  return (
    <section className={`heatmap-section ${sectionClassName || ''}`.trim()} style={{ '--heatmap-section-top': `${extraTop}px` }}>
      <div className="heatmap-section-title">{title}</div>
      <div className="heatmap-region-list">
        {regions.map((region) => {
          const rowCellSpan = Math.min(rowCellCount, Math.ceil(((region.end | 0) - (region.start | 0)) / granularity));
          const rows = buildCellRows(region.cellsByGranularity?.[String(granularity)] || [], rowCellCount);
          const overlayRanges = codeOverlayByRegion.get(region.index) || [];
          const overlayRows = buildOverlayRows(overlayRanges, region.start | 0, region.end | 0, granularity, rowCellCount);
          return (
            <div key={`${title}:${region.index}`} className="heatmap-region">
              <div className="heatmap-rows">
                {rows.map((row, rowIndex) => {
                  const absoluteStart = (baseLabel | 0) + (region.start | 0) + (row.cellStart * granularity);
                  const rowOverlay = overlayRows[rowIndex] || { spans: [] };
                  return (
                    <div key={`${title}:${region.index}:${row.cellStart}`} className="heatmap-row">
                      <div className="heatmap-row-label">
                        {fmtHex(absoluteStart, absoluteStart > 0xFFFF ? 6 : 4)}
                      </div>
                      <div
                        className="heatmap-row-grid"
                        style={{
                          '--heatmap-row-cell-count': rowCellSpan
                        }}
                      >
                        {row.cells.map((value, cellIndex) => (
                          <div
                            key={cellIndex}
                            className="heatmap-cell"
                            style={{
                              '--heatmap-cell-index': cellIndex,
                              backgroundColor: entropyCellColor(value)
                            }}
                            title={`${fmtHex(absoluteStart + (cellIndex * granularity), 6)} · ${granularity} bytes · entropy ${(Number(value || 0) / 255 * 8).toFixed(2)}`}
                          />
                        ))}
                        {rowOverlay.spans.map((span, spanIndex) => (
                          <div
                            key={`overlay:${spanIndex}`}
                            className="heatmap-overlay-span"
                            style={{
                              '--heatmap-overlay-start-cell': span.start,
                              '--heatmap-overlay-cell-span': Math.max(1, span.end - span.start)
                            }}
                          />
                        ))}
                      </div>
                    </div>
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

export default function HeatmapWindow() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('');
  const [granularity, setGranularity] = useState(8);

  const reload = useCallback(async () => {
    setStatus('');
    try {
      const res = await window.nesviz?.getHeatmapData?.();
      if (!res?.ok) {
        setStatus(res?.error || 'Failed to load heatmap');
        return;
      }
      setData(res);
      const validGranularities = Array.isArray(res?.granularities) ? res.granularities : [];
      setGranularity((prev) => (validGranularities.includes(prev) ? prev : (res?.defaultGranularity || validGranularities[0] || 8)));
    } catch (e) {
      setStatus(`Failed to load heatmap: ${e?.message ?? String(e)}`);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!window?.nesviz?.onHeatmapDataChanged) return undefined;
    return window.nesviz.onHeatmapDataChanged(() => {
      reload();
    });
  }, [reload]);

  const rowCellCount = Number(data?.rowCellCount) > 0 ? (data.rowCellCount | 0) : 64;
  const gridWidthCells = rowCellCount;
  const prgRegions = Array.isArray(data?.prg?.regions) ? data.prg.regions : [];
  const chrRegions = Array.isArray(data?.chr?.regions) ? data.chr.regions : [];
  const granularityOptions = Array.isArray(data?.granularities) ? data.granularities : [8, 16, 32, 48, 64];

  const codeOverlayByRegion = useMemo(() => {
    const map = new Map();
    for (const region of Array.isArray(data?.prg?.codeOverlayRegions) ? data.prg.codeOverlayRegions : []) {
      map.set(region.index, Array.isArray(region.overlayRanges) ? region.overlayRanges : []);
    }
    return map;
  }, [data]);

  if (!data?.hasRom) {
    return <div className="heatmap-empty-view">{status || 'No ROM loaded'}</div>;
  }

  return (
    <div className="heatmap-window">
      <div className="heatmap-header">
        <div>
          <div className="heatmap-header-title">{data?.rom?.filename || 'Heatmap'}</div>
          <div className="heatmap-header-subtitle">Shannon entropy for PRG{data?.chr ? ' and CHR' : ''}</div>
        </div>
        <div className="heatmap-controls">
          <label className="heatmap-control">
            <span>Granularity</span>
            <select value={granularity} onChange={(e) => setGranularity(Number(e.target.value) || 8)}>
              {granularityOptions.map((value) => (
                <option key={value} value={value}>{value} bytes</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="heatmap-scroller">
        {status ? <div className="heatmap-status">{status}</div> : null}

        <div className="heatmap-root" style={{ '--heatmap-grid-cell-count': gridWidthCells }}>
          <HeatmapSection
            title="PRG"
            sectionClassName="heatmap-section--prg"
            baseLabel={0}
            regions={prgRegions}
            rowCellCount={rowCellCount}
            granularity={granularity}
            codeOverlayByRegion={codeOverlayByRegion}
          />

          {data?.chr ? <div className="heatmap-gap" style={{ height: `${SECTION_GAP}px` }} /> : null}

          {data?.chr ? (
            <HeatmapSection
              title="CHR"
              sectionClassName="heatmap-section--chr"
              baseLabel={0}
              regions={chrRegions}
              rowCellCount={rowCellCount}
                granularity={granularity}
              codeOverlayByRegion={new Map()}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
