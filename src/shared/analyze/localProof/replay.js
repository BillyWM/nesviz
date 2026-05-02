import { addImm, andImm, const8, orImm, shl1, shr1, unknown8, valueSet, xorImm } from './values.js';

function cloneDeps(deps) {
  return new Set(deps || []);
}

function makeCell(value = unknown8(), deps = []) {
  return { value, deps: cloneDeps(deps) };
}

function cloneCell(cell) {
  return makeCell(cell?.value || unknown8(), cell?.deps || []);
}

function cloneState(state) {
  const zp = new Map();
  for (const [addr, cell] of state.zp.entries()) zp.set(addr, cloneCell(cell));
  return {
    A: cloneCell(state.A),
    X: cloneCell(state.X),
    Y: cloneCell(state.Y),
    zp
  };
}

function initialState() {
  return { A: makeCell(), X: makeCell(), Y: makeCell(), zp: new Map() };
}

function tokenForReg(reg) {
  if (reg === 'A' || reg === 'X' || reg === 'Y') return reg;
  return null;
}

function getReg(state, reg) {
  const key = tokenForReg(reg);
  return key ? state[key] : makeCell();
}

function setReg(state, reg, cell) {
  const key = tokenForReg(reg);
  if (!key) return;
  state[key] = cloneCell(cell);
}

function withLineDep(cell, lineIndex, value = cell?.value || unknown8()) {
  const deps = cloneDeps(cell?.deps || []);
  deps.add(lineIndex);
  return makeCell(value, deps);
}

function readOperand8(line) {
  const bytes = Array.isArray(line?.bytes) ? line.bytes : [];
  return bytes.length > 1 ? (bytes[1] & 0xff) : null;
}

function loadRegisterForMnemonic(mnemonic) {
  if (mnemonic === 'LDA') return 'A';
  if (mnemonic === 'LDX') return 'X';
  if (mnemonic === 'LDY') return 'Y';
  return null;
}

function storeRegisterForMnemonic(mnemonic) {
  if (mnemonic === 'STA') return 'A';
  if (mnemonic === 'STX') return 'X';
  if (mnemonic === 'STY') return 'Y';
  return null;
}

function transfer(line, state, lineIndex, fromReg, toReg) {
  const from = getReg(state, fromReg);
  setReg(state, toReg, withLineDep(from, lineIndex, from.value));
}

function transformA(state, lineIndex, transform) {
  const a = getReg(state, 'A');
  setReg(state, 'A', withLineDep(a, lineIndex, transform(a.value)));
}

function deltaReg(state, reg, lineIndex, delta) {
  const cell = getReg(state, reg);
  setReg(state, reg, withLineDep(cell, lineIndex, addImm(cell.value, delta)));
}

function executeLine(state, line, lineIndex) {
  const mnemonic = typeof line?.mnemonic === 'string' ? line.mnemonic : '';
  const mode = typeof line?.mode === 'string' ? line.mode : '';

  const loadReg = loadRegisterForMnemonic(mnemonic);
  if (loadReg) {
    if (mode === 'imm') {
      const imm = readOperand8(line);
      setReg(state, loadReg, makeCell(imm == null ? unknown8() : const8(imm), [lineIndex]));
    } else {
      setReg(state, loadReg, makeCell(unknown8(), [lineIndex]));
    }
    return;
  }

  if (mnemonic === 'TAX') return transfer(line, state, lineIndex, 'A', 'X');
  if (mnemonic === 'TAY') return transfer(line, state, lineIndex, 'A', 'Y');
  if (mnemonic === 'TXA') return transfer(line, state, lineIndex, 'X', 'A');
  if (mnemonic === 'TYA') return transfer(line, state, lineIndex, 'Y', 'A');

  if (mnemonic === 'AND' && mode === 'imm') {
    const imm = readOperand8(line);
    return transformA(state, lineIndex, (value) => (imm == null ? unknown8() : andImm(value, imm)));
  }
  if (mnemonic === 'ORA' && mode === 'imm') {
    const imm = readOperand8(line);
    return transformA(state, lineIndex, (value) => (imm == null ? unknown8() : orImm(value, imm)));
  }
  if (mnemonic === 'EOR' && mode === 'imm') {
    const imm = readOperand8(line);
    return transformA(state, lineIndex, (value) => (imm == null ? unknown8() : xorImm(value, imm)));
  }
  if (mnemonic === 'ASL' && mode === 'acc') return transformA(state, lineIndex, shl1);
  if (mnemonic === 'LSR' && mode === 'acc') return transformA(state, lineIndex, shr1);
  if ((mnemonic === 'ROL' || mnemonic === 'ROR') && mode === 'acc') return transformA(state, lineIndex, () => unknown8());

  if (mnemonic === 'INX') return deltaReg(state, 'X', lineIndex, 1);
  if (mnemonic === 'DEX') return deltaReg(state, 'X', lineIndex, -1);
  if (mnemonic === 'INY') return deltaReg(state, 'Y', lineIndex, 1);
  if (mnemonic === 'DEY') return deltaReg(state, 'Y', lineIndex, -1);

  const storeReg = storeRegisterForMnemonic(mnemonic);
  if (storeReg && mode === 'zp') {
    const zpAddr = readOperand8(line);
    if (zpAddr != null) state.zp.set(zpAddr & 0xff, withLineDep(getReg(state, storeReg), lineIndex, getReg(state, storeReg).value));
    return;
  }

  if (mnemonic === 'ADC' || mnemonic === 'SBC') {
    return transformA(state, lineIndex, () => unknown8());
  }
}

export function replayLocalPath({ block, startLineIndex = 0, endLineIndex = null }) {
  const lines = Array.isArray(block?.lines) ? block.lines : [];
  const start = Math.max(0, startLineIndex | 0);
  const end = Math.min(lines.length - 1, endLineIndex == null ? lines.length - 1 : (endLineIndex | 0));
  const state = initialState();
  const statesBefore = new Map();
  const statesAfter = new Map();

  for (let i = 0; i < lines.length; i++) {
    if (i < start) continue;
    if (i > end) break;
    statesBefore.set(i, cloneState(state));
    executeLine(state, lines[i], i);
    statesAfter.set(i, cloneState(state));
  }

  return { ok: true, statesBefore, statesAfter };
}

export function cellValuesAt(replay, lineIndex, token) {
  const state = replay?.statesBefore?.get(lineIndex | 0);
  if (!state) return null;
  const reg = tokenForReg(token);
  if (reg) return valueSet(state[reg]?.value || unknown8());
  return null;
}

export function cellDepsAt(replay, lineIndex, token) {
  const state = replay?.statesBefore?.get(lineIndex | 0);
  if (!state) return [];
  const reg = tokenForReg(token);
  if (reg) return Array.from(state[reg]?.deps || []).sort((a, b) => a - b);
  return [];
}
