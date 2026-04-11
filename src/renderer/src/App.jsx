import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BlockStack } from './components/BlockStack.jsx';
import { ArtifactPanel } from './components/ArtifactPanel.jsx';
import { buildViewATimelineFromBlocks } from './util/timeline.js';
import { UNKNOWN_FETCH_CTX_KEY } from '../../shared/analyze/fetchContext.js';

function useBlocksById(blocks) {
  return useMemo(() => new Map((blocks || []).map((b) => [b.id, b])), [blocks]);
}

function fmtCpu(addr) {
  if (typeof addr !== 'number') return '????';
  return addr.toString(16).toUpperCase().padStart(4, '0');
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

function formatHexDump(bytes) {
  if (!Array.isArray(bytes) || bytes.length === 0) return '';
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push(bytes.slice(i, i + 16).map((b) => Number(b).toString(16).toUpperCase().padStart(2, '0')).join(' '));
  }
  return lines.join('\n');
}

function normalizeSite(site) {
  if (!site || typeof site !== 'object') return null;
  let siteKey = typeof site.siteKey === 'string' && site.siteKey ? site.siteKey : null;
  const ctxKey = (typeof site.ctxKey === 'string' && site.ctxKey) ? site.ctxKey : UNKNOWN_FETCH_CTX_KEY;
  const cpuAddr = typeof site.cpuAddr === 'number' ? (site.cpuAddr & 0xffff) : (site.cpuAddr != null ? (Number(site.cpuAddr) & 0xffff) : null);
  const romOff = typeof site.romOff === 'number' ? (site.romOff | 0) : (site.romOff != null && Number.isFinite(Number(site.romOff)) ? (Number(site.romOff) | 0) : null);
  if (!siteKey && typeof cpuAddr === 'number') siteKey = `${ctxKey}:${fmtCpu(cpuAddr)}`;
  if (!siteKey && cpuAddr == null) return null;
  return { siteKey, ctxKey, cpuAddr, romOff };
}

