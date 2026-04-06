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
  bankSetState,
  exactBankState,
  expandBankState,
  isExactBankState,
  mapValueStateToBankState,
  unknownBankState
} from './bankState.js';

export function createFixedSwitch16kMapper({ prgBytes, mapperMeta = null, mapperNumber = 2 }) {
  const prgSize = prgBytes?.length | 0;
  const bankSize = 16 * 1024;
  const bankCount = Math.max(1, (prgSize / bankSize) | 0);
  const fixedBank = Math.max(0, bankCount - 1);
  const mapperFamily = mapperNumber === 94 ? 'UN1ROM' : 'UxROM';
  const initialCtx = makeSlotFetchCtx({
    mapperFamily,
    prgSlots: {
      switch16k: unknownBankState()
    }
  });
  const busConflicts = mapperMeta?.busConflicts || 'unknown';
  const valueMask = mapperNumber === 94 ? 0x07 : null;

  function fetchCtxKey(ctx) {
    return baseFetchCtxKey(ctx || initialCtx);
  }

  function initialFetchCtx() {
    return initialCtx;
  }

  function slotForCpuAddr(cpuAddr) {
    const a = cpuAddr & 0xffff;
    if (a >= 0x8000 && a <= 0xbfff) return 'switch16k';
    if (a >= 0xc000 && a <= 0xffff) return 'fixed16k';
    return null;
  }

  function bankValueFromWrite(value) {
    const v = value & 0xff;
    if (mapperNumber === 94) return (v >> 2) & 0x07;
    return v;
  }

  function cpuToRomOffForExactBank(cpuAddr, bankIndex) {
    const a = cpuAddr & 0xffff;
    if (a >= 0x8000 && a <= 0xbfff) {
      const bank = ((bankIndex % bankCount) + bankCount) % bankCount;
      return (bank * bankSize) + (a - 0x8000);
    }
    if (a >= 0xc000 && a <= 0xffff) {
      return (fixedBank * bankSize) + (a - 0xc000);
    }
    return null;
  }

  function cpuToRomOffInCtx(ctx, cpuAddr) {
    const a = cpuAddr & 0xffff;
    if (a >= 0xc000 && a <= 0xffff) return cpuToRomOffForExactBank(a, fixedBank);
    if (a < 0x8000 || a > 0xbfff) return null;
    const bankState = getFetchCtxSlot(ctx || initialCtx, 'switch16k');
    if (!isExactBankState(bankState)) return null;
    return cpuToRomOffForExactBank(a, bankState.bank);
  }

  function resolveCodeFetch(ctx, cpuAddr) {
    const activeCtx = ctx || initialCtx;
    const ctxKey = fetchCtxKey(activeCtx);
    const a = cpuAddr & 0xffff;
    if (a < 0x8000 || a > 0xffff) return { ok: false, ctxKey, backing: unknownBacking() };
    if (a >= 0xc000) {
      const romOff = cpuToRomOffForExactBank(a, fixedBank);
      return { ok: true, ctxKey, backing: exactBacking(romOff) };
    }
    const bankState = getFetchCtxSlot(activeCtx, 'switch16k');
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
    if (bank === fixedBank) {
      return [{ cpuAddr: (0xc000 + within) & 0xffff, fetchCtx: initialCtx }];
    }
    const ctx = setFetchCtxSlot(initialCtx, 'switch16k', exactBankState(bank));
    return [{ cpuAddr: (0x8000 + within) & 0xffff, fetchCtx: ctx }];
  }

  function romOffToCpuAddrs(romOff) {
    return seedSitesForRomOff(romOff).map((s) => s.cpuAddr & 0xffff);
  }

  function targetSitesForCpuAddr(ctx, cpuAddr, { maxForks = 4 } = {}) {
    const a = cpuAddr & 0xffff;
    const slot = slotForCpuAddr(a);
    if (!slot) return { sites: [], ambiguous: false };
    if (slot === 'fixed16k') {
      return { sites: [{ cpuAddr: a, fetchCtx: ctx || initialCtx }], ambiguous: false };
    }
    const state = getFetchCtxSlot(ctx || initialCtx, 'switch16k');
    const expanded = expandBankState(state, { maxForks });
    if (!expanded.exactBanks || !expanded.exactBanks.length) return { sites: [], ambiguous: true };
    const sites = expanded.exactBanks.map((bank) => ({
      cpuAddr: a,
      fetchCtx: setFetchCtxSlot(ctx || initialCtx, 'switch16k', exactBankState(bank))
    }));
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
    let bankState = mapValueStateToBankState(effValueState, { bankCount, mask: valueMask, maxSetSize: Math.min(8, Math.max(1, bankCount)) });
    if (mapperNumber === 94 && bankState.kind === 'set') {
      bankState = bankSetState(bankState.banks.filter((b) => b >= 0 && b < bankCount));
    }
    return setFetchCtxSlot(activeCtx, 'switch16k', bankState);
  }

  function probableScanBoundaries() {
    const out = [];
    for (let off = 0; off <= prgSize; off += bankSize) out.push(off);
    if (out.length === 0 || out[out.length - 1] !== prgSize) out.push(prgSize);
    return out;
  }


  function getProbableInterruptRoots({ vectors }) {
    const roots = [];
    if (typeof vectors?.nmi === 'number') roots.push({ cpuAddr: vectors.nmi & 0xffff, fetchCtx: initialCtx });
    if (typeof vectors?.irqBrk === 'number') roots.push({ cpuAddr: vectors.irqBrk & 0xffff, fetchCtx: initialCtx });
    return roots.filter((r) => (r.cpuAddr & 0xffff) >= 0x8000);
  }
  return {
    id: 'fixed-switch-16k',
    mapperFamily,
    bankCount,
    fixedBank,
    initialFetchCtx,
    fetchCtxKey,
    slotForCpuAddr,
    cpuToRomOffInCtx,
    resolveCodeFetch,
    seedSitesForRomOff,
    romOffToCpuAddrs,
    targetSitesForCpuAddr,
    isMapperWriteCpuAddr,
    getProbableInterruptRoots,
    applyMapperWrite,
    bankValueFromWrite,
    probableScanBoundaries
  };
}
