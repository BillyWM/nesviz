export const NES_CPU_REGISTER_ADDRS = Object.freeze({
  PPUCTRL_2000: 0x2000,
  PPUMASK_2001: 0x2001,
  PPUSTATUS_2002: 0x2002,
  OAMADDR_2003: 0x2003,
  OAMDATA_2004: 0x2004,
  PPUSCROLL_2005: 0x2005,
  PPUADDR_2006: 0x2006,
  PPUDATA_2007: 0x2007,
  OAMDMA_4014: 0x4014,
  CONTROLLER_1_4016: 0x4016,
  CONTROLLER_2_4017: 0x4017,
  CONTROLLER_STROBE_4016: 0x4016,
  APU_FRAME_COUNTER_4017: 0x4017
});

export const NES_MAPPER_REGISTER_NAMES = Object.freeze({
  MMC1_CONTROL: 'MMC1_CONTROL',
  MMC1_CHR_BANK_0: 'MMC1_CHR_BANK_0',
  MMC1_CHR_BANK_1: 'MMC1_CHR_BANK_1',
  MMC1_PRG_BANK: 'MMC1_PRG_BANK',
  MMC3_BANK_SELECT: 'MMC3_BANK_SELECT',
  MMC3_BANK_DATA: 'MMC3_BANK_DATA',
  MMC3_MIRRORING: 'MMC3_MIRRORING',
  MMC3_PRG_RAM_PROTECT: 'MMC3_PRG_RAM_PROTECT',
  MMC3_IRQ_LATCH: 'MMC3_IRQ_LATCH',
  MMC3_IRQ_RELOAD: 'MMC3_IRQ_RELOAD',
  MMC3_IRQ_DISABLE: 'MMC3_IRQ_DISABLE',
  MMC3_IRQ_ENABLE: 'MMC3_IRQ_ENABLE'
});

