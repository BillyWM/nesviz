import {
  backingSet,
  exactBacking,
  fetchCtxKey as baseFetchCtxKey,
  makeFetchCtx,
  unknownBacking
} from '../fetchContext.js';
import {
  bankStateKey,
  exactBankState,
  expandBankState,
  mapValueStateToBankState,
  normalizeBankState,
  unknownBankState,
  joinBankStates
} from './bankState.js';

const PRG_MODE_32K = 'switch-32k';
const PRG_MODE_FIXED_FIRST = 'fixed-first';
const PRG_MODE_FIXED_LAST = 'fixed-last';
const ALL_PRG_MODES = [PRG_MODE_32K, PRG_MODE_FIXED_FIRST, PRG_MODE_FIXED_LAST];
const MAX_PENDING_SET_SIZE = 8;

function unknownModeState() {
  return { kind: 'unknown' };
}

function exactModeState(value) {
  return ALL_PRG_MODES.includes(value) ? { kind: 'exact', value } : unknownModeState();
}

function modeSetState(values) {
  const vals = Array.from(new Set((Array.isArray(values) ? values : []).filter((v) => ALL_PRG_MODES.includes(v)))).sort();
  if (vals.length === 0) return unknownModeState();
  if (vals.length === 1) return exactModeState(vals[0]);
  return { kind: 'set', values: vals };
}

function normalizeModeState(state) {
  if (state?.kind === 'exact') return exactModeState(state.value);
  if (state?.kind === 'set') return modeSetState(state.values || []);
  return unknownModeState();
}

function modeStateValues(state) {
  if (state?.kind === 'exact' && ALL_PRG_MODES.includes(state.value)) return [state.value];
  if (state?.kind === 'set' && Array.isArray(state.values)) return Array.from(new Set(state.values.filter((v) => ALL_PRG_MODES.includes(v)))).sort();
  return [];
}

function modeStateKey(state) {
  if (state?.kind === 'exact' && ALL_PRG_MODES.includes(state.value)) return state.value;
  if (state?.kind === 'set' && Array.isArray(state.values)) return `{${modeStateValues(state).join(',')}}`;
  return '?';
}

function joinModeStates(a, b) {
  if (a?.kind === 'unknown' || b?.kind === 'unknown') return unknownModeState();
  const vals = [...modeStateValues(a), ...modeStateValues(b)];
  return modeSetState(vals);
}

function expandModeState(state, { maxForks = ALL_PRG_MODES.length } = {}) {
  const vals = modeStateValues(state);
  if (!vals.length) return { exactModes: ALL_PRG_MODES.slice(0, Math.max(1, maxForks | 0)), truncated: true };
  if (vals.length > maxForks) return { exactModes: vals.slice(0, maxForks), truncated: true };
  return { exactModes: vals, truncated: false };
}

function unknownPendingState() {
  return { kind: 'unknown' };
}

function normalizePendingEntry(entry) {
  const countRaw = typeof entry?.count === 'number' ? entry.count : Number(entry?.count);
  if (!Number.isFinite(countRaw)) return null;
  const count = Math.max(0, Math.min(4, countRaw | 0));
  const mask = count > 0 ? ((1 << count) - 1) : 0;
  const bitsRaw = typeof entry?.bits === 'number' ? entry.bits : Number(entry?.bits);
  const bits = Number.isFinite(bitsRaw) ? ((bitsRaw | 0) & mask) : 0;
  return { count, bits };
}

function pendingEntryKey(entry) {
  return `${entry.count | 0}:${entry.bits | 0}`;
}

function exactPendingState(count = 0, bits = 0) {
  const norm = normalizePendingEntry({ count, bits });
  if (!norm) return unknownPendingState();
  return { kind: 'exact', count: norm.count, bits: norm.bits };
}

