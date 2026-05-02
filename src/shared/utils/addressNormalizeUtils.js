export function normalizeRomOff(romOff) {
  const n = Number(romOff);
  if (!Number.isFinite(n) || n < 0) return null;
  return n >>> 0;
}

export function normalizeCpuAddr(addr) {
  const n = Number(addr);
  if (!Number.isFinite(n) || n < 0) return null;
  return n & 0xffff;
}

export function canonicalizeCpuAddr(addr) {
  const a = addr & 0xffff;
  if (a < 0x2000) {
    const canon = a & 0x07ff;
    if (canon < 0x0100) return { space: 'zp', addr: canon };
    return { space: 'ram', addr: canon };
  }
  if (a >= 0x6000 && a < 0x8000) return { space: 'prgram', addr: a };
  if (a >= 0x2000 && a < 0x4020) return { space: 'io', addr: a };
  if (a >= 0x8000) return { space: 'rom', addr: a };
  return { space: 'other', addr: a };
}

export function normalizeCpuAddrSet(cpuAddrs, maxSet = 16) {
  const unique = Array.from(new Set((cpuAddrs || [])
    .map((addr) => (typeof addr === 'number' ? addr : Number(addr)))
    .filter((addr) => Number.isFinite(addr))
    .map((addr) => addr & 0xffff))).sort((a, b) => a - b);
  if (!unique.length) return null;
  if (unique.length > Math.max(1, maxSet | 0)) return null;
  return unique;
}

export function normalizeAddr(space, addr) {
  if (space === 'rom') return addr >>> 0;
  return addr & 0xffff;
}
