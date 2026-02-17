// Known-bits abstract domain for 8-bit values.
//
// Representation: (knownMask, knownValue)
//   - For every bit where knownMask has 1, the corresponding bit in knownValue is the proven value.
//   - Bits where knownMask has 0 are unknown.
//
// This domain composes well with a scalar domain (const/set/range/unknown).

function clamp8(x) {
  return (x & 0xff) >>> 0;
}

export function bUnknown8() {
  return { knownMask: 0x00, knownValue: 0x00 };
}

export function bConst8(v) {
  return { knownMask: 0xff, knownValue: clamp8(v) };
}

export function bJoin(a, b) {
  if (!a || !b) return bUnknown8();
  const am = clamp8(a.knownMask);
  const av = clamp8(a.knownValue);
  const bm = clamp8(b.knownMask);
  const bv = clamp8(b.knownValue);

  // A bit is known in the join iff it is known in both inputs and the known values match.
  const bothKnown = am & bm;
  const diff = (av ^ bv) & 0xff;
  const mask = bothKnown & (~diff & 0xff);
  const val = av & mask;
  return { knownMask: clamp8(mask), knownValue: clamp8(val) };
}

export function bAndImm(a, imm) {
  const m = clamp8(imm);
  const am = clamp8(a?.knownMask ?? 0);
  const av = clamp8(a?.knownValue ?? 0);

  // Bits masked off become known 0.
  const knownMask = (am & m) | (~m & 0xff);
  const knownValue = (av & m) & 0xff;
  return { knownMask: clamp8(knownMask), knownValue: clamp8(knownValue) };
}

export function bOrImm(a, imm) {
  const m = clamp8(imm);
  const am = clamp8(a?.knownMask ?? 0);
  const av = clamp8(a?.knownValue ?? 0);

  // Bits forced to 1 become known 1.
  const knownMask = (am & (~m & 0xff)) | m;
  const knownValue = (av & (~m & 0xff)) | m;
  return { knownMask: clamp8(knownMask), knownValue: clamp8(knownValue) };
}

export function bXorImm(a, imm) {
  const m = clamp8(imm);
  const am = clamp8(a?.knownMask ?? 0);
  const av = clamp8(a?.knownValue ?? 0);
  return { knownMask: am, knownValue: clamp8(av ^ m) };
}

export function bShl1(a) {
  const am = clamp8(a?.knownMask ?? 0);
  const av = clamp8(a?.knownValue ?? 0);

  // ASL: bit0 becomes 0 (known), bit i comes from old bit i-1.
  const knownMask = ((am << 1) & 0xfe) | 0x01;
  const knownValue = (av << 1) & 0xfe;
  return { knownMask: clamp8(knownMask), knownValue: clamp8(knownValue) };
}

export function bShr1(a) {
  const am = clamp8(a?.knownMask ?? 0);
  const av = clamp8(a?.knownValue ?? 0);

  // LSR: bit7 becomes 0 (known), bit i comes from old bit i+1.
  const knownMask = ((am >> 1) & 0x7f) | 0x80;
  const knownValue = (av >> 1) & 0x7f;
  return { knownMask: clamp8(knownMask), knownValue: clamp8(knownValue) };
}
