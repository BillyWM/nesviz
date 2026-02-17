import { vUnknown, vJoin } from './value.js';
import { pUnknown, pJoin } from './prov.js';
import { bUnknown8, bJoin } from './bits.js';

// A tracked value is (abstract value set) + (provenance expression). 🤖
// The abstract value drives the analysis; provenance is attached for explainability and pattern matching later. 🤖

export function makeTracked(abs = vUnknown(), prov = pUnknown(), bits = bUnknown8(), spanStartRomOff = null) {
  return { abs, prov, bits, spanStartRomOff: (typeof spanStartRomOff === 'number') ? (spanStartRomOff >>> 0) : null };
}

export function makeState(trackedZpAddrs, opts = null) {
  const zp = new Map();
  for (const a of trackedZpAddrs || []) zp.set(a & 0xff, makeTracked());
  return {
    A: makeTracked(),
    X: makeTracked(),
    Y: makeTracked(),
    // Carry flag (0/1) when known; null when unknown. Used for a few constant-preserving idioms (CLC; ADC #imm). 🤖
    C: null,
    zp,
    ram: opts?.trackRam ? new Map() : null,
    lastCmp: null, // { reg: 'A'|'X'|'Y', imm: byte } 🤖
    lastNZ: null // { reg: 'A'|'X'|'Y' } for load/ALU -> branch adjacency filtering. 🤖
  };
}

export function cloneState(s) {
  const out = {
    A: { ...s.A },
    X: { ...s.X },
    Y: { ...s.Y },
    C: (s.C === 0 || s.C === 1) ? s.C : null,
    zp: new Map(Array.from(s.zp.entries()).map(([k, v]) => [k, { ...v }])) ,
    ram: s.ram ? new Map(Array.from(s.ram.entries()).map(([k, v]) => [k, { ...v }])) : null,
    lastCmp: s.lastCmp ? { ...s.lastCmp } : null,
    lastNZ: s.lastNZ ? { ...s.lastNZ } : null
  };
  return out;
}

function absEq(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'unknown') return true;
  if (a.kind === 'const') return a.v === b.v;
  if (a.kind === 'set') {
    if (a.values.length !== b.values.length) return false;
    for (let i = 0; i < a.values.length; i++) if (a.values[i] !== b.values[i]) return false;
    return true;
  }
  if (a.kind === 'range') {
    return a.lo === b.lo && a.hi === b.hi;
  }
  return false;
}

function joinTracked(a, b) {
  const sa = typeof a?.spanStartRomOff === 'number' ? (a.spanStartRomOff >>> 0) : null;
  const sb = typeof b?.spanStartRomOff === 'number' ? (b.spanStartRomOff >>> 0) : null;
  const spanStartRomOff = (sa != null && sb != null) ? Math.min(sa, sb) : (sa != null ? sa : sb);
  return {
    abs: vJoin(a.abs, b.abs),
    prov: pJoin(a.prov, b.prov),
    bits: bJoin(a.bits, b.bits),
    spanStartRomOff
  };
}

// Joins `incoming` into `base` and reports whether any *abstract value* changed. 🤖
export function joinInto(base, incoming) {
  let changed = false;

  const regs = ['A', 'X', 'Y'];
  for (const r of regs) {
    const joined = joinTracked(base[r], incoming[r]);
    if (!absEq(base[r].abs, joined.abs)) changed = true;
    base[r] = joined;
  }

  // Carry: preserve only when both paths agree. Otherwise it becomes unknown. 🤖
  const bc = (base.C === 0 || base.C === 1) ? base.C : null;
  const ic = (incoming.C === 0 || incoming.C === 1) ? incoming.C : null;
  const jc = (bc != null && ic != null && bc === ic) ? bc : null;
  if (base.C !== jc) {
    base.C = jc;
    // carry changes don't count as abstract-value changes for the worklist; it's an auxiliary precision knob.
  }

  for (const [k, v] of base.zp.entries()) {
    const inc = incoming.zp.get(k) || makeTracked();
    const joined = joinTracked(v, inc);
    if (!absEq(v.abs, joined.abs)) changed = true;
    base.zp.set(k, joined);
  }

  if (base.ram || incoming.ram) {
    if (!base.ram) base.ram = new Map();
    const baseKeys = new Set(Array.from(base.ram.keys()));
    const incKeys = incoming.ram ? Array.from(incoming.ram.keys()) : [];
    for (const k of incKeys) baseKeys.add(k);

    for (const k of baseKeys) {
      const bv = base.ram.get(k) || makeTracked();
      const iv = incoming.ram ? (incoming.ram.get(k) || makeTracked()) : makeTracked();
      const joined = joinTracked(bv, iv);
      if (!absEq(bv.abs, joined.abs)) changed = true;
      base.ram.set(k, joined);
    }
  }

  // Branch-adjacency facts are only meaningful within a single straight-line path; drop them on joins. 🤖
  base.lastCmp = null;
  base.lastNZ = null;

  return changed;
}