function pendingSetState(entries) {
  const vals = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const norm = normalizePendingEntry(entry);
    if (!norm) continue;
    const key = pendingEntryKey(norm);
    if (seen.has(key)) continue;
    seen.add(key);
    vals.push(norm);
  }
  vals.sort((a, b) => (a.count - b.count) || (a.bits - b.bits));
  if (vals.length === 0) return unknownPendingState();
  if (vals.length === 1) return exactPendingState(vals[0].count, vals[0].bits);
  return { kind: 'set', states: vals };
}

function normalizePendingState(state, maxSetSize = MAX_PENDING_SET_SIZE) {
  if (state?.kind === 'exact') return exactPendingState(state.count, state.bits);
  if (state?.kind === 'set') {
    const vals = Array.isArray(state.states) ? state.states : [];
    const norm = pendingSetState(vals);
    if (norm.kind === 'set' && norm.states.length > maxSetSize) return unknownPendingState();
    return norm;
  }
  return unknownPendingState();
}

function pendingStateValues(state) {
  if (state?.kind === 'exact') {
    const norm = normalizePendingEntry(state);
    return norm ? [norm] : [];
  }
  if (state?.kind === 'set' && Array.isArray(state.states)) {
    return Array.from(new Map(state.states.map((entry) => {
      const norm = normalizePendingEntry(entry);
      return norm ? [pendingEntryKey(norm), norm] : null;
    }).filter(Boolean)).values()).sort((a, b) => (a.count - b.count) || (a.bits - b.bits));
  }
  return [];
}

function pendingStateKey(state) {
  if (state?.kind === 'exact') {
    const norm = normalizePendingEntry(state);
    return norm ? pendingEntryKey(norm) : '?';
  }
  if (state?.kind === 'set' && Array.isArray(state.states)) {
    const vals = pendingStateValues(state);
    return `{${vals.map((entry) => pendingEntryKey(entry)).join(',')}}`;
  }
  return '?';
}

function joinPendingStates(a, b, maxSetSize = MAX_PENDING_SET_SIZE) {
  if (a?.kind === 'unknown' || b?.kind === 'unknown') return unknownPendingState();
  return normalizePendingState(pendingSetState([...pendingStateValues(a), ...pendingStateValues(b)]), maxSetSize);
}