const NAMED_REGISTER_DEFS = [
  {
    type: 'mirror',
    family: 'ppu',
    space: 'cpu',
    start: NES_CPU_REGISTER_ADDRS.PPUCTRL_2000,
    end: 0x3fff,
    mirrorSize: 8,
    registers: {
      [NES_CPU_REGISTER_ADDRS.PPUCTRL_2000]: 'PPUCTRL_2000',
      [NES_CPU_REGISTER_ADDRS.PPUMASK_2001]: 'PPUMASK_2001',
      [NES_CPU_REGISTER_ADDRS.PPUSTATUS_2002]: 'PPUSTATUS_2002',
      [NES_CPU_REGISTER_ADDRS.OAMADDR_2003]: 'OAMADDR_2003',
      [NES_CPU_REGISTER_ADDRS.OAMDATA_2004]: 'OAMDATA_2004',
      [NES_CPU_REGISTER_ADDRS.PPUSCROLL_2005]: 'PPUSCROLL_2005',
      [NES_CPU_REGISTER_ADDRS.PPUADDR_2006]: 'PPUADDR_2006',
      [NES_CPU_REGISTER_ADDRS.PPUDATA_2007]: 'PPUDATA_2007'
    }
  },
  {
    type: 'exact',
    family: 'ppu',
    space: 'cpu',
    addr: NES_CPU_REGISTER_ADDRS.OAMDMA_4014,
    name: 'OAMDMA_4014'
  },
  {
    type: 'exact',
    family: 'io',
    space: 'cpu',
    addr: NES_CPU_REGISTER_ADDRS.CONTROLLER_1_4016,
    name: 'CONTROLLER_1_4016',
    appliesTo: 'read'
  },
  {
    type: 'exact',
    family: 'io',
    space: 'cpu',
    addr: NES_CPU_REGISTER_ADDRS.CONTROLLER_STROBE_4016,
    name: 'CONTROLLER_STROBE_4016',
    appliesTo: 'write'
  },
  {
    type: 'exact',
    family: 'io',
    space: 'cpu',
    addr: NES_CPU_REGISTER_ADDRS.CONTROLLER_2_4017,
    name: 'CONTROLLER_2_4017',
    appliesTo: 'read'
  },
  {
    type: 'exact',
    family: 'io',
    space: 'cpu',
    addr: NES_CPU_REGISTER_ADDRS.APU_FRAME_COUNTER_4017,
    name: 'APU_FRAME_COUNTER_4017',
    appliesTo: 'write'
  },
  {
    type: 'range',
    family: 'mapper',
    space: 'cpu',
    mapper: 'MMC1',
    start: 0x8000,
    end: 0x9fff,
    name: NES_MAPPER_REGISTER_NAMES.MMC1_CONTROL,
    appliesTo: 'mapperWrite'
  },
  {
    type: 'range',
    family: 'mapper',
    space: 'cpu',
    mapper: 'MMC1',
    start: 0xa000,
    end: 0xbfff,
    name: NES_MAPPER_REGISTER_NAMES.MMC1_CHR_BANK_0,
    appliesTo: 'mapperWrite'
  },
  {
    type: 'range',
    family: 'mapper',
    space: 'cpu',
    mapper: 'MMC1',
    start: 0xc000,
    end: 0xdfff,
    name: NES_MAPPER_REGISTER_NAMES.MMC1_CHR_BANK_1,
    appliesTo: 'mapperWrite'
  },
  {
    type: 'range',
    family: 'mapper',
    space: 'cpu',
    mapper: 'MMC1',
    start: 0xe000,
    end: 0xffff,
    name: NES_MAPPER_REGISTER_NAMES.MMC1_PRG_BANK,
    appliesTo: 'mapperWrite'
  },
  {
    type: 'range',
    family: 'mapper',
    space: 'cpu',
    mapper: 'MMC3',
    start: 0x8000,
    end: 0x9ffe,
    parity: 'even',
    name: NES_MAPPER_REGISTER_NAMES.MMC3_BANK_SELECT,
    appliesTo: 'mapperWrite'
  },
  {
    type: 'range',
    family: 'mapper',
    space: 'cpu',
    mapper: 'MMC3',
    start: 0x8001,
    end: 0x9fff,
    parity: 'odd',
    name: NES_MAPPER_REGISTER_NAMES.MMC3_BANK_DATA,
    appliesTo: 'mapperWrite'
  },
  {
    type: 'range',
    family: 'mapper',
    space: 'cpu',
    mapper: 'MMC3',
    start: 0xa000,
    end: 0xbffe,
    parity: 'even',
    name: NES_MAPPER_REGISTER_NAMES.MMC3_MIRRORING,
    appliesTo: 'mapperWrite'
  },
  {
    type: 'range',
    family: 'mapper',
    space: 'cpu',
    mapper: 'MMC3',
    start: 0xa001,
    end: 0xbfff,
    parity: 'odd',
    name: NES_MAPPER_REGISTER_NAMES.MMC3_PRG_RAM_PROTECT,
    appliesTo: 'mapperWrite'
  },
  {
    type: 'range',
    family: 'mapper',
    space: 'cpu',
    mapper: 'MMC3',
    start: 0xc000,
    end: 0xdffe,
    parity: 'even',
    name: NES_MAPPER_REGISTER_NAMES.MMC3_IRQ_LATCH,
    appliesTo: 'mapperWrite'
  },
  {
    type: 'range',
    family: 'mapper',
    space: 'cpu',
    mapper: 'MMC3',
    start: 0xc001,
    end: 0xdfff,
    parity: 'odd',
    name: NES_MAPPER_REGISTER_NAMES.MMC3_IRQ_RELOAD,
    appliesTo: 'mapperWrite'
  },
  {
    type: 'range',
    family: 'mapper',
    space: 'cpu',
    mapper: 'MMC3',
    start: 0xe000,
    end: 0xfffe,
    parity: 'even',
    name: NES_MAPPER_REGISTER_NAMES.MMC3_IRQ_DISABLE,
    appliesTo: 'mapperWrite'
  },
  {
    type: 'range',
    family: 'mapper',
    space: 'cpu',
    mapper: 'MMC3',
    start: 0xe001,
    end: 0xffff,
    parity: 'odd',
    name: NES_MAPPER_REGISTER_NAMES.MMC3_IRQ_ENABLE,
    appliesTo: 'mapperWrite'
  }
];

