import { EDGE_KINDS } from '../cfg/constants.js';
import { FLAG_VALUE } from './flagsDomain.js';

export const BRANCH_PREDICATES = Object.freeze({
  BEQ: Object.freeze({ flag: 'z', value: FLAG_VALUE.TRUE }),
  BNE: Object.freeze({ flag: 'z', value: FLAG_VALUE.FALSE }),
  BMI: Object.freeze({ flag: 'n', value: FLAG_VALUE.TRUE }),
  BPL: Object.freeze({ flag: 'n', value: FLAG_VALUE.FALSE }),
  BCS: Object.freeze({ flag: 'c', value: FLAG_VALUE.TRUE }),
  BCC: Object.freeze({ flag: 'c', value: FLAG_VALUE.FALSE }),
  BVS: Object.freeze({ flag: 'v', value: FLAG_VALUE.TRUE }),
  BVC: Object.freeze({ flag: 'v', value: FLAG_VALUE.FALSE })
});

export function isConditionalBranchMnemonic(mnemonic) {
  return Object.prototype.hasOwnProperty.call(BRANCH_PREDICATES, mnemonic);
}

export function getBranchPredicateForMnemonic(mnemonic) {
  const predicate = BRANCH_PREDICATES[mnemonic] || null;
  return predicate ? { ...predicate } : null;
}

export function invertBranchPredicate(predicate) {
  if (!predicate) return null;
  if (predicate.value === FLAG_VALUE.TRUE) return { flag: predicate.flag, value: FLAG_VALUE.FALSE };
  if (predicate.value === FLAG_VALUE.FALSE) return { flag: predicate.flag, value: FLAG_VALUE.TRUE };
  return null;
}

export function predicateForBranchEdge(mnemonic, edgeKind) {
  const predicate = getBranchPredicateForMnemonic(mnemonic);
  if (!predicate) return null;
  if (edgeKind === EDGE_KINDS.BRANCH_TAKEN) return predicate;
  if (edgeKind === EDGE_KINDS.BRANCH_NOT_TAKEN) return invertBranchPredicate(predicate);
  return null;
}

export function getFixedFlagEffect(mnemonic) {
  if (mnemonic === 'CLC') return { c: FLAG_VALUE.FALSE };
  if (mnemonic === 'SEC') return { c: FLAG_VALUE.TRUE };
  if (mnemonic === 'CLV') return { v: FLAG_VALUE.FALSE };
  if (mnemonic === 'CLD') return { d: FLAG_VALUE.FALSE };
  if (mnemonic === 'SED') return { d: FLAG_VALUE.TRUE };
  if (mnemonic === 'CLI') return { i: FLAG_VALUE.FALSE };
  if (mnemonic === 'SEI') return { i: FLAG_VALUE.TRUE };
  return null;
}

export function getRegisterUpdateFlagEffect(mnemonic) {
  if (mnemonic === 'INX') return { kind: 'nzFromRegisterResult', registerName: 'x', direction: 'up' };
  if (mnemonic === 'INY') return { kind: 'nzFromRegisterResult', registerName: 'y', direction: 'up' };
  if (mnemonic === 'DEX') return { kind: 'nzFromRegisterResult', registerName: 'x', direction: 'down' };
  if (mnemonic === 'DEY') return { kind: 'nzFromRegisterResult', registerName: 'y', direction: 'down' };
  return null;
}

export function getCompareRegisterForMnemonic(mnemonic) {
  if (mnemonic === 'CMP') return 'a';
  if (mnemonic === 'CPX') return 'x';
  if (mnemonic === 'CPY') return 'y';
  return null;
}

export function flagsWrittenByMnemonic(mnemonic) {
  if (getRegisterUpdateFlagEffect(mnemonic)) return new Set(['n', 'z']);
  if (getCompareRegisterForMnemonic(mnemonic)) return new Set(['n', 'z', 'c']);
  if (mnemonic === 'BIT') return new Set(['n', 'v', 'z']);
  if (mnemonic === 'CLC' || mnemonic === 'SEC') return new Set(['c']);
  if (mnemonic === 'CLV') return new Set(['v']);
  if (mnemonic === 'CLD' || mnemonic === 'SED') return new Set(['d']);
  if (mnemonic === 'CLI' || mnemonic === 'SEI') return new Set(['i']);
  if (mnemonic === 'LDA' || mnemonic === 'LDX' || mnemonic === 'LDY') return new Set(['n', 'z']);
  if (mnemonic === 'TAX' || mnemonic === 'TAY' || mnemonic === 'TXA' || mnemonic === 'TYA' || mnemonic === 'TSX') return new Set(['n', 'z']);
  if (mnemonic === 'PLA') return new Set(['n', 'z']);
  if (mnemonic === 'INC' || mnemonic === 'DEC') return new Set(['n', 'z']);
  if (mnemonic === 'ASL' || mnemonic === 'LSR' || mnemonic === 'ROL' || mnemonic === 'ROR') return new Set(['n', 'z', 'c']);
  if (mnemonic === 'AND' || mnemonic === 'ORA' || mnemonic === 'EOR') return new Set(['n', 'z']);
  if (mnemonic === 'ADC' || mnemonic === 'SBC') return new Set(['n', 'v', 'z', 'c']);
  if (mnemonic === 'PLP' || mnemonic === 'RTI') return new Set(['n', 'v', 'd', 'i', 'z', 'c']);
  return new Set();
}
