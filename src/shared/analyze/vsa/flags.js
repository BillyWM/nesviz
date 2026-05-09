function cloneSubject(subject) {
  if (!subject || typeof subject !== 'object') return null;
  return { ...subject };
}

export function makeFlagSource(line, { effect = 'unknown', subject = null } = {}) {
  if (!line || typeof line !== 'object') return null;
  return {
    romOff: typeof line.romOff === 'number' ? (line.romOff >>> 0) : null,
    cpuAddr: typeof line.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null,
    mnemonic: typeof line.mnemonic === 'string' ? line.mnemonic : null,
    mode: typeof line.mode === 'string' ? line.mode : null,
    effect: typeof effect === 'string' ? effect : 'unknown',
    subject: cloneSubject(subject)
  };
}

export function cloneFlagSource(source) {
  if (!source || typeof source !== 'object') return null;
  return {
    ...source,
    subject: cloneSubject(source.subject)
  };
}

export function cloneFlag(flag) {
  return {
    knownValue: flag?.knownValue === 0 || flag?.knownValue === 1 ? flag.knownValue : null,
    source: cloneFlagSource(flag?.source)
  };
}

export function makeUnknownFlag() {
  return { knownValue: null, source: null };
}

export function makeUnknownFlags() {
  return {
    N: makeUnknownFlag(),
    V: makeUnknownFlag(),
    Z: makeUnknownFlag(),
    C: makeUnknownFlag()
  };
}

export function cloneFlags(flags) {
  const src = flags || makeUnknownFlags();
  return {
    N: cloneFlag(src.N),
    V: cloneFlag(src.V),
    Z: cloneFlag(src.Z),
    C: cloneFlag(src.C)
  };
}

