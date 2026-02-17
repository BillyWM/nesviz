// Small abstract-domain helpers for 8-bit values.
// Domain: unknown | const | set | range. 🤖
//
// Why Range?
// Many NES patterns bound an index with compares/branches (e.g. CPX #$10; BCC ok). 🤖
// A range lets us keep that information without exploding into huge sets. 🤖
// When a range is small we can still enumerate it for jump-table decoding. 🤖

const MAX_SET = 64;

export function vRange8(lo, hi) {
  let a = lo & 0xff;
  let b = hi & 0xff;
  // Treat wrap/invalid ranges as empty. 🤖
  if (a > b) return vSet8([]);
  if (a === b) return vConst8(a);
  return { kind: 'range', lo: a, hi: b };
}

export function vUnknown() {
  return { kind: 'unknown' };
}

export function vConst8(v) {
  return { kind: 'const', v: v & 0xff };
}

export function vSet8(values) {
  const set = new Set();
  for (const x of values) set.add(x & 0xff);
  const arr = Array.from(set).sort((a, b) => a - b);
  if (arr.length > MAX_SET) return vUnknown();
  if (arr.length === 0) return { kind: 'set', values: [] };
  if (arr.length === 1) return vConst8(arr[0]);
  return { kind: 'set', values: arr };
}

export function vToSet(v) {
  if (v.kind === 'unknown') return null;
  if (v.kind === 'const') return new Set([v.v]);
  if (v.kind === 'set') return new Set(v.values);
  // We avoid turning ranges into sets implicitly; callers can request enumeration with a cap. 🤖
  return null;
}

export function vEnumerate(v, cap = 32) {
  if (!v) return null;
  if (v.kind === 'const') return [v.v];
  if (v.kind === 'set') return v.values;
  if (v.kind === 'range') {
    const size = (v.hi - v.lo + 1);
    if (size > cap) return null;
    const out = [];
    for (let x = v.lo; x <= v.hi; x++) out.push(x & 0xff);
    return out;
  }
  return null;
}

export function vJoin(a, b) {
  if (!a || !b) return vUnknown();
  if (a.kind === 'unknown' || b.kind === 'unknown') return vUnknown();

  if (a.kind === 'const' && b.kind === 'const') {
    if (a.v === b.v) return a;
    return vSet8([a.v, b.v]);
  }

  const as = vToSet(a);
  const bs = vToSet(b);
  // If either side is a range, over-approximate to a range. 🤖
  if (a.kind === 'range' && b.kind === 'range') {
    return vRange8(Math.min(a.lo, b.lo), Math.max(a.hi, b.hi));
  }
  if (a.kind === 'range') {
    if (b.kind === 'const') return vRange8(Math.min(a.lo, b.v), Math.max(a.hi, b.v));
    if (b.kind === 'set') return vRange8(Math.min(a.lo, b.values[0]), Math.max(a.hi, b.values[b.values.length - 1]));
    return vUnknown();
  }
  if (b.kind === 'range') {
    if (a.kind === 'const') return vRange8(Math.min(b.lo, a.v), Math.max(b.hi, a.v));
    if (a.kind === 'set') return vRange8(Math.min(b.lo, a.values[0]), Math.max(b.hi, a.values[a.values.length - 1]));
    return vUnknown();
  }

  if (!as || !bs) return vUnknown();

  const out = new Set(as);
  for (const x of bs) out.add(x);
  return vSet8(out);
}

export function vAnd8(v, mask) {
  if (v.kind === 'unknown') return vUnknown();
  if (v.kind === 'const') return vConst8(v.v & mask);
  if (v.kind === 'set') return vSet8(v.values.map((x) => x & mask));
  if (v.kind === 'range') {
    // AND can create holes; over-approximate by enumerating if small, otherwise unknown. 🤖
    const vals = vEnumerate(v, 32);
    if (!vals) return vUnknown();
    return vSet8(vals.map((x) => x & mask));
  }
  return vUnknown();
}

export function vOr8(v, mask) {
  const m = mask & 0xff;
  if (v.kind === 'unknown') return vUnknown();
  if (v.kind === 'const') return vConst8((v.v | m) & 0xff);
  if (v.kind === 'set') return vSet8(v.values.map((x) => (x | m) & 0xff));
  if (v.kind === 'range') {
    // OR can create holes; over-approximate by enumerating if small, otherwise unknown. 🤖
    const vals = vEnumerate(v, 32);
    if (!vals) return vUnknown();
    return vSet8(vals.map((x) => (x | m) & 0xff));
  }
  return vUnknown();
}

export function vXor8(v, mask) {
  const m = mask & 0xff;
  if (v.kind === 'unknown') return vUnknown();
  if (v.kind === 'const') return vConst8((v.v ^ m) & 0xff);
  if (v.kind === 'set') return vSet8(v.values.map((x) => (x ^ m) & 0xff));
  if (v.kind === 'range') {
    // XOR can create holes; over-approximate by enumerating if small, otherwise unknown. 🤖
    const vals = vEnumerate(v, 32);
    if (!vals) return vUnknown();
    return vSet8(vals.map((x) => (x ^ m) & 0xff));
  }
  return vUnknown();
}

