import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { BlockStack } from './components/BlockStack.jsx';
import { ArtifactPanel } from './components/ArtifactPanel.jsx';
import { buildViewATimelineFromBlocks } from './util/timeline.js';
import { clampContextMenuPosition, getCurrentSelectionText } from './utils/domUtils.js';
import { formatHexDump } from './utils/hexDumpUtils.js';

function useBlocksById(blocks) {
  return useMemo(() => new Map((blocks || []).map((b) => [b.id, b])), [blocks]);
}

function fmtCpu(addr) {
  if (typeof addr !== 'number') return '????';
  return addr.toString(16).toUpperCase().padStart(4, '0');
}

function fmtRom(addr) {
  if (typeof addr !== 'number') return '??????';
  return addr.toString(16).toUpperCase().padStart(6, '0');
}

function emptyVectorDestinations() {
  return { nmi: [], reset: [], irq: [] };
}

function gapKeyFor(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.gapKey === 'string' && item.gapKey) return item.gapKey;
  const type = typeof item.type === 'string' ? item.type : 'unknown';
  const romStart = typeof item.romStart === 'number' ? item.romStart : Number(item.romStart);
  const romEnd = typeof item.romEnd === 'number' ? item.romEnd : Number(item.romEnd);
  if (!Number.isFinite(romStart) || !Number.isFinite(romEnd)) return null;
  return `gap:${type}:${romStart | 0}:${romEnd | 0}`;
}



