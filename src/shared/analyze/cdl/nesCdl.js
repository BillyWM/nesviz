import { readUint32Le } from '../../utils/binaryReadUtils.js';

const NES_CDL_FORMAT_MESEN2 = 'mesen2';
const MESEN2_HEADER_SIZE = 9;
const MESEN2_HEADER_MAGIC = 'CDLv2';

const textDecoder = new TextDecoder('ascii');

export { NES_CDL_FORMAT_MESEN2 };

export function parseNesCdl(cdlBytes, { prgSize, chrSize }, options = {}) {
  const formatHint = typeof options?.formatHint === 'string' ? options.formatHint.trim().toLowerCase() : 'auto';

  if (!cdlBytes || (cdlBytes.length | 0) <= 0) {
    return {
      ok: false,
      format: null,
      prg: null,
      chr: null,
      warnings: ['Empty CDL file']
    };
  }

  if (formatHint !== 'auto' && formatHint !== NES_CDL_FORMAT_MESEN2) {
    return unsupportedFormatResult(`Unsupported CDL format hint "${options.formatHint}". Only Mesen2 CDLv2 files are supported right now.`);
  }

  if (formatHint === NES_CDL_FORMAT_MESEN2 || hasMesen2Header(cdlBytes)) {
    return parseMesen2NesCdl(cdlBytes, { prgSize, chrSize });
  }

  return unsupportedFormatResult('Unsupported CDL format. Only Mesen2 CDLv2 files are supported right now.');
}

export function parseMesen2NesCdl(cdlBytes, { prgSize, chrSize }) {
  if (!cdlBytes || (cdlBytes.length | 0) <= 0) {
    return {
      ok: false,
      format: NES_CDL_FORMAT_MESEN2,
      prg: null,
      chr: null,
      warnings: ['Empty CDL file']
    };
  }

  const warnings = [];
  const rawLen = cdlBytes.length | 0;

  if (!hasMesen2Header(cdlBytes)) {
    return unsupportedFormatResult('Unsupported CDL format. Expected a Mesen2 CDLv2 header.');
  }

  if (rawLen < MESEN2_HEADER_SIZE) {
    return {
      ok: false,
      format: NES_CDL_FORMAT_MESEN2,
      prg: null,
      chr: null,
      warnings: [`CDL is truncated (got ${rawLen} bytes, expected at least ${MESEN2_HEADER_SIZE} for the header).`]
    };
  }

  const expectedPayload = (prgSize | 0) + (chrSize | 0);
  const payload = cdlBytes.subarray(MESEN2_HEADER_SIZE);
  const payloadLen = payload.length | 0;

  if (expectedPayload > 0 && payloadLen !== expectedPayload) {
    if (payloadLen < expectedPayload) {
      warnings.push(`CDL payload is shorter than expected after the Mesen2 header (got ${payloadLen}, expected ${expectedPayload}); missing bytes will be treated as unknown.`);
    } else {
      warnings.push(`CDL payload is longer than expected after the Mesen2 header (got ${payloadLen}, expected ${expectedPayload}); extra bytes ignored.`);
    }
  }

  const prg = payload.subarray(0, Math.min(prgSize, payload.length));
  const chrStart = prgSize;
  const chrEnd = Math.min(chrStart + chrSize, payload.length);
  const chr = chrSize > 0 && chrEnd > chrStart ? payload.subarray(chrStart, chrEnd) : null;

  return {
    ok: true,
    format: NES_CDL_FORMAT_MESEN2,
    prg,
    chr,
    warnings,
    header: {
      magic: MESEN2_HEADER_MAGIC,
      crc32: readUint32Le(cdlBytes, 5)
    }
  };
}

function unsupportedFormatResult(message) {
  return {
    ok: false,
    format: null,
    prg: null,
    chr: null,
    warnings: [message]
  };
}

function hasMesen2Header(cdlBytes) {
  if (!cdlBytes || (cdlBytes.length | 0) < MESEN2_HEADER_SIZE) return false;
  return textDecoder.decode(cdlBytes.subarray(0, MESEN2_HEADER_MAGIC.length)) === MESEN2_HEADER_MAGIC;
}

const prgCdlDecoders = {
  [NES_CDL_FORMAT_MESEN2]: {
    decodeByte: decodeMesen2PrgCdlByte,
    isDataObserved: isMesen2PrgDataObserved,
    cpuAddrForRomOff: cpuAddrForRomOffUsingMesen2Cdl
  }
};

export function decodePrgCdlByte(b, format = NES_CDL_FORMAT_MESEN2) {
  return getPrgCdlDecoder(format).decodeByte(b);
}

export function isPrgDataObserved(flags, format = NES_CDL_FORMAT_MESEN2) {
  return getPrgCdlDecoder(format).isDataObserved(flags);
}

export function cpuAddrForRomOffUsingSlot(romOff, slot, format = NES_CDL_FORMAT_MESEN2) {
  return getPrgCdlDecoder(format).cpuAddrForRomOff(romOff, slot);
}

function getPrgCdlDecoder(format) {
  return prgCdlDecoders[format] || prgCdlDecoders[NES_CDL_FORMAT_MESEN2];
}

function decodeMesen2PrgCdlByte(b) {
  const v = b & 0xff;
  return {
    raw: v,
    exec: (v & 0x01) !== 0,
    data: (v & 0x02) !== 0,
    jumpTarget: (v & 0x04) !== 0,
    subEntryPoint: (v & 0x08) !== 0,
    pcmData: (v & 0x80) !== 0
  };
}

function isMesen2PrgDataObserved(flags) {
  if (!flags) return false;
  return !!(flags.data || flags.pcmData);
}

function cpuAddrForRomOffUsingMesen2Cdl(romOff) {
  return (0x8000 + ((romOff | 0) & 0x7fff)) & 0xffff;
}
