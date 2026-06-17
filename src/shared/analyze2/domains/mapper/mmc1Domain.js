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
import { byteBitValues } from './byteValues.js';

export const MMC1_PRG_MODES = Object.freeze({
  SWITCH_32K: 'switch32k',
  FIXED_FIRST: 'fixedFirst',
  FIXED_LAST: 'fixedLast'
});

const ALL_MODES = Object.freeze([
  MMC1_PRG_MODES.SWITCH_32K,
  MMC1_PRG_MODES.FIXED_FIRST,
  MMC1_PRG_MODES.FIXED_LAST
]);
const BANK_SIZE_16K = 0x4000;

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

function latchKey(pair) {
  return `${pair.count}:${pair.bits}`;
}

function normalizeLatchPair(pair) {
  const count = Number(pair?.count);
  const bits = Number(pair?.bits);
  if (!Number.isInteger(count) || count < 0 || count > 4) return null;
  if (!Number.isInteger(bits)) return null;
  const mask = count === 0 ? 0 : ((1 << count) - 1);
  return { count, bits: bits & mask };
}

function latchSpec(cap) {
  return {
    cap,
    normalize: normalizeLatchPair,
    keyForValue: latchKey,
    compare(a, b) {
      return (a.count - b.count) || (a.bits - b.bits);
    }
  };
}

function modeFromControlValue(value) {
  const bits = (value >>> 2) & 0x03;
  if (bits === 0 || bits === 1) return MMC1_PRG_MODES.SWITCH_32K;
  if (bits === 2) return MMC1_PRG_MODES.FIXED_FIRST;
  return MMC1_PRG_MODES.FIXED_LAST;
}

function normalizeState(value, cfg) {
  if (!value || value.kind === 'top') {
    return {
      kind: 'state',
      prgMode: topFiniteSet(),
      prgBank: topFiniteSet(),
      latch: topFiniteSet()
    };
  }
  if (value.kind === 'bottom') return { kind: 'bottom' };
  return {
    kind: 'state',
    prgMode: finiteSetFromSerializable(value.prgMode, cfg.modeSpec),
    prgBank: finiteSetFromSerializable(value.prgBank, cfg.bankSpec),
    latch: finiteSetFromSerializable(value.latch, cfg.latchSpec)
  };
}

function joinStateFields(left, right, cfg, joiner) {
  if (left.kind === 'bottom') return right;
  if (right.kind === 'bottom') return left;
  return {
    kind: 'state',
    prgMode: joiner(left.prgMode, right.prgMode, cfg.modeSpec),
    prgBank: joiner(left.prgBank, right.prgBank, cfg.bankSpec),
    latch: joiner(left.latch, right.latch, cfg.latchSpec)
  };
}

function rawBankFromCommitValue(value, cfg) {
  return cfg.bankSpec.normalize(value & 0x0f);
}

function lowerBankForMode(mode, rawBank, cfg) {
  if (mode === MMC1_PRG_MODES.FIXED_FIRST) return 0;
  if (mode === MMC1_PRG_MODES.FIXED_LAST) return cfg.bankSpec.normalize(rawBank);
  if (mode === MMC1_PRG_MODES.SWITCH_32K) return cfg.bankSpec.normalize(rawBank & ~1);
  return null;
}

function upperBankForMode(mode, rawBank, cfg) {
  if (mode === MMC1_PRG_MODES.FIXED_FIRST) return cfg.bankSpec.normalize(rawBank);
  if (mode === MMC1_PRG_MODES.FIXED_LAST) return cfg.fixedLastBank;
  if (mode === MMC1_PRG_MODES.SWITCH_32K) return cfg.bankSpec.normalize((rawBank & ~1) + 1);
  return null;
}

function commitRegister(state, addr, commitValue, cfg) {
  const out = normalizeState(state, cfg);
  if (out.kind === 'bottom') return out;
  const a = addr & 0xffff;
  if (a >= 0x8000 && a <= 0x9fff) {
    return {
      ...out,
      prgMode: finiteSetOf([modeFromControlValue(commitValue)], cfg.modeSpec)
    };
  }
  if (a >= 0xe000 && a <= 0xffff) {
    return {
      ...out,
      prgBank: finiteSetOf([rawBankFromCommitValue(commitValue, cfg)], cfg.bankSpec)
    };
  }
  return out;
}

