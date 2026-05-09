const NAMED_REGISTER_DEFS = [
  {
    type: 'mirror',
    family: 'ppu',
    space: 'cpu',
    start: 0x2000,
    end: 0x3fff,
    mirrorSize: 8,
    registers: {
      0x2000: 'PPUCTRL_2000',
      0x2001: 'PPUMASK_2001',
      0x2002: 'PPUSTATUS_2002',
      0x2003: 'OAMADDR_2003',
      0x2004: 'OAMDATA_2004',
      0x2005: 'PPUSCROLL_2005',
      0x2006: 'PPUADDR_2006',
      0x2007: 'PPUDATA_2007'
    }
  }
];

function normalizeCpuAddr(addr) {
  const n = typeof addr === 'number' ? addr : Number(addr);
  if (!Number.isFinite(n)) return null;
  return n & 0xffff;
}

function inRange(addr, def) {
  return addr >= def.start && addr <= def.end;
}

function resolveMirror(def, addr) {
  if (!Number.isFinite(def.mirrorSize) || def.mirrorSize <= 0) return null;
  const offset = (addr - def.start) % def.mirrorSize;
  return (def.start + offset) & 0xffff;
}

function resolveExact(def, addr) {
  if (typeof def.addr === 'number') return (def.addr & 0xffff) === addr ? addr : null;
  if (typeof def.start === 'number' && typeof def.end === 'number' && def.start === def.end && def.start === addr) return addr;
  return null;
}

function resolveMasked(def, addr) {
  if (!Number.isFinite(def.mask)) return null;
  return addr & def.mask & 0xffff;
}

function resolveRange(def, addr) {
  return inRange(addr, def) ? (def.canonicalAddr ?? def.start) & 0xffff : null;
}

function resolveCanonicalAddr(def, addr) {
  if (!def || typeof def !== 'object') return null;
  switch (def.type) {
    case 'exact': return resolveExact(def, addr);
    case 'mirror': return inRange(addr, def) ? resolveMirror(def, addr) : null;
    case 'masked': return inRange(addr, def) ? resolveMasked(def, addr) : null;
    case 'range': return resolveRange(def, addr);
    default: return null;
  }
}

function nameForDef(def, canonicalAddr) {
  if (def.registers && typeof def.registers === 'object') {
    const value = def.registers[canonicalAddr];
    if (typeof value === 'string' && value) return value;
  }
  return (typeof def.name === 'string' && def.name) ? def.name : '';
}

function defMatchesOptions(def, options) {
  if (!options || typeof options !== 'object') return true;
  if (options.family && def.family !== options.family) return false;
  if (options.space && def.space !== options.space) return false;
  if (options.mapper && def.mapper !== options.mapper) return false;
  return true;
}

export function getNamedRegister(addr, options = null) {
  const a = normalizeCpuAddr(addr);
  if (a === null) return null;

  for (const def of NAMED_REGISTER_DEFS) {
    if (!defMatchesOptions(def, options)) continue;
    const canonicalAddr = resolveCanonicalAddr(def, a);
    if (canonicalAddr === null) continue;
    const name = nameForDef(def, canonicalAddr);
    if (!name) continue;
    return {
      family: def.family || 'unknown',
      space: def.space || 'cpu',
      mapper: def.mapper || null,
      name,
      addr: a,
      canonicalAddr,
      defType: def.type
    };
  }

  return null;
}

export function getNamedRegisterName(addr, options = null) {
  return getNamedRegister(addr, options)?.name || '';
}

export function isNamedRegister(addr, options = null) {
  return !!getNamedRegister(addr, options);
}

export function isPpuDataRegisterAddr(addr) {
  return getNamedRegisterName(addr, { family: 'ppu', space: 'cpu' }) === 'PPUDATA_2007';
}
