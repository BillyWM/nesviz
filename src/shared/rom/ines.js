// Minimal iNES (NES 1.0-ish) parser. Expand later for NES 2.0 + mappers. 🤖

export function parseInes(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Expected a Node Buffer');

  if (buffer.length < 16) throw new Error('File too small to be iNES');
  if (
    buffer[0] !== 0x4e ||
    buffer[1] !== 0x45 ||
    buffer[2] !== 0x53 ||
    buffer[3] !== 0x1a
  ) {
    throw new Error('Not an iNES file (missing NES<1A> signature)');
  }

  const prgBanks16k = buffer[4];
  const chrBanks8k = buffer[5];
  const flags6 = buffer[6];
  const flags7 = buffer[7];

  const mapperLow = (flags6 >> 4) & 0x0f;
  const mapperHigh = (flags7 >> 4) & 0x0f;
  const mapperNumber = (mapperHigh << 4) | mapperLow;

  const hasTrainer = (flags6 & 0x04) !== 0;
  const mirroring = (flags6 & 0x01) !== 0 ? 'VERT' : 'HORZ';

  let offset = 16;
  if (hasTrainer) offset += 512;

  const prgSize = prgBanks16k * 16 * 1024;
  const chrSize = chrBanks8k * 8 * 1024;

  const prgStart = offset;
  const prgEnd = prgStart + prgSize;
  const chrStart = prgEnd;
  const chrEnd = chrStart + chrSize;

  if (buffer.length < prgEnd) throw new Error('Truncated PRG data');
  if (buffer.length < chrEnd) throw new Error('Truncated CHR data');

  const prg = buffer.subarray(prgStart, prgEnd);
  const chr = buffer.subarray(chrStart, chrEnd);

  return {
    format: 'iNES',
    prgBanks16k,
    chrBanks8k,
    prgSize,
    chrSize,
    mapperNumber,
    // legacy alias in case older code expects `mapper` (avoid churn). 🤖
    mapper: mapperNumber,
    mirroring,
    hasTrainer,
    prg,
    chr
  };
}

function readVectorsFromPrgBytes(prgBytes) {
  if (prgBytes.length < 16 * 1024) throw new Error('PRG too small');
  const last16k = prgBytes.subarray(prgBytes.length - 16 * 1024);

  // Vectors live at CPU $FFFA-$FFFF which is always in the *last* 16KiB window. 🤖
  // For NROM-16, that last window is a mirror of the single PRG bank. 🤖
  const rd16 = (cpuAddr) => {
    const i = (cpuAddr & 0xffff) - 0xc000;
    const lo = last16k[i] & 0xff;
    const hi = last16k[i + 1] & 0xff;
    return (lo | (hi << 8)) & 0xffff;
  };

  return {
    nmi: rd16(0xfffa),
    reset: rd16(0xfffc),
    irqBrk: rd16(0xfffe)
  };
}

// Handy: read the 6502 vectors (NMI/RESET/IRQ+BRK). 🤖
// Accepts either an iNES object (from parseInes) or a raw PRG byte slice. 🤖
export function readVectorsFromLastPrgBank(inesOrPrgBytes) {
  const prgBytes = Buffer.isBuffer(inesOrPrgBytes)
    ? inesOrPrgBytes
    : inesOrPrgBytes?.prg;

  if (!prgBytes) throw new Error('Expected iNES object with .prg or a PRG Buffer');
  return readVectorsFromPrgBytes(prgBytes);
}