function fmtHex4(value) {
  return `$${(value & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

function normalizeCpuAddr(addr) {
  const n = typeof addr === 'number' ? addr : Number(addr);
  if (!Number.isFinite(n)) return null;
  return n & 0xffff;
}

function normalizeMapperName(mapper) {
  if (typeof mapper !== 'string') return '';
  return mapper.trim().toUpperCase();
}

const REGISTER_READ_MNEMONICS = Object.freeze([
  'ADC', 'AND', 'BIT', 'CMP', 'CPX', 'CPY', 'EOR', 'LDA', 'LDX', 'LDY', 'ORA', 'SBC'
]);
const REGISTER_STORE_MNEMONICS = Object.freeze(['STA', 'STX', 'STY']);
const REGISTER_RMW_MNEMONICS = Object.freeze(['ASL', 'LSR', 'ROL', 'ROR', 'INC', 'DEC']);

function normalizeMnemonic(mnemonic) {
  if (typeof mnemonic !== 'string') return '';
  return mnemonic.trim().toUpperCase();
}

function isAccumulatorOrImpliedMode(mode) {
  return mode === 'acc' || mode === 'imp';
}

function isReadOperandContext(options) {
  const mnemonic = normalizeMnemonic(options?.mnemonic);
  return REGISTER_READ_MNEMONICS.includes(mnemonic) && !isAccumulatorOrImpliedMode(options?.mode);
}

function isWriteOperandContext(options) {
  const mnemonic = normalizeMnemonic(options?.mnemonic);
  if (REGISTER_STORE_MNEMONICS.includes(mnemonic)) return true;
  return REGISTER_RMW_MNEMONICS.includes(mnemonic) && !isAccumulatorOrImpliedMode(options?.mode);
}

function isMapperWriteOperandContext(options) {
  return isWriteOperandContext(options);
}

function requiresOperandAccessContext(def) {
  return def?.appliesTo === 'read' || def?.appliesTo === 'write' || def?.appliesTo === 'mapperWrite';
}

function inRange(addr, def) {
  return addr >= def.start && addr <= def.end;
}

function matchesParity(addr, def) {
  if (def.parity === 'even') return (addr & 1) === 0;
  if (def.parity === 'odd') return (addr & 1) === 1;
  return true;
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
  if (!inRange(addr, def)) return null;
  if (!matchesParity(addr, def)) return null;
  return (def.canonicalAddr ?? def.start) & 0xffff;
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
  if (!options || typeof options !== 'object') {
    return !def.mapper && !requiresOperandAccessContext(def);
  }
  if (options.family && def.family !== options.family) return false;
  if (options.space && def.space !== options.space) return false;
  if (def.mapper && normalizeMapperName(options.mapper) !== normalizeMapperName(def.mapper)) return false;
  if (def.appliesTo === 'read' && !isReadOperandContext(options)) return false;
  if (def.appliesTo === 'write' && !isWriteOperandContext(options)) return false;
  if (def.appliesTo === 'mapperWrite' && !isMapperWriteOperandContext(options)) return false;
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
      rangeStart: typeof def.start === 'number' ? (def.start & 0xffff) : null,
      rangeEnd: typeof def.end === 'number' ? (def.end & 0xffff) : null,
      parity: def.parity || null,
      defType: def.type
    };
  }

  return null;
}

export function getNamedRegisterName(addr, options = null) {
  return getNamedRegister(addr, options)?.name || '';
}

export function formatNamedRegisterTooltip(register) {
  if (!register || typeof register !== 'object') return '';
  const exact = fmtHex4(register.addr);
  if (register.defType === 'range'
    && typeof register.rangeStart === 'number'
    && typeof register.rangeEnd === 'number') {
    const qualifier = register.parity ? `, ${register.parity}` : '';
    return `${exact} (Range: ${fmtHex4(register.rangeStart)}-${fmtHex4(register.rangeEnd)}${qualifier})`;
  }
  if (register.defType === 'mirror'
    && typeof register.canonicalAddr === 'number'
    && register.addr !== register.canonicalAddr) {
    return `${exact} (Mirror: ${fmtHex4(register.canonicalAddr)})`;
  }
  return '';
}

export function getNamedRegisterTooltip(addr, options = null) {
  return formatNamedRegisterTooltip(getNamedRegister(addr, options));
}

export function isNamedRegister(addr, options = null) {
  return !!getNamedRegister(addr, options);
}

export function isPpuDataRegisterAddr(addr) {
  return getNamedRegisterName(addr, { family: 'ppu', space: 'cpu' }) === 'PPUDATA_2007';
}

export function isOamDmaRegisterAddr(addr) {
  return getNamedRegisterName(addr, { family: 'ppu', space: 'cpu' }) === 'OAMDMA_4014';
}