export default function App() {
  const [rom, setRom] = useState(null);
  const [romHash, setRomHash] = useState(null);
  const [vectors, setVectors] = useState(null);
  const [vectorDestinations, setVectorDestinations] = useState(emptyVectorDestinations());
  const [openVectorMenuFamily, setOpenVectorMenuFamily] = useState(null);
  const [cdl, setCdl] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [mapper, setMapper] = useState(null);
  const [stats, setStats] = useState(null);
  const [artifacts, setArtifacts] = useState([]);
  const [unresolvedSites, setUnresolvedSites] = useState([]);
  const [pointsOfInterest, setPointsOfInterest] = useState([]);
  // Highlighted POI span (in-memory only). Set when clicking a POI so its lines stay tinted when you scroll away/back.
  const [markedRomSpan, setMarkedRomSpan] = useState(null);
  // Per-ROM user annotations.
  const [bookmarks, setBookmarks] = useState([]);
  const [labelsByRomOff, setLabelsByRomOff] = useState({});
  const [labelsByAddr, setLabelsByAddr] = useState({});
  const [focusLocation, setFocusLocation] = useState(null);
  const [status, setStatus] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isLoadingCachedAnalysis, setIsLoadingCachedAnalysis] = useState(false);
  const [vsaProgress, setVsaProgress] = useState({ runId: null, totalBlocks: null, maxRatio: 0 });

  // Hovered code row (in-memory only). We keep this in a ref to avoid rerendering on hover.
  const hoveredLineRef = useRef(null);
  const contextMenuRef = useRef(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [shownGapBytesByKey, setShownGapBytesByKey] = useState({});
  const [gapBytesByKey, setGapBytesByKey] = useState({});
  const [gapBytesLoadingByKey, setGapBytesLoadingByKey] = useState({});
  const [showDebugInfo, setShowDebugInfo] = useState(false);
  const [analysisDebug, setAnalysisDebug] = useState(null);
  const [vsaDebugModal, setVsaDebugModal] = useState(null);

  // Label editing modal (in-memory only).
  const [labelModal, setLabelModal] = useState(null);
  const [labelText, setLabelText] = useState('');

  // Navigation history (in-memory only): updated only when clicking links (code/POIs/etc).
  const navStackRef = useRef([]);
  const stackApiRef = useRef({});
  const suppressHistoryPushRef = useRef(false);
  const openRequestIdRef = useRef(0);

  const blocksById = useBlocksById(blocks);

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const pos = clampContextMenuPosition(contextMenu.x, contextMenu.y, rect.width, rect.height);
    if (pos.x === contextMenu.x && pos.y === contextMenu.y) return;
    setContextMenu((prev) => {
      if (!prev) return prev;
      if (prev.x === pos.x && prev.y === pos.y) return prev;
      return { ...prev, x: pos.x, y: pos.y };
    });
  }, [contextMenu]);

  useEffect(() => {
    // Live VSA progress streamed from the analysis worker.
    return window.nesviz.onVsaProgress((payload) => {
      const stable = Number(payload?.stableBlocks);
      const total = Number(payload?.totalBlocks);
      const runIdRaw = payload?.runId;
      const runId = (typeof runIdRaw === 'number' && Number.isFinite(runIdRaw)) ? (runIdRaw | 0) : null;
      if (!(total > 0) || !Number.isFinite(stable) || !Number.isFinite(total)) return;
      const ratio = Math.max(0, Math.min(1, stable / total));
      setVsaProgress((prev) => {
        const isNewTotal = prev.totalBlocks !== total;
        const isNewRun = (runId !== null) && (prev.runId !== runId);
        const nextMax = (isNewRun || isNewTotal) ? ratio : Math.max(prev.maxRatio, ratio);
        return { runId: runId ?? prev.runId, totalBlocks: total, maxRatio: nextMax };
      });
    });
  }, []);

  useEffect(() => {
    if (!window?.nesviz?.onMenuSetShowDebugInfo) return undefined;
    return window.nesviz.onMenuSetShowDebugInfo((checked) => {
      setShowDebugInfo(!!checked);
    });
  }, []);

  useEffect(() => {
    if (!openVectorMenuFamily) return undefined;
    const onPointerDown = () => setOpenVectorMenuFamily(null);
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [openVectorMenuFamily]);


  const candidateBlockIdsForRomOff = useMemo(() => {
    const ranges = (blocks || [])
      .map((b) => {
        const romStart = typeof b?.romStart === 'number' ? b.romStart : null;
        const romEnd = typeof b?.romEnd === 'number' ? b.romEnd : null;
        if (romStart === null || romEnd === null) return null;
        return { romStart: romStart >>> 0, romEnd: romEnd >>> 0, blockId: b.id };
      })
      .filter(Boolean)
      .sort((a, b) => a.romStart - b.romStart);

    return (romOff) => {
      if (!Number.isFinite(romOff)) return [];
      const target = romOff >>> 0;
      return ranges.filter((r) => target >= r.romStart && target < r.romEnd).map((r) => r.blockId);
    };
  }, [blocks]);

  const bookmarkRomOffSet = useMemo(() => {
    const s = new Set();
    for (const b of bookmarks || []) {
      const romOff = typeof b?.romOff === 'number' ? (b.romOff >>> 0) : null;
      if (romOff !== null) s.add(romOff);
    }
    return s;
  }, [bookmarks]);

  function normalizeRomOffValue(value) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return n >>> 0;
  }

  function normalizeRomSpanValue(value) {
    if (Number.isFinite(value)) {
      const off = normalizeRomOffValue(value);
      return off === null ? null : { start: off, end: off + 1 };
    }
    const start = normalizeRomOffValue(value?.start);
    const end = normalizeRomOffValue(value?.end);
    if (start === null || end === null || end <= start) return null;
    return { start, end };
  }

  function isBookmarkedRomOff(romOff) {
    const off = normalizeRomOffValue(romOff);
    return off !== null && bookmarkRomOffSet.has(off);
  }

  function getLabelForRomOff(romOff) {
    const off = normalizeRomOffValue(romOff);
    if (off === null) return '';
    const v = labelsByRomOff?.[String(off)]?.label;
    return typeof v === 'string' ? v : '';
  }

  function getLabelForAddr(cpuAddr) {
    if (typeof cpuAddr !== 'number') return '';
    const v = labelsByAddr?.[String(cpuAddr & 0xffff)];
    return typeof v === 'string' ? v : '';
  }

  const setBookmarkAtRomOff = useCallback(async (romOff, set) => {
    if (!romHash) return;
    if (!window?.nesviz?.setBookmarkAtRomOff) return;
    const off = normalizeRomOffValue(romOff);
    if (off === null) return;
    const res = await window.nesviz.setBookmarkAtRomOff(off, !!set);
    if (res?.ok) {
      setBookmarks(Array.isArray(res.bookmarks) ? res.bookmarks : []);
    }
  }, [romHash]);

  const toggleBookmarkAtRomOff = useCallback(async (romOff) => {
    const off = normalizeRomOffValue(romOff);
    if (off === null) return;
    const exists = bookmarkRomOffSet.has(off);
    await setBookmarkAtRomOff(off, !exists);
  }, [bookmarkRomOffSet, setBookmarkAtRomOff]);

  const setRomLabelAt = useCallback(async (romOff, label) => {
    if (!romHash) return;
    if (!window?.nesviz?.setRomLabel) return;
    const off = normalizeRomOffValue(romOff);
    if (off === null) return;
    const res = await window.nesviz.setRomLabel(off, label);
    if (res?.ok) {
      setLabelsByRomOff(res.labels && typeof res.labels === 'object' ? res.labels : {});
    }
  }, [romHash]);

  const setAddrLabelAt = useCallback(async (cpuAddr, label) => {
    if (!romHash) return;
    if (!window?.nesviz?.setAddrLabel) return;
    const res = await window.nesviz.setAddrLabel(cpuAddr, label);
    if (res?.ok) {
      setLabelsByAddr(res.addrLabels && typeof res.addrLabels === 'object' ? res.addrLabels : {});
    }
  }, [romHash]);

  async function resolveDisplayAnchorForRomSpan(value) {
    const span = normalizeRomSpanValue(value);
    if (!span) return { ok: false, error: 'No ROM offset available.' };

    const candidateIds = candidateBlockIdsForRomOff(span.start);
    if (!candidateIds.length) {
      return { ok: false, error: `No display block contains ROM $${fmtRom(span.start)}.` };
    }

    for (const blockId of candidateIds) {
      const res = await window.nesviz.getBlock(blockId);
      if (!res?.ok || !res.block) continue;
      const lines = Array.isArray(res.block.lines) ? res.block.lines : [];
      for (const line of lines) {
        if (typeof line?.romOff !== 'number') continue;
        const lineStart = line.romOff >>> 0;
        if (lineStart !== span.start) continue;
        const lineLen = (typeof line.len === 'number' && line.len > 0) ? (line.len >>> 0) : 1;
        return {
          ok: true,
          blockId,
          focusRomOff: span.start,
          span: value && typeof value === 'object' && Number.isFinite(value.end)
            ? span
            : { start: span.start, end: span.start + lineLen }
        };
      }
    }

    return { ok: false, error: `No display line starts at ROM $${fmtRom(span.start)}.` };
  }

  function navigateToBlockId(blockId, focusRomOff = null) {
    if (!blockId) return;
    setOpenVectorMenuFamily(null);
    setFocusLocation({ blockId, focusRomOff: (typeof focusRomOff === 'number' ? focusRomOff : null) });
  }

  function updateHoveredLine(lineInfo) {
    if (!lineInfo) return;
    const romOff = normalizeRomOffValue(lineInfo.romOff);
    if (romOff === null) return;
    const cpuAddr = typeof lineInfo.cpuAddr === 'number' ? lineInfo.cpuAddr : (lineInfo.cpuAddr != null ? Number(lineInfo.cpuAddr) : null);
    const labelTarget = (lineInfo.labelTarget === 'operand') ? 'operand' : 'line';
    const operandAddrRaw = (typeof lineInfo.operandAddr === 'number')
      ? lineInfo.operandAddr
      : (lineInfo.operandAddr != null ? Number(lineInfo.operandAddr) : null);
    const operandAddr = Number.isFinite(operandAddrRaw) ? (operandAddrRaw & 0xffff) : null;
    hoveredLineRef.current = {
      romOff,
      cpuAddr: Number.isFinite(cpuAddr) ? (cpuAddr & 0xffff) : null,
      labelTarget,
      operandAddr,
      blockId: lineInfo.blockId || null
    };
  }

  function openLabelModalForRomOff(romOff) {
    const off = normalizeRomOffValue(romOff);
    if (off === null) return;
    const existing = getLabelForRomOff(off);
    setLabelText(existing || '');
    setLabelModal({ kind: 'rom', romOff: off });
  }

  function openLabelModalForAddr(cpuAddr) {
    const a = typeof cpuAddr === 'number' ? (cpuAddr & 0xffff) : Number(cpuAddr);
    if (!Number.isFinite(a) || a < 0) return;
    const existing = getLabelForAddr(a & 0xffff);
    setLabelText(existing || '');
    setLabelModal({ kind: 'addr', cpuAddr: a & 0xffff });
  }

  function openLineContextMenu(lineInfo, clientX, clientY) {
    updateHoveredLine(lineInfo);
    const line = hoveredLineRef.current;
    if (!line) return;

    const pos = clampContextMenuPosition(clientX ?? 0, clientY ?? 0, 210, 160);
    setContextMenu({
      kind: 'line',
      x: pos.x,
      y: pos.y,
      selectedText: getCurrentSelectionText(),
      selectedCodeText: typeof lineInfo?.selectedCodeText === 'string' ? lineInfo.selectedCodeText : '',
      asmText: typeof lineInfo?.asmText === 'string' ? lineInfo.asmText : '',
      ...line
    });
  }

  function openBlockContextMenu(blockInfo, clientX, clientY) {
    if (!blockInfo) return;
    const romOff = normalizeRomOffValue(blockInfo.romOff);
    if (romOff === null) return;
    const cpuAddr = typeof blockInfo.cpuAddr === 'number' ? blockInfo.cpuAddr : (blockInfo.cpuAddr != null ? Number(blockInfo.cpuAddr) : null);

    const pos = clampContextMenuPosition(clientX ?? 0, clientY ?? 0, 210, 120);
    setContextMenu({ kind: 'block', x: pos.x, y: pos.y, selectedText: getCurrentSelectionText(), romOff, cpuAddr: Number.isFinite(cpuAddr) ? (cpuAddr & 0xffff) : null, blockId: blockInfo.blockId || null });
  }

  function openGapContextMenu(gapInfo, clientX, clientY) {
    if (!gapInfo || gapInfo.type !== 'unknown') return;
    const gapKey = gapKeyFor(gapInfo);
    if (!gapKey) return;

    const pos = clampContextMenuPosition(clientX ?? 0, clientY ?? 0, 210, 120);
    setContextMenu({ kind: 'gap', x: pos.x, y: pos.y, selectedText: getCurrentSelectionText(), gapKey, type: gapInfo.type, romStart: gapInfo.romStart | 0, romEnd: gapInfo.romEnd | 0 });
  }

  async function toggleGapBytes(gapInfo) {
    const gapKey = gapKeyFor(gapInfo);
    if (!gapKey) return;

    if (shownGapBytesByKey[gapKey]) {
      setShownGapBytesByKey((p) => ({ ...p, [gapKey]: false }));
      return;
    }

    setShownGapBytesByKey((p) => ({ ...p, [gapKey]: true }));
    if (typeof gapBytesByKey[gapKey] === 'string' || gapBytesLoadingByKey[gapKey]) return;

    setGapBytesLoadingByKey((p) => ({ ...p, [gapKey]: true }));
    try {
      const res = await window.nesviz.getPrgBytes(gapInfo.romStart, gapInfo.romEnd);
      if (res?.ok) {
        setGapBytesByKey((p) => ({ ...p, [gapKey]: formatHexDump(Array.isArray(res.bytes) ? res.bytes : []) }));
      }
    } finally {
      setGapBytesLoadingByKey((p) => {
        const n = { ...p };
        delete n[gapKey];
        return n;
      });
    }
  }

  function getTopVisibleBlockId() {
    const fn = stackApiRef?.current?.getTopVisibleBlockId;
    const id = typeof fn === 'function' ? fn() : null;
    return id || null;
  }

  function pushCurrentLocationForLinkClick() {
    const fromId = getTopVisibleBlockId();
    if (!fromId) return;
    const stack = navStackRef.current;
    if (stack.length && stack[stack.length - 1] === fromId) return;
    stack.push(fromId);
  }

  function navigateToBlockIdWithHistory(blockId, focusRomOff = null, span = null) {
    if (!suppressHistoryPushRef.current) pushCurrentLocationForLinkClick();
    if (span && typeof span.start === 'number' && typeof span.end === 'number') {
      setMarkedRomSpan({ start: span.start >>> 0, end: span.end >>> 0 });
    }
    navigateToBlockId(blockId, focusRomOff);
  }

  async function navigateToRomSpanWithHistory(value) {
    const anchor = await resolveDisplayAnchorForRomSpan(value);
    if (!anchor.ok) {
      setStatus(anchor.error || 'No display line for ROM target.');
      return;
    }
    navigateToBlockIdWithHistory(anchor.blockId, anchor.focusRomOff, anchor.span);
  }

  function navigateToRomOffWithHistory(romOff) {
    void navigateToRomSpanWithHistory(romOff);
  }


  function getVectorDestinationsForFamily(family) {
    return Array.isArray(vectorDestinations?.[family]) ? vectorDestinations[family] : [];
  }

  function handleVectorFooterClick(family, event) {
    const entries = getVectorDestinationsForFamily(family);
    if (!entries.length) return;
    if (entries.length === 1) {
      const entry = entries[0];
      navigateToRomOffWithHistory(entry.romOff);
      return;
    }
    event?.stopPropagation?.();
    setOpenVectorMenuFamily((prev) => (prev === family ? null : family));
  }

  function renderVectorFooterItem(family, label, rawCpuAddr) {
    const entries = getVectorDestinationsForFamily(family);
    const text = `${label}: $${fmtCpu(rawCpuAddr)}`;
    const isOpen = openVectorMenuFamily === family;
    if (!entries.length) {
      return <span className="nv-footer-plain" title="No discovered destination for this vector">{text}</span>;
    }
    if (entries.length === 1) {
      return (
        <button
          type="button"
          className="nv-footer-link"
          onClick={() => handleVectorFooterClick(family)}
          title="Jump to discovered vector target"
        >
          {text}
        </button>
      );
    }
    return (
      <div className="nv-footer-vector">
        <button
          type="button"
          className="nv-footer-link"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => handleVectorFooterClick(family, event)}
          title="Show discovered vector destinations"
          aria-expanded={isOpen ? 'true' : 'false'}
        >
          {text}
        </button>
        {isOpen ? (
          <div className="nv-footer-popup" onPointerDown={(event) => event.stopPropagation()}>
            <div className="nv-footer-popup-title">Discovered destinations</div>
            {entries.map((entry) => (
              <button
                key={`${family}:${entry.romOff}`}
                type="button"
                className="nv-footer-popup-link"
                onClick={() => {
                  setOpenVectorMenuFamily(null);
                  navigateToRomOffWithHistory(entry.romOff);
                }}
                title={entry.asm || `ROM ${fmtRom(entry.romOff)}`}
              >
                {fmtRom(entry.romOff)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  // Navigation requests coming from the Labels secondary window.
  useEffect(() => {
    if (!window?.nesviz?.onLabelsNavigate) return;
    const unsub = window.nesviz.onLabelsNavigate((msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'rom') {
        navigateToRomOffWithHistory(msg.romOff);
      }
    });
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [navigateToRomOffWithHistory]);


  function isEditableElement(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  useEffect(() => {
    function onKeyDown(e) {
      if (e.defaultPrevented) return;

      // Don't steal keystrokes from text editing.
      const active = document.activeElement;
      if (isEditableElement(active)) return;

      // Ctrl+B toggles a bookmark on the currently hovered row (contextual add/remove).
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        const line = hoveredLineRef.current;
        if (!line || !Number.isFinite(line.romOff)) return;
        e.preventDefault();
        e.stopPropagation();
        void toggleBookmarkAtRomOff(line.romOff);
        return;
      }

      if (e.key === 'Escape') {
        if (contextMenu) {
          e.preventDefault();
          e.stopPropagation();
          setContextMenu(null);
          return;
        }
        if (labelModal) {
          e.preventDefault();
          e.stopPropagation();
          setLabelModal(null);
          return;
        }
        return;
      }

      if (e.key !== 'Backspace') return;

      const stack = navStackRef.current;
      if (!stack || stack.length === 0) return;

      e.preventDefault();
      e.stopPropagation();
      const prev = stack.pop();
      if (!prev) return;

      suppressHistoryPushRef.current = true;
      try {
        navigateToBlockId(prev);
      } finally {
        // Clear in next tick to avoid accidental pushes if navigation triggers sync callbacks.
        window.setTimeout(() => { suppressHistoryPushRef.current = false; }, 0);
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, [contextMenu, labelModal, toggleBookmarkAtRomOff]);

  useEffect(() => {
    if (!window?.nesviz?.getStartupRomPath) return;

    let canceled = false;

    (async () => {
      try {
        const res = await window.nesviz.getStartupRomPath();
        if (canceled || !res?.ok || !res?.filepath) return;
        await openRomPath(res.filepath);
      } catch {
        // Keep startup quiet if the remembered ROM cannot be restored.
      }
    })();

    return () => {
      canceled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!window?.nesviz?.onMenuOpenRom) return;
    const unsubOpen = window.nesviz.onMenuOpenRom(() => {
      openRom();
    });
    const unsubOpenRecent = window.nesviz.onMenuOpenRecentRom?.((filepath) => {
      if (!filepath) return;
      openRomPath(filepath);
    });
    const unsubOpenCdl = window.nesviz.onMenuOpenCdl?.(() => {
      openCdl();
    });
    const unsubAbout = window.nesviz.onMenuShowAbout?.(() => {
      setStatus('NesViz: NES reverse engineering tool (static analysis prototype)');
      setTimeout(() => setStatus(''), 2500);
    });
    return () => {
      if (typeof unsubOpen === 'function') unsubOpen();
      if (typeof unsubOpenRecent === 'function') unsubOpenRecent();
      if (typeof unsubOpenCdl === 'function') unsubOpenCdl();
      if (typeof unsubAbout === 'function') unsubAbout();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadActiveAnalysisIntoUi(statusPrefix, opts = {}) {
    const requestId = Number.isFinite(opts?.requestId) ? opts.requestId : null;
    const isStale = () => requestId !== null && openRequestIdRef.current !== requestId;

    const tlRes = await window.nesviz.getTimeline();
    if (isStale()) return false;
    const artRes = await window.nesviz.getArtifacts();
    if (isStale()) return false;

    if (tlRes.ok) {
      console.log('NesViz getTimeline', tlRes);
      if (tlRes.debug) console.log('NesViz analysis debug', tlRes.debug);
      const idx = (tlRes.blocksIndex || [])
        .map((b) => {
          if (!b) return null;
          const romStart = typeof b.romStart === 'number' ? b.romStart : Number(b.romStart);
          const romEnd = typeof b.romEnd === 'number' ? b.romEnd : Number(b.romEnd);
          const cpuStart = typeof b.cpuStart === 'number' ? b.cpuStart : (b.cpuStart != null ? Number(b.cpuStart) : null);
          const cpuEnd = typeof b.cpuEnd === 'number' ? b.cpuEnd : (b.cpuEnd != null ? Number(b.cpuEnd) : null);
          if (!Number.isFinite(romStart) || !Number.isFinite(romEnd)) return null;
          return { ...b, romStart, romEnd, cpuStart: Number.isFinite(cpuStart) ? cpuStart : null, cpuEnd: Number.isFinite(cpuEnd) ? cpuEnd : null };
        })
        .filter(Boolean);

      let built = Array.isArray(tlRes.timeline) && tlRes.timeline.length ? tlRes.timeline : buildViewATimelineFromBlocks(idx);

      // Ultra-defensive fallback: if coercion worked but the timeline builder still yields no code,
      // show a simple code-only list so we never end up with a blank/only-gap PRG view. 🤖
      if (built.length === 0 && idx.length) {
        const sorted = [...idx].sort((a, b) => a.romStart - b.romStart);
        built = sorted.map((b) => ({
          type: 'code',
          blockId: b.id,
          romStart: b.romStart,
          romEnd: b.romEnd,
          byteLen: (b.romEnd - b.romStart) | 0
        }));
      }

      const codeCount = built.filter((t) => t.type === 'code').length;
      const dataCount = built.filter((t) => t.type === 'data').length;
      setStatus(`${statusPrefix} Blocks: ${idx.length}. Rendered: ${built.length} items (${codeCount} code, ${dataCount} data).`);
      setTimeline(built);
      setBlocks(idx);
      setMapper(tlRes.mapper);
      setStats(tlRes.stats);
      setAnalysisDebug(tlRes.debug || null);
      setVectorDestinations((tlRes.vectorDestinationsByFamily && typeof tlRes.vectorDestinationsByFamily === 'object') ? tlRes.vectorDestinationsByFamily : emptyVectorDestinations());
      setOpenVectorMenuFamily(null);
    }

    if (isStale()) return false;

    if (artRes.ok) {
      console.log('NesViz getArtifacts', artRes);
      setArtifacts(artRes.artifacts || []);
      setUnresolvedSites(artRes.unresolvedSites || []);
      setPointsOfInterest(artRes.pointsOfInterest || []);
      setMapper(artRes.mapper);
      setStats(artRes.stats);
    }

    return true;
  }

  function applyOpenedRomToUi(res) {
    setRom(res.rom);
    setRomHash(res.romHash || null);
    setVectors(res.vectors);
    setVectorDestinations(emptyVectorDestinations());
    setOpenVectorMenuFamily(null);
    setBookmarks(Array.isArray(res.bookmarks) ? res.bookmarks : []);
    setLabelsByRomOff((res.labels && typeof res.labels === 'object') ? res.labels : {});
    setLabelsByAddr((res.addrLabels && typeof res.addrLabels === 'object') ? res.addrLabels : {});
    setContextMenu(null);
    setLabelModal(null);
    hoveredLineRef.current = null;
    setShownGapBytesByKey({});
    setGapBytesByKey({});
    setGapBytesLoadingByKey({});
    setAnalysisDebug(null);
    setVsaDebugModal(null);

    // New ROM => clear navigation history note: in-memory only.
    navStackRef.current = [];
    suppressHistoryPushRef.current = false;

    setCdl(null);
    setTimeline([]);
    setBlocks([]);
    setMapper(null);
    setStats(null);
    setArtifacts([]);
    setUnresolvedSites([]);
    setPointsOfInterest([]);
    setMarkedRomSpan(null);
    setFocusLocation(null);
  }

  async function maybeLoadCachedAnalysis(requestId) {
    setIsLoadingCachedAnalysis(true);
    setStatus('Loading cached analysis…');

    try {
      const cacheRes = await window.nesviz.loadActiveAnalysisCache();
      if (openRequestIdRef.current !== requestId) return;

      if (!cacheRes?.ok) {
        setStatus(cacheRes?.error || 'Cached analysis load failed');
        return;
      }

      if (!cacheRes.hasCachedAnalysis) {
        setStatus('ROM loaded.');
        return;
      }

      await loadActiveAnalysisIntoUi('Loaded cached analysis.', { requestId });
    } catch (e) {
      if (openRequestIdRef.current !== requestId) return;
      setStatus(`Cached analysis load failed: ${e?.message ?? String(e)}`);
    } finally {
      if (openRequestIdRef.current === requestId) {
        setIsLoadingCachedAnalysis(false);
      }
    }
  }

  async function handleOpenRomRequest(openFn, openFailedMessage) {
    const requestId = (openRequestIdRef.current + 1) | 0;
    openRequestIdRef.current = requestId;
    setIsLoadingCachedAnalysis(false);
    setStatus('Opening ROM…');

    try {
      const res = await openFn();
      if (openRequestIdRef.current !== requestId) return;
      if (!res.ok) {
        setStatus(res.canceled ? '' : (res.error || openFailedMessage));
        return;
      }

      applyOpenedRomToUi(res);
      if (res.hasCachedAnalysis) {
        void maybeLoadCachedAnalysis(requestId);
      } else {
        setStatus('ROM loaded.');
      }
    } catch (e) {
      if (openRequestIdRef.current !== requestId) return;
      setStatus(`Open failed: ${e?.message ?? String(e)}`);
    }
  }

  async function openRom() {
    await handleOpenRomRequest(() => window.nesviz.openRom(), 'Open canceled');
  }

  async function openRomPath(filepath) {
    await handleOpenRomRequest(() => window.nesviz.openRomPath(filepath), 'Open failed');
  }

  function getContextMenuLabelTarget(cm) {
    if (!cm) return null;
    // If the click was over the ASM column, we treat "label" as labeling the operand address.
    if (cm.kind === 'line' && cm.labelTarget === 'operand') {
      if (typeof cm.operandAddr !== 'number') return null;
      const a = cm.operandAddr & 0xffff;
      return { kind: 'addr', key: a, existing: getLabelForAddr(a) };
    }
    if (Number.isFinite(cm.romOff)) {
      const romOff = cm.romOff >>> 0;
      return { kind: 'rom', romOff, existing: getLabelForRomOff(romOff) };
    }
    return null;
  }

  function getContextMenuCopyCodeText(cm) {
    if (!cm || cm.kind !== 'line') return '';
    if (typeof cm.selectedCodeText === 'string' && cm.selectedCodeText) return cm.selectedCodeText;
    if (typeof cm.asmText === 'string' && cm.asmText) return cm.asmText;
    return '';
  }

  async function copyTextToClipboard(text) {
    if (!window?.nesviz?.copyText) return;
    const payload = typeof text === 'string' ? text : String(text ?? '');
    if (!payload) return;
    const res = await window.nesviz.copyText(payload);
    if (!res?.ok) throw new Error(res?.error || 'Copy failed');
  }

  async function handleContextMenuCopy(text) {
    try {
      await copyTextToClipboard(text);
    } catch (e) {
      setStatus(`Copy failed: ${e?.message ?? String(e)}`);
    } finally {
      setContextMenu(null);
    }
  }

  async function showVsaForContextMenu(cm) {
    const blockId = cm?.blockId || null;
    if (!showDebugInfo || !blockId || !window?.nesviz?.getBlockVsaDebug) return;
    setContextMenu(null);
    setVsaDebugModal({ loading: true, error: '', debug: null });
    try {
      const res = await window.nesviz.getBlockVsaDebug(blockId);
      if (!res?.ok) {
        setVsaDebugModal({ loading: false, error: res?.error || 'VSA debug lookup failed', debug: null });
        return;
      }
      setVsaDebugModal({ loading: false, error: '', debug: res.debug || null });
    } catch (e) {
      setVsaDebugModal({ loading: false, error: e?.message || String(e), debug: null });
    }
  }

  async function saveLabelModal() {
    if (!labelModal) return;

    if (labelModal.kind === 'addr') {
      await setAddrLabelAt(labelModal.cpuAddr, labelText);
      return;
    }

    if (labelModal.kind === 'rom') {
      await setRomLabelAt(labelModal.romOff, labelText);
    }
  }

  async function openCdl() {
    setStatus('Opening CDL…');
    try {
      const res = await window.nesviz.openCdl();
      if (!res.ok) {
        setStatus(res.canceled ? '' : (res.error || 'Open canceled'));
        return;
      }

      setCdl(res.cdl || null);
      const warns = (res.cdl?.warnings || []).filter(Boolean);
      const warnText = warns.length ? ` Warnings: ${warns.join(' | ')}` : '';
      setStatus(`CDL loaded: ${res.cdl?.filename || '(unknown)'} (run analysis to apply).${warnText}`);
    } catch (e) {
      setStatus(`Open CDL failed: ${e?.message ?? String(e)}`);
    }
  }

  async function runStatic() {
    if (!romHash) return;
    setIsAnalyzing(true);
    setIsLoadingCachedAnalysis(false);
    setVsaProgress({ runId: null, totalBlocks: null, maxRatio: 0 });
    setStatus('Analyzing…');
    setShownGapBytesByKey({});
    setGapBytesByKey({});
    setGapBytesLoadingByKey({});
    setAnalysisDebug(null);
    try {
      const runRes = await window.nesviz.runStaticAnalysis();
      if (!runRes.ok) {
        setStatus(runRes.error || 'Analysis failed');
        return;
      }

      await loadActiveAnalysisIntoUi('Analysis complete.');
    } catch (e) {
      setStatus(`Analysis failed: ${e?.message ?? String(e)}`);
    } finally {
      // Hide the progress bar once analysis finishes (success or failure).
      setIsAnalyzing(false);
      setVsaProgress({ runId: null, totalBlocks: null, maxRatio: 0 });
    }
  }

  return (
    <div className="nv-app">
      <header className="nv-topbar">
        <div className="nv-top-left">
          <button className="nv-btn" onClick={runStatic} disabled={!romHash || isAnalyzing}>{isAnalyzing ? 'Analyzing...' : 'Analyze'}</button>
        </div>
        <div className="nv-top-meta">
          {rom ? (
            <>
              <span className="nv-meta-item"><strong>{rom.filename}</strong></span>
              <span className="nv-meta-item">mapper {rom.mapperNumber}</span>
              <span className="nv-meta-item">PRG {rom.prgSize} bytes</span>
              {cdl ? <span className="nv-meta-item">CDL {cdl.filename}</span> : null}
            </>
          ) : (
            <span className="nv-meta-item">No ROM loaded</span>
          )}
        </div>
        <div className="nv-top-status" title={status}>
          {isAnalyzing && vsaProgress.totalBlocks ? (
            <div
              className="nv-top-status-progress"
              style={{ width: `${Math.round(vsaProgress.maxRatio * 100)}%` }}
            />
          ) : null}
          <span className="nv-top-status-text">{status}</span>
        </div>
      </header>

      <div className="nv-main">
        <section className="nv-stack-pane">
          <div className="nv-panel-title">PRG view</div>
          <BlockStack
            timeline={timeline}
            blocksById={blocksById}
            focusLocation={focusLocation}
            markedRomSpan={markedRomSpan}
            isLoadingCachedAnalysis={isLoadingCachedAnalysis}
            onFocused={() => setFocusLocation(null)}
            onNavigateToRomOff={navigateToRomOffWithHistory}
            labelsByRomOff={labelsByRomOff}
            labelsByAddr={labelsByAddr}
            onHoverLine={updateHoveredLine}
            onContextMenuLine={(lineInfo, x, y) => openLineContextMenu(lineInfo, x, y)}
            onContextMenuBlock={(blockInfo, x, y) => openBlockContextMenu(blockInfo, x, y)}
            onContextMenuGap={(gapInfo, x, y) => openGapContextMenu(gapInfo, x, y)}
            shownGapBytesByKey={shownGapBytesByKey}
            gapBytesByKey={gapBytesByKey}
            gapBytesLoadingByKey={gapBytesLoadingByKey}
            analysisDebug={analysisDebug}
            showDebugInfo={showDebugInfo}
            apiRef={stackApiRef}
          />
        </section>

        <aside className="nv-right">
          <div className="nv-panel-title">Artifacts</div>
          <ArtifactPanel
            rom={rom}
            mapper={mapper}
            stats={stats}
            artifacts={artifacts}
            unresolvedSites={unresolvedSites}
            pointsOfInterest={pointsOfInterest}
            bookmarks={bookmarks}
            labelsByRomOff={labelsByRomOff}
            onNavigateToRomSpan={navigateToRomSpanWithHistory}
            onNavigateToRomOff={navigateToRomOffWithHistory}
            onContextMenuBookmark={(b, x, y) => {
              if (!b) return;
              openLineContextMenu(b, x, y);
            }}
          />
        </aside>
      </div>

      <footer className="nv-footer">
        {vectors ? (
          <div className="nv-footer-row">
            {renderVectorFooterItem('nmi', 'NMI', vectors.nmi)}
            {renderVectorFooterItem('reset', 'RESET', vectors.reset)}
            {renderVectorFooterItem('irq', 'IRQ/BRK', vectors.irqBrk)}
          </div>
        ) : (
          <div className="nv-footer-row nv-footer-muted">Vectors will appear here after loading a ROM.</div>
        )}
      </footer>

      {contextMenu ? (
        <div
          className="nv-contextmenu-backdrop"
          onMouseDown={() => {
            setContextMenu(null);
          }}
        >
          <div
            ref={contextMenuRef}
            className="nv-contextmenu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
          >
            {contextMenu.kind === 'line' ? (
              <button
                type="button"
                className="nv-contextmenu-item"
                onClick={() => {
                  void toggleBookmarkAtRomOff(contextMenu.romOff);
                  setContextMenu(null);
                }}
              >
                {isBookmarkedRomOff(contextMenu.romOff) ? 'Remove bookmark' : 'Add bookmark'}
              </button>
            ) : null}

            {contextMenu.kind === 'gap' ? (
              <button
                type="button"
                className="nv-contextmenu-item"
                onClick={() => {
                  toggleGapBytes(contextMenu);
                  setContextMenu(null);
                }}
              >
                {shownGapBytesByKey[contextMenu.gapKey] ? 'Hide bytes' : 'Show bytes'}
              </button>
            ) : null}

            {(() => {
              const lt = getContextMenuLabelTarget(contextMenu);
              if (!lt) return null;
              return (
                <button
                  type="button"
                  className="nv-contextmenu-item"
                  onClick={() => {
                    if (lt.kind === 'addr') openLabelModalForAddr(lt.key);
                    else openLabelModalForRomOff(lt.romOff);
                    setContextMenu(null);
                  }}
                >
                  {lt.existing ? 'Edit label' : 'Add label'}
                </button>
              );
            })()}

            {typeof contextMenu.selectedText === 'string' && contextMenu.selectedText ? (
              <button
                type="button"
                className="nv-contextmenu-item"
                onClick={() => {
                  void handleContextMenuCopy(contextMenu.selectedText);
                }}
              >
                Copy
              </button>
            ) : null}

            {(() => {
              const copyCodeText = getContextMenuCopyCodeText(contextMenu);
              if (!copyCodeText) return null;
              return (
                <button
                  type="button"
                  className="nv-contextmenu-item"
                  onClick={() => {
                    void handleContextMenuCopy(copyCodeText);
                  }}
                >
                  Copy code
                </button>
              );
            })()}

            {showDebugInfo && contextMenu?.blockId ? (
              <div className="nv-contextmenu-submenu">
                <button
                  type="button"
                  className="nv-contextmenu-item nv-contextmenu-submenu-trigger"
                >
                  Debug <span aria-hidden="true">▸</span>
                </button>
                <div className="nv-contextmenu-submenu-panel">
                  <button
                    type="button"
                    className="nv-contextmenu-item"
                    onClick={() => {
                      void showVsaForContextMenu(contextMenu);
                    }}
                  >
                    Show VSA
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {labelModal ? (
        <div
          className="nv-modal-backdrop"
          onMouseDown={() => {
            setLabelModal(null);
          }}
        >
          <div
            className="nv-modal nv-modal-small"
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
          >
            <div className="nv-modal-header">
              <div className="nv-modal-title">Label</div>
            </div>
            <div className="nv-label-modal-body">
              <input
                className="nv-textinput"
                value={labelText}
                onChange={(e) => setLabelText(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    (async () => {
                      await saveLabelModal();
                      setLabelModal(null);
                    })();
                  }
                }}
              />
              <div className="nv-label-modal-actions">
                <button
                  type="button"
                  className="nv-btn"
                  onClick={async () => {
                    await saveLabelModal();
                    setLabelModal(null);
                  }}
                >
                  OK
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {vsaDebugModal ? (
        <div
          className="nv-modal-backdrop"
          onMouseDown={() => {
            setVsaDebugModal(null);
          }}
        >
          <div
            className="nv-modal nv-vsa-debug-modal"
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
          >
            <div className="nv-modal-header">
              <div>
                <div className="nv-modal-title">VSA debug</div>
                {vsaDebugModal.debug ? (
                  <div className="nv-modal-subtitle">
                    Block {vsaDebugModal.debug.displayBlockId || '—'} · {vsaDebugModal.debug.observationCount || 0} observations
                  </div>
                ) : null}
              </div>
              <div className="nv-modal-header-actions">
                <button
                  type="button"
                  className="nv-btn"
                  onClick={() => setVsaDebugModal(null)}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="nv-vsa-debug-body">
              {vsaDebugModal.loading ? <div className="nv-muted">Loading VSA debug…</div> : null}
              {vsaDebugModal.error ? <div className="nv-vsa-debug-error">{vsaDebugModal.error}</div> : null}
              {!vsaDebugModal.loading && !vsaDebugModal.error && vsaDebugModal.debug ? (
                <div className="nv-vsa-debug-lines">
                  {(vsaDebugModal.debug.lines || []).map((line) => (
                    <div key={`${line.romOff}:${line.cpuAddr}`} className="nv-vsa-debug-line">
                      <div className="nv-vsa-debug-code">
                        <span className="nv-vsa-debug-rom">{fmtRom(line.romOff)}</span>
                        <span className="nv-vsa-debug-cpu">${fmtCpu(line.cpuAddr)}</span>
                        <span className="nv-vsa-debug-asm">{line.asm || ''}</span>
                      </div>
                      {line.entries?.length ? (
                        <div className="nv-vsa-debug-entries">
                          {line.entries.map((entry, idx) => (
                            <div key={entry.id || `${line.romOff}:${idx}`} className="nv-vsa-debug-entry">
                              <div className="nv-vsa-debug-entry-text">VSA: {entry.text}</div>
                              {entry.details?.length ? (
                                <div className="nv-vsa-debug-entry-details">{entry.details.join(' · ')}</div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}
