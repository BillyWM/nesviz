import { useState } from 'react';

import { hex4, hex6, hexN } from '../util/hex.js';

function shapeLabel(shape) {
  if (shape === 'interleaved_words') return 'interleaved (lo/hi words)';
  if (shape === 'interleaved_pairs') return 'interleaved (lo/hi pairs)';
  return 'split (lo/hi tables)';
}

function confidenceLabel(c) {
  if (c === 'certain') return 'certain';
  if (c === 'probable') return 'probable';
  return 'weak';
}

function blockedSummary(blockedBy) {
  if (!blockedBy || blockedBy.length === 0) return null;
  return blockedBy.slice(0, 2).join(', ');
}

export function ArtifactPanel({ rom, mapper, stats, artifacts, unresolvedSites, pointsOfInterest, bookmarks, labelsByRomOff, onNavigateToRomSpan, onNavigateToRomOff, onContextMenuBookmark }) {
  const [openByKey, setOpenByKey] = useState(() => ({
    rom: true,
    poi: true,
    bookmarks: true,
    jumpTables: false,
    unresolved: false
  }));

  function toggle(key) {
    setOpenByKey((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const jumpTables = (artifacts || []).filter((a) => a.kind === 'jumpTable' && Number.isFinite(a.siteRomOff));
  const decodedJumpTables = jumpTables.filter((jt) => jt.status === 'decoded');
  const candidateJumpTables = jumpTables.filter((jt) => jt.status !== 'decoded');
  const resolvedRomOffs = new Set(decodedJumpTables
    .map((jt) => jt.siteRomOff)
    .filter((romOff) => Number.isFinite(romOff)));
  const unresolvedIndirectJmps = (unresolvedSites || [])
    .filter((s) => s?.kind === 'jmp_ind' && Number.isFinite(s.romOff));
  const codePctText = Number.isFinite(stats?.codePct)
    ? `${stats.codePct.toFixed(2)}%`
    : '0.00%';
  const confirmedCodePctOfCodeText = Number.isFinite(stats?.confirmedCodePctOfCode)
    ? `${stats.confirmedCodePctOfCode.toFixed(2)}%`
    : '0.00%';
  const probableCodePctOfCodeText = Number.isFinite(stats?.probableCodePctOfCode)
    ? `${stats.probableCodePctOfCode.toFixed(2)}%`
    : '0.00%';
  const codePctTitle = `Confirmed: ${confirmedCodePctOfCodeText} of discovered code\nProbable: ${probableCodePctOfCodeText} of discovered code`;
  const dataPctText = Number.isFinite(stats?.dataPct)
    ? `${stats.dataPct.toFixed(2)}%`
    : '0.00%';
  const unknownPctText = Number.isFinite(stats?.unknownPct)
    ? `${stats.unknownPct.toFixed(2)}%`
    : '100.00%';
  const totalPctText = Number.isFinite(stats?.totalPct)
    ? `${stats.totalPct.toFixed(2)}%`
    : '0.00%';

  return (
    <div className="nv-artifacts">
      <div className="nv-art-section">
        <div
          className="nv-art-header is-clickable"
          role="button"
          tabIndex={0}
          onClick={() => toggle('rom')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggle('rom');
            }
          }}
          aria-label={openByKey.rom ? 'Collapse ROM' : 'Expand ROM'}
        >
          <div className="nv-art-title">ROM</div>
          <button
            type="button"
            className="nv-disclosure"
            onClick={(e) => {
              // Prevent double toggle due to the parent click handler.
              e.stopPropagation();
              toggle('rom');
            }}
            aria-label={openByKey.rom ? 'Collapse' : 'Expand'}
          >
            {openByKey.rom ? '▼' : '▶'}
          </button>
        </div>
        {openByKey.rom && (
          <div className="nv-art-body">
        <div className="nv-art-kv">
          <span className="nv-art-k">File</span>
          <span className="nv-art-v">{rom?.filename ?? '—'}</span>
        </div>
        <div className="nv-art-kv">
          <span className="nv-art-k">Mapper</span>
          <span className="nv-art-v">{rom ? `${rom.mapperNumber} (${mapper?.kind ?? '?'})` : '—'}</span>
        </div>
        <div className="nv-art-kv">
          <span className="nv-art-k">PRG</span>
          <span className="nv-art-v">{rom ? `${rom.prgSize} bytes` : '—'}</span>
        </div>
        <div className="nv-art-kv">
          <span className="nv-art-k">Blocks</span>
          <span className="nv-art-v">{stats?.blockCount ?? 0}</span>
        </div>
        <div className="nv-art-kv">
          <span className="nv-art-k">Instructions</span>
          <span className="nv-art-v">{stats?.instructionCount ?? 0}</span>
        </div>
        <div className="nv-art-kv" title={codePctTitle}>
          <span className="nv-art-k">Code</span>
          <span className="nv-art-v">{codePctText}</span>
        </div>
        <div className="nv-art-kv">
          <span className="nv-art-k">Data</span>
          <span className="nv-art-v">{dataPctText}</span>
        </div>
        <div className="nv-art-kv">
          <span className="nv-art-k">Unknown</span>
          <span className="nv-art-v">{unknownPctText}</span>
        </div>
        <div className="nv-art-kv">
          <span className="nv-art-k">Total</span>
          <span className="nv-art-v">{totalPctText}</span>
        </div>
          </div>
        )}
      </div>

      <BookmarksSection
        isOpen={!!openByKey.bookmarks}
        onToggle={() => toggle('bookmarks')}
        bookmarks={bookmarks}
        onNavigateToRomOff={onNavigateToRomOff}
        onContextMenuBookmark={onContextMenuBookmark}
      />

      <PointsOfInterestSection
        isOpen={!!openByKey.poi}
        onToggle={() => toggle('poi')}
        pointsOfInterest={pointsOfInterest}
        onNavigateToRomSpan={onNavigateToRomSpan}
      />

      <div className="nv-art-section">
        <div
          className="nv-art-header is-clickable"
          role="button"
          tabIndex={0}
          onClick={() => toggle('jumpTables')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggle('jumpTables');
            }
          }}
          aria-label={openByKey.jumpTables ? 'Collapse Jump tables' : 'Expand Jump tables'}
        >
          <div className="nv-art-title">Jump tables ({jumpTables.length})</div>
          <button
            type="button"
            className="nv-disclosure"
            onClick={(e) => {
              // Prevent double toggle due to the parent click handler.
              e.stopPropagation();
              toggle('jumpTables');
            }}
            aria-label={openByKey.jumpTables ? 'Collapse' : 'Expand'}
          >
            {openByKey.jumpTables ? '▼' : '▶'}
          </button>
        </div>
        {openByKey.jumpTables && (
          <div className="nv-art-body">
        {jumpTables.length === 0 ? (
          <div className="nv-art-muted">No jump tables recognized yet.</div>
        ) : (
          <div className="nv-art-list">
            {decodedJumpTables.length > 0 && (
              <div className="nv-art-subtitle">Decoded</div>
            )}
            {decodedJumpTables.map((jt) => (
              <button
                key={jt.id}
                className="nv-art-item"
                onClick={() => onNavigateToRomOff?.(jt.siteRomOff)}
              >
                <div className="nv-art-item-title">
                  JMP ({hex4(jt.ptrAddr)}) @ ${hex4(jt.sitePc)}
                  <span className={`nv-art-badge is-${confidenceLabel(jt.confidence)}`}>{confidenceLabel(jt.confidence)}</span>
                </div>
                <div className="nv-art-item-sub">
                  {shapeLabel(jt.shape)} · idx {jt.indexSource ?? '?'} ({jt.indexSummary ?? 'unknown'}) · {jt.targets.length} targets
                </div>
              </button>
            ))}

            {candidateJumpTables.length > 0 && (
              <div className="nv-art-subtitle">Candidates</div>
            )}
            {candidateJumpTables.map((jt) => {
              const blocked = blockedSummary(jt.decodeBlockedBy);
              return (
                <button
                  key={jt.id}
                  className="nv-art-item is-candidate"
                  onClick={() => onNavigateToRomOff?.(jt.siteRomOff)}
                >
                  <div className="nv-art-item-title">
                    JMP ({hex4(jt.ptrAddr)}) @ ${hex4(jt.sitePc)}
                    <span className={`nv-art-badge is-${confidenceLabel(jt.confidence)}`}>{confidenceLabel(jt.confidence)}</span>
                  </div>
                  <div className="nv-art-item-sub">
                    {shapeLabel(jt.shape)} · idx {jt.indexSource ?? '?'} ({jt.indexSummary ?? 'unknown'}) · not decoded{blocked ? ` · blocked: ${blocked}` : ''}
                  </div>
                  <div className="nv-art-item-sub nv-art-evidence">
                    lo: {jt.evidence?.lo ?? '—'}
                  </div>
                  <div className="nv-art-item-sub nv-art-evidence">
                    hi: {jt.evidence?.hi ?? '—'}
                  </div>
                </button>
              );
            })}
          </div>
        )}
          </div>
        )}
      </div>

      <div className="nv-art-section">
        <div
          className="nv-art-header is-clickable"
          role="button"
          tabIndex={0}
          onClick={() => toggle('unresolved')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggle('unresolved');
            }
          }}
          aria-label={openByKey.unresolved ? 'Collapse Unresolved indirect JMP' : 'Expand Unresolved indirect JMP'}
        >
          <div className="nv-art-title">Unresolved indirect JMP ({unresolvedIndirectJmps.length})</div>
          <button
            type="button"
            className="nv-disclosure"
            onClick={(e) => {
              // Prevent double toggle due to the parent click handler.
              e.stopPropagation();
              toggle('unresolved');
            }}
            aria-label={openByKey.unresolved ? 'Collapse' : 'Expand'}
          >
            {openByKey.unresolved ? '▼' : '▶'}
          </button>
        </div>
        {openByKey.unresolved && (
          <div className="nv-art-body">
        {unresolvedIndirectJmps.length === 0 ? (
          <div className="nv-art-muted">None.</div>
        ) : (
          <div className="nv-art-list">
            {unresolvedIndirectJmps.map((s) => {
              const isResolved = Number.isFinite(s.romOff) && resolvedRomOffs.has(s.romOff);
              return (
                <button
                  key={`jmp-ind:${s.romOff}`}
                  className={`nv-art-item ${isResolved ? 'is-resolved' : ''}`}
                  onClick={() => onNavigateToRomOff?.(s.romOff)}
                >
                  <div className="nv-art-item-title">
                    JMP (...) @ ${hex4(s.pc)}
                  </div>
                  <div className="nv-art-item-sub">
                    ptr at ${hex4(s.ptrAddr)} · {isResolved ? 'resolved' : 'unresolved'}
                  </div>
                </button>
              );
            })}
          </div>
        )}
          </div>
        )}
      </div>
    </div>
  );
}

