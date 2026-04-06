import { useCallback, useEffect, useMemo, useState } from 'react';

function fmtHex4(v) {
  if (typeof v !== 'number') return '????';
  return (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

function fmtHex6(v) {
  if (typeof v !== 'number') return '??????';
  return (v >>> 0).toString(16).toUpperCase().padStart(6, '0');
}

export default function LabelsWindow() {
  const [status, setStatus] = useState('');
  const [hasRom, setHasRom] = useState(false);
  const [romHash, setRomHash] = useState(null);
  const [labelsBySite, setLabelsBySite] = useState({});
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
      setLabelsBySite((res.labels && typeof res.labels === 'object') ? res.labels : {});
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

  const siteItems = useMemo(() => {
    const out = [];
    for (const [siteKey, entry] of Object.entries(labelsBySite || {})) {
      const label = (entry?.label ?? '').toString();
      if (!siteKey || !label) continue;
      const cpuAddr = typeof entry?.cpuAddr === 'number' ? (entry.cpuAddr & 0xffff) : null;
      const romOff = typeof entry?.romOff === 'number' ? (entry.romOff | 0) : null;
      const ctxKey = typeof entry?.ctxKey === 'string' && entry.ctxKey ? entry.ctxKey : 'nrom:fixed';
      out.push({ kind: 'site', siteKey, ctxKey, cpuAddr, romOff, label });
    }
    out.sort((a, b) => {
      const ar = a.romOff ?? Number.MAX_SAFE_INTEGER;
      const br = b.romOff ?? Number.MAX_SAFE_INTEGER;
      if (ar !== br) return ar - br;
      const ac = a.cpuAddr ?? 0;
      const bc = b.cpuAddr ?? 0;
      return ac - bc;
    });
    return out;
  }, [labelsBySite]);

  const total = addrItems.length + siteItems.length;

  function navigateTo(it) {
    if (!it || !window?.nesviz?.labelsNavigate) return;
    if (it.kind === 'addr') {
      window.nesviz.labelsNavigate({ kind: 'addr', cpuAddr: it.cpuAddr });
      return;
    }
    if (it.kind === 'site') {
      window.nesviz.labelsNavigate({
        kind: 'site',
        siteKey: it.siteKey,
        ctxKey: it.ctxKey,
        cpuAddr: it.cpuAddr,
        romOff: it.romOff
      });
    }
  }

  return (
    <div className="nv-toolwindow">
      <div className="nv-modal-header">
        <div className="nv-modal-title">Labels</div>
        <button type="button" className="nv-btn" onClick={reload} title="Reload labels">
          Refresh
        </button>
        <button type="button" className="nv-btn" onClick={() => window.close()}>
          Close
        </button>
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
                  <button
                    key={`a:${it.cpuAddr}`}
                    type="button"
                    className="nv-modal-row"
                    onClick={() => navigateTo(it)}
                    title={`$${fmtHex4(it.cpuAddr)}`}
                  >
                    <div className="nv-col nv-col-name" style={{ textAlign: 'left' }}>{it.label}</div>
                    <div className="nv-col nv-col-meta" style={{ textAlign: 'right' }}>${fmtHex4(it.cpuAddr)}</div>
                  </button>
                ))}
              </>
            ) : null}

            {siteItems.length ? (
              <>
                <div className="nv-modal-list-head" style={{ paddingTop: addrItems.length ? 14 : 6 }}>
                  <div className="nv-col nv-col-name nv-modal-colhead" style={{ textAlign: 'left' }}>Code site labels</div>
                </div>
                {siteItems.map((it) => (
                  <button
                    key={`s:${it.siteKey}`}
                    type="button"
                    className="nv-modal-row"
                    onClick={() => navigateTo(it)}
                    title={it.romOff != null ? `ROM+0x${fmtHex6(it.romOff)}` : it.siteKey}
                  >
                    <div className="nv-col nv-col-name" style={{ textAlign: 'left' }}>{it.label}</div>
                    <div className="nv-col nv-col-meta" style={{ textAlign: 'right' }}>
                      {it.cpuAddr != null ? `$${fmtHex4(it.cpuAddr)}` : '—'}{it.romOff != null ? ` · 0x${fmtHex6(it.romOff)}` : ''}
                    </div>
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
