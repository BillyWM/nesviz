import { pFilter } from './prov.js';
import { vFilterEq, vFilterNe, vFilterLt, vFilterGe, vFilterSign, vIsEmpty } from './value.js';
import { cloneState, makeTracked } from './state.js';

// Branch constraint refinement. 🤖
//
// Goal: take cheap flag-adjacency facts (CMP/CPX/CPY #imm, or last NZ-producing op) and use them to
// narrow abstract values on each outgoing edge of a conditional branch. 🤖
//
// This is *not* a full 6502 flags model; it's an adjacency heuristic that preserves soundness by
// only applying constraints when we are confident about the predicate source. 🤖

function getReg(state, reg) {
  return state[reg] || makeTracked();
}

function applyRegFilter(baseTracked, absFiltered, pred) {
  // Preserve bits + spanStart across value refinements.
  // If we refined to a single constant, we can upgrade bits to fully-known.
  const bitsBase = baseTracked.bits || { knownMask: 0, knownValue: 0 };
  let bits = { ...bitsBase };

  if (absFiltered?.kind === 'const') {
    bits = { knownMask: 0xff, knownValue: absFiltered.v & 0xff };
  } else if (pred?.op === 'neg' || pred?.op === 'pos') {
    // We can safely set the sign bit when filtering by BMI/BPL, as long as it doesn't conflict.
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

function filterFromCompare(state, branchMnemonic) {
  const cmp = state.lastCmp;
  if (!cmp) return { taken: null, fall: null };

  const base = getReg(state, cmp.reg);
  const imm = cmp.imm & 0xff;

  // BEQ/BNE after CMP: equality/non-equality of the compared register. 🤖
  if (branchMnemonic === 'BEQ' || branchMnemonic === 'BNE') {
    const takenAbs = branchMnemonic === 'BEQ' ? vFilterEq(base.abs, imm) : vFilterNe(base.abs, imm);
    const fallAbs = branchMnemonic === 'BEQ' ? vFilterNe(base.abs, imm) : vFilterEq(base.abs, imm);
    const taken = cloneState(state);
    const fall = cloneState(state);
    taken[cmp.reg] = applyRegFilter(base, takenAbs, branchMnemonic === 'BEQ' ? makeEqPred(imm) : makeNePred(imm));
    fall[cmp.reg] = applyRegFilter(base, fallAbs, branchMnemonic === 'BEQ' ? makeNePred(imm) : makeEqPred(imm));
    taken.lastCmp = null;
    fall.lastCmp = null;
    return { taken, fall };
  }

  // BCC/BCS after CMP: unsigned < / >=. 🤖
  if (branchMnemonic === 'BCC' || branchMnemonic === 'BCS') {
    const takenAbs = branchMnemonic === 'BCC' ? vFilterLt(base.abs, imm) : vFilterGe(base.abs, imm);
    const fallAbs = branchMnemonic === 'BCC' ? vFilterGe(base.abs, imm) : vFilterLt(base.abs, imm);
    const taken = cloneState(state);
    const fall = cloneState(state);
    taken[cmp.reg] = applyRegFilter(base, takenAbs, branchMnemonic === 'BCC' ? makeLtPred(imm) : makeGePred(imm));
    fall[cmp.reg] = applyRegFilter(base, fallAbs, branchMnemonic === 'BCC' ? makeGePred(imm) : makeLtPred(imm));
    taken.lastCmp = null;
    fall.lastCmp = null;
    return { taken, fall };
  }

  return { taken: null, fall: null };
}

function filterFromNZ(state, branchMnemonic) {
  const nz = state.lastNZ;
  if (!nz) return { taken: null, fall: null };
  const base = getReg(state, nz.reg);

  if (branchMnemonic === 'BEQ' || branchMnemonic === 'BNE') {
    const takenAbs = branchMnemonic === 'BEQ' ? vFilterEq(base.abs, 0) : vFilterNe(base.abs, 0);
    const fallAbs = branchMnemonic === 'BEQ' ? vFilterNe(base.abs, 0) : vFilterEq(base.abs, 0);
    const taken = cloneState(state);
    const fall = cloneState(state);
    taken[nz.reg] = applyRegFilter(base, takenAbs, branchMnemonic === 'BEQ' ? makeEqPred(0) : makeNePred(0));
    fall[nz.reg] = applyRegFilter(base, fallAbs, branchMnemonic === 'BEQ' ? makeNePred(0) : makeEqPred(0));
    return { taken, fall };
  }

  if (branchMnemonic === 'BMI' || branchMnemonic === 'BPL') {
    const wantNeg = branchMnemonic === 'BMI';
    const takenAbs = vFilterSign(base.abs, wantNeg);
    const fallAbs = vFilterSign(base.abs, !wantNeg);
    const taken = cloneState(state);
    const fall = cloneState(state);
    taken[nz.reg] = applyRegFilter(base, takenAbs, makeSignPred(wantNeg));
    fall[nz.reg] = applyRegFilter(base, fallAbs, makeSignPred(!wantNeg));
    return { taken, fall };
  }

  return { taken: null, fall: null };
}

function isFeasible(state) {
  // If any tracked register is explicitly empty, treat the state as infeasible for propagation. 🤖
  const regs = ['A', 'X', 'Y'];
  for (const r of regs) {
    if (vIsEmpty(state[r].abs)) return false;
  }
  return true;
}

export function constrainBranchEdges(state, branchMnemonic) {
  // Prefer compare-derived facts over NZ-derived facts when both exist. 🤖
  const fromCmp = filterFromCompare(state, branchMnemonic);
  if (fromCmp.taken || fromCmp.fall) {
    return {
      taken: fromCmp.taken && isFeasible(fromCmp.taken) ? fromCmp.taken : null,
      fall: fromCmp.fall && isFeasible(fromCmp.fall) ? fromCmp.fall : null
    };
  }

  const fromNz = filterFromNZ(state, branchMnemonic);
  return {
    taken: fromNz.taken && isFeasible(fromNz.taken) ? fromNz.taken : null,
    fall: fromNz.fall && isFeasible(fromNz.fall) ? fromNz.fall : null
  };
}
