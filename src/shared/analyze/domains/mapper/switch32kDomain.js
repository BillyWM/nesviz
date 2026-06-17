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

const PRG_CPU_START = 0x8000;
const PRG_CPU_END = 0xffff;
const BANK_SIZE = 0x8000;

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

function normalizeState(value, cfg) {
  if (!value || value.kind === 'top') return { kind: 'state', prg32Bank: topFiniteSet() };
  if (value.kind === 'bottom') return { kind: 'bottom' };
  return {
    kind: 'state',
    prg32Bank: finiteSetFromSerializable(value.prg32Bank, bankSpec(cfg.bankCount, cfg.bankSetCap))
  };
}

function bankStateFromWriteValue(byte, cfg) {
  const values = byteValuesUnderCap(byte, cfg.writeValueCap);
  if (!values) return topFiniteSet();
  return finiteSetOf(values.map((value) => value & cfg.bankMask), bankSpec(cfg.bankCount, cfg.bankSetCap));
}

export function createSwitch32kDomain({ bankCount, bankSetCap = 8, writeValueCap = 16 } = {}) {
  const cfg = {
    bankCount: Math.max(1, bankCount | 0),
    bankSetCap: Math.max(1, bankSetCap | 0),
    writeValueCap: Math.max(1, writeValueCap | 0),
    bankMask: Math.max(1, bankCount | 0) - 1
  };
  const bSpec = bankSpec(cfg.bankCount, cfg.bankSetCap);

  return {
    id: 'switch32kDomain',
    domainKind: 'mapper',
    bottom() { return { kind: 'bottom' }; },
    top() { return { kind: 'state', prg32Bank: topFiniteSet() }; },
    initialForContext(mapperContext) {
      const bank = Number.isInteger(mapperContext?.bankIndex) ? mapperContext.bankIndex : 0;
      return { kind: 'state', prg32Bank: finiteSetOf([bank], bSpec) };
    },
    clone(value) { return normalizeState(value, cfg); },
    leq(a, b) {
      const left = normalizeState(a, cfg);
      const right = normalizeState(b, cfg);
      if (left.kind === 'bottom') return true;
      if (right.kind === 'bottom') return left.kind === 'bottom';
      return finiteSetSubsetOf(left.prg32Bank, right.prg32Bank, bSpec);
    },
    join(a, b) {
      const left = normalizeState(a, cfg);
      const right = normalizeState(b, cfg);
      if (left.kind === 'bottom') return right;
      if (right.kind === 'bottom') return left;
      return { kind: 'state', prg32Bank: joinFiniteSets(left.prg32Bank, right.prg32Bank, bSpec) };
    },
    widen(a, b) {
      const left = normalizeState(a, cfg);
      const right = normalizeState(b, cfg);
      if (left.kind === 'bottom') return right;
      if (right.kind === 'bottom') return left;
      return { kind: 'state', prg32Bank: widenFiniteSets(left.prg32Bank, right.prg32Bank, bSpec) };
    },
    equals(a, b) {
      const left = normalizeState(a, cfg);
      const right = normalizeState(b, cfg);
      if (left.kind !== right.kind) return false;
      if (left.kind === 'bottom') return true;
      return finiteSetEquals(left.prg32Bank, right.prg32Bank, bSpec);
    },
    key(value) {
      const normalized = normalizeState(value, cfg);
      if (normalized.kind === 'bottom') return '⊥';
      return `prg32=${finiteSetKey(normalized.prg32Bank, bSpec)}`;
    },
    toSerializable(value) {
      const normalized = normalizeState(value, cfg);
      if (normalized.kind === 'bottom') return { kind: 'bottom' };
      return { kind: 'state', prg32Bank: finiteSetToSerializable(normalized.prg32Bank, bSpec) };
    },
    fromSerializable(value) { return normalizeState(value, cfg); },
    transferWrite(value, write) {
      const state = normalizeState(value, cfg);
      if (state.kind === 'bottom') return state;
      const addr = write?.cpuAddr & 0xffff;
      if (addr < PRG_CPU_START || addr > PRG_CPU_END) return state;
      return { kind: 'state', prg32Bank: bankStateFromWriteValue(write.value, cfg) };
    },
    resolveCpuAddress(value, cpuAddr) {
      const state = normalizeState(value, cfg);
      const addr = cpuAddr & 0xffff;
      if (addr < PRG_CPU_START || addr > PRG_CPU_END) return { kind: 'unmapped', cpuAddr: addr, reason: 'cpuAddressOutsidePrgRom' };
      if (state.kind === 'bottom') return { kind: 'bottom', cpuAddr: addr };
      const banks = finiteSetValues(state.prg32Bank, bSpec);
      if (!banks) return { kind: 'unknown', cpuAddr: addr, reason: 'prg32BankUnknown' };
      const romOffs = banks.map((bank) => (bank * BANK_SIZE + (addr - PRG_CPU_START)) >>> 0);
      if (romOffs.length === 1) return { kind: 'exact', cpuAddr: addr, romOff: romOffs[0] };
      return { kind: 'set', cpuAddr: addr, romOffs };
    }
  };
}
