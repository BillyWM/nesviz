import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatMb } from '../../shared/utils/byteFormatUtils.js';

function normalizeStats(raw) {
  return {
    gameCount: Number.isFinite(raw?.gameCount) ? raw.gameCount : 0,
    bytes: Number.isFinite(raw?.bytes) ? raw.bytes : 0,
    mb: Number.isFinite(raw?.mb) ? raw.mb : 0
  };
}

export default function PreferencesWindow() {
  const [stats, setStats] = useState(() => normalizeStats(null));
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setStatus('Loading…');
    try {
      const res = await window.nesviz?.getPreferencesAnalysisCacheStats?.();
      if (!res?.ok) {
        setStatus(res?.error || 'Failed to load cache stats');
        return;
      }
      setStats(normalizeStats(res.stats));
      setStatus('');
    } catch (e) {
      setStatus(`Failed to load cache stats: ${e?.message ?? String(e)}`);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const clearCache = useCallback(async () => {
    setBusy(true);
    setStatus('Clearing…');
    try {
      const res = await window.nesviz?.clearPreferencesAnalysisCache?.();
      if (!res?.ok) {
        setStatus(res?.error || 'Failed to clear analysis cache');
        return;
      }
      setStats(normalizeStats(res.stats));
      setStatus('Analysis cache cleared.');
    } catch (e) {
      setStatus(`Failed to clear analysis cache: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const cacheSummary = useMemo(() => {
    const gameLabel = stats.gameCount === 1 ? 'game' : 'games';
    return `${stats.gameCount} ${gameLabel}, ${formatMb(stats.mb)}`;
  }, [stats]);

  return (
    <div className="nv-toolwindow">
      <div className="nv-modal-header">
        <div className="nv-modal-title">Preferences</div>
      </div>

      <div className="nv-modal-meta">
        {status ? <span className="nv-badge">{status}</span> : null}
      </div>

      <div className="nv-modal-list" style={{ flex: 1, padding: 14 }}>
        <section className="nv-preferences-section">
          <div className="nv-preferences-section-title">
            Caches
          </div>
          <div className="nv-preferences-row">
            <div>
              <div className="nv-preferences-label">Analysis cache</div>
              <div className="nv-preferences-summary">{cacheSummary}</div>
            </div>
            <button type="button" className="nv-btn" disabled={busy || stats.gameCount === 0} onClick={clearCache}>
              {busy ? 'Clearing…' : 'Clear'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
