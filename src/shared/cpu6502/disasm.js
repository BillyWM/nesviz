import { OPCODES } from './opcodes.js';
import { hex2, hex4 } from './fmt.js';

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
  // We classify only the control-flow relevant instructions here; everything else is "fallthrough". 🤖
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
    // JMP (addr) uses a 16-bit pointer stored in CPU memory; on NMOS 6502 there is a page-wrap quirk for addr=$xxFF. 🤖
    // We keep the pointer address here; later phases decide whether we can resolve it statically (e.g., if addr is in zero page). 🤖
    return { type: 'jmp_ind', ptrAddr: u16le(bytes, 1) };
  }

  if (mnemonic === 'RTS') return { type: 'stop', reason: 'rts' };
  if (mnemonic === 'RTI') return { type: 'stop', reason: 'rti' };
  if (mnemonic === 'BRK') return { type: 'stop', reason: 'brk' };

  return { type: 'next', next: (pc + len) & 0xffff };
}

export function disasmOne(prgBytes, pc, romOff) {
  // disasmOne decodes a single instruction at CPU address pc. 🤖
  // romOff is the resolved PRG ROM offset for this pc under a mapping context; it is used to fetch bytes from the file. 🤖
  const opByte = prgBytes[romOff];
  const entry = OPCODES[opByte];

  if (!entry) {
    return {
      ok: false,
      pc,
      romOff,
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
    pc,
    romOff,
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

export function disasmOneAt(prgBytes, mapper, pc) {
  // Resolve CPU address -> PRG ROM offset for the current mapping context, then decode. 🤖
  // If the address is unmapped (e.g. RAM or bank not currently mapped), return ok:false so discovery stops that path. 🤖
  const romOff = mapper.cpuToRomOff(pc & 0xffff);
  if (romOff == null) {
    return {
      ok: false,
      pc: pc & 0xffff,
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
  return disasmOne(prgBytes, pc & 0xffff, romOff);
}
