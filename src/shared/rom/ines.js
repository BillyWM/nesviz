import {
  classifyMapperFromHeader,
  getMapperDisplayName,
  isCurrentStaticAnalysisTargetMapper,
  resolveMapperInfo
} from './mapperInfo.js';
import { crc32HexBuffers } from './crc32.js';
import { lookupMesenRomOverride } from './mesenOverrides.js';

function decodeNes2RomSize(lsb, upperNibble, unitSize) {
  const lo = lsb & 0xff;
  const hi = upperNibble & 0x0f;

  if (hi !== 0x0f) {
    return (((hi << 8) | lo) * unitSize) >>> 0;
  }

  const exponent = (lo >> 2) & 0x3f;
  const multiplier = ((lo & 0x03) * 2) + 1;
  return (2 ** exponent) * multiplier;
}

function decodeRamShiftCount(shift) {
  const s = shift & 0x0f;
  if (s === 0) return 0;
  return 64 << s;
}

export function parseInesHeader(buffer) {
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

  const prgUnitsLsb = buffer[4] & 0xff;
  const chrUnitsLsb = buffer[5] & 0xff;
  const flags6 = buffer[6] & 0xff;
  const flags7 = buffer[7] & 0xff;
  const byte8 = buffer[8] & 0xff;
  const byte9 = buffer[9] & 0xff;
  const byte10 = buffer[10] & 0xff;
  const byte11 = buffer[11] & 0xff;

  const isNes2 = (flags7 & 0x0c) === 0x08;
  const mapperLow = (flags6 >> 4) & 0x0f;
  const mapperHigh = (flags7 >> 4) & 0x0f;
  const mapperUpper = isNes2 ? (byte8 & 0x0f) : 0;
  const mapperNumber = (mapperLow | (mapperHigh << 4) | (mapperUpper << 8)) >>> 0;
  const submapperNumber = isNes2 ? ((byte8 >> 4) & 0x0f) : 0;

  const hasTrainer = (flags6 & 0x04) !== 0;
  const hasBattery = (flags6 & 0x02) !== 0;
  const fourScreen = (flags6 & 0x08) !== 0;
  const mirroring = (flags6 & 0x01) !== 0 ? 'VERT' : 'HORZ';

  const prgSize = isNes2
    ? decodeNes2RomSize(prgUnitsLsb, byte9 & 0x0f, 16 * 1024)
    : prgUnitsLsb * 16 * 1024;
  const chrSize = isNes2
    ? decodeNes2RomSize(chrUnitsLsb, (byte9 >> 4) & 0x0f, 8 * 1024)
    : chrUnitsLsb * 8 * 1024;

  const prgRamSize = isNes2 ? decodeRamShiftCount(byte10 & 0x0f) : 0;
  const prgNvramSize = isNes2 ? decodeRamShiftCount((byte10 >> 4) & 0x0f) : 0;
  const chrRamSize = isNes2 ? decodeRamShiftCount(byte11 & 0x0f) : (chrSize === 0 ? 8 * 1024 : 0);
  const chrNvramSize = isNes2 ? decodeRamShiftCount((byte11 >> 4) & 0x0f) : 0;

  const prgBanks16k = Math.floor(prgSize / (16 * 1024));
  const chrBanks8k = Math.floor(chrSize / (8 * 1024));
  const mapperName = getMapperDisplayName(mapperNumber);
  const analysisMapper = classifyMapperFromHeader({
    mapperNumber,
    submapperNumber,
    prgSize,
    chrSize,
    prgRamSize,
    prgNvramSize,
    chrRamSize,
    chrNvramSize,
    isNes2
  });

  return {
    format: isNes2 ? 'NES 2.0' : 'iNES',
    formatVariant: isNes2 ? 'NES2.0' : 'iNES',
    isNes2,
    mapperNumber,
    mapper: mapperNumber,
    submapperNumber,
    mapperName,
    prgBanks16k,
    chrBanks8k,
    prgSize,
    chrSize,
    prgRamSize,
    prgNvramSize,
    chrRamSize,
    chrNvramSize,
    hasTrainer,
    hasBattery,
    fourScreen,
    mirroring,
    isTargetMapper: isCurrentStaticAnalysisTargetMapper(mapperNumber),
    analysisMapper
  };
}

export function parseInes(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Expected a Node Buffer');

  const header = parseInesHeader(buffer);

  let offset = 16;
  if (header.hasTrainer) offset += 512;

  const prgStart = offset;
  const prgEnd = prgStart + header.prgSize;
  const chrStart = prgEnd;
  const chrEnd = chrStart + header.chrSize;

  if (buffer.length < prgEnd) throw new Error('Truncated PRG data');
  if (buffer.length < chrEnd) throw new Error('Truncated CHR data');

  const prg = buffer.subarray(prgStart, prgEnd);
  const chr = buffer.subarray(chrStart, chrEnd);
  const prgChrCrc32 = crc32HexBuffers([prg, chr]);
  const romOverride = lookupMesenRomOverride(prgChrCrc32, header.mapperNumber);
  const resolvedSubmapperNumber = romOverride?.submapperNumber ?? header.submapperNumber;
  const analysisMapper = resolveMapperInfo(
    {
      ...header,
      submapperNumber: resolvedSubmapperNumber
    },
    romOverride
  );

  return {
    ...header,
    submapperNumber: resolvedSubmapperNumber,
    analysisMapper,
    prgChrCrc32,
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
