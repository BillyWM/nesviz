import { fmtHex } from '../../shared/utils/numberUtils.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import RefreshButton from './components/RefreshButton.jsx';

export default function LabelsWindow() {
  const [status, setStatus] = useState('');
  const [hasRom, setHasRom] = useState(false);
  const [romHash, setRomHash] = useState(null);
  const [labelsByRomOff, setLabelsByRomOff] = useState({});
  const [labelsByAddr, setLabelsByAddr] = useState({});

  const reload = useCallback(async () => {
    setStatus('Loading labels…');
    try {
      const res = await window.nesviz?.getActiveLabels?.();
      if (!res?.ok) {
        setStatus(res?.error || 'Failed to load labels');
        return;
      }
      const nextHasRom = !!res.hasRom;
      setHasRom(nextHasRom);
      setRomHash(nextHasRom ? (res.romHash || null) : null);
      setLabelsByRomOff((res.labels && typeof res.labels === 'object') ? res.labels : {});
      setLabelsByAddr((res.addrLabels && typeof res.addrLabels === 'object') ? res.addrLabels : {});
      setStatus('');
    } catch (e) {
      setStatus(`Failed to load labels: ${e?.message ?? String(e)}`);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const addrItems = useMemo(() => {
    const out = [];
    for (const [k, v] of Object.entries(labelsByAddr || {})) {
      const a = Number(k);
      const label = (v ?? '').toString();
      if (!Number.isFinite(a) || a < 0 || !label) continue;
      out.push({ kind: 'addr', cpuAddr: (a & 0xffff), label });
    }
    out.sort((x, y) => x.cpuAddr - y.cpuAddr);
    return out;
  }, [labelsByAddr]);

  const romItems = useMemo(() => {
    const out = [];
    for (const [key, entry] of Object.entries(labelsByRomOff || {})) {
      const label = (entry?.label ?? '').toString();
      const romOff = typeof entry?.romOff === 'number' ? (entry.romOff >>> 0) : Number(key);
      if (!Number.isFinite(romOff) || romOff < 0 || !label) continue;
      out.push({ kind: 'rom', romOff: romOff >>> 0, label });
    }
    out.sort((a, b) => a.romOff - b.romOff);
    return out;
  }, [labelsByRomOff]);

  const total = addrItems.length + romItems.length;

  function navigateTo(it) {
    if (!it || !window?.nesviz?.labelsNavigate) return;
    if (it.kind === 'rom') {
      window.nesviz.labelsNavigate({ kind: 'rom', romOff: it.romOff });
    }
  }

  return (
    <div className="nv-toolwindow">
      <div className="nv-modal-header nv-centered-tool-header">
        <div className="nv-modal-title">Labels</div>
        <div className="nv-centered-tool-header-actions" aria-label="Labels actions">
          <RefreshButton onClick={reload} title="Reload labels" />
        </div>
        <div className="nv-centered-tool-header-spacer" aria-hidden="true" />
      </div>

      <div className="nv-modal-meta">
        {!hasRom ? (
          <span className="nv-badge">No ROM loaded.</span>
        ) : total === 0 ? (
          <span className="nv-badge">No labels for this ROM.</span>
        ) : (
          <>
            <span className="nv-badge">{total} label{total === 1 ? '' : 's'}</span>
            {romHash ? <span className="nv-badge" title={romHash}>ROM {romHash.slice(0, 10)}…</span> : null}
          </>
        )}
        {status ? <span className="nv-badge">{status}</span> : null}
      </div>

      <div className="nv-modal-list" style={{ flex: 1 }}>
        {total === 0 ? (
          <div className="nv-modal-empty">{hasRom ? 'Add a label in the main window to see it here.' : 'Open a ROM to see its labels.'}</div>
        ) : (
          <>
            {addrItems.length ? (
              <>
                <div className="nv-modal-list-head" style={{ paddingTop: 6 }}>
                  <div className="nv-col nv-col-name nv-modal-colhead" style={{ textAlign: 'left' }}>CPU address labels</div>
                </div>
                {addrItems.map((it) => (
                  <div
                    key={`a:${it.cpuAddr}`}
                    className="nv-modal-row"
                    title={`$${fmtHex(it.cpuAddr)}`}
                  >
                    <div className="nv-col nv-col-name" style={{ textAlign: 'left' }}>{it.label}</div>
                    <div className="nv-col nv-col-meta" style={{ textAlign: 'right' }}>${fmtHex(it.cpuAddr)}</div>
                  </div>
                ))}
              </>
            ) : null}

            {romItems.length ? (
              <>
                <div className="nv-modal-list-head" style={{ paddingTop: addrItems.length ? 14 : 6 }}>
                  <div className="nv-col nv-col-name nv-modal-colhead" style={{ textAlign: 'left' }}>ROM labels</div>
                </div>
                {romItems.map((it) => (
                  <button
                    key={`rom:${it.romOff}`}
                    type="button"
                    className="nv-modal-row"
                    onClick={() => navigateTo(it)}
                    title={`ROM+0x${fmtHex(it.romOff, 6)}`}
                  >
                    <div className="nv-col nv-col-name" style={{ textAlign: 'left' }}>{it.label}</div>
                    <div className="nv-col nv-col-meta" style={{ textAlign: 'right' }}>0x{fmtHex(it.romOff, 6)}</div>
                  </button>
                ))}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
