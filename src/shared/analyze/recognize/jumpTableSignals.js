import { hex2, hex4 } from '../../cpu6502/fmt.js';
import { cpuToRomOffWithMapper } from '../map/cpuToRomOff.js';
import { vEnumerate } from '../vsa/value.js';

// Extract jump-table "signals" (objective facts) from provenance/state at an indirect JMP site. 🤖
//
// This file intentionally contains no confidence decisions; it only reports what we can prove/observe. 🤖

function readPrgAtCpu(prgBytes, mapper, cpuAddr, fetchCtx = null) {
  const romOff = cpuToRomOffWithMapper(mapper, cpuAddr, fetchCtx);
  if (romOff == null) return null;
  if (romOff < 0 || romOff >= prgBytes.length) return null;
  return prgBytes[romOff] & 0xff;
}

function isReadRom8(n) {
  return n && n.kind === 'ReadRom8';
}

function collectReadRom8Leaves(prov, cap = 6) {
  // When control-flow merges, provenance becomes Join(...). We "peek" into joins to recover
  // any ReadRom8 shapes, but we cap recursion to avoid blowups. 🤖
  const out = [];
  const stack = [prov];
  while (stack.length && out.length < cap) {
    const n = stack.pop();
    if (!n) continue;
    if (n.kind === 'Join' && Array.isArray(n.options)) {
      for (let i = n.options.length - 1; i >= 0; i--) stack.push(n.options[i]);
      continue;
    }
    if (isReadRom8(n)) out.push(n);
  }
  return out;
}

function decomposeAddrExpr(n) {
  // VSA currently emits Add16(Const16(base), idxExpr) for indexed ROM reads. 🤖
  if (!n || n.kind !== 'Add16') return null;
  const a = n.a;
  const b = n.b;
  if (!a || !b) return null;
  if (a.kind === 'Const16') return { base: a.v & 0xffff, idxExpr: b };
  if (b.kind === 'Const16') return { base: b.v & 0xffff, idxExpr: a };
  return null;
}

function summarizeProv(p) {
  if (!p) return 'unknown';
  if (p.kind === 'Join') {
    const leaves = collectReadRom8Leaves(p, 2);
    if (leaves.length === 0) return 'join(...)';
    const parts = leaves.map((x) => summarizeProv(x));
    return parts.join(' | ');
  }
  if (p.kind === 'ReadRom8') {
    const d = decomposeAddrExpr(p.addrExpr);
    if (d) {
      const src = p.indexSource ? p.indexSource : '?';
      return `ReadRom8($${hex4(d.base)} + ${src})`;
    }
    return 'ReadRom8(...)';
  }
  if (p.kind === 'Const8') return `const $${hex2(p.v)}`;
  if (p.kind === 'Unknown') return 'unknown';
  return p.kind;
}

function pickFallbackIndexSource(state, enumCap = 32) {
  const preference = [];
  if (state?.lastCmp?.reg === 'X' || state?.lastCmp?.reg === 'Y') preference.push(state.lastCmp.reg);
  if (state?.lastNZ?.reg === 'X' || state?.lastNZ?.reg === 'Y') preference.push(state.lastNZ.reg);
  for (const reg of ['X', 'Y']) if (!preference.includes(reg)) preference.push(reg);

  const candidates = [];
  for (const reg of preference) {
    const tracked = reg === 'X' ? state?.X : state?.Y;
    const vals = tracked?.abs ? vEnumerate(tracked.abs, enumCap) : null;
    if (vals?.length) candidates.push({ reg, vals });
  }
  if (!candidates.length) return null;
  const preferred = candidates[0];
  const smallest = candidates.slice().sort((a, b) => a.vals.length - b.vals.length)[0];
  if (preferred && preferred.vals.length <= Math.max(8, enumCap >> 1)) return preferred;
  if (smallest && smallest.vals.length <= Math.max(8, enumCap >> 1)) return smallest;
  return null;
}