function resetState(state, cfg) {
  const out = normalizeState(state, cfg);
  if (out.kind === 'bottom') return out;
  return {
    ...out,
    prgMode: finiteSetOf([MMC1_PRG_MODES.FIXED_LAST], cfg.modeSpec),
    latch: finiteSetOf([{ count: 0, bits: 0 }], cfg.latchSpec)
  };
}

function impreciseSerialWriteState(state, addr, cfg) {
  const input = normalizeState(state, cfg);
  if (input.kind === 'bottom') return input;

  const a = addr & 0xffff;
  const out = {
    ...input,
    latch: topFiniteSet()
  };

  if (a >= 0x8000 && a <= 0x9fff) {
    return {
      ...out,
      prgMode: topFiniteSet()
    };
  }

  if (a >= 0xe000 && a <= 0xffff) {
    return {
      ...out,
      prgBank: topFiniteSet()
    };
  }

  return out;
}

function serialWriteState(state, addr, bit, cfg) {
  const input = normalizeState(state, cfg);
  if (input.kind === 'bottom') return input;
  const latchValues = finiteSetValues(input.latch, cfg.latchSpec);
  if (!latchValues) return impreciseSerialWriteState(input, addr, cfg);

  let out = { ...input, latch: finiteSetOf([], cfg.latchSpec) };
  for (const pair of latchValues) {
    if (pair.count < 4) {
      const nextLatch = finiteSetOf([{ count: pair.count + 1, bits: pair.bits | ((bit & 1) << pair.count) }], cfg.latchSpec);
      out = joinStateFields(out, { ...input, latch: nextLatch }, cfg, joinFiniteSets);
    } else {
      const commitValue = pair.bits | ((bit & 1) << 4);
      const committed = commitRegister(input, addr, commitValue, cfg);
      out = joinStateFields(out, { ...committed, latch: finiteSetOf([{ count: 0, bits: 0 }], cfg.latchSpec) }, cfg, joinFiniteSets);
    }
  }
  return out;
}