export default function App() {
  const [rom, setRom] = useState(null);
  const [romHash, setRomHash] = useState(null);
  const [vectors, setVectors] = useState(null);
  const [cdl, setCdl] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [blockAliases, setBlockAliases] = useState({});
  const [mapper, setMapper] = useState(null);
  const [stats, setStats] = useState(null);
  const [artifacts, setArtifacts] = useState([]);
  const [unresolvedSites, setUnresolvedSites] = useState([]);
  const [pointsOfInterest, setPointsOfInterest] = useState([]);
  // Highlighted POI span (in-memory only). Set when clicking a POI so its lines stay tinted when you scroll away/back.
  const [markedPoiSpan, setMarkedPoiSpan] = useState(null);
  // Per-ROM user annotations.
  const [bookmarks, setBookmarks] = useState([]);
  const [labelsBySite, setLabelsBySite] = useState({});
  const [labelsByAddr, setLabelsByAddr] = useState({});
  const [focusLocation, setFocusLocation] = useState(null);
  const [status, setStatus] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [vsaProgress, setVsaProgress] = useState({ runId: null, totalBlocks: null, maxRatio: 0 });

  // Hovered code row (in-memory only). We keep this in a ref to avoid rerendering on hover.
  const hoveredLineRef = useRef(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [shownGapBytesByKey, setShownGapBytesByKey] = useState({});
  const [gapBytesByKey, setGapBytesByKey] = useState({});
  const [gapBytesLoadingByKey, setGapBytesLoadingByKey] = useState({});
  const [showDebugInfo, setShowDebugInfo] = useState(false);
  const [analysisDebug, setAnalysisDebug] = useState(null);

  // Label editing modal (in-memory only).
  const [labelModal, setLabelModal] = useState(null);
  const [labelText, setLabelText] = useState('');

  // Navigation history (in-memory only): updated only when clicking links (code/POIs/etc).
  const navStackRef = useRef([]);
  const stackApiRef = useRef({});
  const suppressHistoryPushRef = useRef(false);

  const blocksById = useBlocksById(blocks);


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


  const resolveBlockIdForCpuAddr = useMemo(() => {
    // Prefer exact line/start matches when available; fall back to CPU ranges for coalesced/span-style navigation.
    const exactByCtx = new Map();
    const byCtx = new Map();
    for (const b of blocks || []) {
      const ctxId = (b?.instances?.[0]?.ctxId) || b?.ctxKey || UNKNOWN_FETCH_CTX_KEY;
      if (!exactByCtx.has(ctxId)) exactByCtx.set(ctxId, new Map());
      const exact = exactByCtx.get(ctxId);

      const cpuStart = typeof b?.cpuStart === 'number' ? (b.cpuStart & 0xffff) : null;
      if (cpuStart !== null && !exact.has(cpuStart)) exact.set(cpuStart, b.id);

      const lines = Array.isArray(b?.lines) ? b.lines : [];
      for (const line of lines) {
        const lineCpu = typeof line?.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null;
        if (lineCpu === null) continue;
        if (!exact.has(lineCpu)) exact.set(lineCpu, b.id);
      }

      const cpuEnd = typeof b?.cpuEnd === 'number' ? (b.cpuEnd & 0xffff) : null;
      if (cpuStart === null || cpuEnd === null) continue;
      if (!byCtx.has(ctxId)) byCtx.set(ctxId, []);
      byCtx.get(ctxId).push({ cpuStart, cpuEnd, blockId: b.id });
    }

    for (const arr of byCtx.values()) {
      arr.sort((a, b) => a.cpuStart - b.cpuStart);
    }

    function findInCtx(arr, cpuAddr) {
      let lo = 0;
      let hi = arr.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const s = arr[mid].cpuStart;
        if (s <= cpuAddr) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best < 0) return null;
      const hit = arr[best];
      if (cpuAddr >= hit.cpuStart && cpuAddr < hit.cpuEnd) return hit.blockId;
      return null;
    }

    return (cpuAddr, ctxId = UNKNOWN_FETCH_CTX_KEY) => {
      if (typeof cpuAddr !== 'number') return null;
      const addr = cpuAddr & 0xffff;
      const exact = exactByCtx.get(ctxId);
      if (exact && exact.has(addr)) return exact.get(addr);
      const arr = byCtx.get(ctxId) || [];
      return findInCtx(arr, addr);
    };
  }, [blocks]);

  const canNavigateCpuAddr = useMemo(() => {
    return (cpuAddr, ctxId = UNKNOWN_FETCH_CTX_KEY) => !!resolveBlockIdForCpuAddr(cpuAddr, ctxId);
  }, [resolveBlockIdForCpuAddr]);

  const resolveBlockIdForRomOff = useMemo(() => {
    const ranges = (blocks || [])
      .map((b) => {
        const romStart = typeof b?.romStart === 'number' ? b.romStart : null;
        const romEnd = typeof b?.romEnd === 'number' ? b.romEnd : null;
        if (romStart === null || romEnd === null) return null;
        return { romStart: romStart | 0, romEnd: romEnd | 0, blockId: b.id };
      })
      .filter(Boolean)
      .sort((a, b) => a.romStart - b.romStart);

    function find(romOff) {
      let lo = 0;
      let hi = ranges.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const s = ranges[mid].romStart;
        if (s <= romOff) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best < 0) return null;
      const hit = ranges[best];
      if (romOff >= hit.romStart && romOff < hit.romEnd) return hit.blockId;
      return null;
    }

    return (romOff) => {
      if (typeof romOff !== 'number') return null;
      return find(romOff | 0);
    };
  }, [blocks]);

  const bookmarkSiteKeySet = useMemo(() => {
    const s = new Set();
    for (const b of bookmarks || []) {
      const key = typeof b?.siteKey === 'string' ? b.siteKey : null;
      if (key) s.add(key);
    }
    return s;
  }, [bookmarks]);

  function isBookmarked(siteKey) {
    if (typeof siteKey !== 'string' || !siteKey) return false;
    return bookmarkSiteKeySet.has(siteKey);
  }

  function getLabelForSite(siteKey) {
    if (typeof siteKey !== 'string' || !siteKey) return '';
    const v = labelsBySite?.[siteKey]?.label;
    return typeof v === 'string' ? v : '';
  }

  function getLabelForAddr(cpuAddr) {
    if (typeof cpuAddr !== 'number') return '';
    const v = labelsByAddr?.[String(cpuAddr & 0xffff)];
    return typeof v === 'string' ? v : '';
  }

  const setBookmarkAt = useCallback(async (site, set) => {
    if (!romHash) return;
    if (!window?.nesviz?.setBookmark) return;
    const n = normalizeSite(site);
    if (!n) return;
    const res = await window.nesviz.setBookmark(n, !!set);
    if (res?.ok) {
      setBookmarks(Array.isArray(res.bookmarks) ? res.bookmarks : []);
    }
  }, [romHash]);

  const toggleBookmarkAt = useCallback(async (site) => {
    const n = normalizeSite(site);
    if (!n?.siteKey) return;
    const exists = bookmarkSiteKeySet.has(n.siteKey);
    await setBookmarkAt(n, !exists);
  }, [bookmarkSiteKeySet, setBookmarkAt]);

  const setLabelAt = useCallback(async (site, label) => {
    if (!romHash) return;
    if (!window?.nesviz?.setLabel) return;
    const n = normalizeSite(site);
    if (!n) return;
    const res = await window.nesviz.setLabel(n, label);
    if (res?.ok) {
      setLabelsBySite(res.labels && typeof res.labels === 'object' ? res.labels : {});
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

  function navigateToCpuAddr(cpuAddr, ctxId = UNKNOWN_FETCH_CTX_KEY) {
    if (typeof cpuAddr !== 'number') return;
    const blockId = resolveBlockIdForCpuAddr(cpuAddr, ctxId);
    if (!blockId) {
      setStatus(`No discovered block at $${fmtCpu(cpuAddr)}.`);
      return;
    }
    setFocusLocation({ blockId, anchorRomOff: null });
  }

  function navigateToBlockId(blockId, anchorRomOff = null) {
    const resolved = (blockAliases && blockAliases[blockId]) ? blockAliases[blockId] : blockId;
    if (!resolved) return;
    setFocusLocation({ blockId: resolved, anchorRomOff: (typeof anchorRomOff === 'number' ? anchorRomOff : null) });
  }

  function updateHoveredLine(lineInfo) {
    if (!lineInfo) return;
    const siteKey = typeof lineInfo.siteKey === 'string' ? lineInfo.siteKey : null;
    const ctxKey = (typeof lineInfo.ctxKey === 'string' && lineInfo.ctxKey) ? lineInfo.ctxKey : UNKNOWN_FETCH_CTX_KEY;
    const romOff = typeof lineInfo.romOff === 'number' ? lineInfo.romOff : Number(lineInfo.romOff);
    const cpuAddr = typeof lineInfo.cpuAddr === 'number' ? lineInfo.cpuAddr : (lineInfo.cpuAddr != null ? Number(lineInfo.cpuAddr) : null);
    const labelTarget = (lineInfo.labelTarget === 'operand') ? 'operand' : 'line';
    const operandAddrRaw = (typeof lineInfo.operandAddr === 'number')
      ? lineInfo.operandAddr
      : (lineInfo.operandAddr != null ? Number(lineInfo.operandAddr) : null);
    const operandAddr = Number.isFinite(operandAddrRaw) ? (operandAddrRaw & 0xffff) : null;
    if (!siteKey && (!Number.isFinite(cpuAddr) || cpuAddr < 0)) return;
    hoveredLineRef.current = {
      siteKey,
      ctxKey,
      romOff: Number.isFinite(romOff) && romOff >= 0 ? (romOff | 0) : null,
      cpuAddr: Number.isFinite(cpuAddr) ? (cpuAddr & 0xffff) : null,
      labelTarget,
      operandAddr
    };
  }

  function openLabelModalForSite(site) {
    const n = normalizeSite(site);
    if (!n) return;
    const existing = getLabelForSite(n.siteKey);
    setLabelText(existing || '');
    setLabelModal({ kind: 'site', site: n });
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

    // Clamp to viewport a bit so it doesn't render off-screen.
    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    const menuW = 210;
    const menuH = 86;
    const x = Math.max(8, Math.min(clientX ?? 0, Math.max(8, w - menuW - 8)));
    const y = Math.max(8, Math.min(clientY ?? 0, Math.max(8, h - menuH - 8)));

    setContextMenu({ kind: 'line', x, y, ...line });
  }

  function openBlockContextMenu(blockInfo, clientX, clientY) {
    if (!blockInfo) return;
    const siteKey = typeof blockInfo.siteKey === 'string' ? blockInfo.siteKey : null;
    const romOff = typeof blockInfo.romOff === 'number' ? blockInfo.romOff : Number(blockInfo.romOff);
    const cpuAddr = typeof blockInfo.cpuAddr === 'number' ? blockInfo.cpuAddr : (blockInfo.cpuAddr != null ? Number(blockInfo.cpuAddr) : null);
    if (!siteKey && (!Number.isFinite(cpuAddr) || cpuAddr < 0)) return;

    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    const menuW = 210;
    const menuH = 48;
    const x = Math.max(8, Math.min(clientX ?? 0, Math.max(8, w - menuW - 8)));
    const y = Math.max(8, Math.min(clientY ?? 0, Math.max(8, h - menuH - 8)));
    setContextMenu({ kind: 'block', x, y, siteKey: blockInfo.siteKey || null, ctxKey: blockInfo.ctxKey || UNKNOWN_FETCH_CTX_KEY, romOff: Number.isFinite(romOff) ? (romOff | 0) : null, cpuAddr: Number.isFinite(cpuAddr) ? (cpuAddr & 0xffff) : null, blockId: blockInfo.blockId || null });
  }

  function openGapContextMenu(gapInfo, clientX, clientY) {
    if (!gapInfo || gapInfo.type !== 'unknown') return;
    const gapKey = gapKeyFor(gapInfo);
    if (!gapKey) return;

    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    const menuW = 210;
    const menuH = 48;
    const x = Math.max(8, Math.min(clientX ?? 0, Math.max(8, w - menuW - 8)));
    const y = Math.max(8, Math.min(clientY ?? 0, Math.max(8, h - menuH - 8)));
    setContextMenu({ kind: 'gap', x, y, gapKey, type: gapInfo.type, romStart: gapInfo.romStart | 0, romEnd: gapInfo.romEnd | 0 });
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

  function navigateToSiteWithHistory(site) {
    const n = normalizeSite(site);
    if (!n || typeof n.cpuAddr !== 'number') {
      setStatus('Run static analysis first to navigate to bookmarks.');
      return;
    }
    const blockId = resolveBlockIdForCpuAddr(n.cpuAddr, n.ctxKey);
    if (!blockId) {
      setStatus('Run static analysis first to navigate to bookmarks.');
      return;
    }
    navigateToBlockIdWithHistory(blockId, n.romOff);
  }

  function getTopVisibleBlockId() {
    const fn = stackApiRef?.current?.getTopVisibleBlockId;
    const id = typeof fn === 'function' ? fn() : null;
    if (id) return (blockAliases && blockAliases[id]) ? blockAliases[id] : id;
    return null;
  }

  function pushCurrentLocationForLinkClick() {
    const fromId = getTopVisibleBlockId();
    if (!fromId) return;
    const stack = navStackRef.current;
    // Avoid consecutive duplicates.
    if (stack.length && stack[stack.length - 1] === fromId) return;
    stack.push(fromId);
  }

  function navigateToCpuAddrWithHistory(cpuAddr, ctxId = UNKNOWN_FETCH_CTX_KEY) {
    if (!suppressHistoryPushRef.current) pushCurrentLocationForLinkClick();
    navigateToCpuAddr(cpuAddr, ctxId);
  }

  function navigateToBlockIdWithHistory(blockId, anchorRomOff = null, maybePoi = null) {
    if (!suppressHistoryPushRef.current) pushCurrentLocationForLinkClick();
    const span = maybePoi?.basis?.romOffSpan;
    if (span && typeof span.start === 'number' && typeof span.end === 'number') {
      setMarkedPoiSpan({ start: span.start >>> 0, end: span.end >>> 0 });
    }
    navigateToBlockId(blockId, anchorRomOff);
  }

  // Navigation requests coming from the Labels secondary window.
  useEffect(() => {
    if (!window?.nesviz?.onLabelsNavigate) return;
    const unsub = window.nesviz.onLabelsNavigate((msg) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.kind === 'site') {
        navigateToSiteWithHistory(msg);
        return;
      }

      if (msg.kind === 'addr') {
        const aRaw = (typeof msg.cpuAddr === 'number') ? msg.cpuAddr : Number(msg.cpuAddr);
        if (!Number.isFinite(aRaw) || aRaw < 0) return;
        const ctxId = (typeof msg.ctxId === 'string' && msg.ctxId) ? msg.ctxId : UNKNOWN_FETCH_CTX_KEY;
        const a = (aRaw & 0xffff);
        if (!canNavigateCpuAddr(a, ctxId)) return;
        navigateToCpuAddrWithHistory(a, ctxId);
      }
    });
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [canNavigateCpuAddr, navigateToBlockIdWithHistory, navigateToCpuAddrWithHistory]);


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
        if (!line || typeof line.siteKey !== 'string') return;
        e.preventDefault();
        e.stopPropagation();
        toggleBookmarkAt(line);
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
  }, [blockAliases, contextMenu, labelModal, toggleBookmarkAt]);

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

  async function loadActiveAnalysisIntoUi(statusPrefix) {
    const tlRes = await window.nesviz.getTimeline();
    const artRes = await window.nesviz.getArtifacts();

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
      setBlockAliases(tlRes.blockAliases || {});
      setMapper(tlRes.mapper);
      setStats(tlRes.stats);
      setAnalysisDebug(tlRes.debug || null);
    }

    if (artRes.ok) {
      console.log('NesViz getArtifacts', artRes);
      setArtifacts(artRes.artifacts || []);
      setUnresolvedSites(artRes.unresolvedSites || []);
      setPointsOfInterest(artRes.pointsOfInterest || []);
      setMapper(artRes.mapper);
      setStats(artRes.stats);
    }
  }

  async function openRom() {
    setStatus('Opening ROM…');
    try {
      const res = await window.nesviz.openRom();
      if (!res.ok) {
        setStatus(res.canceled ? '' : (res.error || 'Open canceled'));
        return;
      }

      setRom(res.rom);
      setRomHash(res.romHash || null);
      setVectors(res.vectors);
      setBookmarks(Array.isArray(res.bookmarks) ? res.bookmarks : []);
      setLabelsBySite((res.labels && typeof res.labels === 'object') ? res.labels : {});
      setLabelsByAddr((res.addrLabels && typeof res.addrLabels === 'object') ? res.addrLabels : {});
      setContextMenu(null);
      setLabelModal(null);
      hoveredLineRef.current = null;
      setShownGapBytesByKey({});
      setGapBytesByKey({});
      setGapBytesLoadingByKey({});
    setAnalysisDebug(null);

      // New ROM => clear navigation history note: in-memory only.
      navStackRef.current = [];
      suppressHistoryPushRef.current = false;

      setCdl(null);
      setTimeline([]);
      setBlocks([]);
      setBlockAliases({});
      setMapper(null);
      setStats(null);
      setArtifacts([]);
      setUnresolvedSites([]);
      setPointsOfInterest([]);
      setMarkedPoiSpan(null);
      setFocusLocation(null);
      if (res.hasCachedAnalysis) {
        await loadActiveAnalysisIntoUi('Loaded cached analysis.');
      } else {
        setStatus('ROM loaded.');
      }
    } catch (e) {
      setStatus(`Open failed: ${e?.message ?? String(e)}`);
    }
  }

  async function openRomPath(filepath) {
    setStatus('Opening ROM…');
    try {
      const res = await window.nesviz.openRomPath(filepath);
      if (!res.ok) {
        setStatus(res.canceled ? '' : (res.error || 'Open failed'));
        return;
      }

      setRom(res.rom);
      setRomHash(res.romHash || null);
      setVectors(res.vectors);
      setBookmarks(Array.isArray(res.bookmarks) ? res.bookmarks : []);
      setLabelsBySite((res.labels && typeof res.labels === 'object') ? res.labels : {});
      setLabelsByAddr((res.addrLabels && typeof res.addrLabels === 'object') ? res.addrLabels : {});
      setContextMenu(null);
      setLabelModal(null);
      hoveredLineRef.current = null;
      setShownGapBytesByKey({});
      setGapBytesByKey({});
      setGapBytesLoadingByKey({});
    setAnalysisDebug(null);

      // New ROM => clear navigation history.
      navStackRef.current = [];
      suppressHistoryPushRef.current = false;

      setCdl(null);
      setTimeline([]);
      setBlocks([]);
      setBlockAliases({});
      setMapper(null);
      setStats(null);
      setArtifacts([]);
      setUnresolvedSites([]);
      setPointsOfInterest([]);
      setFocusLocation(null);
      setMarkedPoiSpan(null);
      if (res.hasCachedAnalysis) {
        await loadActiveAnalysisIntoUi('Loaded cached analysis.');
      } else {
        setStatus('ROM loaded.');
      }
    } catch (e) {
      setStatus(`Open failed: ${e?.message ?? String(e)}`);
    }
  }

  function getContextMenuLabelTarget(cm) {
    if (!cm) return null;
    // If the click was over the ASM column, we treat "label" as labeling the operand address.
    if (cm.kind === 'line' && cm.labelTarget === 'operand') {
      if (typeof cm.operandAddr !== 'number') return null;
      const a = cm.operandAddr & 0xffff;
      return { kind: 'addr', key: a, existing: getLabelForAddr(a) };
    }
    if (typeof cm.siteKey === 'string' && cm.siteKey) {
      return { kind: 'site', site: normalizeSite(cm), existing: getLabelForSite(cm.siteKey) };
    }
    return null;
  }

  async function saveLabelModal() {
    if (!labelModal) return;

    if (labelModal.kind === 'addr') {
      await setAddrLabelAt(labelModal.cpuAddr, labelText);
      return;
    }

    const site = normalizeSite(labelModal.site);
    const cpuAddr = (typeof site?.cpuAddr === 'number') ? (site.cpuAddr & 0xffff) : null;

    const prevLineLabel = site?.siteKey ? getLabelForSite(site.siteKey) : '';
    const prevAddrLabel = (cpuAddr != null) ? getLabelForAddr(cpuAddr) : '';

    await setLabelAt(site, labelText);

    // If this ROM-offset label is (also) acting as the address label for the line's CPU address,
    // keep them in sync. But don't overwrite an explicitly-set address label.
    if (cpuAddr != null && (!prevAddrLabel || prevAddrLabel === prevLineLabel)) {
      await setAddrLabelAt(cpuAddr, labelText);
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
          <button className="nv-btn" onClick={runStatic} disabled={!romHash}>Analyze (static)</button>
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
            markedPoiSpan={markedPoiSpan}
            onFocused={() => setFocusLocation(null)}
            onNavigateToCpuAddr={navigateToCpuAddrWithHistory}
            canNavigateCpuAddr={canNavigateCpuAddr}
            resolveBlockIdForCpuAddr={resolveBlockIdForCpuAddr}
            labelsBySite={labelsBySite}
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
            labelsBySite={labelsBySite}
            onNavigateToBlock={navigateToBlockIdWithHistory}
            onNavigateToSite={navigateToSiteWithHistory}
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
            <button
              type="button"
              className="nv-footer-link"
              onClick={() => navigateToCpuAddrWithHistory(vectors.nmi)}
              title="Jump to NMI vector target"
            >
              NMI: ${fmtCpu(vectors.nmi)}
            </button>
            <button
              type="button"
              className="nv-footer-link"
              onClick={() => navigateToCpuAddrWithHistory(vectors.reset)}
              title="Jump to RESET vector target"
            >
              RESET: ${fmtCpu(vectors.reset)}
            </button>
            <button
              type="button"
              className="nv-footer-link"
              onClick={() => navigateToCpuAddrWithHistory(vectors.irqBrk)}
              title="Jump to IRQ/BRK vector target"
            >
              IRQ/BRK: ${fmtCpu(vectors.irqBrk)}
            </button>
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
                  toggleBookmarkAt(contextMenu);
                  setContextMenu(null);
                }}
              >
                {isBookmarked(contextMenu.siteKey) ? 'Remove bookmark' : 'Add bookmark'}
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
                    else openLabelModalForSite(lt.site);
                    setContextMenu(null);
                  }}
                >
                  {lt.existing ? 'Edit label' : 'Add label'}
                </button>
              );
            })()}
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

    </div>
  );
}
