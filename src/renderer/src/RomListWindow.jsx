import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export default function RomListWindow() {
  const [folderPath, setFolderPath] = useState('');
  const [items, setItems] = useState([]);
  const [scanMeta, setScanMeta] = useState(null);
  const [status, setStatus] = useState('');

  // Sort state: one column at a time; null key means scan order.
  const [sort, setSort] = useState({ key: null, dir: 'asc' });
  const activeScanIdRef = useRef(null);

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

  const toggleSort = useCallback((key) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' };
      return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
    });
  }, []);

  const applyCache = useCallback((cache) => {
    if (!cache || !cache.ok || !cache.hasCache || !cache.folderPath) return false;

    const nextItems = Array.isArray(cache.items) ? cache.items : [];
    const meta = cache.meta || {};
    const totalCount = Number.isFinite(meta.totalCount) ? meta.totalCount : nextItems.length;
    const scannedCount = Number.isFinite(meta.scannedCount) ? meta.scannedCount : totalCount;
    const foundCount = Number.isFinite(meta.foundCount) ? meta.foundCount : nextItems.length;
    const errorCount = Number.isFinite(meta.errorCount) ? meta.errorCount : 0;

    setFolderPath(cache.folderPath);
    setItems(nextItems);
    setScanMeta({
      folderPath: cache.folderPath,
      totalCount,
      scannedCount,
      foundCount,
      errorCount,
      done: true,
      cached: true
    });
    activeScanIdRef.current = null;
    return true;
  }, []);

  // Load cached list on first mount.
  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        const cache = await window.nesviz?.getRomFolderCache?.();
        if (canceled) return;
        if (!applyCache(cache)) {
          setFolderPath('');
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

  // Streamed scan events from the main process.
  useEffect(() => {
    if (!window?.nesviz?.onRomFolderScan) return;
    const unsub = window.nesviz.onRomFolderScan((msg) => {
      if (!msg || msg.scanId !== activeScanIdRef.current) return;
      if (msg.type === 'start') {
        setScanMeta({ ...msg, scannedCount: 0, foundCount: 0, errorCount: 0 });
        return;
      }
      if (msg.type === 'batch') {
        const chunk = Array.isArray(msg.items) ? msg.items : [];
        setItems((prev) => prev.concat(chunk));
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
          done: true
        }));
        setStatus('');
        return;
      }
      if (msg.type === 'error') {
        setScanMeta((prev) => ({ ...(prev || {}), error: msg.message || 'Scan error', done: true }));
        setStatus(msg.message || 'Scan error');
      }
    });
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  const startScan = useCallback(async (nextFolderPath, opts = null) => {
    if (!nextFolderPath) return;
    setFolderPath(nextFolderPath);
    setItems([]);
    setScanMeta({ folderPath: nextFolderPath, totalCount: 0, scannedCount: 0, foundCount: 0, errorCount: 0, done: false });

    try {
      const scan = await window.nesviz?.startRomFolderScan?.(nextFolderPath, opts || null);
      if (!scan?.ok) {
        const err = scan?.error || 'Scan failed';
        setStatus(err);
        setScanMeta((prev) => ({ ...(prev || {}), error: err, done: true }));
        activeScanIdRef.current = null;
        return;
      }
      activeScanIdRef.current = scan.scanId;
      setStatus('Scanning folder…');
    } catch (e) {
      setStatus(`Scan failed: ${e?.message ?? String(e)}`);
      setScanMeta((prev) => ({ ...(prev || {}), error: 'Scan failed', done: true }));
      activeScanIdRef.current = null;
    }
  }, []);

  const selectFolderAndScan = useCallback(async () => {
    setStatus('Selecting ROM folder…');
    try {
      const sel = await window.nesviz?.selectRomFolder?.();
      if (!sel?.ok) {
        setStatus(sel?.canceled ? '' : (sel?.error || 'Select canceled'));
        return;
      }
      await startScan(sel.folderPath, { force: false });
    } catch (e) {
      setStatus(`Folder select failed: ${e?.message ?? String(e)}`);
    }
  }, [startScan]);

  const refresh = useCallback(async () => {
    if (!folderPath) return;
    await startScan(folderPath, { force: true });
  }, [folderPath, startScan]);

  // Commands from main (e.g. "Open ROM Folder..." should prompt the folder picker).
  useEffect(() => {
    if (!window?.nesviz?.onRomListCommand) return;
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
    window.nesviz?.romListOpenRom?.(filePath);
  }

  const done = !!scanMeta?.done;
  const scanning = scanMeta && done === false;

  return (
    <div className="nv-toolwindow">
      <div className="nv-modal-header">
        <div className="nv-modal-title">ROMs in folder</div>
        <button
          type="button"
          className="nv-btn"
          onClick={selectFolderAndScan}
          title="Choose a folder to scan"
        >
          Select folder
        </button>
        <button
          type="button"
          className="nv-btn"
          onClick={refresh}
          disabled={!folderPath || !!scanning}
          title={scanning ? 'Scan in progress' : 'Rescan folder'}
        >
          Refresh
        </button>
        <button
          type="button"
          className="nv-btn"
          onClick={() => window.close()}
        >
          Close
        </button>
      </div>

      <div className="nv-modal-subtitle" title={folderPath || ''}>
        {folderPath || '(No folder selected)'}
      </div>

      <div className="nv-modal-meta">
        {scanMeta?.error ? (
          <span className="nv-badge nv-badge-bad">{scanMeta.error}</span>
        ) : scanMeta ? (
          <>
            <span className="nv-badge">scanned {scanMeta.scannedCount || 0}/{scanMeta.totalCount || 0}</span>
            <span className="nv-badge">found {scanMeta.foundCount || 0}</span>
            {scanMeta.errorCount ? <span className="nv-badge">errors {scanMeta.errorCount}</span> : null}
            {scanMeta.done ? <span className="nv-badge nv-badge-good">done</span> : <span className="nv-badge">scanning…</span>}
          </>
        ) : (
          <span className="nv-badge">Select a folder to scan for ROMs.</span>
        )}
        {status ? <span className="nv-badge">{status}</span> : null}
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

        {sortedItems.length === 0 ? (
          <div className="nv-modal-empty">{folderPath ? 'No supported ROMs found.' : 'No ROMs loaded yet.'}</div>
        ) : (
          sortedItems.map((it) => (
            <button
              key={it.filePath}
              type="button"
              className={`nv-modal-row${it.isAnalysisSupported === false ? ' nv-modal-row-unsupported' : ''}`}
              onClick={() => openRom(it.filePath)}
              title={it.isAnalysisSupported === false ? `${it.filePath}
Not currently supported for static analysis.` : it.filePath}
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
