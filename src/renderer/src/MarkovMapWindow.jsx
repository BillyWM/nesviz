import { useCallback, useEffect, useMemo, useState } from 'react';
import { fmtHex } from '../../shared/utils/numberUtils.js';
import { fmtMetric, fmtPercent } from '../../shared/utils/numberUtils.js';

function markovColor(normalized) {
  const t = Math.max(0, Math.min(1, Number(normalized) || 0));
  const lightness = 10 + (t * 52);
  return `hsl(43 86% ${lightness.toFixed(2)}%)`;
}

function buildRows(sizeBytes, occupiedRanges, rowWidthBytes) {
  const rows = [];
  const ranges = Array.isArray(occupiedRanges)
    ? occupiedRanges.slice().sort((a, b) => (Number(a?.start) || 0) - (Number(b?.start) || 0) || (Number(a?.end) || 0) - (Number(b?.end) || 0))
    : [];
  let rangeIndex = 0;
  for (let rowStart = 0; rowStart < sizeBytes; rowStart += rowWidthBytes) {
    const rowEnd = Math.min(sizeBytes, rowStart + rowWidthBytes);
    while (rangeIndex < ranges.length && (Number(ranges[rangeIndex]?.end) || 0) <= rowStart) rangeIndex += 1;
    const spans = [];
    let idx = rangeIndex;
    let cursor = rowStart;
    while (idx < ranges.length) {
      const range = ranges[idx];
      const start = Number(range?.start);
      const end = Number(range?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        idx += 1;
        continue;
      }
      if (start >= rowEnd) break;
      const overlapStart = Math.max(rowStart, cursor, start);
      const overlapEnd = Math.min(rowEnd, end);
      if (overlapEnd > overlapStart) {
        spans.push({
          start: overlapStart - rowStart,
          end: overlapEnd - rowStart,
          metricValue: Number(range?.metricValue),
          normalized: Number(range?.normalized),
          percentile: Number(range?.percentile),
          bucketKey: typeof range?.bucketKey === 'string' ? range.bucketKey : '',
          rawBlockId: String(range?.rawBlockId || ''),
          confidence: range?.confidence === 'probable' ? 'probable' : 'certain'
        });
        cursor = overlapEnd;
      }
      if (end <= rowEnd) idx += 1;
      else break;
    }
    rows.push({ start: rowStart, end: rowEnd, spans });
  }
  return rows;
}

