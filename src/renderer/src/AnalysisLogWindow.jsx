import { useCallback, useEffect, useState } from 'react';
import RefreshButton from './components/RefreshButton.jsx';

export default function AnalysisLogWindow() {
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState('');

  const reload = useCallback(async () => {
    setStatus('Loading…');
    try {
      const res = await window.nesviz?.getAnalysisLog?.();
      if (!res?.ok) {
        setStatus(res?.error || 'Failed to load analysis log');
        return;
      }
      setLines(Array.isArray(res.lines) ? res.lines : []);
      setStatus('');
    } catch (e) {
      setStatus(`Failed to load analysis log: ${e?.message ?? String(e)}`);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!window?.nesviz?.onAnalysisLogUpdated) return;
    const unsub = window.nesviz.onAnalysisLogUpdated((payload) => {
      setLines(Array.isArray(payload?.lines) ? payload.lines : []);
      setStatus('');
    });
    return () => {
      try { unsub?.(); } catch {}
    };
  }, []);

  return (
    <div className="nv-toolwindow">
      <div className="nv-modal-header nv-centered-tool-header">
        <div className="nv-modal-title">Analysis Log</div>
        <div className="nv-centered-tool-header-actions" aria-label="Analysis Log actions">
          <RefreshButton onClick={reload} title="Reload analysis log" />
        </div>
        <div className="nv-centered-tool-header-spacer" aria-hidden="true" />
      </div>

      <div className="nv-modal-meta">
        <span className="nv-badge">{lines.length} line{lines.length === 1 ? '' : 's'}</span>
        {status ? <span className="nv-badge">{status}</span> : null}
      </div>

      <div className="nv-modal-list" style={{ flex: 1, padding: 10 }}>
        {lines.length === 0 ? (
          <div className="nv-modal-empty">No analysis log messages yet.</div>
        ) : (
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 12, lineHeight: 1.45 }}>
            {lines.join('\n')}
          </pre>
        )}
      </div>
    </div>
  );
}
