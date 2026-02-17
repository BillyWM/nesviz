import { useMemo, useState } from 'react';

function InfoRow({ label, value, mono = false }) {
  const displayValue = value ? String(value) : '';
  const monoFont = useMemo(() => {
    return 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
  }, []);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'baseline', padding: '2px 0' }}>
      <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.58)' }}>{label}</div>
      <div
        style={{
          fontSize: 12,
          color: 'rgba(0,0,0,0.78)',
          fontFamily: mono ? monoFont : 'inherit',
          fontVariantNumeric: 'tabular-nums',
          minHeight: 16
        }}
      >
        {displayValue || <span>&nbsp;</span>}
      </div>
    </div>
  );
}

export default function TraceStreamerWindow() {
  // UI stub for now; wiring + network logic comes next.
  const [connected] = useState(false);
  const [emulatorName] = useState('');
  const [gameName] = useState('');
  const [checksum] = useState('');

  // Placeholder ROM details (filled in once we implement the handshake + protocol parsing).
  const [mapper] = useState('');
  const [submapper] = useState('');
  const [prgRom] = useState('');
  const [chrRom] = useState('');
  const [prgRam] = useState('');
  const [prgNvram] = useState('');
  const [chrRam] = useState('');
  const [chrNvram] = useState('');
  const [mirroring] = useState('');
  const [battery] = useState('');
  const [trainer] = useState('');
  const [fourScreen] = useState('');

  const fields = useMemo(() => {
    return [
      { label: 'Emulator', value: emulatorName },
      { label: 'Game', value: gameName },
      { label: 'Checksum', value: checksum, mono: true },
      { label: 'Mapper', value: mapper },
      { label: 'Submapper', value: submapper },
      { label: 'PRG ROM', value: prgRom },
      { label: 'CHR ROM', value: chrRom },
      { label: 'PRG RAM', value: prgRam },
      { label: 'PRG NVRAM', value: prgNvram },
      { label: 'CHR RAM', value: chrRam },
      { label: 'CHR NVRAM', value: chrNvram },
      { label: 'Mirroring', value: mirroring },
      { label: 'Battery', value: battery },
      { label: 'Trainer', value: trainer },
      { label: 'Four-screen', value: fourScreen }
    ];
  }, [
    emulatorName,
    gameName,
    checksum,
    mapper,
    submapper,
    prgRom,
    chrRom,
    prgRam,
    prgNvram,
    chrRam,
    chrNvram,
    mirroring,
    battery,
    trainer,
    fourScreen
  ]);

  return (
    <div className="nv-toolwindow">
      <div className="nv-modal-header">
        <div className="nv-modal-title">Trace Streamer</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="nv-btn"
            onClick={() => {}}
            title={connected ? 'Disconnect (not implemented yet)' : 'Connect (not implemented yet)'}
          >
            {connected ? 'Disconnect' : 'Connect'}
          </button>
          <button type="button" className="nv-btn" onClick={() => window.close()}>
            Close
          </button>
        </div>
      </div>

      <div className="nv-modal-meta">
        <span className={`nv-badge ${connected ? 'nv-badge-good' : 'nv-badge-bad'}`}>
          {connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      <div style={{ padding: 14, flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 28px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {fields.slice(0, Math.ceil(fields.length / 2)).map((f) => (
              <InfoRow key={f.label} label={f.label} value={f.value} mono={!!f.mono} />
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {fields.slice(Math.ceil(fields.length / 2)).map((f) => (
              <InfoRow key={f.label} label={f.label} value={f.value} mono={!!f.mono} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