function RegionRows({ baseLabel, rows, cellSizePx, metricLabel, familyLabel }) {
  const labelWidth = 88;
  return (
    <div className="markov-map-rows">
      {rows.map((row) => {
        const rowByteCount = row.end - row.start;
        const rowWidthPx = rowByteCount * cellSizePx;
        const absoluteStart = baseLabel + row.start;
        return (
          <div key={`row:${baseLabel}:${row.start}`} className="markov-map-row">
            <div className="markov-map-row-label" style={{ width: `${labelWidth}px` }}>
              {fmtHex(absoluteStart, absoluteStart > 0xFFFF ? 6 : 4)}
            </div>
            <div
              className="markov-map-row-grid"
              style={{
                '--markov-map-row-width': `${rowWidthPx}px`,
                '--markov-map-cell-size': `${cellSizePx}px`
              }}
            >
              {row.spans.map((span, index) => {
                const width = (span.end - span.start) * cellSizePx;
                if (width <= 0) return null;
                return (
                  <div
                    key={index}
                    className="markov-map-span"
                    style={{
                      '--markov-map-span-left': `${span.start * cellSizePx}px`,
                      '--markov-map-span-width': `${width}px`,
                      backgroundColor: markovColor(span.normalized)
                    }}
                    title={`${familyLabel}\n${metricLabel}: ${fmtMetric(span.metricValue)}\nPercentile: ${fmtPercent(span.percentile)}${span.bucketKey ? `\nLength bucket: ${span.bucketKey}` : ''}\nBlock: ${span.rawBlockId || '(unknown)'}\nConfidence: ${span.confidence}`}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const METRIC_OPTIONS = [
  { value: 'avgLogLikelihood', label: 'Average log-likelihood' },
  { value: 'crossEntropyBits', label: 'Cross-entropy' },
  { value: 'perplexity', label: 'Perplexity' },
  { value: 'unseenTransitionRatio', label: 'Unseen transition ratio' },
  { value: 'robustMahalanobisDistance', label: 'Robust Mahalanobis distance' }
];

const FAMILY_OPTIONS = [
  { value: 'opcode', label: 'Opcode' },
  { value: 'addressing', label: 'Addressing mode' },
  { value: 'mnemonic', label: 'Mnemonic' }
];

export default function MarkovMapWindow() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('');
  const [corpus, setCorpus] = useState('confirmed');
  const [displayedCodeType, setDisplayedCodeType] = useState('confirmed');
  const [family, setFamily] = useState('opcode');
  const [order, setOrder] = useState(1);
  const [metric, setMetric] = useState('avgLogLikelihood');

  const reload = useCallback(async () => {
    setStatus('');
    try {
      const res = await window.nesviz?.getMarkovMapData?.({ corpus, displayedCodeType, family, order, metric });
      if (!res?.ok) {
        setStatus(res?.error || 'Failed to load Markov map');
        return;
      }
      setData(res);
    } catch (e) {
      setStatus(`Failed to load Markov map: ${e?.message ?? String(e)}`);
    }
  }, [corpus, displayedCodeType, family, metric, order]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!window?.nesviz?.onMarkovMapDataChanged) return undefined;
    return window.nesviz.onMarkovMapDataChanged(() => {
      reload();
    });
  }, [reload]);

  const rowWidthBytes = Number(data?.rowWidthBytes) > 0 ? (data.rowWidthBytes | 0) : 64;
  const cellSizePx = Number(data?.cellSizePx) > 0 ? (data.cellSizePx | 0) : 16;
  const gridWidth = rowWidthBytes * cellSizePx;
  const metricLabel = useMemo(() => METRIC_OPTIONS.find((opt) => opt.value === metric)?.label || metric, [metric]);
  const familyLabel = useMemo(() => {
    if (metric === 'robustMahalanobisDistance') return 'Combined profile';
    return FAMILY_OPTIONS.find((opt) => opt.value === family)?.label || family;
  }, [family, metric]);

  const prgRegions = useMemo(() => {
    const regions = Array.isArray(data?.prg?.regions) ? data.prg.regions : [];
    return regions.map((region) => ({
      ...region,
      rows: buildRows((region.end | 0) - (region.start | 0), region.occupiedRanges || [], rowWidthBytes)
    }));
  }, [data, rowWidthBytes]);

  if (!data?.hasRom) {
    return <div className="markov-map-empty-view">{status || 'No ROM loaded'}</div>;
  }

  return (
    <div className="markov-map-window">
      <div className="markov-map-header">
        <div>
          <div className="markov-map-header-title">{data?.rom?.filename || 'Markov map'}</div>
          <div className="markov-map-header-subtitle">PRG-only block metric map from trained Markov artifacts</div>
          {data?.normalization ? (
            <div className="markov-map-header-meta">
              {familyLabel} · {metricLabel}: p5 {fmtMetric(data.normalization.percentileLow)} · p95 {fmtMetric(data.normalization.percentileHigh)} · scored blocks {data.normalization.scoredBlockCount ?? 0}
            </div>
          ) : null}
        </div>
        <div className="markov-map-controls">
          <label className="markov-map-control">
            <span>Corpus</span>
            <select value={corpus} onChange={(e) => setCorpus(e.target.value === 'probablePlus' ? 'probablePlus' : 'confirmed')}>
              <option value="confirmed">Confirmed code</option>
              <option value="probablePlus">Probable code</option>
            </select>
          </label>
          <label className="markov-map-control">
            <span>Code</span>
            <select value={displayedCodeType} onChange={(e) => setDisplayedCodeType(e.target.value === 'probablePlus' ? 'probablePlus' : 'confirmed')}>
              <option value="confirmed">Confirmed code</option>
              <option value="probablePlus">Probable code</option>
            </select>
          </label>
          <label className="markov-map-control">
            <span>Family</span>
            <select
              value={family}
              onChange={(e) => setFamily(e.target.value === 'mnemonic' ? 'mnemonic' : (e.target.value === 'addressing' ? 'addressing' : 'opcode'))}
              disabled={metric === 'robustMahalanobisDistance'}
              title={metric === 'robustMahalanobisDistance' ? 'Robust Mahalanobis distance uses opcode, addressing-mode, and mnemonic families together' : ''}
            >
              {FAMILY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="markov-map-control markov-map-control--order">
            <span>Order</span>
            <select
              value={order}
              onChange={(e) => setOrder(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
              disabled={metric === 'robustMahalanobisDistance'}
              title={metric === 'robustMahalanobisDistance' ? 'Robust Mahalanobis distance uses all orders 1-5 together' : ''}
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <div className="markov-map-control markov-map-control--metric">
            <span>Metric</span>
            <div className="markov-map-radio-group">
              {METRIC_OPTIONS.map((option) => (
                <label key={option.value} className="markov-map-radio">
                  <input
                    type="radio"
                    name="markovMetric"
                    checked={metric === option.value}
                    onChange={() => setMetric(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="markov-map-scroller">
        {status ? <div className="markov-map-status">{status}</div> : null}

        <div className="markov-map-root" style={{ '--markov-map-grid-width': `${gridWidth}px` }}>
          <section className="markov-map-section">
            <div className="markov-map-section-title">PRG</div>
            <div className="markov-map-region-list">
              {prgRegions.map((region) => (
                <div key={`region:${region.index}`}>
                  <div className="markov-map-region-label">
                    {fmtHex(region.start, 6)}–{fmtHex(region.end - 1, 6)}
                  </div>
                  <section className="markov-map-section">
                    <RegionRows
                      baseLabel={region.start}
                      rows={region.rows}
                      cellSizePx={cellSizePx}
                      metricLabel={metricLabel}
                      familyLabel={familyLabel}
                    />
                  </section>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
