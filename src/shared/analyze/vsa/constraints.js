import { pFilter } from './prov.js';
import { vFilterEq, vFilterNe, vFilterLt, vFilterGe, vFilterSign, vIsEmpty } from './value.js';
import { cloneState, makeTracked } from './state.js';
import { flagReadByBranchMnemonic, branchTakenWhen } from './flags.js';

function getReg(state, reg) {
  return state[reg] || makeTracked();
}

function applyRegFilter(baseTracked, absFiltered, pred) {
  const bitsBase = baseTracked.bits || { knownMask: 0, knownValue: 0 };
  let bits = { ...bitsBase };

  if (absFiltered?.kind === 'const') {
    bits = { knownMask: 0xff, knownValue: absFiltered.v & 0xff };
  } else if (pred?.op === 'neg' || pred?.op === 'pos') {
    const wantNeg = pred.op === 'neg';
    const alreadyKnown = (bits.knownMask & 0x80) !== 0;
    const alreadyNeg = (bits.knownValue & 0x80) !== 0;
    if (!alreadyKnown || alreadyNeg === wantNeg) {
      bits = {
        knownMask: (bits.knownMask | 0x80) & 0xff,
        knownValue: wantNeg ? (bits.knownValue | 0x80) & 0xff : (bits.knownValue & 0x7f) & 0xff
      };
    }
  }

  return {
    abs: absFiltered,
    prov: pFilter(baseTracked.prov, pred),
    bits,
    spanStartRomOff: typeof baseTracked.spanStartRomOff === 'number' ? baseTracked.spanStartRomOff : null
  };
}

function makeEqPred(imm) {
  return { op: '==', imm: imm & 0xff };
}

function makeNePred(imm) {
  return { op: '!=', imm: imm & 0xff };
}

function makeLtPred(imm) {
  return { op: '<', imm: imm & 0xff };
}

function makeGePred(imm) {
  return { op: '>=', imm: imm & 0xff };
}

function makeSignPred(wantNegative) {
  return { op: wantNegative ? 'neg' : 'pos' };
}

function compareSubject(source) {
  return source?.subject?.kind === 'compare' ? source.subject : null;
}

function regResultSubject(source) {
  const subject = source?.subject;
  return subject?.kind === 'reg' && typeof subject.reg === 'string' ? subject.reg : null;
}

function filterFromCompareSource(state, branchMnemonic, source) {
  const subject = compareSubject(source);
  if (!subject || typeof subject.reg !== 'string' || typeof subject.imm !== 'number') return { taken: null, fall: null };

  const reg = subject.reg;
  const imm = subject.imm & 0xff;
  const base = getReg(state, reg);

  if (branchMnemonic === 'BEQ' || branchMnemonic === 'BNE') {
    const takenAbs = branchMnemonic === 'BEQ' ? vFilterEq(base.abs, imm) : vFilterNe(base.abs, imm);
    const fallAbs = branchMnemonic === 'BEQ' ? vFilterNe(base.abs, imm) : vFilterEq(base.abs, imm);
    const taken = cloneState(state);
    const fall = cloneState(state);
    taken[reg] = applyRegFilter(base, takenAbs, branchMnemonic === 'BEQ' ? makeEqPred(imm) : makeNePred(imm));
    fall[reg] = applyRegFilter(base, fallAbs, branchMnemonic === 'BEQ' ? makeNePred(imm) : makeEqPred(imm));
    return { taken, fall };
  }

  if (branchMnemonic === 'BCC' || branchMnemonic === 'BCS') {
    const takenAbs = branchMnemonic === 'BCC' ? vFilterLt(base.abs, imm) : vFilterGe(base.abs, imm);
    const fallAbs = branchMnemonic === 'BCC' ? vFilterGe(base.abs, imm) : vFilterLt(base.abs, imm);
    const taken = cloneState(state);
    const fall = cloneState(state);
    taken[reg] = applyRegFilter(base, takenAbs, branchMnemonic === 'BCC' ? makeLtPred(imm) : makeGePred(imm));
    fall[reg] = applyRegFilter(base, fallAbs, branchMnemonic === 'BCC' ? makeGePred(imm) : makeLtPred(imm));
    return { taken, fall };
  }

  return { taken: null, fall: null };
}

