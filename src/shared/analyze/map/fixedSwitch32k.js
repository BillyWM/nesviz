import {
  backingSet,
  exactBacking,
  fetchCtxKey as baseFetchCtxKey,
  getFetchCtxSlot,
  makeSlotFetchCtx,
  setFetchCtxSlot,
  unknownBacking
} from '../fetchContext.js';
import {
  exactBankState,
  expandBankState,
  isExactBankState,
  mapValueStateToBankState,
  unknownBankState
} from './bankState.js';

export function createFixedSwitch32kMapper({ prgBytes, mapperMeta = null, mapperNumber = 7 }) {
  const prgSize = prgBytes?.length | 0;
  const bankSize = 32 * 1024;
  const bankCount = Math.max(1, (prgSize / bankSize) | 0);
  const mapperFamily = mapperMeta?.mapperFamily || (mapperNumber === 7 ? 'AxROM' : mapperNumber === 34 ? 'BNROM' : mapperNumber === 66 ? 'GxROM' : '32KSwitch');
  const initialCtx = makeSlotFetchCtx({ mapperFamily, prgSlots: { prg32k: unknownBankState() } });
  const busConflicts = mapperMeta?.busConflicts || 'unknown';

  function fetchCtxKey(ctx) {
    return baseFetchCtxKey(ctx || initialCtx);
  }

  function initialFetchCtx() {
    return initialCtx;
  }

  function ctxForBank(bank) {
    return setFetchCtxSlot(initialCtx, 'prg32k', exactBankState(bank));
  }

  function slotForCpuAddr(cpuAddr) {
    const a = cpuAddr & 0xffff;
    return (a >= 0x8000 && a <= 0xffff) ? 'prg32k' : null;
  }

  function bankValueFromWrite(value) {
    const v = value & 0xff;
    if (mapperNumber === 7) return v & 0x07;
    if (mapperNumber === 66) return (v >> 4) & 0x03;
    return v;
  }

  function cpuToRomOffForExactBank(cpuAddr, bankIndex) {
    const a = cpuAddr & 0xffff;
    if (a < 0x8000 || a > 0xffff) return null;
    const bank = ((bankIndex % bankCount) + bankCount) % bankCount;
    return (bank * bankSize) + (a - 0x8000);
  }

  function cpuToRomOffInCtx(ctx, cpuAddr) {
    const a = cpuAddr & 0xffff;
    if (a < 0x8000 || a > 0xffff) return null;
    const bankState = getFetchCtxSlot(ctx || initialCtx, 'prg32k');
    if (!isExactBankState(bankState)) return null;
    return cpuToRomOffForExactBank(a, bankState.bank);
  }

  function resolveCodeFetch(ctx, cpuAddr) {
    const activeCtx = ctx || initialCtx;
    const ctxKey = fetchCtxKey(activeCtx);
    const a = cpuAddr & 0xffff;
    if (a < 0x8000 || a > 0xffff) return { ok: false, ctxKey, backing: unknownBacking() };
    const bankState = getFetchCtxSlot(activeCtx, 'prg32k');
    if (isExactBankState(bankState)) {
      return { ok: true, ctxKey, backing: exactBacking(cpuToRomOffForExactBank(a, bankState.bank)) };
    }
    const expanded = expandBankState(bankState, { maxForks: Math.max(1, bankCount) });
    if (!expanded.exactBanks || !expanded.exactBanks.length) return { ok: false, ctxKey, backing: unknownBacking() };
    return { ok: true, ctxKey, backing: backingSet(expanded.exactBanks.map((bank) => cpuToRomOffForExactBank(a, bank))) };
  }

  function seedSitesForRomOff(romOff) {
    const off = romOff | 0;
    if (off < 0 || off >= prgSize) return [];
    const bank = (off / bankSize) | 0;
    const within = off % bankSize;
    return [{ cpuAddr: (0x8000 + within) & 0xffff, fetchCtx: ctxForBank(bank) }];
  }

  function romOffToCpuAddrs(romOff) {
    return seedSitesForRomOff(romOff).map((s) => s.cpuAddr & 0xffff);
  }

  function targetSitesForCpuAddr(ctx, cpuAddr, { maxForks = 4 } = {}) {
    const a = cpuAddr & 0xffff;
    if (a < 0x8000 || a > 0xffff) return { sites: [], ambiguous: false };
    const state = getFetchCtxSlot(ctx || initialCtx, 'prg32k');
    const expanded = expandBankState(state, { maxForks });
    if (!expanded.exactBanks || !expanded.exactBanks.length) return { sites: [], ambiguous: true };
    const sites = expanded.exactBanks.map((bank) => ({ cpuAddr: a, fetchCtx: ctxForBank(bank) }));
    return { sites, ambiguous: !!expanded.truncated };
  }

  function isMapperWriteCpuAddr(cpuAddr) {
    const a = cpuAddr & 0xffff;
    return a >= 0x8000 && a <= 0xffff;
  }

  function applyBusConflictsToValueState(valueState, ctx, cpuAddr) {
    if (busConflicts !== 'and') return valueState;
    const resolved = resolveCodeFetch(ctx, cpuAddr & 0xffff);
    if (resolved?.backing?.kind !== 'exact') return { kind: 'unknown' };
    const romValue = prgBytes[resolved.backing.romOff] & 0xff;
    if (!valueState || valueState.kind === 'unknown') return { kind: 'unknown' };
    if (valueState.kind === 'exact') return { kind: 'exact', value: valueState.value & romValue };
    if (valueState.kind === 'set') {
      const values = Array.from(new Set((valueState.values || []).map((v) => ((v & 0xff) & romValue)).sort((a, b) => a - b)));
      return values.length === 1 ? { kind: 'exact', value: values[0] } : { kind: 'set', values };
    }
    return { kind: 'unknown' };
  }

  function applyMapperWrite({ ctx, cpuAddr, valueState }) {
    const activeCtx = ctx || initialCtx;
    const effValueState = applyBusConflictsToValueState(valueState, activeCtx, cpuAddr);
    const bankState = mapValueStateToBankState(effValueState, { bankCount, mask: null, maxSetSize: Math.min(8, Math.max(1, bankCount)) });
    return setFetchCtxSlot(activeCtx, 'prg32k', bankState);
  }

  function probableScanBoundaries() {
    const out = [];
    for (let off = 0; off <= prgSize; off += bankSize) out.push(off);
    if (out.length === 0 || out[out.length - 1] !== prgSize) out.push(prgSize);
    return out;
  }

  function getProbableInterruptRoots({ prgBytes }) {
    const roots = [];
    for (let bank = 0; bank < bankCount; bank++) {
      const base = bank * bankSize;
      const ctx = ctxForBank(bank);
      const nmi = (prgBytes[base + 0x7ffa] | (prgBytes[base + 0x7ffb] << 8)) & 0xffff;
      const irqBrk = (prgBytes[base + 0x7ffe] | (prgBytes[base + 0x7fff] << 8)) & 0xffff;
      if (nmi >= 0x8000) roots.push({ cpuAddr: nmi, fetchCtx: ctx });
      if (irqBrk >= 0x8000) roots.push({ cpuAddr: irqBrk, fetchCtx: ctx });
    }
    return roots;
  }

  return {
    id: 'fixed-switch-32k',
    mapperFamily,
    bankCount,
    bankSize,
    initialFetchCtx,
    fetchCtxKey,
    ctxForBank,
    slotForCpuAddr,
    cpuToRomOffInCtx,
    resolveCodeFetch,
    seedSitesForRomOff,
    romOffToCpuAddrs,
    targetSitesForCpuAddr,
    isMapperWriteCpuAddr,
    applyMapperWrite,
    bankValueFromWrite,
    probableScanBoundaries,
    getProbableInterruptRoots
  };
}