const POI_KIND_TITLES = {
  waitsForInterrupt: 'Waits for interrupt',
  waitsForZpValue: 'Waits for ZP value',
  waitsForVblank: 'Waits for vblank',
  waitsForSprite0Hit: 'Waits for sprite 0 hit',
  setsScroll: 'Sets scroll',
  writesPpuData: 'writes PPUDATA',
  oamDma: 'OAM DMA',
  writesPalettes: 'Writes Palettes',
  writesAttributes: 'Writes Attributes',
  dataTables: 'Data table reads',
  pointerTables: 'Pointer tables',
  monotoneTables: 'Monotone table reads',
  alignmentNops: 'Alignment NOPs'
};

const POI_KIND_ORDER = [
  'oamDma',
  'writesPpuData',
  'writesPalettes',
  'writesAttributes',
  'dataTables',
  'pointerTables',
  'monotoneTables',
  'setsScroll',
  'alignmentNops',
  'waitsForVblank',
  'waitsForSprite0Hit',
  'waitsForZpValue',
  'waitsForInterrupt'
];

const POI_KIND_ORDER_INDEX = Object.fromEntries(
  POI_KIND_ORDER.map((kind, index) => [kind, index])
);

function poiKindTitle(kind) {
  return POI_KIND_TITLES[kind] || kind;
}