function absSummary(abs) {
  if (!abs) return { kind: 'unknown', summary: 'unknown', cardinality: null };
  if (abs.kind === 'unknown') return { kind: 'unknown', summary: 'unknown', cardinality: null };
  if (abs.kind === 'const') return { kind: 'const', summary: `const $${hex2(abs.v)}`, cardinality: 1 };
  if (abs.kind === 'set') return { kind: 'set', summary: `set(${abs.values.length})`, cardinality: abs.values.length };
  if (abs.kind === 'range') {
    const size = (abs.hi - abs.lo + 1);
    return { kind: 'range', summary: `range[$${hex2(abs.lo)}..$${hex2(abs.hi)}]`, cardinality: size };
  }
  return { kind: abs.kind, summary: abs.kind, cardinality: null };
}

export function extractJumpTableSignals({ prgBytes, mapper, site, state, enumCap = 32 }) {
  const pc = site.pc & 0xffff;
  const ptrAddr = site.ptrAddr & 0xffff;
  const fetchCtx = site.fetchCtx || mapper.initialFetchCtx();

  if (!state) {
    return {
      pc,
      ptrAddr,
      ptrInZp: ptrAddr <= 0x00ff,
      shapeMatch: 'none',
      decodeBlockedBy: ['missing_site_state']
    };
  }

  // For now we only track pointer bytes in ZP (cheap + common for dispatch pointers). 🤖
  const ptrInZp = ptrAddr <= 0x00ff;
  if (!ptrInZp) {
    return {
      pc,
      ptrAddr,
      ptrInZp,
      shapeMatch: 'none',
      decodeBlockedBy: ['ptr_not_zp']
    };
  }

  const lo = state.zp.get(ptrAddr & 0xff);
  const hi = state.zp.get((ptrAddr + 1) & 0xff); // page-wrap quirk for $00FF handled by &0xff. 🤖
  if (!lo || !hi) {
    return {
      pc,
      ptrAddr,
      ptrInZp,
      shapeMatch: 'none',
      decodeBlockedBy: ['ptr_bytes_untracked']
    };
  }

  const loProv = lo.prov;
  const hiProv = hi.prov;
  const evidence = { lo: summarizeProv(loProv), hi: summarizeProv(hiProv) };

  const loReads = collectReadRom8Leaves(loProv);
  const hiReads = collectReadRom8Leaves(hiProv);
  if (loReads.length === 0 || hiReads.length === 0) {
    return {
      pc,
      ptrAddr,
      ptrInZp,
      shapeMatch: 'none',
      evidence,
      decodeBlockedBy: ['ptr_not_loaded_from_rom']
    };
  }

  // Pick the best lo/hi ReadRom8 pair (prefer same index expr + same index source). 🤖
  let best = null;
  for (const loR of loReads) {
    const loD = decomposeAddrExpr(loR.addrExpr);
    if (!loD) continue;
    for (const hiR of hiReads) {
      const hiD = decomposeAddrExpr(hiR.addrExpr);
      if (!hiD) continue;
      const sameIndexExpr = (loD.idxExpr?.id != null) && (loD.idxExpr.id === hiD.idxExpr?.id);
      const indexSource = loR.indexSource;
      const sameIndexSource = !!indexSource && indexSource === hiR.indexSource;
      const rank = (sameIndexExpr ? 2 : 0) + (sameIndexSource ? 1 : 0);
      if (!best || rank > best.rank) {
        best = { rank, loR, hiR, loD, hiD, sameIndexExpr, sameIndexSource, indexSource };
      }
      if (best && best.rank === 3) break;
    }
    if (best && best.rank === 3) break;
  }

  if (!best) {
    return {
      pc,
      ptrAddr,
      ptrInZp,
      shapeMatch: 'none',
      evidence,
      decodeBlockedBy: ['rom_read_shape_unknown']
    };
  }

  const loD = best.loD;
  const hiD = best.hiD;
  const sameIndexExpr = best.sameIndexExpr;
  const indexSource = best.indexSource;
  const sameIndexSource = best.sameIndexSource;
  const basesAreConst = true; // by construction: decomposeAddrExpr only returns Const16 base. 🤖

  let shapeMatch = 'split_lohi';
  if (((loD.base + 1) & 0xffff) === (hiD.base & 0xffff)) shapeMatch = 'interleaved_words';

  let effectiveIndexSource = indexSource;
  let inferredIndexSource = false;
  let idxTracked = effectiveIndexSource === 'X' ? state.X : effectiveIndexSource === 'Y' ? state.Y : null;
  let idxAbs = idxTracked?.abs || null;
  let idxEnum = idxAbs ? vEnumerate(idxAbs, enumCap) : null;
  if ((!effectiveIndexSource || !sameIndexSource || !idxEnum?.length) && sameIndexExpr) {
    const fallback = pickFallbackIndexSource(state, enumCap);
    if (fallback) {
      effectiveIndexSource = fallback.reg;
      inferredIndexSource = true;
      idxTracked = effectiveIndexSource === 'X' ? state.X : state.Y;
      idxAbs = idxTracked?.abs || null;
      idxEnum = fallback.vals;
    }
  }
  const idxInfo = absSummary(idxAbs);
  const idxEnumerable = !!idxEnum && idxEnum.length > 0;

  const indexSourceResolved = !!effectiveIndexSource && (sameIndexSource || inferredIndexSource);
  const baseLo = loD.base;
  const baseHi = hiD.base;
  const baseReadable = (readPrgAtCpu(prgBytes, mapper, baseLo, fetchCtx) != null) && (readPrgAtCpu(prgBytes, mapper, baseHi, fetchCtx) != null);

  const targets = [];
  let decodeOk = false;
  if (idxEnumerable && baseReadable && sameIndexExpr && indexSourceResolved) {
    decodeOk = true;
    for (const i of idxEnum) {
      const loByte = readPrgAtCpu(prgBytes, mapper, (baseLo + i) & 0xffff, fetchCtx);
      const hiByte = readPrgAtCpu(prgBytes, mapper, (baseHi + i) & 0xffff, fetchCtx);
      if (loByte == null || hiByte == null) {
        decodeOk = false;
        break;
      }
      const targetCpu = (loByte | (hiByte << 8)) & 0xffff;
      const targetRomOff = cpuToRomOffWithMapper(mapper, targetCpu, fetchCtx);
      targets.push({
        index: i & 0xff,
        targetCpu,
        targetRomOff
      });
    }
    if (!decodeOk) targets.length = 0;
  }

  const decodeBlockedBy = [];
  if (!sameIndexExpr) decodeBlockedBy.push('lo_hi_index_mismatch');
  if (!sameIndexSource && !inferredIndexSource) decodeBlockedBy.push('lo_hi_index_source_mismatch');
  if (!effectiveIndexSource) decodeBlockedBy.push('missing_index_source');
  if (!idxEnumerable) decodeBlockedBy.push(idxInfo.kind === 'range' ? 'index_range_too_large' : 'index_unknown');
  if (!baseReadable) decodeBlockedBy.push('base_unmapped');
  if (idxEnumerable && baseReadable && sameIndexExpr && indexSourceResolved && targets.length === 0) decodeBlockedBy.push('decode_failed');

  return {
    pc,
    ptrAddr,
    ptrInZp,
    shapeMatch,
    shape: shapeMatch,
    indexSource: effectiveIndexSource,
    baseLo,
    baseHi,
    basesAreConst,
    baseReadable,
    sameIndexExpr,
    sameIndexSource: sameIndexSource || inferredIndexSource,
    idxInfo,
    idxEnumerable,
    idxEnum,
    inferredIndexSource,
    targets,
    decodeOk,
    evidence,
    decodeBlockedBy
  };
}
