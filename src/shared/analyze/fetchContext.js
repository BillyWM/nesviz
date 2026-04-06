import { hexN } from '../cpu6502/fmt.js';
import { bankStateKey, normalizeBankState, unknownBankState } from './map/bankState.js';

export function makeFetchCtx({ kind = 'prg_fetch', mapperFamily = 'NROM', state = null, key = null } = {}) {
  const ctx = { kind, mapperFamily, state };
  ctx.key = key || canonicalFetchCtxKey(ctx);
  return ctx;
}

export function makeFixedFetchCtx({ mapperFamily = 'NROM', key = null, state = null } = {}) {
  return makeFetchCtx({ kind: 'prg_fetch', mapperFamily, state, key });
}

export function makeSlotFetchCtx({ mapperFamily = 'GENERIC', prgSlots = {} } = {}) {
  const normSlots = {};
  for (const [slotId, slotState] of Object.entries(prgSlots || {})) {
    normSlots[slotId] = normalizeBankState(slotState);
  }
  return makeFetchCtx({ kind: 'prg_fetch', mapperFamily, state: { prgSlots: normSlots } });
}

export function canonicalizeFetchCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return makeFixedFetchCtx();
  if (ctx.state?.prgSlots && typeof ctx.state.prgSlots === 'object') {
    return makeSlotFetchCtx({ mapperFamily: ctx.mapperFamily || 'GENERIC', prgSlots: ctx.state.prgSlots });
  }
  return makeFixedFetchCtx({ mapperFamily: ctx.mapperFamily || 'NROM', key: ctx.key || null, state: ctx.state ?? null });
}

function canonicalFetchCtxKey(ctx) {
  if (!ctx || typeof ctx !== 'object') return 'nrom:fixed';
  const fam = String(ctx.mapperFamily || 'NROM').toLowerCase();
  const slots = ctx.state?.prgSlots;
  if (!slots || typeof slots !== 'object' || !Object.keys(slots).length) return `${fam}:fixed`;
  const parts = Object.keys(slots).sort().map((slotId) => `${slotId}=${bankStateKey(normalizeBankState(slots[slotId]))}`);
  return `${fam}:${parts.join(';')}`;
}

export function fetchCtxKey(ctx) {
  if (!ctx || typeof ctx !== 'object') return 'nrom:fixed';
  if (typeof ctx.key === 'string' && ctx.key) return ctx.key;
  return canonicalFetchCtxKey(ctx);
}

export function getFetchCtxSlot(ctx, slotId) {
  if (!ctx || typeof ctx !== 'object') return unknownBankState();
  const st = ctx.state?.prgSlots?.[slotId];
  return normalizeBankState(st);
}

export function setFetchCtxSlot(ctx, slotId, bankState) {
  const base = canonicalizeFetchCtx(ctx);
  const prgSlots = { ...(base.state?.prgSlots || {}) };
  prgSlots[slotId] = normalizeBankState(bankState);
  return makeSlotFetchCtx({ mapperFamily: base.mapperFamily || 'GENERIC', prgSlots });
}

export function exactBacking(romOff) {
  const off = typeof romOff === 'number' ? romOff : Number(romOff);
  if (!Number.isFinite(off) || off < 0) return { kind: 'unknown' };
  return { kind: 'exact', romOff: off | 0 };
}

export function backingSet(romOffs) {
  const vals = Array.isArray(romOffs)
    ? romOffs
        .map((v) => (typeof v === 'number' ? v : Number(v)))
        .filter((v) => Number.isFinite(v) && v >= 0)
        .map((v) => v | 0)
    : [];
  if (vals.length === 0) return { kind: 'unknown' };
  if (vals.length === 1) return exactBacking(vals[0]);
  return { kind: 'set', romOffs: Array.from(new Set(vals)).sort((a, b) => a - b) };
}

export function unknownBacking() {
  return { kind: 'unknown' };
}

export function siteKeyFor(ctxKey, cpuAddr) {
  const ctx = (typeof ctxKey === 'string' && ctxKey) ? ctxKey : 'nrom:fixed';
  const cpu = typeof cpuAddr === 'number' ? (cpuAddr & 0xffff) : (Number(cpuAddr) & 0xffff);
  return `${ctx}:${hexN(cpu, 4)}`;
}
