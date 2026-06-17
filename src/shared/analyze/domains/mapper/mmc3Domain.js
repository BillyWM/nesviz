import {
  finiteSetEquals,
  finiteSetFromSerializable,
  finiteSetKey,
  finiteSetOf,
  finiteSetSubsetOf,
  finiteSetToSerializable,
  finiteSetValues,
  joinFiniteSets,
  topFiniteSet,
  widenFiniteSets
} from './finiteSetDomain.js';
import { byteValuesUnderCap } from './byteValues.js';

export const MMC3_PRG_MODES = Object.freeze({
  NORMAL: 'normal',
  SWAPPED: 'swapped'
});

export const MMC3_BANK_SELECTS = Object.freeze({
  R6: 'r6',
  R7: 'r7',
  OTHER: 'other'
});

const ALL_PRG_MODES = Object.freeze([MMC3_PRG_MODES.NORMAL, MMC3_PRG_MODES.SWAPPED]);
const ALL_SELECTS = Object.freeze([MMC3_BANK_SELECTS.R6, MMC3_BANK_SELECTS.R7, MMC3_BANK_SELECTS.OTHER]);
const BANK_SIZE_8K = 0x2000;

function enumSpec(values, cap = values.length) {
  const allowed = new Set(values);
  return {
    cap,
    normalize(value) {
      return allowed.has(value) ? value : null;
    },
    compare(a, b) {
      return values.indexOf(a) - values.indexOf(b);
    }
  };
}

function bankSpec(bankCount, cap) {
  return {
    cap,
    normalize(value) {
      const n = Number(value);
      if (!Number.isInteger(n)) return null;
      if (bankCount <= 0) return null;
      return ((n % bankCount) + bankCount) % bankCount;
    }
  };
}

function prgModeFromBankSelectValue(value) {
  return (value & 0x40) ? MMC3_PRG_MODES.SWAPPED : MMC3_PRG_MODES.NORMAL;
}

function selectClassFromBankSelectValue(value) {
  const reg = value & 0x07;
  if (reg === 6) return MMC3_BANK_SELECTS.R6;
  if (reg === 7) return MMC3_BANK_SELECTS.R7;
  return MMC3_BANK_SELECTS.OTHER;
}

function normalizeState(value, cfg) {
  if (!value || value.kind === 'top') {
    return {
      kind: 'state',
      prgMode: topFiniteSet(),
      bankSelect: topFiniteSet(),
      r6: topFiniteSet(),
      r7: topFiniteSet()
    };
  }
  if (value.kind === 'bottom') return { kind: 'bottom' };
  return {
    kind: 'state',
    prgMode: finiteSetFromSerializable(value.prgMode, cfg.modeSpec),
    bankSelect: finiteSetFromSerializable(value.bankSelect, cfg.selectSpec),
    r6: finiteSetFromSerializable(value.r6, cfg.bankSpec),
    r7: finiteSetFromSerializable(value.r7, cfg.bankSpec)
  };
}

function joinStateFields(left, right, cfg, joiner) {
  if (left.kind === 'bottom') return right;
  if (right.kind === 'bottom') return left;
  return {
    kind: 'state',
    prgMode: joiner(left.prgMode, right.prgMode, cfg.modeSpec),
    bankSelect: joiner(left.bankSelect, right.bankSelect, cfg.selectSpec),
    r6: joiner(left.r6, right.r6, cfg.bankSpec),
    r7: joiner(left.r7, right.r7, cfg.bankSpec)
  };
}

function setFromWriteValues(byte, mapper, setSpec, cfg) {
  const values = byteValuesUnderCap(byte, cfg.writeValueCap);
  if (!values) return topFiniteSet();
  return finiteSetOf(values.map(mapper), setSpec);
}

function bankSetFromWriteValue(byte, cfg) {
  const values = byteValuesUnderCap(byte, cfg.writeValueCap);
  if (!values) return topFiniteSet();
  return finiteSetOf(values, cfg.bankSpec);
}

function slotForCpuAddr(cpuAddr) {
  const addr = cpuAddr & 0xffff;
  if (addr >= 0x8000 && addr <= 0x9fff) return 'slot8000';
  if (addr >= 0xa000 && addr <= 0xbfff) return 'slotA000';
  if (addr >= 0xc000 && addr <= 0xdfff) return 'slotC000';
  if (addr >= 0xe000 && addr <= 0xffff) return 'slotE000';
  return null;
}

