import { useCallback, useEffect, useMemo, useState } from 'react';
import { fmtHex } from '../../shared/utils/numberUtils.js';

const SECTION_GAP = 18;
const LINK_PREVIEW_COUNT = 20;
const LINK_EXPANDED_COUNT = 24;


function buildRows(sizeBytes, occupiedRanges, annotationRanges, rowWidthBytes) {
  const rows = [];
  const occupied = Array.isArray(occupiedRanges) ? occupiedRanges.slice() : [];
  const annotations = Array.isArray(annotationRanges) ? annotationRanges.slice() : [];
  let occupiedIndex = 0;
  let annotationIndex = 0;

  for (let rowStart = 0; rowStart < sizeBytes; rowStart += rowWidthBytes) {
    const rowEnd = Math.min(sizeBytes - 1, rowStart + rowWidthBytes - 1);
    while (occupiedIndex < occupied.length && (occupied[occupiedIndex]?.end ?? -1) < rowStart) occupiedIndex++;
    while (annotationIndex < annotations.length && (annotations[annotationIndex]?.end ?? -1) < rowStart) annotationIndex++;

    const spans = [];
    let cursor = rowStart;
    let idx = occupiedIndex;
    while (idx < occupied.length) {
      const range = occupied[idx];
      const start = Number(range?.start);
      const end = Number(range?.end);
      const type = String(range?.type || 'group');
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        idx++;
        continue;
      }
      if (start > rowEnd) break;
      const overlapStart = Math.max(rowStart, start);
      const overlapEnd = Math.min(rowEnd, end);
      if (overlapEnd >= overlapStart) {
        if (cursor < overlapStart) spans.push({ start: cursor - rowStart, end: overlapStart - rowStart - 1, type: 'empty' });
        spans.push({ start: overlapStart - rowStart, end: overlapEnd - rowStart, type });
        cursor = overlapEnd + 1;
      }
      if (end <= rowEnd) idx++;
      else break;
    }
    if (cursor <= rowEnd) spans.push({ start: cursor - rowStart, end: rowEnd - rowStart, type: 'empty' });

    const annotationSpans = [];
    let annIdx = annotationIndex;
    while (annIdx < annotations.length) {
      const range = annotations[annIdx];
      const start = Number(range?.start);
      const end = Number(range?.end);
      const annotationIds = Array.isArray(range?.annotationIds) ? range.annotationIds.filter(Boolean) : [];
      if (!Number.isFinite(start) || !Number.isFinite(end) || !annotationIds.length) {
        annIdx++;
        continue;
      }
      if (start > rowEnd) break;
      const overlapStart = Math.max(rowStart, start);
      const overlapEnd = Math.min(rowEnd, end);
      if (overlapEnd >= overlapStart) {
        annotationSpans.push({
          start: overlapStart - rowStart,
          end: overlapEnd - rowStart,
          annotationIds
        });
      }
      if (end <= rowEnd) annIdx++;
      else break;
    }

    rows.push({ start: rowStart, end: rowEnd, spans, annotationSpans });
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

function sliceRanges(occupiedRanges, sectionStart, sectionEnd) {
  const ranges = [];
  for (const range of Array.isArray(occupiedRanges) ? occupiedRanges : []) {
    const start = Number(range?.start);
    const end = Number(range?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const overlapStart = Math.max(sectionStart, start);
    const overlapEnd = Math.min(sectionEnd, end);
    if (overlapEnd < overlapStart) continue;
    ranges.push({
      start: overlapStart - sectionStart,
      end: overlapEnd - sectionStart,
      type: String(range?.type || 'group')
    });
  }
  return ranges;
}

function sliceAnnotationRanges(annotationRanges, sectionStart, sectionEnd) {
  const ranges = [];
  for (const range of Array.isArray(annotationRanges) ? annotationRanges : []) {
    const start = Number(range?.start);
    const end = Number(range?.end);
    const annotationIds = Array.isArray(range?.annotationIds) ? range.annotationIds.filter(Boolean) : [];
    if (!Number.isFinite(start) || !Number.isFinite(end) || !annotationIds.length) continue;
    const overlapStart = Math.max(sectionStart, start);
    const overlapEnd = Math.min(sectionEnd, end);
    if (overlapEnd < overlapStart) continue;
    ranges.push({
      start: overlapStart - sectionStart,
      end: overlapEnd - sectionStart,
      annotationIds
    });
  }
  return ranges;
}

function buildRowsForSection(sizeBytes, occupiedRanges, annotationRanges, rowWidthBytes, sectionStart, sectionEnd) {
  if ((sizeBytes | 0) <= 0) return [];
  const start = Math.max(0, Math.min(sizeBytes - 1, sectionStart | 0));
  const end = Math.max(start, Math.min(sizeBytes - 1, sectionEnd | 0));
  return buildRows(end - start + 1, sliceRanges(occupiedRanges, start, end), sliceAnnotationRanges(annotationRanges, start, end), rowWidthBytes);
}

function rangeWidth(range) {
  if (range?.space === 'zp') return 2;
  if (range?.space === 'prg') return 6;
  return 4;
}

function formatRange(range) {
  const start = Number(range?.start);
  const end = Number(range?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '$????';
  const width = rangeWidth(range);
  const len = end - start + 1;
  if (len <= 1) return `$${fmtHex(start, width)}`;
  if (len === 2) return `$${fmtHex(start, width)}/$${fmtHex(end, width)}`;
  return `$${fmtHex(start, width)}-$${fmtHex(end, width)}`;
}

function linkSort(a, b) {
  const ar = typeof a.romOff === 'number' ? a.romOff : Number.MAX_SAFE_INTEGER;
  const br = typeof b.romOff === 'number' ? b.romOff : Number.MAX_SAFE_INTEGER;
  return ar - br || String(a.label || '').localeCompare(String(b.label || '')) || String(a.id || '').localeCompare(String(b.id || ''));
}

function sectionKey(section) {
  const range = section?.range || {};
  return `${range.space}:${range.start}:${range.end}:${section?.label || ''}:${section?.note || ''}`;
}

function mergeLinks(a, b) {
  const byKey = new Map();
  for (const link of [...(a || []), ...(b || [])]) {
    const key = [
      link.kind || '',
      typeof link.romOff === 'number' ? link.romOff : '',
      typeof link.cpuAddr === 'number' ? link.cpuAddr : '',
      link.siteKey || '',
      link.contextKey || '',
      link.label || ''
    ].join(':');
    if (!byKey.has(key)) byKey.set(key, link);
  }
  return Array.from(byKey.values()).sort(linkSort);
}

function mergeUseGroups(groups) {
  const byKind = new Map();
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!group || typeof group !== 'object') continue;
    const kind = String(group.kind || 'links');
    let merged = byKind.get(kind);
    if (!merged) {
      merged = {
        kind,
        label: String(group.label || kind),
        links: []
      };
      byKind.set(kind, merged);
    }
    merged.links = mergeLinks(merged.links, Array.isArray(group.links) ? group.links : []);
  }
  return Array.from(byKind.values()).filter((group) => group.links.length);
}

function buildPopupSections(annotationIds, annotationsById) {
  const byKey = new Map();
  for (const id of annotationIds || []) {
    const annotation = annotationsById.get(id);
    if (!annotation) continue;
    const range = annotation.range || {};
    const key = `${range.space}:${range.start}:${range.end}:${annotation.label}:${annotation.note || ''}`;
    let section = byKey.get(key);
    if (!section) {
      section = {
        label: annotation.label,
        note: annotation.note || '',
        range,
        useGroups: []
      };
      byKey.set(key, section);
    }
    section.useGroups = mergeUseGroups([...(section.useGroups || []), ...(annotation.useGroups || [])]);
  }

  return Array.from(byKey.values())
    .sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0)
      || (a.range?.end ?? 0) - (b.range?.end ?? 0)
      || String(a.label).localeCompare(String(b.label)));
}

