import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FolderButton from './components/FolderButton.jsx';
import RefreshButton from './components/RefreshButton.jsx';
import { formatFolderPathsSubtitle, normalizeFolderPathsValue } from './utils/folderPathDisplayUtils.js';

const DEFAULT_FILTER_STATE = Object.freeze({
  nameQuery: ''
});

const DEFAULT_SORT = Object.freeze({
  key: null,
  dir: 'asc'
});

export default function RomListWindow() {
  const [folderPaths, setFolderPaths] = useState([]);
  const [items, setItems] = useState([]);
  const [scanMeta, setScanMeta] = useState(null);
  const [status, setStatus] = useState('');
  const [filterState, setFilterState] = useState(() => ({ ...DEFAULT_FILTER_STATE }));

  // Sort state: one column at a time; null key means scan order.
  const [sort, setSort] = useState(() => ({ ...DEFAULT_SORT }));
  const activeScanTokenRef = useRef(null);
  const romListUiStateReadyRef = useRef(false);

  const sortedItems = useMemo(() => {
    const key = sort?.key;
    if (!key) return items;

    const dir = sort?.dir === 'desc' ? -1 : 1;
    const out = Array.isArray(items) ? items.slice() : [];

    function s(x) {
      return (x ?? '').toString();
    }

    function sl(x) {
      return s(x).toLowerCase();
    }

    function n(x) {
      const v = Number(x);
      return Number.isFinite(v) ? v : 0;
    }

    function cmp(a, b) {
      if (key === 'filename') return sl(a.filename).localeCompare(sl(b.filename));
      if (key === 'mapperName') return sl(a.mapperName).localeCompare(sl(b.mapperName));
      if (key === 'prgBytes') return n(a.prgBytes) - n(b.prgBytes);
      if (key === 'chrBytes') return n(a.chrBytes) - n(b.chrBytes);
      return 0;
    }

    out.sort((a, b) => {
      const primary = cmp(a, b);
      if (primary) return primary * dir;
      return sl(a.filename).localeCompare(sl(b.filename)) * dir;
    });
    return out;
  }, [items, sort]);

  const activeFilters = useMemo(() => {
    const filters = [];
    const rawNameQuery = filterState?.nameQuery ?? '';
    const nameQuery = rawNameQuery.trim();

    if (nameQuery) {
      const needle = nameQuery.toLowerCase();
      filters.push({
        key: 'nameQuery',
        type: 'text',
        value: nameQuery,
        matches(item) {
          return (item?.filename ?? '').toString().toLowerCase().includes(needle);
        }
      });
    }

    return filters;
  }, [filterState]);

  const visibleItems = useMemo(() => {
    if (!activeFilters.length) return sortedItems;
    return sortedItems.filter((item) => activeFilters.every((filter) => filter.matches(item)));
  }, [activeFilters, sortedItems]);

  const toggleSort = useCallback((key) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' };
      return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
    });
  }, []);

  const applyCache = useCallback((cache) => {
    const nextFolderPaths = normalizeFolderPathsValue(cache?.folderPaths);
    if (!cache || !cache.ok || !cache.hasCache || !nextFolderPaths.length) return false;

    const nextItems = Array.isArray(cache.items) ? cache.items : [];
    const meta = cache.meta || {};
    const totalCount = Number.isFinite(meta.totalCount) ? meta.totalCount : nextItems.length;
    const scannedCount = Number.isFinite(meta.scannedCount) ? meta.scannedCount : totalCount;
    const foundCount = Number.isFinite(meta.foundCount) ? meta.foundCount : nextItems.length;
    const errorCount = Number.isFinite(meta.errorCount) ? meta.errorCount : 0;

    setFolderPaths(nextFolderPaths);
    setItems(nextItems);
    setScanMeta({
      folderPaths: nextFolderPaths,
      totalCount,
      scannedCount,
      foundCount,
      errorCount,
      done: true,
      cached: true
    });
    if (activeScanTokenRef.current) {
      window.nesviz.cancelRomFolderScan(activeScanTokenRef.current);
      activeScanTokenRef.current = null;
    }
    return true;
  }, []);

  // Load cached list on first mount.
  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        const cache = await window.nesviz.getRomFolderCache();
        if (canceled) return;
        if (!applyCache(cache)) {
          setFolderPaths([]);
          setItems([]);
          setScanMeta(null);
        }
      } catch {
        // Ignore cache load failures.
      }
    })();
    return () => {
      canceled = true;
    };
  }, [applyCache]);

  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        const savedUiState = await window.nesviz.getRomListUiState();
        if (canceled) return;

        if (savedUiState?.filterState && typeof savedUiState.filterState === 'object') {
          setFilterState({
            ...DEFAULT_FILTER_STATE,
            ...savedUiState.filterState
          });
        }

        if (savedUiState?.sort && typeof savedUiState.sort === 'object') {
          setSort({
            ...DEFAULT_SORT,
            ...savedUiState.sort,
            dir: savedUiState.sort?.dir === 'desc' ? 'desc' : 'asc'
          });
        }
      } catch {
        // Ignore transient UI state load failures.
      } finally {
        if (!canceled) romListUiStateReadyRef.current = true;
      }
    })();

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!romListUiStateReadyRef.current) return;
    void window.nesviz.setRomListUiState({
      filterState,
      sort
    });
  }, [filterState, sort]);


  const startScan = useCallback(async (nextFolderPathsInput, opts = null) => {
    const nextFolderPaths = normalizeFolderPathsValue(nextFolderPathsInput);
    if (!nextFolderPaths.length) return;

    if (activeScanTokenRef.current) {
      window.nesviz.cancelRomFolderScan(activeScanTokenRef.current);
      activeScanTokenRef.current = null;
    }

    setFolderPaths(nextFolderPaths);
    setItems([]);
    setScanMeta({ folderPaths: nextFolderPaths, totalCount: null, scannedCount: 0, foundCount: 0, errorCount: 0, done: false });

    try {
      let token = null;
      const scan = window.nesviz.startRomFolderScan(nextFolderPaths, opts || null, (msg) => {
        if (!msg || token !== activeScanTokenRef.current) return;

        if (msg.type === 'start') {
          const msgFolderPaths = normalizeFolderPathsValue(msg.folderPaths);
          if (msgFolderPaths.length) setFolderPaths(msgFolderPaths);
          setScanMeta({
            ...msg,
            folderPaths: msgFolderPaths.length ? msgFolderPaths : nextFolderPaths,
            scannedCount: 0,
            foundCount: 0,
            errorCount: 0,
            done: false
          });
          return;
        }

        if (msg.type === 'batch') {
          const chunk = Array.isArray(msg.items) ? msg.items : [];
          if (chunk.length) setItems((prev) => prev.concat(chunk));
          setScanMeta((prev) => ({
            ...(prev || {}),
            scannedCount: msg.scannedCount,
            totalCount: msg.totalCount,
            foundCount: msg.foundCount,
            errorCount: msg.errorCount
          }));
          return;
        }

        if (msg.type === 'done') {
          setScanMeta((prev) => ({
            ...(prev || {}),
            scannedCount: msg.scannedCount,
            totalCount: msg.totalCount,
            foundCount: msg.foundCount,
            errorCount: msg.errorCount,
            cached: !!msg.cached,
            done: true
          }));
          setStatus('');
          activeScanTokenRef.current = null;
          return;
        }

        if (msg.type === 'error') {
          const message = msg.message || 'Scan error';
          setScanMeta((prev) => ({ ...(prev || {}), error: message, done: true }));
          setStatus(message);
          activeScanTokenRef.current = null;
        }
      });

      if (!scan?.ok) {
        const err = scan?.error || 'Scan failed';
        setStatus(err);
        setScanMeta((prev) => ({ ...(prev || {}), error: err, done: true }));
        activeScanTokenRef.current = null;
        return;
      }

      token = scan.token;
      activeScanTokenRef.current = token;
      setStatus('Scanning folders…');
    } catch (e) {
      setStatus(`Scan failed: ${e?.message ?? String(e)}`);
      setScanMeta((prev) => ({ ...(prev || {}), error: 'Scan failed', done: true }));
      activeScanTokenRef.current = null;
    }
  }, []);

  const selectFolderAndScan = useCallback(async () => {
    setStatus('Selecting ROM folders…');
    try {
      const sel = await window.nesviz.selectRomFolder();
      if (!sel?.ok) {
        setStatus(sel?.canceled ? '' : (sel?.error || 'Select canceled'));
        return;
      }
      await startScan(sel.folderPaths, { force: false });
    } catch (e) {
      setStatus(`Folder select failed: ${e?.message ?? String(e)}`);
    }
  }, [startScan]);

  const refresh = useCallback(async () => {
    if (!folderPaths.length) return;
    await startScan(folderPaths, { force: true });
  }, [folderPaths, startScan]);

  useEffect(() => () => {
    if (!activeScanTokenRef.current) return;
    window.nesviz.cancelRomFolderScan(activeScanTokenRef.current);
    activeScanTokenRef.current = null;
  }, []);

  // Commands from main (e.g. "Open ROM Folder..." should prompt the folder picker).
  useEffect(() => {
    const unsub = window.nesviz.onRomListCommand((cmd) => {
      if (!cmd || typeof cmd !== 'object') return;
      if (cmd.type === 'selectFolderAndScan') {
        selectFolderAndScan();
      }
    });
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [selectFolderAndScan]);

  function openRom(filePath) {
    if (!filePath) return;
    // Tell main to open this ROM in the main window. Main will close this window.
    window.nesviz.romListOpenRom(filePath);
  }

  const done = !!scanMeta?.done;
  const scanning = scanMeta && done === false;
  const visibleCount = visibleItems.length;
  const totalCount = sortedItems.length;
  const hasActiveFilters = activeFilters.length > 0;
  const folderSubtitle = formatFolderPathsSubtitle(folderPaths);

  return (
    <div className="nv-toolwindow">
      <div className="nv-modal-header nv-romlist-header">
        <div className="nv-modal-title">ROMs in folder</div>
        <div className="nv-romlist-header-actions" aria-label="ROM list actions">
          <FolderButton
            onClick={selectFolderAndScan}
            title="Select folders"
          />
          <RefreshButton
            onClick={refresh}
            disabled={!folderPaths.length || !!scanning}
            title={scanning ? 'Refresh disabled while scan is in progress' : 'Refresh'}
          />
        </div>
        <div className="nv-romlist-header-spacer" aria-hidden="true" />
      </div>

      <div className="nv-modal-subtitle" title={folderSubtitle || ''}>
        {folderSubtitle || '(No folder selected)'}
      </div>

      <div className="nv-modal-meta">
        {scanMeta?.error ? (
          <span className="nv-badge nv-badge-bad">{scanMeta.error}</span>
        ) : scanMeta ? (
          <>
            <span className="nv-badge">{Number.isFinite(scanMeta.totalCount) ? `scanned ${scanMeta.scannedCount || 0}/${scanMeta.totalCount}` : `scanned ${scanMeta.scannedCount || 0}`}</span>
            <span className="nv-badge">found {scanMeta.foundCount || 0}</span>
            <span className="nv-badge">showing {visibleCount}/{totalCount}</span>
            {scanMeta.errorCount ? <span className="nv-badge">errors {scanMeta.errorCount}</span> : null}
            {scanMeta.done ? <span className="nv-badge nv-badge-good">done</span> : <span className="nv-badge">scanning…</span>}
          </>
        ) : (
          <span className="nv-badge">Select a folder to scan for ROMs.</span>
        )}
        {status ? <span className="nv-badge">{status}</span> : null}
      </div>

      <div className="nv-modal-filters">
        <input
          type="text"
          className="nv-textinput"
          value={filterState.nameQuery}
          onChange={(e) => {
            const nextValue = e.target.value;
            setFilterState((prev) => ({
              ...(prev || {}),
              nameQuery: nextValue
            }));
          }}
          placeholder="Filter ROM names…"
          aria-label="Filter ROMs by name"
          spellCheck={false}
        />
      </div>

      <div className="nv-modal-list" style={{ flex: 1 }}>
        <div className="nv-modal-list-head">
          <button
            type="button"
            className="nv-col nv-col-name nv-modal-colhead"
            onClick={() => toggleSort('filename')}
          >
            ROM
          </button>
          <button
            type="button"
            className="nv-col nv-col-meta nv-modal-colhead"
            onClick={() => toggleSort('mapperName')}
          >
            Mapper
          </button>
          <button
            type="button"
            className="nv-col nv-col-meta nv-modal-colhead"
            onClick={() => toggleSort('prgBytes')}
          >
            PRG
          </button>
          <button
            type="button"
            className="nv-col nv-col-meta nv-modal-colhead"
            onClick={() => toggleSort('chrBytes')}
          >
            CHR
          </button>
        </div>

        {visibleItems.length === 0 ? (
          <div className="nv-modal-empty">
            {folderPaths.length
              ? (totalCount > 0 && hasActiveFilters ? 'No ROMs match the filter.' : 'No supported ROMs found.')
              : 'No ROMs loaded yet.'}
          </div>
        ) : (
          visibleItems.map((it) => (
            <button
              key={it.filePath}
              type="button"
              className={`nv-modal-row${it.isAnalyzable === false ? ' nv-modal-row-unsupported' : ''}`}
              onClick={() => openRom(it.filePath)}
              title={it.isAnalyzable === false ? `${it.filePath}\nNot currently supported for static analysis.` : it.filePath}
            >
              <div className="nv-col nv-col-name">{it.filename}</div>
              <div className="nv-col nv-col-meta">{it.mapperName || 'NROM'}</div>
              <div className="nv-col nv-col-meta">{it.prgBytes}</div>
              <div className="nv-col nv-col-meta">{it.chrBytes}</div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
