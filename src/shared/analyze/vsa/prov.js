// Provenance is represented as an immutable expression tree. 🤖
// We keep it deliberately "lossy": when paths join, we create Join(...) nodes rather than attempting to preserve per-path detail. 🤖

let _nextId = 1;
function n(kind, fields) {
  return { id: _nextId++, kind, ...fields };
}

export function pUnknown() {
  return n('Unknown', {});
}

export function pConst8(v) {
  return n('Const8', { v: v & 0xff });
}

export function pConst16(v) {
  return n('Const16', { v: v & 0xffff });
}

export function pAdd16(a, b) {
  return n('Add16', { a, b });
}

export function pAdd8(a, delta) {
  return n('Add8', { a, delta: delta | 0 });
}

export function pAnd8(a, mask) {
  return n('And8', { a, mask: mask & 0xff });
}

export function pOr8(a, mask) {
  return n('Or8', { a, mask: mask & 0xff });
}

export function pXor8(a, mask) {
  return n('Xor8', { a, mask: mask & 0xff });
}

export function pShl1(a) {
  return n('Shl1', { a });
}

export function pShr1(a) {
  return n('Shr1', { a });
}

export function pReadRom8(addrExpr, indexSource = null) {
  return n('ReadRom8', { addrExpr, indexSource });
}

export function pReadZp8(zpAddr) {
  return n('ReadZp8', { zpAddr: zpAddr & 0xff });
}

// Memory read wrapper used by the broader VSA facts pass.
// `base` is the provenance of the value that was read from the given address.
export function pReadMem8(space, addr, base) {
  return n('ReadMem8', { space, addr: addr & 0xffff, base });
}

// Pointer expression (16-bit) composed from a ZP pointer location.
export function pPtr16FromZp(zpAddr, loBase, hiBase) {
  return n('Ptr16FromZp', { zpAddr: zpAddr & 0xff, loBase, hiBase });
}

export function pJoin(a, b) {
  if (a === b) return a;
  return n('Join', { options: [a, b] });
}

export function pFilter(base, pred) {
  return n('Filter', { base, pred });
}