function visibleLinks(links, expansionMode) {
  if (expansionMode === 'all') return links;
  if (expansionMode === 'expanded') return links.slice(0, LINK_EXPANDED_COUNT);
  return links.slice(0, LINK_PREVIEW_COUNT);
}

function UseGroupList({ sectionKeyValue, groups, expansionByGroup, onSetExpansion, onNavigateLink }) {
  if (!Array.isArray(groups) || !groups.length) return null;
  return (
    <div className="memory-map-annotation-groups">
      {groups.map((group) => {
        const groupKey = `${sectionKeyValue}:${group.kind}`;
        const expansionMode = expansionByGroup[groupKey] || 'preview';
        const visible = visibleLinks(group.links, expansionMode);
        const hiddenCount = group.links.length - visible.length;
        return (
          <div key={groupKey} className="memory-map-annotation-group">
            <span className="memory-map-annotation-group-label">{group.label}:</span>{' '}
            {visible.map((link, index) => (
              <button
                key={`${link.kind || 'link'}:${link.romOff ?? ''}:${link.cpuAddr ?? ''}:${link.siteKey || ''}:${index}`}
                type="button"
                className="memory-map-annotation-link"
                onClick={(event) => {
                  event.stopPropagation();
                  onNavigateLink(link);
                }}
                title={typeof link.romOff === 'number' ? `Jump to ROM+0x${fmtHex(link.romOff, 6)}` : 'Missing navigation target'}
                disabled={typeof link.romOff !== 'number'}
              >
                {link.label}
              </button>
            ))}
            {hiddenCount > 0 && expansionMode === 'expanded' ? (
              <button
                type="button"
                className="memory-map-annotation-link-more"
                onClick={() => onSetExpansion(groupKey, 'all')}
              >
                show {hiddenCount} more
              </button>
            ) : null}
            {hiddenCount > 0 && expansionMode !== 'expanded' ? (
              <button
                type="button"
                className="memory-map-annotation-link-more memory-map-annotation-link-more--ellipsis"
                onClick={() => onSetExpansion(groupKey, 'expanded')}
                aria-label={`Show more ${group.label}`}
              >
                …
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function AnnotationPopup({ popup, annotationsById, linkExpansionByGroup, onSetLinkExpansion, onNavigateLink }) {
  if (!popup) return null;
  const sections = buildPopupSections(popup.annotationIds, annotationsById);
  if (!sections.length) return null;
  return (
    <div
      className="memory-map-annotation-popup"
      style={{ left: `${popup.x}px`, top: `${popup.y}px` }}
      onClick={(event) => event.stopPropagation()}
    >
      {sections.map((section, index) => {
        const key = sectionKey(section);
        return (
          <div key={key}>
            {index > 0 ? <hr className="memory-map-annotation-divider" /> : null}
            <div className="memory-map-annotation-title">
              {formatRange(section.range)}: {section.label}
            </div>
            {section.note ? <div className="memory-map-annotation-note">{section.note}</div> : null}
            <UseGroupList
              sectionKeyValue={key}
              groups={section.useGroups}
              expansionByGroup={linkExpansionByGroup}
              onSetExpansion={onSetLinkExpansion}
              onNavigateLink={onNavigateLink}
            />
          </div>
        );
      })}
    </div>
  );
}

function MemorySection({ title, baseLabel, rows, cellSizePx, onAnnotationClick, extraTop = 0 }) {
  const labelWidth = 88;
  return (
    <section className="memory-map-section" style={{ '--memory-map-section-top': `${extraTop}px` }}>
      {title ? <div className="memory-map-section-title">{title}</div> : null}
      <div className="memory-map-rows">
        {rows.map((row) => {
          const rowByteCount = row.end - row.start + 1;
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
                  const width = (span.end - span.start + 1) * cellSizePx;
                  if (width <= 0) return null;
                  return (
                    <div
                      key={`span:${index}`}
                      className={spanClassName(span.type)}
                      style={{
                        '--memory-map-span-left': `${span.start * cellSizePx}px`,
                        '--memory-map-span-width': `${width}px`
                      }}
                    />
                  );
                })}
                {row.annotationSpans.map((span, index) => {
                  const width = (span.end - span.start + 1) * cellSizePx;
                  if (width <= 0) return null;
                  return (
                    <button
                      key={`annotation:${index}:${span.annotationIds.join('|')}`}
                      type="button"
                      className="memory-map-annotation-span"
                      style={{
                        '--memory-map-span-left': `${span.start * cellSizePx}px`,
                        '--memory-map-span-width': `${width}px`
                      }}
                      onClick={(event) => onAnnotationClick(event, span.annotationIds)}
                      aria-label="Show memory annotation"
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
  const [annotationPopup, setAnnotationPopup] = useState(null);
  const [linkExpansionByGroup, setLinkExpansionByGroup] = useState({});

  const reload = useCallback(async () => {
    setStatus('');
    try {
      const res = await window.nesviz.getMemoryMapData();
      if (!res?.ok) {
        setStatus(res?.error || 'Failed to load memory map');
        return;
      }
      setData(res);
      setAnnotationPopup(null);
      setLinkExpansionByGroup({});
    } catch (e) {
      setStatus(`Failed to load memory map: ${e?.message ?? String(e)}`);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    return window.nesviz.onMemoryMapDataChanged(() => {
      reload();
    });
  }, [reload]);

  const rowWidthBytes = Number(data?.rowWidthBytes) > 0 ? (data.rowWidthBytes | 0) : 64;
  const cellSizePx = Number(data?.cellSizePx) > 0 ? (data.cellSizePx | 0) : 16;

  const annotationsById = useMemo(() => {
    const map = new Map();
    for (const annotation of Array.isArray(data?.rangeAnnotations) ? data.rangeAnnotations : []) {
      if (typeof annotation?.id === 'string' && annotation.id) map.set(annotation.id, annotation);
    }
    return map;
  }, [data]);

  const handleAnnotationClick = useCallback((event, annotationIds) => {
    event.stopPropagation();
    const ids = Array.from(new Set((annotationIds || []).filter(Boolean)));
    if (!ids.length) return;
    setLinkExpansionByGroup({});
    setAnnotationPopup({
      x: event.clientX + 8,
      y: event.clientY + 8,
      annotationIds: ids
    });
  }, []);

  const handleSetLinkExpansion = useCallback((key, mode) => {
    setLinkExpansionByGroup((prev) => ({
      ...prev,
      [key]: mode
    }));
  }, []);

  const handleNavigateLink = useCallback((link) => {
    const romOff = Number(link?.romOff);
    if (!Number.isInteger(romOff) || romOff < 0) return;
    window.nesviz.memoryMapNavigate({ kind: 'rom', romOff: romOff >>> 0 });
  }, []);

  const ramSections = useMemo(() => {
    const sizeBytes = Number(data?.ram?.sizeBytes) > 0 ? (data.ram.sizeBytes | 0) : 0;
    const occupiedRanges = Array.isArray(data?.ram?.occupiedRanges) ? data.ram.occupiedRanges : [];
    const annotationRanges = Array.isArray(data?.ram?.annotationRanges) ? data.ram.annotationRanges : [];
    return [
      {
        key: 'zp',
        label: 'Zero Page',
        baseLabel: 0x0000,
        rows: buildRowsForSection(sizeBytes, occupiedRanges, annotationRanges, rowWidthBytes, 0x0000, 0x00ff)
      },
      {
        key: 'stack',
        label: 'Stack',
        baseLabel: 0x0100,
        rows: buildRowsForSection(sizeBytes, occupiedRanges, annotationRanges, rowWidthBytes, 0x0100, 0x01ff)
      },
      {
        key: 'ram',
        label: 'RAM (0200–07FF)',
        baseLabel: 0x0200,
        rows: buildRowsForSection(sizeBytes, occupiedRanges, annotationRanges, rowWidthBytes, 0x0200, sizeBytes - 1)
      }
    ].filter((section) => Array.isArray(section.rows) && section.rows.length);
  }, [data, rowWidthBytes]);

  const prgRegions = useMemo(() => {
    const regions = Array.isArray(data?.prg?.regions) ? data.prg.regions : [];
    return regions.map((region) => {
      const start = region.start | 0;
      const end = region.end | 0;
      const sizeBytes = Math.max(0, end - start + 1);
      return {
        ...region,
        sizeBytes,
        rows: buildRows(sizeBytes, region.occupiedRanges || [], region.annotationRanges || [], rowWidthBytes)
      };
    });
  }, [data, rowWidthBytes]);

  if (!data?.hasRom) {
    return <div className="memory-map-empty-view">{status || 'No ROM loaded'}</div>;
  }

  const gridWidth = rowWidthBytes * cellSizePx;

  return (
    <div className="memory-map-window" onClick={() => setAnnotationPopup(null)}>
      <div className="memory-map-header">
        <div className="memory-map-header-title">{data?.rom?.filename || 'Memory Map'}</div>
      </div>

      <div className="memory-map-scroller">
        {status ? <div className="memory-map-status">{status}</div> : null}

        <div className="memory-map-root" style={{ '--memory-map-grid-width': `${gridWidth}px` }}>
          <section className="memory-map-section">
            <div className="memory-map-section-title">RAM</div>
            <div className="memory-map-region-list">
              {ramSections.map((section) => (
                <div key={`ram:${section.key}`}>
                  <div className="memory-map-region-label">{section.label}</div>
                  <MemorySection
                    title=""
                    baseLabel={section.baseLabel}
                    rows={section.rows}
                    cellSizePx={cellSizePx}
                    onAnnotationClick={handleAnnotationClick}
                  />
                </div>
              ))}
            </div>
          </section>

          <div className="memory-map-gap" style={{ height: `${SECTION_GAP}px` }} />

          <section className="memory-map-section">
            <div className="memory-map-section-title">PRG</div>
            <div className="memory-map-region-list">
              {prgRegions.map((region) => (
                <div key={`region:${region.index}`}>
                  <div className="memory-map-region-label">
                    {fmtHex(region.start, 6)}–{fmtHex(region.end, 6)}
                  </div>
                  <MemorySection
                    title=""
                    baseLabel={region.start}
                    rows={region.rows}
                    cellSizePx={cellSizePx}
                    onAnnotationClick={handleAnnotationClick}
                  />
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <AnnotationPopup
        popup={annotationPopup}
        annotationsById={annotationsById}
        linkExpansionByGroup={linkExpansionByGroup}
        onSetLinkExpansion={handleSetLinkExpansion}
        onNavigateLink={handleNavigateLink}
      />
    </div>
  );
}
