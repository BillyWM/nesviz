import { parseBytesText, u16le } from '../../utils/byteUtils.js';
import { isPpuDataRegisterAddr } from '../../nes/namedRegisters.js';

const STORE_MNEMONICS = new Set(['STA', 'STX', 'STY']);
const WRITE_MODES = new Set(['abs', 'absX', 'absY']);

function makePoiId(kind, romOffStart, romOffEnd) {
  return `${kind}:${(romOffStart >>> 0).toString(16)}-${(romOffEnd >>> 0).toString(16)}`;
}

function operandAbs(line) {
  if (!line || !WRITE_MODES.has(line.mode)) return null;
  const bytes = parseBytesText(line.bytesText, { strict: false });
  if (!bytes || bytes.length < 3) return null;
  return u16le(bytes, 1);
}

function lineEndRomOff(line) {
  if (!line || typeof line.romOff !== 'number') return null;
  const len = (typeof line.len === 'number' && line.len > 0) ? (line.len >>> 0) : 1;
  return ((line.romOff >>> 0) + len) >>> 0;
}

function isPpuDataWrite(line) {
  if (!line || !STORE_MNEMONICS.has(line.mnemonic)) return false;
  const abs = operandAbs(line);
  return abs !== null && isPpuDataRegisterAddr(abs);
}

export function runPpuRecognizersForBlock(block) {
  const lines = Array.isArray(block?.lines) ? block.lines : [];
  if (!lines.length) return [];

  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isPpuDataWrite(line)) continue;
    if (typeof line.romOff !== 'number') continue;
    const end = lineEndRomOff(line);
    if (end === null) continue;
    hits.push({ line, index: i, end });
  }

  if (!hits.length) return [];

  const first = hits[0];
  const last = hits[hits.length - 1];
  const start = first.line.romOff >>> 0;
  const end = last.end >>> 0;
  if (!(end > start)) return [];

  return [
    {
      id: makePoiId('writesPpuData', start, end),
      kind: 'writesPpuData',
      label: 'writes PPUDATA',
      pill: 'writes PPUDATA',
      basis: { romOffSpan: { start, end } },
      meta: {
        register: 'PPUDATA_2007',
        writeCount: hits.length,
        writeCpuAddrs: hits
          .map((h) => (typeof h.line.cpuAddr === 'number' ? (h.line.cpuAddr & 0xffff) : null))
          .filter((v) => v !== null),
        writeRomOffs: hits.map((h) => h.line.romOff >>> 0)
      }
    }
  ];
}
