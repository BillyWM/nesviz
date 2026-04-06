import { useState } from 'react';

import { hex4, hex6 } from '../util/hex.js';

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

export function ArtifactPanel({ rom, mapper, stats, artifacts, unresolvedSites, pointsOfInterest, bookmarks, labelsBySite, onNavigateToBlock, onNavigateToSite, onContextMenuBookmark }) {
  const [openByKey, setOpenByKey] = useState(() => ({
    rom: true,
    poi: true,
    bookmarks: true,
    jumpTables: true,
    unresolved: true
  }));

  function toggle(key) {
    setOpenByKey((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const jumpTables = (artifacts || []).filter((a) => a.kind === 'jumpTable');
  const decodedJumpTables = jumpTables.filter((jt) => jt.status === 'decoded');
  const candidateJumpTables = jumpTables.filter((jt) => jt.status !== 'decoded');
  const resolvedPcs = new Set(decodedJumpTables.map((jt) => jt.sitePc));
  const coverageText = Number.isFinite(stats?.coveragePct)
    ? `${stats.coveragePct.toFixed(2)}%`
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
        <div className="nv-art-kv">
          <span className="nv-art-k">Coverage</span>
          <span className="nv-art-v">{coverageText}</span>
        </div>
          </div>
        )}
      </div>

      <BookmarksSection
        isOpen={!!openByKey.bookmarks}
        onToggle={() => toggle('bookmarks')}
        bookmarks={bookmarks}
        onNavigateToSite={onNavigateToSite}
        onContextMenuBookmark={onContextMenuBookmark}
      />

      <PointsOfInterestSection
        isOpen={!!openByKey.poi}
        onToggle={() => toggle('poi')}
        pointsOfInterest={pointsOfInterest}
        onNavigateToBlock={onNavigateToBlock}
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
          <div className="nv-art-title">Jump tables</div>
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
                onClick={() => onNavigateToBlock?.(jt.siteBlockId, null)}
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
                  onClick={() => onNavigateToBlock?.(jt.siteBlockId, null)}
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
          <div className="nv-art-title">Unresolved indirect JMP</div>
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
        {(!unresolvedSites || unresolvedSites.length === 0) ? (
          <div className="nv-art-muted">None.</div>
        ) : (
          <div className="nv-art-list">
            {unresolvedSites.map((s) => {
              const isResolved = resolvedPcs.has(s.pc);
              return (
                <button
                  key={`${s.blockId}:${s.pc}`}
                  className={`nv-art-item ${isResolved ? 'is-resolved' : ''}`}
                  onClick={() => onNavigateToBlock?.(s.blockId, null)}
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

function poiKindTitle(kind) {
  if (kind === 'waitsForInterrupt') return 'Waits for interrupt';
  if (kind === 'waitsForZpValue') return 'Waits for ZP value';
  if (kind === 'waitsForVblank') return 'Waits for vblank';
  if (kind === 'waitsForSprite0Hit') return 'Waits for sprite 0 hit';
  if (kind === 'setsScroll') return 'Sets scroll';
  if (kind === 'alignmentNops') return 'Alignment NOPs';
  return kind;
}

function groupPois(pointsOfInterest) {
  const byKind = new Map();
  for (const p of pointsOfInterest || []) {
    const kind = p?.kind || 'unknown';
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(p);
  }
  // Stable-ish order
  const order = ['setsScroll', 'alignmentNops', 'waitsForVblank', 'waitsForSprite0Hit', 'waitsForZpValue', 'waitsForInterrupt'];
  const keys = Array.from(byKind.keys()).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.localeCompare(b);
  });
  return keys.map((k) => ({ kind: k, items: byKind.get(k) }));
}

function BookmarksSection({ isOpen, onToggle, bookmarks, onNavigateToSite, onContextMenuBookmark }) {
  const sorted = (bookmarks || [])
    .filter((b) => b && typeof b.siteKey === 'string')
    .slice()
    .sort((a, b) => {
      const ar = typeof a.romOff === 'number' ? a.romOff : Number.MAX_SAFE_INTEGER;
      const br = typeof b.romOff === 'number' ? b.romOff : Number.MAX_SAFE_INTEGER;
      if (ar !== br) return ar - br;
      const ac = typeof a.cpuAddr === 'number' ? a.cpuAddr : 0;
      const bc = typeof b.cpuAddr === 'number' ? b.cpuAddr : 0;
      return ac - bc;
    });

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
                return (
                  <button
                    key={b.siteKey}
                    className="nv-art-item"
                    onClick={() => onNavigateToSite?.(b)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onContextMenuBookmark?.(b, e.clientX, e.clientY);
                    }}
                  >
                    <div className="nv-art-item-title">
                      {typeof b.cpuAddr === 'number' ? `$${hex4(b.cpuAddr)}` : '—'}
                    </div>
                    <div className="nv-art-item-sub">
                      {typeof b.cpuAddr === 'number'
                        ? `${`$${hex4(b.cpuAddr)}`} · ${hex6(b.romOff)}`
                        : hex6(b.romOff)}
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

function PointsOfInterestSection({ isOpen, onToggle, pointsOfInterest, onNavigateToBlock }) {
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
                    {g.items.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="nv-poi-addr"
                        onClick={() => onNavigateToBlock?.(p.anchorBlockId, p.anchorRomOff, p)}
                        title={typeof p.anchorRomOff === 'number' ? `PRG+${p.anchorRomOff.toString(16)}` : ''}
                      >
                        {typeof p.anchorCpuAddr === 'number' ? `$${hex4(p.anchorCpuAddr)}` : (p.anchorBlockId || '—')}
                      </button>
                    ))}
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