function subjectEquals(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function flagSourceEquals(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.romOff === b.romOff
    && a.cpuAddr === b.cpuAddr
    && a.mnemonic === b.mnemonic
    && a.mode === b.mode
    && a.effect === b.effect
    && subjectEquals(a.subject, b.subject);
}

export function flagEquals(a, b) {
  const av = a?.knownValue === 0 || a?.knownValue === 1 ? a.knownValue : null;
  const bv = b?.knownValue === 0 || b?.knownValue === 1 ? b.knownValue : null;
  return av === bv && flagSourceEquals(a?.source || null, b?.source || null);
}

export function joinFlags(a, b) {
  const left = a || makeUnknownFlags();
  const right = b || makeUnknownFlags();
  const out = makeUnknownFlags();
  for (const flag of ['N', 'V', 'Z', 'C']) {
    out[flag] = flagEquals(left[flag], right[flag]) ? cloneFlag(left[flag]) : makeUnknownFlag();
  }
  return out;
}

export function flagReadByBranchMnemonic(mnemonic) {
  switch (mnemonic) {
    case 'BPL':
    case 'BMI':
      return 'N';
    case 'BVC':
    case 'BVS':
      return 'V';
    case 'BCC':
    case 'BCS':
      return 'C';
    case 'BNE':
    case 'BEQ':
      return 'Z';
    default:
      return null;
  }
}

export function branchTakenWhen(mnemonic) {
  switch (mnemonic) {
    case 'BMI':
    case 'BVS':
    case 'BCS':
    case 'BEQ':
      return 1;
    case 'BPL':
    case 'BVC':
    case 'BCC':
    case 'BNE':
      return 0;
    default:
      return null;
  }
}

function knownSignFromBits(bits) {
  const mask = bits?.knownMask ?? 0;
  if ((mask & 0x80) === 0) return null;
  return (bits.knownValue & 0x80) !== 0 ? 1 : 0;
}

function knownZeroFromAbs(abs) {
  if (!abs || abs.kind === 'unknown') return null;
  if (abs.kind === 'const') return (abs.v & 0xff) === 0 ? 1 : 0;
  if (abs.kind === 'set') {
    const values = Array.isArray(abs.values) ? abs.values.map((v) => v & 0xff) : [];
    if (!values.length) return null;
    const allZero = values.every((v) => v === 0);
    const noneZero = values.every((v) => v !== 0);
    if (allZero) return 1;
    if (noneZero) return 0;
    return null;
  }
  if (abs.kind === 'range') {
    const lo = abs.lo & 0xff;
    const hi = abs.hi & 0xff;
    if (lo > 0 || hi < 0) return 0;
  }
  return null;
}

function knownBit(bits, bitMask) {
  const mask = bits?.knownMask ?? 0;
  if ((mask & bitMask) === 0) return null;
  return (bits.knownValue & bitMask) !== 0 ? 1 : 0;
}

export function setFlag(flags, flag, knownValue, source) {
  if (!flags || !flags[flag]) return;
  flags[flag] = {
    knownValue: knownValue === 0 || knownValue === 1 ? knownValue : null,
    source: cloneFlagSource(source)
  };
}

export function writeNZFromResult(flags, line, result, { subject = null, zEffect = 'resultZero', nEffect = 'resultNegative' } = {}) {
  setFlag(flags, 'Z', knownZeroFromAbs(result?.abs), makeFlagSource(line, { effect: zEffect, subject }));
  setFlag(flags, 'N', knownSignFromBits(result?.bits), makeFlagSource(line, { effect: nEffect, subject }));
}

export function writeExplicitFlag(flags, line, flag, value, effect) {
  setFlag(flags, flag, value, makeFlagSource(line, { effect, subject: { kind: 'flag', flag } }));
}

export function writeCompareFlags(flags, line, lhs, rhsTracked, { reg = null, rhs = null } = {}) {
  const subject = { kind: 'compare', reg, rhsKind: rhs?.kind || null };
  if (typeof rhs?.imm === 'number') subject.imm = rhs.imm & 0xff;
  const lhsConst = lhs?.abs?.kind === 'const' ? (lhs.abs.v & 0xff) : null;
  const rhsConst = rhsTracked?.abs?.kind === 'const'
    ? (rhsTracked.abs.v & 0xff)
    : (typeof rhs?.imm === 'number' ? (rhs.imm & 0xff) : null);

  let knownZ = null;
  let knownC = null;
  let knownN = null;
  if (lhsConst !== null && rhsConst !== null) {
    const diff = (lhsConst - rhsConst) & 0xff;
    knownZ = lhsConst === rhsConst ? 1 : 0;
    knownC = lhsConst >= rhsConst ? 1 : 0;
    knownN = (diff & 0x80) !== 0 ? 1 : 0;
  }

  setFlag(flags, 'Z', knownZ, makeFlagSource(line, { effect: 'compareZero', subject }));
  setFlag(flags, 'C', knownC, makeFlagSource(line, { effect: 'compareCarry', subject }));
  setFlag(flags, 'N', knownN, makeFlagSource(line, { effect: 'compareNegative', subject }));
}

export function writeShiftFlags(flags, line, input, result, { subject = null, direction = 'left', rotate = false } = {}) {
  writeNZFromResult(flags, line, result, {
    subject,
    zEffect: 'resultZero',
    nEffect: direction === 'right' && !rotate ? 'resultNegativeCleared' : 'resultNegative'
  });
  const carryBit = direction === 'left' ? 0x80 : 0x01;
  setFlag(flags, 'C', knownBit(input?.bits, carryBit), makeFlagSource(line, {
    effect: direction === 'left' ? 'carryOutBit7' : 'carryOutBit0',
    subject
  }));
}

export function writeAluFlags(flags, line, result, { subject = null } = {}) {
  writeNZFromResult(flags, line, result, { subject });
  setFlag(flags, 'C', null, makeFlagSource(line, { effect: 'aluCarry', subject }));
  setFlag(flags, 'V', null, makeFlagSource(line, { effect: 'aluOverflow', subject }));
}

export function writeBitFlags(flags, line, aTracked, operandTracked, { subject = null } = {}) {
  const operandSubject = subject || { kind: 'mem', reg: null };
  setFlag(flags, 'N', knownBit(operandTracked?.bits, 0x80), makeFlagSource(line, { effect: 'bitOperand7', subject: operandSubject }));
  setFlag(flags, 'V', knownBit(operandTracked?.bits, 0x40), makeFlagSource(line, { effect: 'bitOperand6', subject: operandSubject }));

  let knownZ = null;
  const aConst = aTracked?.abs?.kind === 'const' ? (aTracked.abs.v & 0xff) : null;
  const opConst = operandTracked?.abs?.kind === 'const' ? (operandTracked.abs.v & 0xff) : null;
  if (aConst !== null && opConst !== null) knownZ = (aConst & opConst) === 0 ? 1 : 0;
  setFlag(flags, 'Z', knownZ, makeFlagSource(line, { effect: 'bitAndZero', subject: operandSubject }));
}

export function flagKnownValue(flags, flag) {
  const value = flags?.[flag]?.knownValue;
  return value === 0 || value === 1 ? value : null;
}