function isUnknownPendingState(state) {
  return !state || state.kind === 'unknown';
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

function rawBankStateFromCommitValue(commitValue, bankCount, maxSetSize) {
  return mapValueStateToBankState({ kind: 'exact', value: commitValue & 0x1f }, { bankCount, mask: null, maxSetSize });
}

function modeStateFromControlValue(controlValue) {
  const prgModeBits = ((controlValue | 0) >>> 2) & 0x03;
  if (prgModeBits === 0 || prgModeBits === 1) return exactModeState(PRG_MODE_32K);
  if (prgModeBits === 2) return exactModeState(PRG_MODE_FIXED_FIRST);
  return exactModeState(PRG_MODE_FIXED_LAST);
}

export function createMmc1Mapper({ prgBytes, mapperMeta = null }) {
  const prgSize = prgBytes?.length | 0;
  const bankSize16k = 16 * 1024;
  const bankCount = Math.max(1, (prgSize / bankSize16k) | 0);
  const fixedLastBank = Math.max(0, bankCount - 1);
  const maxBankSetSize = Math.min(8, Math.max(1, bankCount));
  const mapperFamily = mapperMeta?.mapperFamily || 'MMC1';

  function normalizeRawBankState(state) {
    return normalizeBankState(state, maxBankSetSize);
  }

  function normalizeSerialPendingState(state) {
    return normalizePendingState(state, MAX_PENDING_SET_SIZE);
  }

  function makeMmc1FetchCtx({ mode = exactModeState(PRG_MODE_FIXED_LAST), prgReg = unknownBankState(), pending = exactPendingState(0, 0) } = {}) {
    const normMode = normalizeModeState(mode);
    const normPrgReg = normalizeRawBankState(prgReg);
    const normPending = normalizeSerialPendingState(pending);
    const key = `mmc1:mode=${modeStateKey(normMode)};prg=${bankStateKey(normPrgReg)};pending=${pendingStateKey(normPending)}`;
    return makeFetchCtx({
      mapperFamily,
      state: {
        mapperType: 'mmc1',
        mode: normMode,
        prgReg: normPrgReg,
        pending: normPending
      },
      key
    });
  }

  function getModeState(ctx) {
    return normalizeModeState(ctx?.state?.mode);
  }

  function getRawPrgBankState(ctx) {
    return normalizeRawBankState(ctx?.state?.prgReg);
  }

  function getPendingState(ctx) {
    return normalizeSerialPendingState(ctx?.state?.pending);
  }

  const initialCtx = makeMmc1FetchCtx({
    mode: exactModeState(PRG_MODE_FIXED_LAST),
    prgReg: bankCount <= 1 ? exactBankState(0) : unknownBankState(),
    pending: exactPendingState(0, 0)
  });

  function fetchCtxKey(ctx) {
    return baseFetchCtxKey(ctx || initialCtx);
  }

  function initialFetchCtx() {
    return initialCtx;
  }

  function slotForCpuAddr(cpuAddr) {
    const a = cpuAddr & 0xffff;
    if (a >= 0x8000 && a <= 0xbfff) return 'lower16k';
    if (a >= 0xc000 && a <= 0xffff) return 'upper16k';
    return null;
  }

  function normalizeBankIndex(bankIndex) {
    if (!Number.isFinite(bankIndex) || bankCount <= 0) return 0;
    const n = bankIndex | 0;
    return ((n % bankCount) + bankCount) % bankCount;
  }

  function pairBaseForRawBank(rawBank) {
    const b = normalizeBankIndex(rawBank);
    return normalizeBankIndex(b & ~1);
  }

  function lowerBankForMode(mode, rawBank) {
    switch (mode) {
      case PRG_MODE_FIXED_FIRST:
        return 0;
      case PRG_MODE_FIXED_LAST:
        return normalizeBankIndex(rawBank);
      case PRG_MODE_32K:
        return pairBaseForRawBank(rawBank);
      default:
        return null;
    }
  }

  function upperBankForMode(mode, rawBank) {
    switch (mode) {
      case PRG_MODE_FIXED_FIRST:
        return normalizeBankIndex(rawBank);
      case PRG_MODE_FIXED_LAST:
        return fixedLastBank;
      case PRG_MODE_32K:
        return bankCount <= 1 ? 0 : normalizeBankIndex(pairBaseForRawBank(rawBank) + 1);
      default:
        return null;
    }
  }

  function cpuToRomOffForBanks(cpuAddr, lowerBank, upperBank) {
    const a = cpuAddr & 0xffff;
    if (a >= 0x8000 && a <= 0xbfff) return (normalizeBankIndex(lowerBank) * bankSize16k) + (a - 0x8000);
    if (a >= 0xc000 && a <= 0xffff) return (normalizeBankIndex(upperBank) * bankSize16k) + (a - 0xc000);
    return null;
  }

  function exactRomOffsetsForState(ctx, cpuAddr, { maxForks = Math.max(1, bankCount) } = {}) {
    const a = cpuAddr & 0xffff;
    if (a < 0x8000 || a > 0xffff) return { romOffs: [], ambiguous: false };

    const expandedModes = expandModeState(getModeState(ctx || initialCtx), { maxForks: ALL_PRG_MODES.length });
    const rawBankState = getRawPrgBankState(ctx || initialCtx);
    const expandedBanks = expandBankState(rawBankState, { maxForks: Math.max(1, bankCount) });
    const rawBanks = expandedBanks.exactBanks && expandedBanks.exactBanks.length
      ? expandedBanks.exactBanks
      : Array.from({ length: Math.max(1, bankCount) }, (_, i) => i);

    const limit = Math.max(1, maxForks | 0);
    const romOffs = [];
    const seen = new Set();
    let ambiguous = !!expandedModes.truncated || !!expandedBanks.truncated;

    for (const mode of expandedModes.exactModes || ALL_PRG_MODES) {
      if ((mode === PRG_MODE_FIXED_LAST && a >= 0xc000) || (mode === PRG_MODE_FIXED_FIRST && a < 0xc000)) {
        const romOff = cpuToRomOffForBanks(a, 0, fixedLastBank);
        const key = romOff == null ? null : String(romOff | 0);
        if (key != null && !seen.has(key)) {
          seen.add(key);
          romOffs.push(romOff | 0);
        }
        continue;
      }

      for (const rawBank of rawBanks) {
        const lowerBank = lowerBankForMode(mode, rawBank);
        const upperBank = upperBankForMode(mode, rawBank);
        const romOff = cpuToRomOffForBanks(a, lowerBank, upperBank);
        if (romOff == null) continue;
        const key = String(romOff | 0);
        if (seen.has(key)) continue;
        seen.add(key);
        romOffs.push(romOff | 0);
        if (romOffs.length >= limit && (expandedBanks.truncated || rawBanks.length > limit || (expandedModes.exactModes || []).length > 1)) {
          ambiguous = true;
          return { romOffs, ambiguous };
        }
      }
    }

    return { romOffs, ambiguous };
  }

  function cpuToRomOffInCtx(ctx, cpuAddr) {
    const exact = exactRomOffsetsForState(ctx || initialCtx, cpuAddr, { maxForks: 2 });
    return exact.romOffs.length === 1 ? exact.romOffs[0] : null;
  }

  function resolveCodeFetch(ctx, cpuAddr) {
    const activeCtx = ctx || initialCtx;
    const ctxKey = fetchCtxKey(activeCtx);
    const a = cpuAddr & 0xffff;
    if (a < 0x8000 || a > 0xffff) return { ok: false, ctxKey, backing: unknownBacking() };
    const exact = exactRomOffsetsForState(activeCtx, a, { maxForks: Math.max(1, bankCount * ALL_PRG_MODES.length) });
    if (!exact.romOffs.length) return { ok: false, ctxKey, backing: unknownBacking() };
    if (exact.romOffs.length === 1) return { ok: true, ctxKey, backing: exactBacking(exact.romOffs[0]) };
    return { ok: true, ctxKey, backing: backingSet(exact.romOffs) };
  }

  function ctxForModeAndBank(mode, rawBankState, pending = getPendingState(initialCtx)) {
    return makeMmc1FetchCtx({ mode: exactModeState(mode), prgReg: rawBankState, pending });
  }

  function seedSitesForRomOff(romOff) {
    const off = romOff | 0;
    if (off < 0 || off >= prgSize) return [];
    const bank = (off / bankSize16k) | 0;
    const within = off % bankSize16k;
    const sites = [];
    const seen = new Set();

    function addSite(cpuAddr, fetchCtx) {
      const cpu = cpuAddr & 0xffff;
      const key = `${fetchCtxKey(fetchCtx)}:${cpu}`;
      if (seen.has(key)) return;
      seen.add(key);
      sites.push({ cpuAddr: cpu, fetchCtx });
    }

    addSite(0x8000 + within, ctxForModeAndBank(PRG_MODE_FIXED_LAST, exactBankState(bank), exactPendingState(0, 0)));
    if (bank === fixedLastBank) addSite(0xc000 + within, ctxForModeAndBank(PRG_MODE_FIXED_LAST, getRawPrgBankState(initialCtx), exactPendingState(0, 0)));

    addSite(0xc000 + within, ctxForModeAndBank(PRG_MODE_FIXED_FIRST, exactBankState(bank), exactPendingState(0, 0)));
    if (bank === 0) addSite(0x8000 + within, ctxForModeAndBank(PRG_MODE_FIXED_FIRST, getRawPrgBankState(initialCtx), exactPendingState(0, 0)));

    const pairBase = pairBaseForRawBank(bank);
    if (bank === pairBase) addSite(0x8000 + within, ctxForModeAndBank(PRG_MODE_32K, exactBankState(pairBase), exactPendingState(0, 0)));
    if (bank === upperBankForMode(PRG_MODE_32K, pairBase)) addSite(0xc000 + within, ctxForModeAndBank(PRG_MODE_32K, exactBankState(pairBase), exactPendingState(0, 0)));

    return sites;
  }

  function romOffToCpuAddrs(romOff) {
    return seedSitesForRomOff(romOff).map((s) => s.cpuAddr & 0xffff);
  }

  function targetSitesForCpuAddr(ctx, cpuAddr, { maxForks = 4 } = {}) {
    const a = cpuAddr & 0xffff;
    const slot = slotForCpuAddr(a);
    if (!slot) return { sites: [], ambiguous: false };

    const activeCtx = ctx || initialCtx;
    const activePending = getPendingState(activeCtx);
    const expandedModes = expandModeState(getModeState(activeCtx), { maxForks: ALL_PRG_MODES.length });
    const rawBankState = getRawPrgBankState(activeCtx);
    const expandedBanks = expandBankState(rawBankState, { maxForks: Math.max(1, maxForks | 0) });
    const candidateBanks = expandedBanks.exactBanks && expandedBanks.exactBanks.length
      ? expandedBanks.exactBanks
      : Array.from({ length: Math.max(1, Math.min(bankCount, Math.max(1, maxForks | 0))) }, (_, i) => i);

    const sites = [];
    const seen = new Set();
    let ambiguous = !!expandedModes.truncated;

    function addSite(fetchCtx) {
      const key = `${fetchCtxKey(fetchCtx)}:${a}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (sites.length >= Math.max(1, maxForks | 0)) {
        ambiguous = true;
        return;
      }
      sites.push({ cpuAddr: a, fetchCtx });
    }

    for (const mode of expandedModes.exactModes || ALL_PRG_MODES) {
      if (mode === PRG_MODE_FIXED_LAST && slot === 'upper16k') {
        addSite(ctxForModeAndBank(PRG_MODE_FIXED_LAST, rawBankState, activePending));
        continue;
      }
      if (mode === PRG_MODE_FIXED_FIRST && slot === 'lower16k') {
        addSite(ctxForModeAndBank(PRG_MODE_FIXED_FIRST, rawBankState, activePending));
        continue;
      }
      if (expandedBanks.truncated || !expandedBanks.exactBanks || !expandedBanks.exactBanks.length) ambiguous = true;
      for (const rawBank of candidateBanks) {
        addSite(ctxForModeAndBank(mode, exactBankState(rawBank), activePending));
      }
    }

    return { sites, ambiguous };
  }

  function isMapperWriteCpuAddr(cpuAddr) {
    const a = cpuAddr & 0xffff;
    return a >= 0x8000 && a <= 0xffff;
  }

  function resetModeCtx(ctx) {
    return makeMmc1FetchCtx({
      mode: exactModeState(PRG_MODE_FIXED_LAST),
      prgReg: getRawPrgBankState(ctx || initialCtx),
      pending: exactPendingState(0, 0)
    });
  }

  function rangeForCpuAddr(cpuAddr) {
    const a = cpuAddr & 0xffff;
    if (a >= 0x8000 && a <= 0x9fff) return 'control';
    if (a >= 0xa000 && a <= 0xbfff) return 'chr0';
    if (a >= 0xc000 && a <= 0xdfff) return 'chr1';
    if (a >= 0xe000 && a <= 0xffff) return 'prg';
    return null;
  }

  function buildCtxFromParts({ mode, prgReg, pending }) {
    return makeMmc1FetchCtx({
      mode: normalizeModeState(mode),
      prgReg: normalizeRawBankState(prgReg),
      pending: normalizeSerialPendingState(pending)
    });
  }

  function applySerialCommit({ activeCtx, cpuAddr, commitValue }) {
    const range = rangeForCpuAddr(cpuAddr);
    if (range === 'control') {
      return buildCtxFromParts({
        mode: modeStateFromControlValue(commitValue),
        prgReg: getRawPrgBankState(activeCtx),
        pending: exactPendingState(0, 0)
      });
    }
    if (range === 'prg') {
      return buildCtxFromParts({
        mode: getModeState(activeCtx),
        prgReg: rawBankStateFromCommitValue(commitValue, bankCount, maxBankSetSize),
        pending: exactPendingState(0, 0)
      });
    }
    return buildCtxFromParts({
      mode: getModeState(activeCtx),
      prgReg: getRawPrgBankState(activeCtx),
      pending: exactPendingState(0, 0)
    });
  }

  function applyKnownSerialWrite({ activeCtx, cpuAddr, value }) {
    const byte = value & 0xff;
    if ((byte & 0x80) !== 0) return resetModeCtx(activeCtx);

    const pending = getPendingState(activeCtx);
    if (isUnknownPendingState(pending)) {
      return applyUnknownSerialWrite({ activeCtx, cpuAddr, includeReset: false });
    }

    const nextStates = [];
    for (const entry of pendingStateValues(pending)) {
      const nextCount = (entry.count | 0) + 1;
      const nextBits = (entry.bits | 0) | ((byte & 1) << (entry.count | 0));
      if (nextCount >= 5) nextStates.push(applySerialCommit({ activeCtx, cpuAddr, commitValue: nextBits & 0x1f }));
      else nextStates.push(buildCtxFromParts({ mode: getModeState(activeCtx), prgReg: getRawPrgBankState(activeCtx), pending: exactPendingState(nextCount, nextBits) }));
    }

    if (!nextStates.length) return applyUnknownSerialWrite({ activeCtx, cpuAddr, includeReset: false });
    return joinMmc1FetchCtxs(nextStates, activeCtx);
  }

  function applyUnknownSerialWrite({ activeCtx, cpuAddr, includeReset = true }) {
    const range = rangeForCpuAddr(cpuAddr);
    const results = [];
    if (includeReset) results.push(resetModeCtx(activeCtx));

    const modeBase = (range === 'control') ? unknownModeState() : getModeState(activeCtx);
    const modeState = includeReset ? joinModeStates(modeBase, exactModeState(PRG_MODE_FIXED_LAST)) : modeBase;
    const prgState = (range === 'prg') ? unknownBankState() : getRawPrgBankState(activeCtx);
    results.push(buildCtxFromParts({ mode: modeState, prgReg: prgState, pending: unknownPendingState() }));

    return joinMmc1FetchCtxs(results, activeCtx);
  }

  function joinMmc1FetchCtxs(ctxs, fallbackCtx) {
    const list = Array.isArray(ctxs) ? ctxs.filter(Boolean) : [];
    if (!list.length) return fallbackCtx || initialCtx;
    if (list.length === 1) return list[0];

    let mode = getModeState(list[0]);
    let prgReg = getRawPrgBankState(list[0]);
    let pending = getPendingState(list[0]);

    for (let i = 1; i < list.length; i++) {
      mode = joinModeStates(mode, getModeState(list[i]));
      prgReg = joinBankStates(prgReg, getRawPrgBankState(list[i]), maxBankSetSize);
      pending = joinPendingStates(pending, getPendingState(list[i]), MAX_PENDING_SET_SIZE);
    }

    return makeMmc1FetchCtx({ mode, prgReg, pending });
  }

  function applyMapperWrite({ ctx, cpuAddr, valueState }) {
    const activeCtx = ctx || initialCtx;
    const a = cpuAddr & 0xffff;
    if (a < 0x8000 || a > 0xffff) return activeCtx;

    const values = valueStateValues8(valueState, MAX_PENDING_SET_SIZE);
    if (!values) return applyUnknownSerialWrite({ activeCtx, cpuAddr: a, includeReset: true });

    const nextCtxs = values.map((value) => applyKnownSerialWrite({ activeCtx, cpuAddr: a, value }));
    return joinMmc1FetchCtxs(nextCtxs, activeCtx);
  }

  function probableScanBoundaries() {
    const out = [];
    for (let off = 0; off <= prgSize; off += bankSize16k) out.push(off);
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
    id: 'mmc1',
    mapperFamily,
    bankCount,
    bankSize: bankSize16k,
    fixedLastBank,
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