function filterFromResultSource(state, branchMnemonic, source) {
  const reg = regResultSubject(source);
  if (!reg) return { taken: null, fall: null };
  const base = getReg(state, reg);

  if (branchMnemonic === 'BEQ' || branchMnemonic === 'BNE') {
    const takenAbs = branchMnemonic === 'BEQ' ? vFilterEq(base.abs, 0) : vFilterNe(base.abs, 0);
    const fallAbs = branchMnemonic === 'BEQ' ? vFilterNe(base.abs, 0) : vFilterEq(base.abs, 0);
    const taken = cloneState(state);
    const fall = cloneState(state);
    taken[reg] = applyRegFilter(base, takenAbs, branchMnemonic === 'BEQ' ? makeEqPred(0) : makeNePred(0));
    fall[reg] = applyRegFilter(base, fallAbs, branchMnemonic === 'BEQ' ? makeNePred(0) : makeEqPred(0));
    return { taken, fall };
  }

  if (branchMnemonic === 'BMI' || branchMnemonic === 'BPL') {
    const wantNeg = branchMnemonic === 'BMI';
    const takenAbs = vFilterSign(base.abs, wantNeg);
    const fallAbs = vFilterSign(base.abs, !wantNeg);
    const taken = cloneState(state);
    const fall = cloneState(state);
    taken[reg] = applyRegFilter(base, takenAbs, makeSignPred(wantNeg));
    fall[reg] = applyRegFilter(base, fallAbs, makeSignPred(!wantNeg));
    return { taken, fall };
  }

  return { taken: null, fall: null };
}

function isFeasible(state) {
  for (const r of ['A', 'X', 'Y']) {
    if (vIsEmpty(state[r].abs)) return false;
  }
  return true;
}

function constrainFromKnownFlag(state, branchMnemonic, flag, takenWhen) {
  const knownValue = state.flags?.[flag]?.knownValue;
  if (!(knownValue === 0 || knownValue === 1)) return null;
  const taken = knownValue === takenWhen ? cloneState(state) : null;
  const fall = knownValue !== takenWhen ? cloneState(state) : null;
  return { taken, fall };
}

export function constrainBranchEdges(state, branchMnemonic) {
  const flag = flagReadByBranchMnemonic(branchMnemonic);
  const takenWhen = branchTakenWhen(branchMnemonic);
  if (!flag || !(takenWhen === 0 || takenWhen === 1)) return { taken: null, fall: null };

  const source = state.flags?.[flag]?.source || null;

  const fromCompare = filterFromCompareSource(state, branchMnemonic, source);
  if (fromCompare.taken || fromCompare.fall) {
    return {
      taken: fromCompare.taken && isFeasible(fromCompare.taken) ? fromCompare.taken : null,
      fall: fromCompare.fall && isFeasible(fromCompare.fall) ? fromCompare.fall : null
    };
  }

  const fromResult = filterFromResultSource(state, branchMnemonic, source);
  if (fromResult.taken || fromResult.fall) {
    return {
      taken: fromResult.taken && isFeasible(fromResult.taken) ? fromResult.taken : null,
      fall: fromResult.fall && isFeasible(fromResult.fall) ? fromResult.fall : null
    };
  }

  const fromKnownFlag = constrainFromKnownFlag(state, branchMnemonic, flag, takenWhen);
  if (fromKnownFlag) {
    return {
      taken: fromKnownFlag.taken && isFeasible(fromKnownFlag.taken) ? fromKnownFlag.taken : null,
      fall: fromKnownFlag.fall && isFeasible(fromKnownFlag.fall) ? fromKnownFlag.fall : null
    };
  }

  return { taken: null, fall: null };
}
