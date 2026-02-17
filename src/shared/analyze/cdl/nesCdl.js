// NES CDL support (Mesen/Mesen2 compatible with the long-standing FCEUX-style CDL bitfield). 🤖
// The CDL is a byte-for-byte overlay for PRG+CHR where each byte is a bitfield describing observed usage. 🤖

// Bits we care about now (PRG):
//  - bit0: executed as code
//  - bit1: read as data
// Mesen-family adds additional bits (jump targets, JSR targets, DMC reads, etc); we preserve everything. 🤖

export function sliceCdlForRom(cdlBytes, { prgSize, chrSize }) {
  const warnings = [];
  const expected = (prgSize | 0) + (chrSize | 0);
  const rawLen = cdlBytes?.length | 0;

  if (!cdlBytes || rawLen <= 0) {
    return { prg: null, chr: null, warnings: ['Empty CDL file'] };
  }

  // Most tools write exactly PRG+CHR bytes (excluding the iNES header). If the file is longer, we conservatively take
  // the leading expected bytes and keep a warning so the user can sanity-check. 🤖
  let usable = cdlBytes;
  if (expected > 0 && rawLen !== expected) {
    if (rawLen < expected) {
      warnings.push(`CDL is shorter than expected (got ${rawLen}, expected ${expected}); missing bytes will be treated as unknown.`);
    } else {
      warnings.push(`CDL is longer than expected (got ${rawLen}, expected ${expected}); extra bytes ignored.`);
      usable = cdlBytes.subarray(0, expected);
    }
  }

  const prg = usable.subarray(0, Math.min(prgSize, usable.length));
  const chrStart = prgSize;
  const chrEnd = Math.min(chrStart + chrSize, usable.length);
  const chr = chrSize > 0 && chrEnd > chrStart ? usable.subarray(chrStart, chrEnd) : null;

  return { prg, chr, warnings };
}

export function decodePrgCdlByte(b) {
  const v = b & 0xff;
  return {
    raw: v,
    exec: (v & 0x01) !== 0,
    data: (v & 0x02) !== 0,
    // slot is A14-A13 of the most recent access; in practice this corresponds to which 8KiB window ($8000,$A000,$C000,$E000). 🤖
    slot: (v >> 2) & 0x03,
    // Mesen-family extras (kept for later UI):
    jumpTarget: (v & 0x10) !== 0,
    indirectData: (v & 0x20) !== 0,
    dmcRead: (v & 0x40) !== 0,
    jsrTarget: (v & 0x80) !== 0
  };
}

export function isPrgDataObserved(flags) {
  if (!flags) return false;
  // "Data" in the View-A sense means this byte was observed being read as data in any way. 🤖
  return !!(flags.data || flags.indirectData || flags.dmcRead);
}

export function cpuAddrForRomOffUsingSlot(romOff, slot) {
  // Given the 8KiB slot ($8000 + slot*0x2000) and the low 13 bits of the ROM offset, we can reconstruct
  // a plausible CPU address for that ROM byte. This is especially useful for 16KiB NROM where $8000-$BFFF
  // mirrors into $C000-$FFFF. 🤖
  const offIn8k = romOff & 0x1fff;
  const base = 0x8000 + ((slot & 3) * 0x2000);
  return (base + offIn8k) & 0xffff;
}