export function createMmc1Domain({ bankCount, bankSetCap = 8, latchSetCap = 16, writeValueCap = 16 } = {}) {
  const cfg = {
    bankCount: Math.max(1, bankCount | 0),
    bankSetCap: Math.max(1, bankSetCap | 0),
    latchSetCap: Math.max(1, latchSetCap | 0),
    writeValueCap: Math.max(1, writeValueCap | 0),
    fixedLastBank: Math.max(0, (Math.max(1, bankCount | 0)) - 1)
  };
  cfg.modeSpec = enumSpec(ALL_MODES, ALL_MODES.length);
  cfg.bankSpec = bankSpec(cfg.bankCount, cfg.bankSetCap);
  cfg.latchSpec = latchSpec(cfg.latchSetCap);

  return {
    id: 'mmc1Domain',
    domainKind: 'mapper',
    bottom() { return { kind: 'bottom' }; },
    top() {
      return {
        kind: 'state',
        prgMode: topFiniteSet(),
        prgBank: topFiniteSet(),
        latch: topFiniteSet()
      };
    },
    initialForContext(mapperContext) {
      if (mapperContext?.domainState) return normalizeState(mapperContext.domainState, cfg);
      return {
        kind: 'state',
        prgMode: finiteSetOf([MMC1_PRG_MODES.FIXED_LAST], cfg.modeSpec),
        prgBank: cfg.bankCount <= 1 ? finiteSetOf([0], cfg.bankSpec) : topFiniteSet(),
        latch: finiteSetOf([{ count: 0, bits: 0 }], cfg.latchSpec)
      };
    },
    clone(value) { return normalizeState(value, cfg); },
    leq(a, b) {
      const left = normalizeState(a, cfg);
      const right = normalizeState(b, cfg);
      if (left.kind === 'bottom') return true;
      if (right.kind === 'bottom') return left.kind === 'bottom';
      return finiteSetSubsetOf(left.prgMode, right.prgMode, cfg.modeSpec)
        && finiteSetSubsetOf(left.prgBank, right.prgBank, cfg.bankSpec)
        && finiteSetSubsetOf(left.latch, right.latch, cfg.latchSpec);
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
        && finiteSetEquals(left.prgBank, right.prgBank, cfg.bankSpec)
        && finiteSetEquals(left.latch, right.latch, cfg.latchSpec);
    },
    key(value) {
      const normalized = normalizeState(value, cfg);
      if (normalized.kind === 'bottom') return '⊥';
      return `mode=${finiteSetKey(normalized.prgMode, cfg.modeSpec)};prg=${finiteSetKey(normalized.prgBank, cfg.bankSpec)};latch=${finiteSetKey(normalized.latch, cfg.latchSpec)}`;
    },
    toSerializable(value) {
      const normalized = normalizeState(value, cfg);
      if (normalized.kind === 'bottom') return { kind: 'bottom' };
      return {
        kind: 'state',
        prgMode: finiteSetToSerializable(normalized.prgMode, cfg.modeSpec),
        prgBank: finiteSetToSerializable(normalized.prgBank, cfg.bankSpec),
        latch: finiteSetToSerializable(normalized.latch, cfg.latchSpec)
      };
    },
    fromSerializable(value) { return normalizeState(value, cfg); },
    transferWrite(value, write) {
      const state = normalizeState(value, cfg);
      if (state.kind === 'bottom') return state;
      const addr = write?.cpuAddr & 0xffff;
      if (addr < 0x8000 || addr > 0xffff) return state;

      const resetBits = byteBitValues(write.value, 7);
      const serialBits = byteBitValues(write.value, 0);
      if (!resetBits.length || !serialBits.length) return { kind: 'bottom' };

      let out = { kind: 'bottom' };
      if (resetBits.includes(1)) {
        out = joinStateFields(out, resetState(state, cfg), cfg, joinFiniteSets);
      }
      if (resetBits.includes(0)) {
        for (const bit of serialBits) {
          out = joinStateFields(out, serialWriteState(state, addr, bit, cfg), cfg, joinFiniteSets);
        }
      }
      return out;
    },
    resolveCpuAddress(value, cpuAddr) {
      const state = normalizeState(value, cfg);
      const addr = cpuAddr & 0xffff;
      if (addr < 0x8000 || addr > 0xffff) return { kind: 'unmapped', cpuAddr: addr, reason: 'cpuAddressOutsidePrgRom' };
      if (state.kind === 'bottom') return { kind: 'bottom', cpuAddr: addr };
      const modes = finiteSetValues(state.prgMode, cfg.modeSpec);
      const banks = finiteSetValues(state.prgBank, cfg.bankSpec);
      if (!modes) return { kind: 'unknown', cpuAddr: addr, reason: 'mmc1PrgModeUnknown' };
      if (!banks) {
        const onlyFixedUpper = addr >= 0xc000 && modes.every((mode) => mode === MMC1_PRG_MODES.FIXED_LAST);
        if (onlyFixedUpper) {
          const romOff = (cfg.fixedLastBank * BANK_SIZE_16K + (addr - 0xc000)) >>> 0;
          return { kind: 'exact', cpuAddr: addr, romOff };
        }
        const onlyFixedLower = addr < 0xc000 && modes.every((mode) => mode === MMC1_PRG_MODES.FIXED_FIRST);
        if (onlyFixedLower) return { kind: 'exact', cpuAddr: addr, romOff: (addr - 0x8000) >>> 0 };
        return { kind: 'unknown', cpuAddr: addr, reason: 'mmc1PrgBankUnknown' };
      }
      const romOffs = [];
      for (const mode of modes) {
        for (const rawBank of banks) {
          const bank = addr < 0xc000 ? lowerBankForMode(mode, rawBank, cfg) : upperBankForMode(mode, rawBank, cfg);
          if (bank === null) return { kind: 'unknown', cpuAddr: addr, reason: 'mmc1BankResolutionUnknown' };
          const base = addr < 0xc000 ? 0x8000 : 0xc000;
          romOffs.push((bank * BANK_SIZE_16K + (addr - base)) >>> 0);
        }
      }
      const deduped = Array.from(new Set(romOffs)).sort((a, b) => a - b);
      if (deduped.length === 1) return { kind: 'exact', cpuAddr: addr, romOff: deduped[0] };
      return { kind: 'set', cpuAddr: addr, romOffs: deduped };
    }
  };
}