export function vShr1(v) {
  if (v.kind === 'unknown') return vUnknown();
  if (v.kind === 'const') return vConst8((v.v >>> 1) & 0xff);
  if (v.kind === 'set') return vSet8(v.values.map((x) => (x >>> 1) & 0xff));
  if (v.kind === 'range') {
    const vals = vEnumerate(v, 32);
    if (!vals) return vUnknown();
    return vSet8(vals.map((x) => (x >>> 1) & 0xff));
  }
  return vUnknown();
}

export function vShl1(v) {
  if (v.kind === 'unknown') return vUnknown();
  if (v.kind === 'const') return vConst8((v.v << 1) & 0xff);
  if (v.kind === 'set') return vSet8(v.values.map((x) => (x << 1) & 0xff));
  if (v.kind === 'range') {
    // shift is monotonic for unsigned bytes if we ignore wrap; we keep it conservative via enumeration cap. 🤖
    const vals = vEnumerate(v, 32);
    if (!vals) return vUnknown();
    return vSet8(vals.map((x) => (x << 1) & 0xff));
  }
  return vUnknown();
}

export function vAdd8(v, delta) {
  if (v.kind === 'unknown') return vUnknown();
  if (v.kind === 'const') return vConst8((v.v + delta) & 0xff);
  if (v.kind === 'set') return vSet8(v.values.map((x) => (x + delta) & 0xff));
  if (v.kind === 'range') {
    // add with wrap can create holes; enumerate if small. 🤖
    const vals = vEnumerate(v, 32);
    if (!vals) return vUnknown();
    return vSet8(vals.map((x) => (x + delta) & 0xff));
  }
  return vUnknown();
}

export function vFilterEq(v, imm) {
  if (v.kind === 'unknown') return vUnknown();
  if (v.kind === 'const') return v.v === (imm & 0xff) ? v : vSet8([]);
  if (v.kind === 'set') return vSet8(v.values.filter((x) => x === (imm & 0xff)));
  if (v.kind === 'range') {
    const x = imm & 0xff;
    if (x < v.lo || x > v.hi) return vSet8([]);
    return vConst8(x);
  }
  return vUnknown();
}

export function vFilterNe(v, imm) {
  if (v.kind === 'unknown') return vUnknown();
  if (v.kind === 'const') return v.v !== (imm & 0xff) ? v : vSet8([]);
  if (v.kind === 'set') return vSet8(v.values.filter((x) => x !== (imm & 0xff)));
  if (v.kind === 'range') {
    // Removing a single value from a range creates a hole; enumerate if small, else keep range. 🤖
    const vals = vEnumerate(v, 32);
    if (!vals) return v;
    return vSet8(vals.filter((x) => x !== (imm & 0xff)));
  }
  return vUnknown();
}

export function vFilterLt(v, imm) {
  const x = imm & 0xff;
  if (v.kind === 'unknown') return vRange8(0, (x - 1) & 0xff);
  if (v.kind === 'const') return (v.v < x) ? v : vSet8([]);
  if (v.kind === 'set') return vSet8(v.values.filter((t) => t < x));
  if (v.kind === 'range') return vRange8(v.lo, Math.min(v.hi, (x - 1) & 0xff));
  return vUnknown();
}

export function vFilterGe(v, imm) {
  const x = imm & 0xff;
  if (v.kind === 'unknown') return vRange8(x, 0xff);
  if (v.kind === 'const') return (v.v >= x) ? v : vSet8([]);
  if (v.kind === 'set') return vSet8(v.values.filter((t) => t >= x));
  if (v.kind === 'range') return vRange8(Math.max(v.lo, x), v.hi);
  return vUnknown();
}

export function vFilterSign(v, wantNegative) {
  if (v.kind === 'unknown') {
    return wantNegative ? vRange8(0x80, 0xff) : vRange8(0x00, 0x7f);
  }
  if (v.kind === 'const') {
    const neg = (v.v & 0x80) !== 0;
    return (neg === wantNegative) ? v : vSet8([]);
  }
  if (v.kind === 'set') {
    return vSet8(v.values.filter((x) => (((x & 0x80) !== 0) === wantNegative)));
  }
  if (v.kind === 'range') {
    // Range might straddle the sign boundary; keep it simple via enumeration cap. 🤖
    const vals = vEnumerate(v, 64);
    if (!vals) return vUnknown();
    return vSet8(vals.filter((x) => (((x & 0x80) !== 0) === wantNegative)));
  }
  return vUnknown();
}

export function vIsEmpty(v) {
  return v.kind === 'set' && v.values.length === 0;
}

export function vDescribe(v) {
  if (!v) return 'unknown';
  if (v.kind === 'unknown') return 'unknown';
  if (v.kind === 'const') return `const $${v.v.toString(16).toUpperCase().padStart(2, '0')}`;
  if (v.kind === 'set') return `set(${v.values.length})`;
  if (v.kind === 'range') return `range[$${v.lo.toString(16).toUpperCase().padStart(2, '0')}..$${v.hi.toString(16).toUpperCase().padStart(2, '0')}]`;
  return v.kind;
}
