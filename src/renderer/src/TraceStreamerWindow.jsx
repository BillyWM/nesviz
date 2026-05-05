import { useEffect, useMemo, useState } from 'react';
import { formatKiB } from '../../shared/utils/byteUtils.js';
import { parseLeadingInt } from '../../shared/utils/numberUtils.js';

const MAPPER_NAMES = Object.freeze({
  0: 'NROM',
  1: 'MMC1',
  2: 'UNROM',
  3: 'CNROM',
  4: 'MMC3',
  5: 'MMC5',
  7: 'AxROM',
  9: 'MMC2',
  10: 'MMC4',
  11: 'Color Dreams',
  66: 'GxROM'
});

function mapperToText(mapperId) {
  const id = Number(mapperId);
  if (!Number.isFinite(id)) return '';
  const name = MAPPER_NAMES[id] || 'Unknown';
  return `${name} (${id})`;
}

function mirroringToText(m) {
  switch (Number(m)) {
    case 0:
      return 'Horizontal';
    case 1:
      return 'Vertical';
    case 2:
      return 'Single-screen A';
    case 3:
      return 'Single-screen B';
    case 4:
      return 'Four-screen';
    default:
      return '';
  }
}

function InfoRow({ label, value, mono = false, valueTitle = '' }) {
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
        title={valueTitle || undefined}
      >
        {displayValue || <span>&nbsp;</span>}
      </div>
    </div>
  );
}

export default function TraceStreamerWindow() {
  const [status, setStatus] = useState(() => ({
    connected: false,
    connecting: false,
    // INFO fields
    hasGame: false,
    fileName: '',
    sha1: '',
    crc32: '',
    prgCrc32: '',
    prgChrCrc32: '',
    mapperId: '',
    submapperId: '',
    mirroring: '',
    prgRomSize: '',
    chrRomSize: '',
    workRamSize: '',
    saveRamSize: '',
    chrRamSize: '',
    saveChrRamSize: ''
  }));

  useEffect(() => {
    let unsub = null;
    let cancelled = false;

    (async () => {
      try {
        const initial = await window.nesviz.traceStreamerGetStatus();
        if (!cancelled && initial && typeof initial === 'object') setStatus(initial);
      } catch {
        // Ignore; window can still update via push events.
      }
    })();

    unsub = window.nesviz.onTraceStreamerStatus((next) => {
      if (!next || typeof next !== 'object') return;
      setStatus(next);
    });

    return () => {
      cancelled = true;
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  const connected = !!status.connected;
  const connectBtnDisabled = !!status.connecting;

  const emulatorName = ''; // Not provided by v1 protocol; keep blank for now.
  const gameName = status.hasGame ? status.fileName : connected ? '(No ROM loaded)' : '';
  const crc32 = status.hasGame ? status.crc32 : '';

  const prgRomBytes = status.hasGame ? parseLeadingInt(status.prgRomSize) : null;
  const chrRomBytes = status.hasGame ? parseLeadingInt(status.chrRomSize) : null;
  const workRamBytes = status.hasGame ? parseLeadingInt(status.workRamSize) : null;
  const saveRamBytes = status.hasGame ? parseLeadingInt(status.saveRamSize) : null;
  const chrRamBytes = status.hasGame ? parseLeadingInt(status.chrRamSize) : null;
  const saveChrRamBytes = status.hasGame ? parseLeadingInt(status.saveChrRamSize) : null;

  const prgRomKiB = formatKiB(prgRomBytes);
  const chrRomKiB = formatKiB(chrRomBytes);
  const workRamKiB = formatKiB(workRamBytes);
  const saveRamKiB = formatKiB(saveRamBytes);
  const chrRamKiB = formatKiB(chrRamBytes);
  const saveChrRamKiB = formatKiB(saveChrRamBytes);

  const prgRomTitle = prgRomBytes == null ? '' : `${prgRomBytes} bytes`;
  const chrRomTitle = chrRomBytes == null ? '' : `${chrRomBytes} bytes`;
  const workRamTitle = workRamBytes == null ? '' : `${workRamBytes} bytes`;
  const saveRamTitle = saveRamBytes == null ? '' : `${saveRamBytes} bytes`;
  const chrRamTitle = chrRamBytes == null ? '' : `${chrRamBytes} bytes`;
  const saveChrRamTitle = saveChrRamBytes == null ? '' : `${saveChrRamBytes} bytes`;

  const fields = useMemo(() => {
    return [
      { label: 'Emulator', value: emulatorName },
      { label: 'Game', value: gameName },
      { label: 'CRC32', value: crc32, mono: true },
      { label: 'Mapper', value: status.hasGame ? mapperToText(status.mapperId) : '' },
      { label: 'Submapper', value: status.hasGame ? status.submapperId : '' },
      { label: 'Mirroring', value: status.hasGame ? mirroringToText(status.mirroring) : '' },
      { label: 'PRG ROM', value: status.hasGame ? prgRomKiB : '', valueTitle: prgRomTitle },
      { label: 'CHR ROM', value: status.hasGame ? chrRomKiB : '', valueTitle: chrRomTitle },
      { label: 'Work RAM', value: status.hasGame ? workRamKiB : '', valueTitle: workRamTitle },
      { label: 'Save RAM', value: status.hasGame ? saveRamKiB : '', valueTitle: saveRamTitle },
      { label: 'CHR RAM', value: status.hasGame ? chrRamKiB : '', valueTitle: chrRamTitle },
      { label: 'Save CHR RAM', value: status.hasGame ? saveChrRamKiB : '', valueTitle: saveChrRamTitle }
    ];
  }, [
    emulatorName,
    gameName,
    crc32,
    status,
    prgRomKiB,
    chrRomKiB,
    workRamKiB,
    saveRamKiB,
    chrRamKiB,
    saveChrRamKiB,
    prgRomTitle,
    chrRomTitle,
    workRamTitle,
    saveRamTitle,
    chrRamTitle,
    saveChrRamTitle
  ]);

  return (
    <div className="nv-toolwindow">
      <div className="nv-modal-header">
        <div className="nv-modal-title">Trace Streamer</div>
        <div className="nv-modal-header-actions">
          <button
            type="button"
            className="nv-btn"
            disabled={connectBtnDisabled}
            onClick={() => {
              if (connected) {
                window.nesviz.traceStreamerDisconnect();
              } else {
                window.nesviz.traceStreamerConnect();
              }
            }}
            title={connected ? 'Disconnect from emulator' : 'Connect to emulator'}
          >
            {connected ? 'Disconnect' : 'Connect'}
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
              <InfoRow key={f.label} label={f.label} value={f.value} mono={!!f.mono} valueTitle={f.valueTitle || ''} />
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {fields.slice(Math.ceil(fields.length / 2)).map((f) => (
              <InfoRow key={f.label} label={f.label} value={f.value} mono={!!f.mono} valueTitle={f.valueTitle || ''} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
