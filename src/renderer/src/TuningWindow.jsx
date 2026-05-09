import { useCallback, useEffect, useMemo, useState } from 'react';

function SliderRow({ label, value, min, max, step = 1, onChange }) {
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 10, alignItems: 'center', marginBottom: 10 }}>
      <div>
        <div style={{ fontSize: 13, marginBottom: 4 }}>{label}</div>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 12, textAlign: 'right' }}>{value}</div>
    </label>
  );
}

export default function TuningWindow() {
  const [tuning, setTuning] = useState(null);
  const [status, setStatus] = useState('');

  const reload = useCallback(async () => {
    setStatus('Loading…');
    try {
      const res = await window.nesviz.getTuningState();
      if (!res?.ok) {
        setStatus(res?.error || 'Failed to load tuning');
        return;
      }
      setTuning(res.tuning || null);
      setStatus('Changes apply to the next Analyze run.');
    } catch (e) {
      setStatus(`Failed to load tuning: ${e?.message ?? String(e)}`);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const unsub = window.nesviz.onTuningUpdated((payload) => {
      setTuning(payload?.tuning || null);
      setStatus('Changes apply to the next Analyze run.');
    });
    return () => { try { unsub?.(); } catch {} };
  }, []);

  const patch = useCallback(async (partial) => {
    try {
      const res = await window.nesviz.setTuningState(partial);
      if (res?.ok) {
        setTuning(res.tuning || null);
        setStatus('Changes apply to the next Analyze run.');
      }
    } catch (e) {
      setStatus(`Failed to update tuning: ${e?.message ?? String(e)}`);
    }
  }, []);

  const reset = useCallback(async () => {
    try {
      const res = await window.nesviz.resetTuningState();
      if (res?.ok) {
        setTuning(res.tuning || null);
        setStatus('Reset to defaults. Changes apply to the next Analyze run.');
      }
    } catch (e) {
      setStatus(`Failed to reset tuning: ${e?.message ?? String(e)}`);
    }
  }, []);

  const view = useMemo(() => tuning || {
    maxProbeStartsPerRange: 64,
    minChunkBytes: 48,
    minShortChunkBytes: 16,
    shortChunkMinScore: 30,
    requireGoodTerminatorForShortChunks: true
  }, [tuning]);

  return (
    <div className="nv-toolwindow">
      <div className="nv-modal-header">
        <div className="nv-modal-title">Tuning</div>
        <div className="nv-modal-header-actions">
          <button type="button" className="nv-btn" onClick={reset}>Reset</button>
        </div>
      </div>

      <div className="nv-modal-meta">
        <span className="nv-badge">Session only</span>
        {status ? <span className="nv-badge">{status}</span> : null}
      </div>

      <div className="nv-modal-list" style={{ flex: 1, padding: 12 }}>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Probable code</div>
          <SliderRow label="Max probe starts per range" value={view.maxProbeStartsPerRange} min={1} max={256} onChange={(v) => patch({ maxProbeStartsPerRange: v })} />
          <SliderRow label="Min chunk bytes" value={view.minChunkBytes} min={1} max={128} onChange={(v) => patch({ minChunkBytes: v })} />
          <SliderRow label="Min short chunk bytes" value={view.minShortChunkBytes} min={1} max={64} onChange={(v) => patch({ minShortChunkBytes: v })} />
          <SliderRow label="Short chunk min score" value={view.shortChunkMinScore} min={0} max={150} onChange={(v) => patch({ shortChunkMinScore: v })} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
            <input type="checkbox" checked={!!view.requireGoodTerminatorForShortChunks} onChange={(e) => patch({ requireGoodTerminatorForShortChunks: !!e.target.checked })} />
            <span>Require good terminator for short chunks</span>
          </label>
        </div>
      </div>
    </div>
  );
}
