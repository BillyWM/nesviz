import { exactBacking, fetchCtxKey as baseFetchCtxKey, makeFixedFetchCtx } from '../fetchContext.js';

export function createNromMapper({ prgSize }) {
  const is16k = prgSize === 16 * 1024;
  const is32k = prgSize === 32 * 1024;
  const initialCtx = makeFixedFetchCtx({ mapperFamily: 'NROM', key: 'nrom:fixed', state: null });

  function cpuToRomOffInCtx(_ctx, cpuAddr) {
    const a = cpuAddr & 0xffff;
    if (a < 0x8000) return null;
    if (is32k) {
      const off = a - 0x8000;
      if (off < 0 || off >= prgSize) return null;
      return off;
    }
    if (is16k) {
      const off = (a - 0x8000) & 0x3fff;
      if (off < 0 || off >= prgSize) return null;
      return off;
    }
    return null;
  }

  function cpuToRomOff(cpuAddr) {
    return cpuToRomOffInCtx(initialCtx, cpuAddr);
  }

  function resolveCodeFetch(ctx, cpuAddr) {
    const activeCtx = ctx || initialCtx;
    const romOff = cpuToRomOffInCtx(activeCtx, cpuAddr);
    if (romOff == null) return { ok: false, ctxKey: fetchCtxKey(activeCtx), backing: { kind: 'unknown' } };
    return { ok: true, ctxKey: fetchCtxKey(activeCtx), backing: exactBacking(romOff) };
  }

  function romOffToCpuAddrs(romOff) {
    const off = romOff | 0;
    if (off < 0 || off >= prgSize) return [];
    if (is16k) return [0x8000 + off, 0xc000 + off];
    if (is32k) return [0x8000 + off];
    return [];
  }

  function seedSitesForRomOff(romOff) {
    return romOffToCpuAddrs(romOff).map((cpuAddr) => ({ cpuAddr: cpuAddr & 0xffff, fetchCtx: initialCtx }));
  }

  function initialFetchCtx() {
    return initialCtx;
  }

  function fetchCtxKey(ctx) {
    return baseFetchCtxKey(ctx || initialCtx);
  }

  function targetSitesForCpuAddr(ctx, cpuAddr) {
    const a = cpuAddr & 0xffff;
    if (cpuToRomOffInCtx(ctx || initialCtx, a) == null) return { sites: [], ambiguous: false };
    return {
      sites: [{ cpuAddr: a, fetchCtx: ctx || initialCtx }],
      ambiguous: false
    };
  }

  function isMapperWriteCpuAddr() {
    return false;
  }

  function applyMapperWrite({ ctx }) {
    return ctx || initialCtx;
  }


  function getProbableInterruptRoots({ vectors }) {
    const roots = [];
    if (typeof vectors?.nmi === 'number') roots.push({ cpuAddr: vectors.nmi & 0xffff, fetchCtx: initialCtx });
    if (typeof vectors?.irqBrk === 'number') roots.push({ cpuAddr: vectors.irqBrk & 0xffff, fetchCtx: initialCtx });
    return roots.filter((r) => (r.cpuAddr & 0xffff) >= 0x8000);
  }
  return {
    id: 'nrom',
    initialFetchCtx,
    fetchCtxKey,
    cpuToRomOff,
    cpuToRomOffInCtx,
    resolveCodeFetch,
    romOffToCpuAddrs,
    seedSitesForRomOff,
    targetSitesForCpuAddr,
    isMapperWriteCpuAddr,
    getProbableInterruptRoots,
    applyMapperWrite
  };
}