function poiKindOrderIndex(kind) {
  return POI_KIND_ORDER_INDEX[kind] ?? 999;
}

function groupPois(pointsOfInterest) {
  const byKind = new Map();
  for (const p of pointsOfInterest || []) {
    const kind = p?.kind || 'unknown';
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(p);
  }
  const keys = Array.from(byKind.keys()).sort((a, b) => {
    const orderDelta = poiKindOrderIndex(a) - poiKindOrderIndex(b);
    if (orderDelta !== 0) return orderDelta;
    return a.localeCompare(b);
  });
  return keys.map((k) => ({ kind: k, items: byKind.get(k) }));
}

function BookmarksSection({ isOpen, onToggle, bookmarks, onNavigateToRomOff, onContextMenuBookmark }) {
  const sorted = (bookmarks || [])
    .filter((b) => b && Number.isFinite(b.romOff))
    .slice()
    .sort((a, b) => (a.romOff >>> 0) - (b.romOff >>> 0));

  return (
    <div className="nv-art-section">
      <div
        className="nv-art-header is-clickable"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle?.();
          }
        }}
        aria-label={isOpen ? 'Collapse Bookmarks' : 'Expand Bookmarks'}
      >
        <div className="nv-art-title">Bookmarks</div>
        <button
          type="button"
          className="nv-disclosure"
          onClick={(e) => {
            // Prevent double toggle due to the parent click handler.
            e.stopPropagation();
            onToggle?.();
          }}
          aria-label={isOpen ? 'Collapse' : 'Expand'}
        >
          {isOpen ? '▼' : '▶'}
        </button>
      </div>

      {isOpen && (
        <div className="nv-art-body">
          {sorted.length === 0 ? (
            <div className="nv-art-muted">None.</div>
          ) : (
            <div className="nv-art-list">
              {sorted.map((b) => {
                const romOff = b.romOff >>> 0;
                return (
                  <button
                    key={`bookmark:${romOff}`}
                    className="nv-art-item"
                    onClick={() => onNavigateToRomOff?.(romOff)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onContextMenuBookmark?.({ romOff }, e.clientX, e.clientY);
                    }}
                  >
                    <div className="nv-art-item-title">
                      ROM {hex6(romOff)}
                    </div>
                    <div className="nv-art-item-sub">
                      {hex6(romOff)}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function poiRomOffWidth(romOff) {
  const value = Number.isFinite(romOff) ? (romOff >>> 0) : 0;
  const digits = value.toString(16).length;
  return Math.max(4, Math.min(6, digits));
}

function formatPoiRomOff(romOff) {
  return `$${hexN(romOff >>> 0, poiRomOffWidth(romOff))}`;
}

function PointsOfInterestSection({ isOpen, onToggle, pointsOfInterest, onNavigateToRomSpan }) {
  const groups = groupPois(pointsOfInterest);
  return (
    <div className="nv-art-section">
      <div
        className="nv-art-header is-clickable"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle?.();
          }
        }}
        aria-label={isOpen ? 'Collapse Points Of Interest' : 'Expand Points Of Interest'}
      >
        <div className="nv-art-title">Points Of Interest</div>
        <button
          type="button"
          className="nv-disclosure"
          onClick={(e) => {
            // Prevent double toggle due to the parent click handler.
            e.stopPropagation();
            onToggle?.();
          }}
          aria-label={isOpen ? 'Collapse' : 'Expand'}
        >
          {isOpen ? '▼' : '▶'}
        </button>
      </div>
      {isOpen && (
        <div className="nv-art-body">
          {(!pointsOfInterest || pointsOfInterest.length === 0) ? (
            <div className="nv-art-muted">None.</div>
          ) : (
            <div className="nv-art-list">
              {groups.map((g) => (
                <div key={g.kind}>
                  <div className="nv-art-subtitle">{poiKindTitle(g.kind)}</div>
                  <div className="nv-poi-list">
                    {g.items.map((p) => {
                      const span = p?.basis?.romOffSpan;
                      const canNavigate = Number.isFinite(span?.start) && Number.isFinite(span?.end) && span.end > span.start;
                      const label = canNavigate ? formatPoiRomOff(span.start) : '—';
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className="nv-poi-addr"
                          onClick={() => {
                            if (canNavigate) onNavigateToRomSpan?.({ start: span.start >>> 0, end: span.end >>> 0 });
                          }}
                          disabled={!canNavigate}
                          title={canNavigate ? label : ''}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
