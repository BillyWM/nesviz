import { OPCODES } from './opcodes.js';
import { hex2, hex4 } from './fmt.js';
import { exactBacking, fetchCtxKey, siteKeyFor, unknownBacking } from '../analyze/fetchContext.js';

const MODE_LEN = {
  imp: 1,
  acc: 1,
  imm: 2,
  zp: 2,
  zpX: 2,
  zpY: 2,
  abs: 3,
  absX: 3,
  absY: 3,
  ind: 3,
  indX: 2,
  indY: 2,
  rel: 2
};

const BRANCHES = new Set(['BPL', 'BMI', 'BVC', 'BVS', 'BCC', 'BCS', 'BNE', 'BEQ']);

function u16le(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8)) & 0xffff;
}

function s8(n) {
  const b = n & 0xff;
  return b < 0x80 ? b : b - 0x100;
}

function fmtOperand(mode, bytes, pc) {
  switch (mode) {
    case 'imp':
      return '';
    case 'acc':
      return 'A';
    case 'imm':
      return `#$${hex2(bytes[1])}`;
    case 'zp':
      return `$${hex2(bytes[1])}`;
    case 'zpX':
      return `$${hex2(bytes[1])},X`;
    case 'zpY':
      return `$${hex2(bytes[1])},Y`;
    case 'abs':
      return `$${hex4(u16le(bytes, 1))}`;
    case 'absX':
      return `$${hex4(u16le(bytes, 1))},X`;
    case 'absY':
      return `$${hex4(u16le(bytes, 1))},Y`;
    case 'ind':
      return `($${hex4(u16le(bytes, 1))})`;
    case 'indX':
      return `($${hex2(bytes[1])},X)`;
    case 'indY':
      return `($${hex2(bytes[1])}),Y`;
    case 'rel': {
      const target = (pc + 2 + s8(bytes[1])) & 0xffff;
      return `$${hex4(target)}`;
    }
    default:
      return '';
  }
}

function flowInfo(mnemonic, mode, bytes, pc, len) {
  if (BRANCHES.has(mnemonic) && mode === 'rel') {
    const target = (pc + 2 + s8(bytes[1])) & 0xffff;
    return { type: 'branch', mnemonic, target, fallthrough: (pc + 2) & 0xffff };
  }

  if (mnemonic === 'JSR' && mode === 'abs') {
    const target = u16le(bytes, 1);
    return { type: 'call', target, fallthrough: (pc + len) & 0xffff };
  }

  if (mnemonic === 'JMP' && mode === 'abs') {
    return { type: 'jump', target: u16le(bytes, 1) };
  }

  if (mnemonic === 'JMP' && mode === 'ind') {
    return { type: 'jmp_ind', ptrAddr: u16le(bytes, 1) };
  }

  if (mnemonic === 'RTS') return { type: 'stop', reason: 'rts' };
  if (mnemonic === 'RTI') return { type: 'stop', reason: 'rti' };
  if (mnemonic === 'BRK') return { type: 'stop', reason: 'brk' };

  return { type: 'next', next: (pc + len) & 0xffff };
}

export function disasmOne(prgBytes, pc, romOff, extra = null) {
  const opByte = prgBytes[romOff];
  const entry = OPCODES[opByte];
  const ctxKey = extra?.ctxKey || 'nrom:fixed';
  const backing = extra?.backing || exactBacking(romOff);
  const base = {
    pc,
    cpuAddr: pc & 0xffff,
    ctxKey,
    siteKey: siteKeyFor(ctxKey, pc & 0xffff),
    backing,
    romOff
  };

  if (!entry) {
    return {
      ok: false,
      ...base,
      op: opByte,
      mnemonic: '???',
      mode: 'imp',
      len: 1,
      bytes: [opByte],
      bytesText: hex2(opByte),
      text: '???',
      flow: { type: 'illegal' }
    };
  }

  const len = MODE_LEN[entry.mode] ?? 1;
  const bytes = Array.from(prgBytes.subarray(romOff, romOff + len));
  const bytesText = bytes.map(hex2).join(' ');
  const operand = fmtOperand(entry.mode, bytes, pc);
  const text = operand ? `${entry.mnemonic} ${operand}` : entry.mnemonic;

  return {
    ok: true,
    ...base,
    op: opByte,
    mnemonic: entry.mnemonic,
    mode: entry.mode,
    len,
    bytes,
    bytesText,
    text,
    flow: flowInfo(entry.mnemonic, entry.mode, bytes, pc, len)
  };
}

export function disasmOneAtCtx(prgBytes, mapper, fetchCtx, pc) {
  const resolved = mapper.resolveCodeFetch
    ? mapper.resolveCodeFetch(fetchCtx, pc & 0xffff)
    : { ok: true, ctxKey: fetchCtxKey(fetchCtx), backing: exactBacking(mapper.cpuToRomOff(pc & 0xffff)) };
  const romOff = resolved?.backing?.kind === 'exact' ? resolved.backing.romOff : null;
  const ctxKey = resolved?.ctxKey || fetchCtxKey(fetchCtx);
  if (!resolved?.ok || romOff == null) {
    return {
      ok: false,
      pc: pc & 0xffff,
      cpuAddr: pc & 0xffff,
      ctxKey,
      siteKey: siteKeyFor(ctxKey, pc & 0xffff),
      backing: resolved?.backing || unknownBacking(),
      romOff: null,
      op: null,
      mnemonic: '???',
      mode: 'imp',
      len: 1,
      bytes: [],
      bytesText: '',
      text: 'unmapped',
      flow: { type: 'unmapped' }
    };
  }
  return disasmOne(prgBytes, pc & 0xffff, romOff, {
    ctxKey,
    backing: resolved.backing || exactBacking(romOff)
  });
}

export function disasmOneAt(prgBytes, mapper, pc) {
  const fetchCtx = mapper?.initialFetchCtx ? mapper.initialFetchCtx() : null;
  return disasmOneAtCtx(prgBytes, mapper, fetchCtx, pc);
}
