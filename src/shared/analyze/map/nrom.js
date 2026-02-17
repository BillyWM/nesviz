// NROM mapping: no bank switching; PRG is either 16KiB (mirrored) or 32KiB (linear). 🤖
// We expose the mapping as small pure functions so later mappers can share the same interface. 🤖

export function createNromMapper({ prgSize }) {
  const is16k = prgSize === 16 * 1024;
  const is32k = prgSize === 32 * 1024;

  function cpuToRomOff(cpuAddr) {
    const a = cpuAddr & 0xffff;
    if (a < 0x8000) return null;

    if (is32k) {
      const off = a - 0x8000;
      if (off < 0 || off >= prgSize) return null;
      return off;
    }

    if (is16k) {
      const off = (a - 0x8000) & 0x3fff;
      if (off < 0 || off >= prgSize) return null;
      return off;
    }

    // NROM should only be 16KiB or 32KiB PRG; if not, treat as unmapped. 🤖
    return null;
  }

  function romOffToCpuAddrs(romOff) {
    const off = romOff | 0;
    if (off < 0 || off >= prgSize) return [];
    if (is16k) return [0x8000 + off, 0xC000 + off];
    if (is32k) return [0x8000 + off];
    return [];
  }

  return {
    id: 'nrom',
    cpuToRomOff,
    romOffToCpuAddrs
  };
}