function bankToRomOff(cpuAddr, bank) {
  const addr = cpuAddr & 0xffff;
  const base = addr >= 0xe000 ? 0xe000 : (addr >= 0xc000 ? 0xc000 : (addr >= 0xa000 ? 0xa000 : 0x8000));
  return ((bank >>> 0) * BANK_SIZE_8K + (addr - base)) >>> 0;
}

export function createMmc3Domain({ bankCount, bankSetCap = 8, writeValueCap = 16 } = {}) {
  const cfg = {
    bankCount: Math.max(1, bankCount | 0),
    bankSetCap: Math.max(1, bankSetCap | 0),
    writeValueCap: Math.max(1, writeValueCap | 0)
  };
  cfg.fixedLastBank = Math.max(0, cfg.bankCount - 1);
  cfg.fixedSecondLastBank = Math.max(0, cfg.bankCount - 2);
  cfg.modeSpec = enumSpec(ALL_PRG_MODES, ALL_PRG_MODES.length);
  cfg.selectSpec = enumSpec(ALL_SELECTS, ALL_SELECTS.length);
  cfg.bankSpec = bankSpec(cfg.bankCount, cfg.bankSetCap);

  return {
    id: 'mmc3Domain',
    domainKind: 'mapper',
    bottom() { return { kind: 'bottom' }; },
    top() {
      return {
        kind: 'state',
        prgMode: topFiniteSet(),
        bankSelect: topFiniteSet(),
        r6: topFiniteSet(),
        r7: topFiniteSet()
      };
    },
    initialForContext(mapperContext) {
      if (mapperContext?.domainState) return normalizeState(mapperContext.domainState, cfg);
      return this.top();
    },
    clone(value) { return normalizeState(value, cfg); },
    leq(a, b) {
      const left = normalizeState(a, cfg);
      const right = normalizeState(b, cfg);
      if (left.kind === 'bottom') return true;
      if (right.kind === 'bottom') return left.kind === 'bottom';
      return finiteSetSubsetOf(left.prgMode, right.prgMode, cfg.modeSpec)
        && finiteSetSubsetOf(left.bankSelect, right.bankSelect, cfg.selectSpec)
        && finiteSetSubsetOf(left.r6, right.r6, cfg.bankSpec)
        && finiteSetSubsetOf(left.r7, right.r7, cfg.bankSpec);
    },
    join(a, b) {
      return joinStateFields(normalizeState(a, cfg), normalizeState(b, cfg), cfg, joinFiniteSets);
    },
    widen(a, b) {
      return joinStateFields(normalizeState(a, cfg), normalizeState(b, cfg), cfg, widenFiniteSets);
    },
    equals(a, b) {
      const left = normalizeState(a, cfg);
      const right = normalizeState(b, cfg);
      if (left.kind !== right.kind) return false;
      if (left.kind === 'bottom') return true;
      return finiteSetEquals(left.prgMode, right.prgMode, cfg.modeSpec)
        && finiteSetEquals(left.bankSelect, right.bankSelect, cfg.selectSpec)
        && finiteSetEquals(left.r6, right.r6, cfg.bankSpec)
        && finiteSetEquals(left.r7, right.r7, cfg.bankSpec);
    },
    key(value) {
      const normalized = normalizeState(value, cfg);
      if (normalized.kind === 'bottom') return '⊥';
      return `mode=${finiteSetKey(normalized.prgMode, cfg.modeSpec)};sel=${finiteSetKey(normalized.bankSelect, cfg.selectSpec)};r6=${finiteSetKey(normalized.r6, cfg.bankSpec)};r7=${finiteSetKey(normalized.r7, cfg.bankSpec)}`;
    },
    toSerializable(value) {
      const normalized = normalizeState(value, cfg);
      if (normalized.kind === 'bottom') return { kind: 'bottom' };
      return {
        kind: 'state',
        prgMode: finiteSetToSerializable(normalized.prgMode, cfg.modeSpec),
        bankSelect: finiteSetToSerializable(normalized.bankSelect, cfg.selectSpec),
        r6: finiteSetToSerializable(normalized.r6, cfg.bankSpec),
        r7: finiteSetToSerializable(normalized.r7, cfg.bankSpec)
      };
    },
    fromSerializable(value) { return normalizeState(value, cfg); },
    transferWrite(value, write) {
      const state = normalizeState(value, cfg);
      if (state.kind === 'bottom') return state;
      const addr = write?.cpuAddr & 0xffff;
      if (addr < 0x8000 || addr > 0x9fff) return state;
      if ((addr & 1) === 0) {
        return {
          ...state,
          prgMode: setFromWriteValues(write.value, prgModeFromBankSelectValue, cfg.modeSpec, cfg),
          bankSelect: setFromWriteValues(write.value, selectClassFromBankSelectValue, cfg.selectSpec, cfg)
        };
      }

      const bankSet = bankSetFromWriteValue(write.value, cfg);
      const selects = finiteSetValues(state.bankSelect, cfg.selectSpec);
      if (!selects) {
        return {
          ...state,
          r6: topFiniteSet(),
          r7: topFiniteSet()
        };
      }

      let out = { kind: 'bottom' };
      for (const select of selects) {
        if (select === MMC3_BANK_SELECTS.R6) out = joinStateFields(out, { ...state, r6: bankSet }, cfg, joinFiniteSets);
        else if (select === MMC3_BANK_SELECTS.R7) out = joinStateFields(out, { ...state, r7: bankSet }, cfg, joinFiniteSets);
        else out = joinStateFields(out, state, cfg, joinFiniteSets);
      }
      return out;
    },
    resolveCpuAddress(value, cpuAddr) {
      const state = normalizeState(value, cfg);
      const addr = cpuAddr & 0xffff;
      const slot = slotForCpuAddr(addr);
      if (!slot) return { kind: 'unmapped', cpuAddr: addr, reason: 'cpuAddressOutsidePrgRom' };
      if (state.kind === 'bottom') return { kind: 'bottom', cpuAddr: addr };
      if (slot === 'slotE000') return { kind: 'exact', cpuAddr: addr, romOff: bankToRomOff(addr, cfg.fixedLastBank) };
      const modes = finiteSetValues(state.prgMode, cfg.modeSpec);
      if (slot === 'slotA000') {
        const r7Banks = finiteSetValues(state.r7, cfg.bankSpec);
        if (!r7Banks) return { kind: 'unknown', cpuAddr: addr, reason: 'mmc3R7Unknown' };
        const romOffs = Array.from(new Set(r7Banks.map((bank) => bankToRomOff(addr, bank)))).sort((a, b) => a - b);
        if (romOffs.length === 1) return { kind: 'exact', cpuAddr: addr, romOff: romOffs[0] };
        return { kind: 'set', cpuAddr: addr, romOffs };
      }
      if (!modes) return { kind: 'unknown', cpuAddr: addr, reason: 'mmc3PrgModeUnknown' };
      const r6Banks = finiteSetValues(state.r6, cfg.bankSpec);
      const romOffs = [];
      for (const mode of modes) {
        if (slot === 'slot8000') {
          if (mode === MMC3_PRG_MODES.NORMAL) {
            if (!r6Banks) return { kind: 'unknown', cpuAddr: addr, reason: 'mmc3R6Unknown' };
            for (const bank of r6Banks) romOffs.push(bankToRomOff(addr, bank));
          } else {
            romOffs.push(bankToRomOff(addr, cfg.fixedSecondLastBank));
          }
        } else if (slot === 'slotC000') {
          if (mode === MMC3_PRG_MODES.NORMAL) {
            romOffs.push(bankToRomOff(addr, cfg.fixedSecondLastBank));
          } else {
            if (!r6Banks) return { kind: 'unknown', cpuAddr: addr, reason: 'mmc3R6Unknown' };
            for (const bank of r6Banks) romOffs.push(bankToRomOff(addr, bank));
          }
        }
      }
      const deduped = Array.from(new Set(romOffs)).sort((a, b) => a - b);
      if (deduped.length === 1) return { kind: 'exact', cpuAddr: addr, romOff: deduped[0] };
      return { kind: 'set', cpuAddr: addr, romOffs: deduped };
    }
  };
}
