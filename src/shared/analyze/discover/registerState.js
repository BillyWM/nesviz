function exactValue(value) {
  return { kind: 'exact', value: value & 0xff };
}

function unknownValue() {
  return { kind: 'unknown' };
}

function cloneValueState(v) {
  if (!v || v.kind === 'unknown') return unknownValue();
  if (v.kind === 'exact') return exactValue(v.value);
  if (v.kind === 'set') return { kind: 'set', values: Array.from(new Set((v.values || []).map((n) => n & 0xff))).sort((a, b) => a - b) };
  return unknownValue();
}

export function initialRegisterState() {
  return {
    A: unknownValue(),
    X: unknownValue(),
    Y: unknownValue()
  };
}

export function cloneRegisterState(state) {
  return {
    A: cloneValueState(state?.A),
    X: cloneValueState(state?.X),
    Y: cloneValueState(state?.Y)
  };
}

function applyImmOp(prev, op, imm) {
  if (!prev || prev.kind === 'unknown') return unknownValue();
  if (prev.kind === 'exact') {
    if (op === 'AND') return exactValue(prev.value & imm);
    if (op === 'ORA') return exactValue(prev.value | imm);
    if (op === 'EOR') return exactValue(prev.value ^ imm);
  }
  if (prev.kind === 'set') {
    const mapped = Array.from(new Set((prev.values || []).map((v) => {
      if (op === 'AND') return v & imm;
      if (op === 'ORA') return v | imm;
      if (op === 'EOR') return v ^ imm;
      return v;
    }))).sort((a, b) => a - b);
    return mapped.length === 1 ? exactValue(mapped[0]) : { kind: 'set', values: mapped };
  }
  return unknownValue();
}

export function evalInstructionIntoRegisterState(instr, state) {
  const next = cloneRegisterState(state);
  const bytes = Array.isArray(instr?.bytes) ? instr.bytes : [];
  const imm = bytes.length > 1 ? (bytes[1] & 0xff) : 0;

  switch (instr?.mnemonic) {
    case 'LDA':
      if (instr.mode === 'imm') next.A = exactValue(imm);
      else next.A = unknownValue();
      break;
    case 'LDX':
      if (instr.mode === 'imm') next.X = exactValue(imm);
      else next.X = unknownValue();
      break;
    case 'LDY':
      if (instr.mode === 'imm') next.Y = exactValue(imm);
      else next.Y = unknownValue();
      break;
    case 'TAX': next.X = cloneValueState(next.A); break;
    case 'TXA': next.A = cloneValueState(next.X); break;
    case 'TAY': next.Y = cloneValueState(next.A); break;
    case 'TYA': next.A = cloneValueState(next.Y); break;
    case 'AND':
    case 'ORA':
    case 'EOR':
      if (instr.mode === 'imm') next.A = applyImmOp(next.A, instr.mnemonic, imm);
      else next.A = unknownValue();
      break;
    case 'PLA':
    case 'ADC':
    case 'SBC':
    case 'ROL':
    case 'ROR':
    case 'ASL':
    case 'LSR':
    case 'INC':
    case 'DEC':
    case 'CMP':
    case 'CPX':
    case 'CPY':
      if (instr.mnemonic !== 'CPX') next.A = unknownValue();
      break;
    default:
      break;
  }
  return next;
}

export function valueStateForStore(instr, state) {
  switch (instr?.mnemonic) {
    case 'STA': return cloneValueState(state?.A);
    case 'STX': return cloneValueState(state?.X);
    case 'STY': return cloneValueState(state?.Y);
    default: return unknownValue();
  }
}
