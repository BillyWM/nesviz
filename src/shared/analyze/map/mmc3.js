import { dedupeSorted } from '../../utils/uniqueUtils.js';

import {
  backingSet,
  exactBacking,
  fetchCtxKey as baseFetchCtxKey,
  makeFetchCtx,
  unknownBacking
} from '../fetchContext.js';
import {
  bankStateKey,
  bankStateValues,
  exactBankState,
  joinBankStates,
  mapValueStateToBankState,
  normalizeBankState,
  unknownBankState
} from './bankState.js';

const PRG_MODE_NORMAL = 'normal';
const PRG_MODE_SWAPPED = 'swapped';
const ALL_PRG_MODES = [PRG_MODE_NORMAL, PRG_MODE_SWAPPED];

const SELECT_R6 = 'r6';
const SELECT_R7 = 'r7';
const SELECT_OTHER = 'other';
const ALL_SELECT_CLASSES = [SELECT_R6, SELECT_R7, SELECT_OTHER];

function unknownEnumState() {
  return { kind: 'unknown' };
}

function exactEnumState(value, allowed) {
  return allowed.includes(value) ? { kind: 'exact', value } : unknownEnumState();
}

function enumSetState(values, allowed) {
  const vals = Array.from(new Set((Array.isArray(values) ? values : []).filter((v) => allowed.includes(v)))).sort();
  if (vals.length === 0) return unknownEnumState();
  if (vals.length === 1) return exactEnumState(vals[0], allowed);
  return { kind: 'set', values: vals };
}

function normalizeEnumState(state, allowed) {
  if (state?.kind === 'exact') return exactEnumState(state.value, allowed);
  if (state?.kind === 'set') return enumSetState(state.values || [], allowed);
  return unknownEnumState();
}

function enumStateValues(state, allowed) {
  if (state?.kind === 'exact' && allowed.includes(state.value)) return [state.value];
  if (state?.kind === 'set' && Array.isArray(state.values)) {
    return Array.from(new Set(state.values.filter((v) => allowed.includes(v)))).sort();
  }
  return [];
}

function enumStateKey(state, allowed) {
  if (state?.kind === 'exact' && allowed.includes(state.value)) return state.value;
  if (state?.kind === 'set' && Array.isArray(state.values)) return `{${enumStateValues(state, allowed).join(',')}}`;
  return '?';
}

function unknownModeState() {
  return unknownEnumState();
}

function exactModeState(value) {
  return exactEnumState(value, ALL_PRG_MODES);
}

function modeSetState(values) {
  return enumSetState(values, ALL_PRG_MODES);
}

function normalizeModeState(state) {
  return normalizeEnumState(state, ALL_PRG_MODES);
}

function modeStateValues(state) {
  return enumStateValues(state, ALL_PRG_MODES);
}

function modeStateKey(state) {
  return enumStateKey(state, ALL_PRG_MODES);
}

function unknownSelectState() {
  return unknownEnumState();
}

function exactSelectState(value) {
  return exactEnumState(value, ALL_SELECT_CLASSES);
}

function selectSetState(values) {
  return enumSetState(values, ALL_SELECT_CLASSES);
}

function normalizeSelectState(state) {
  return normalizeEnumState(state, ALL_SELECT_CLASSES);
}

function selectStateValues(state) {
  return enumStateValues(state, ALL_SELECT_CLASSES);
}

function selectStateKey(state) {
  return enumStateKey(state, ALL_SELECT_CLASSES);
}

function valueStateValues8(valueState, maxSetSize = 8) {
  if (!valueState || valueState.kind === 'unknown') return null;
  if (valueState.kind === 'exact') return [valueState.value & 0xff];
  if (valueState.kind === 'set') {
    const vals = Array.from(new Set((valueState.values || []).map((v) => v & 0xff))).sort((a, b) => a - b);
    if (vals.length > Math.max(1, maxSetSize | 0)) return null;
    return vals;
  }
  return null;
}

function selectClassFromBankSelectValue(value) {
  const reg = value & 0x07;
  if (reg === 6) return SELECT_R6;
  if (reg === 7) return SELECT_R7;
  return SELECT_OTHER;
}

function modeFromBankSelectValue(value) {
  return ((value >>> 6) & 0x01) ? PRG_MODE_SWAPPED : PRG_MODE_NORMAL;
}

export function createMmc3Mapper({ prgBytes, mapperMeta = null }) {
  const prgSize = prgBytes?.length | 0;
  const bankSize = 8 * 1024;
  const bankCount = Math.max(1, (prgSize / bankSize) | 0);
  const fixedLastBank = Math.max(0, bankCount - 1);
  const fixedSecondLastBank = Math.max(0, bankCount - 2);
  const maxBankSetSize = Math.min(8, Math.max(1, bankCount));
  const mapperFamily = mapperMeta?.mapperFamily || 'MMC3';

  function normalizePrgBankState(state) {
    return normalizeBankState(state, maxBankSetSize);
  }

  function normalizeBankIndex(bankIndex) {
    if (!Number.isFinite(bankIndex) || bankCount <= 0) return 0;
    const n = bankIndex | 0;
    return ((n % bankCount) + bankCount) % bankCount;
  }

  function makeMmc3FetchCtx({
    prgMode = unknownModeState(),
    bankSelectClass = unknownSelectState(),
    r6 = unknownBankState(),
    r7 = unknownBankState()
  } = {}) {
    const normMode = normalizeModeState(prgMode);
    const normSelect = normalizeSelectState(bankSelectClass);
    const normR6 = normalizePrgBankState(r6);
    const normR7 = normalizePrgBankState(r7);
    const key = `mmc3:mode=${modeStateKey(normMode)};sel=${selectStateKey(normSelect)};r6=${bankStateKey(normR6)};r7=${bankStateKey(normR7)}`;
    return makeFetchCtx({
      mapperFamily,
      state: {
        mapperType: 'mmc3',
        prgMode: normMode,
        bankSelectClass: normSelect,
        r6: normR6,
        r7: normR7
      },
      key
    });
  }

  function getModeState(ctx) {
    return normalizeModeState(ctx?.state?.prgMode);
  }

  function getSelectClassState(ctx) {
    return normalizeSelectState(ctx?.state?.bankSelectClass);
  }

  function getR6BankState(ctx) {
    return normalizePrgBankState(ctx?.state?.r6);
  }

  function getR7BankState(ctx) {
    return normalizePrgBankState(ctx?.state?.r7);
  }

  function withCtxState(ctx, overrides = {}) {
    const activeCtx = ctx || initialCtx;
    return makeMmc3FetchCtx({
      prgMode: Object.prototype.hasOwnProperty.call(overrides, 'prgMode') ? overrides.prgMode : getModeState(activeCtx),
      bankSelectClass: Object.prototype.hasOwnProperty.call(overrides, 'bankSelectClass') ? overrides.bankSelectClass : getSelectClassState(activeCtx),
      r6: Object.prototype.hasOwnProperty.call(overrides, 'r6') ? overrides.r6 : getR6BankState(activeCtx),
      r7: Object.prototype.hasOwnProperty.call(overrides, 'r7') ? overrides.r7 : getR7BankState(activeCtx)
    });
  }

  const initialCtx = makeMmc3FetchCtx({
    prgMode: unknownModeState(),
    bankSelectClass: unknownSelectState(),
    r6: unknownBankState(),
    r7: unknownBankState()
  });

  function initialFetchCtx() {
    return initialCtx;
  }

  function fetchCtxKey(ctx) {
    return baseFetchCtxKey(ctx || initialCtx);
  }

  function slotForCpuAddr(cpuAddr) {
    const a = cpuAddr & 0xffff;
    if (a >= 0x8000 && a <= 0x9fff) return 'slot8000';
    if (a >= 0xa000 && a <= 0xbfff) return 'slotA000';
    if (a >= 0xc000 && a <= 0xdfff) return 'slotC000';
    if (a >= 0xe000 && a <= 0xffff) return 'slotE000';
    return null;
  }

  function cpuToRomOffForBank(cpuAddr, bankIndex) {
    const a = cpuAddr & 0xffff;
    const bank = normalizeBankIndex(bankIndex);
    if (a >= 0x8000 && a <= 0x9fff) return (bank * bankSize) + (a - 0x8000);
    if (a >= 0xa000 && a <= 0xbfff) return (bank * bankSize) + (a - 0xa000);
    if (a >= 0xc000 && a <= 0xdfff) return (bank * bankSize) + (a - 0xc000);
    if (a >= 0xe000 && a <= 0xffff) return (bank * bankSize) + (a - 0xe000);
    return null;
  }

  function exactBanksForFetch(ctx, cpuAddr) {
    const activeCtx = ctx || initialCtx;
    const a = cpuAddr & 0xffff;
    const slot = slotForCpuAddr(a);
    if (!slot) return [];
    if (slot === 'slotE000') return [fixedLastBank];
    if (slot === 'slotA000') return dedupeSorted(bankStateValues(getR7BankState(activeCtx)).map((bank) => normalizeBankIndex(bank)));

    const modeValues = modeStateValues(getModeState(activeCtx));
    const concreteModes = modeValues.length ? modeValues : ALL_PRG_MODES;
    const r6Banks = dedupeSorted(bankStateValues(getR6BankState(activeCtx)).map((bank) => normalizeBankIndex(bank)));
    const out = [];

    for (const mode of concreteModes) {
      if (slot === 'slot8000') {
        if (mode === PRG_MODE_NORMAL) out.push(...r6Banks);
        else out.push(fixedSecondLastBank);
      } else if (slot === 'slotC000') {
        if (mode === PRG_MODE_NORMAL) out.push(fixedSecondLastBank);
        else out.push(...r6Banks);
      }
    }

    return dedupeSorted(out);
  }

  function cpuToRomOffInCtx(ctx, cpuAddr) {
    const activeCtx = ctx || initialCtx;
    const a = cpuAddr & 0xffff;
    const banks = exactBanksForFetch(activeCtx, a);
    if (banks.length !== 1) return null;
    return cpuToRomOffForBank(a, banks[0]);
  }

  function resolveCodeFetch(ctx, cpuAddr) {
    const activeCtx = ctx || initialCtx;
    const a = cpuAddr & 0xffff;
    const ctxKey = fetchCtxKey(activeCtx);
    if (a < 0x8000 || a > 0xffff) return { ok: false, ctxKey, backing: unknownBacking() };

    const banks = exactBanksForFetch(activeCtx, a);
    if (!banks.length) return { ok: false, ctxKey, backing: unknownBacking() };
    const romOffs = banks.map((bank) => cpuToRomOffForBank(a, bank)).filter((off) => off != null && off >= 0 && off < prgSize);
    if (!romOffs.length) return { ok: false, ctxKey, backing: unknownBacking() };
    if (romOffs.length === 1) return { ok: true, ctxKey, backing: exactBacking(romOffs[0]) };
    return { ok: true, ctxKey, backing: backingSet(romOffs) };
  }

  function buildTargetSitesForCpuAddr(ctx, cpuAddr) {
    const activeCtx = ctx || initialCtx;
    const a = cpuAddr & 0xffff;
    const slot = slotForCpuAddr(a);
    if (!slot) return [];
    if (slot === 'slotE000') return [{ cpuAddr: a, fetchCtx: activeCtx }];
    if (slot === 'slotA000') {
      const r7Banks = dedupeSorted(bankStateValues(getR7BankState(activeCtx)).map((bank) => normalizeBankIndex(bank)));
      if (!r7Banks.length) return null;
      return r7Banks.map((bank) => ({
        cpuAddr: a,
        fetchCtx: withCtxState(activeCtx, { r7: exactBankState(bank) })
      }));
    }

    const modeValues = modeStateValues(getModeState(activeCtx));
    const concreteModes = modeValues.length ? modeValues : ALL_PRG_MODES;
    const r6Banks = dedupeSorted(bankStateValues(getR6BankState(activeCtx)).map((bank) => normalizeBankIndex(bank)));
    const out = [];

    for (const mode of concreteModes) {
      if (slot === 'slot8000') {
        if (mode === PRG_MODE_NORMAL) {
          if (!r6Banks.length) return null;
          for (const bank of r6Banks) {
            out.push({
              cpuAddr: a,
              fetchCtx: withCtxState(activeCtx, { prgMode: exactModeState(PRG_MODE_NORMAL), r6: exactBankState(bank) })
            });
          }
        } else {
          out.push({ cpuAddr: a, fetchCtx: withCtxState(activeCtx, { prgMode: exactModeState(PRG_MODE_SWAPPED) }) });
        }
      } else if (slot === 'slotC000') {
        if (mode === PRG_MODE_NORMAL) {
          out.push({ cpuAddr: a, fetchCtx: withCtxState(activeCtx, { prgMode: exactModeState(PRG_MODE_NORMAL) }) });
        } else {
          if (!r6Banks.length) return null;
          for (const bank of r6Banks) {
            out.push({
              cpuAddr: a,
              fetchCtx: withCtxState(activeCtx, { prgMode: exactModeState(PRG_MODE_SWAPPED), r6: exactBankState(bank) })
            });
          }
        }
      }
    }

    return out;
  }

  function targetSitesForCpuAddr(ctx, cpuAddr, { maxForks = 4 } = {}) {
    const candidates = buildTargetSitesForCpuAddr(ctx, cpuAddr & 0xffff);
    if (!candidates || !candidates.length) return { sites: [], ambiguous: true };
    const dedup = new Map();
    for (const site of candidates) {
      const key = `${fetchCtxKey(site.fetchCtx)}:${site.cpuAddr & 0xffff}`;
      dedup.set(key, { cpuAddr: site.cpuAddr & 0xffff, fetchCtx: site.fetchCtx });
    }
    const sites = Array.from(dedup.values());
    if (!sites.length) return { sites: [], ambiguous: true };
    if (sites.length > Math.max(1, maxForks | 0)) return { sites: [], ambiguous: true };
    return { sites, ambiguous: false };
  }

  function addSeedSite(out, seen, cpuAddr, fetchCtx) {
    const cpu = cpuAddr & 0xffff;
    if (cpu < 0x8000 || cpu > 0xffff) return;
    const key = `${fetchCtxKey(fetchCtx)}:${cpu}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ cpuAddr: cpu, fetchCtx });
  }

  function seedSitesForRomOff(romOff) {
    const off = romOff | 0;
    if (off < 0 || off >= prgSize) return [];
    const bank = normalizeBankIndex((off / bankSize) | 0);
    const within = off % bankSize;
    const out = [];
    const seen = new Set();

    addSeedSite(out, seen, 0xa000 + within, withCtxState(initialCtx, { r7: exactBankState(bank) }));
    addSeedSite(out, seen, 0x8000 + within, withCtxState(initialCtx, { prgMode: exactModeState(PRG_MODE_NORMAL), r6: exactBankState(bank) }));
    addSeedSite(out, seen, 0xc000 + within, withCtxState(initialCtx, { prgMode: exactModeState(PRG_MODE_SWAPPED), r6: exactBankState(bank) }));

    if (bank === fixedSecondLastBank) {
      addSeedSite(out, seen, 0xc000 + within, withCtxState(initialCtx, { prgMode: exactModeState(PRG_MODE_NORMAL) }));
      addSeedSite(out, seen, 0x8000 + within, withCtxState(initialCtx, { prgMode: exactModeState(PRG_MODE_SWAPPED) }));
    }
    if (bank === fixedLastBank) {
      addSeedSite(out, seen, 0xe000 + within, initialCtx);
    }

    return out;
  }

  function romOffToCpuAddrs(romOff) {
    return Array.from(new Set(seedSitesForRomOff(romOff).map((s) => s.cpuAddr & 0xffff))).sort((a, b) => a - b);
  }

  function isMapperWriteCpuAddr(cpuAddr) {
    const a = cpuAddr & 0xffff;
    return a >= 0x8000 && a <= 0xffff;
  }

  function applyMapperWrite({ ctx, cpuAddr, valueState }) {
    const activeCtx = ctx || initialCtx;
    const a = cpuAddr & 0xffff;
    if (a < 0x8000 || a > 0x9fff) return activeCtx;

    if ((a & 1) === 0) {
      const values = valueStateValues8(valueState, 8);
      if (!values) {
        return withCtxState(activeCtx, {
          prgMode: unknownModeState(),
          bankSelectClass: unknownSelectState()
        });
      }
      return withCtxState(activeCtx, {
        prgMode: modeSetState(values.map((value) => modeFromBankSelectValue(value))),
        bankSelectClass: selectSetState(values.map((value) => selectClassFromBankSelectValue(value)))
      });
    }

    const bankState = mapValueStateToBankState(valueState, { bankCount, mask: null, maxSetSize: maxBankSetSize });
    const selectState = getSelectClassState(activeCtx);
    const oldR6 = getR6BankState(activeCtx);
    const oldR7 = getR7BankState(activeCtx);

    if (selectState.kind === 'exact') {
      if (selectState.value === SELECT_R6) return withCtxState(activeCtx, { r6: bankState });
      if (selectState.value === SELECT_R7) return withCtxState(activeCtx, { r7: bankState });
      return activeCtx;
    }

    const selectValues = selectStateValues(selectState);
    const concreteSelects = selectValues.length ? selectValues : ALL_SELECT_CLASSES;
    let nextR6 = oldR6;
    let nextR7 = oldR7;
    if (concreteSelects.includes(SELECT_R6)) nextR6 = joinBankStates(oldR6, bankState, maxBankSetSize);
    if (concreteSelects.includes(SELECT_R7)) nextR7 = joinBankStates(oldR7, bankState, maxBankSetSize);
    return withCtxState(activeCtx, { r6: nextR6, r7: nextR7 });
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
    id: 'mmc3',
    mapperFamily,
    bankCount,
    bankSize,
    fixedLastBank,
    fixedSecondLastBank,
    initialFetchCtx,
    fetchCtxKey,
    slotForCpuAddr,
    cpuToRomOffInCtx,
    resolveCodeFetch,
    seedSitesForRomOff,
    romOffToCpuAddrs,
    targetSitesForCpuAddr,
    isMapperWriteCpuAddr,
    applyMapperWrite,
    probableScanBoundaries,
    getProbableInterruptRoots
  };
}
