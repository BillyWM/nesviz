// Official (documented) 6502 opcodes only; illegal/undocumented opcodes are null. 🤖
// The NES CPU (2A03/2A07) is based on NMOS 6502 but without decimal mode; the opcode map is still the same. 🤖

function op(mnemonic, mode) {
  return { mnemonic, mode };
}

// Addressing modes used by this project: 🤖
// imp, acc, imm, zp, zpX, zpY, abs, absX, absY, ind, indX, indY, rel 🤖

export const OPCODES = Array.from({ length: 256 }, () => null);

// 0x00 🤖
OPCODES[0x00] = op('BRK', 'imp');
OPCODES[0x01] = op('ORA', 'indX');
OPCODES[0x05] = op('ORA', 'zp');
OPCODES[0x06] = op('ASL', 'zp');
OPCODES[0x08] = op('PHP', 'imp');
OPCODES[0x09] = op('ORA', 'imm');
OPCODES[0x0A] = op('ASL', 'acc');
OPCODES[0x0D] = op('ORA', 'abs');
OPCODES[0x0E] = op('ASL', 'abs');

// 0x10 🤖
OPCODES[0x10] = op('BPL', 'rel');
OPCODES[0x11] = op('ORA', 'indY');
OPCODES[0x15] = op('ORA', 'zpX');
OPCODES[0x16] = op('ASL', 'zpX');
OPCODES[0x18] = op('CLC', 'imp');
OPCODES[0x19] = op('ORA', 'absY');
OPCODES[0x1D] = op('ORA', 'absX');
OPCODES[0x1E] = op('ASL', 'absX');

// 0x20 🤖
OPCODES[0x20] = op('JSR', 'abs');
OPCODES[0x21] = op('AND', 'indX');
OPCODES[0x24] = op('BIT', 'zp');
OPCODES[0x25] = op('AND', 'zp');
OPCODES[0x26] = op('ROL', 'zp');
OPCODES[0x28] = op('PLP', 'imp');
OPCODES[0x29] = op('AND', 'imm');
OPCODES[0x2A] = op('ROL', 'acc');
OPCODES[0x2C] = op('BIT', 'abs');
OPCODES[0x2D] = op('AND', 'abs');
OPCODES[0x2E] = op('ROL', 'abs');

// 0x30 🤖
OPCODES[0x30] = op('BMI', 'rel');
OPCODES[0x31] = op('AND', 'indY');
OPCODES[0x35] = op('AND', 'zpX');
OPCODES[0x36] = op('ROL', 'zpX');
OPCODES[0x38] = op('SEC', 'imp');
OPCODES[0x39] = op('AND', 'absY');
OPCODES[0x3D] = op('AND', 'absX');
OPCODES[0x3E] = op('ROL', 'absX');

// 0x40 🤖
OPCODES[0x40] = op('RTI', 'imp');
OPCODES[0x41] = op('EOR', 'indX');
OPCODES[0x45] = op('EOR', 'zp');
OPCODES[0x46] = op('LSR', 'zp');
OPCODES[0x48] = op('PHA', 'imp');
OPCODES[0x49] = op('EOR', 'imm');
OPCODES[0x4A] = op('LSR', 'acc');
OPCODES[0x4C] = op('JMP', 'abs');
OPCODES[0x4D] = op('EOR', 'abs');
OPCODES[0x4E] = op('LSR', 'abs');

// 0x50 🤖
OPCODES[0x50] = op('BVC', 'rel');
OPCODES[0x51] = op('EOR', 'indY');
OPCODES[0x55] = op('EOR', 'zpX');
OPCODES[0x56] = op('LSR', 'zpX');
OPCODES[0x58] = op('CLI', 'imp');
OPCODES[0x59] = op('EOR', 'absY');
OPCODES[0x5D] = op('EOR', 'absX');
OPCODES[0x5E] = op('LSR', 'absX');

// 0x60 🤖
OPCODES[0x60] = op('RTS', 'imp');
OPCODES[0x61] = op('ADC', 'indX');
OPCODES[0x65] = op('ADC', 'zp');
OPCODES[0x66] = op('ROR', 'zp');
OPCODES[0x68] = op('PLA', 'imp');
OPCODES[0x69] = op('ADC', 'imm');
OPCODES[0x6A] = op('ROR', 'acc');
OPCODES[0x6C] = op('JMP', 'ind');
OPCODES[0x6D] = op('ADC', 'abs');
OPCODES[0x6E] = op('ROR', 'abs');

// 0x70 🤖
OPCODES[0x70] = op('BVS', 'rel');
OPCODES[0x71] = op('ADC', 'indY');
OPCODES[0x75] = op('ADC', 'zpX');
OPCODES[0x76] = op('ROR', 'zpX');
OPCODES[0x78] = op('SEI', 'imp');
OPCODES[0x79] = op('ADC', 'absY');
OPCODES[0x7D] = op('ADC', 'absX');
OPCODES[0x7E] = op('ROR', 'absX');

// 0x80 🤖
OPCODES[0x81] = op('STA', 'indX');
OPCODES[0x84] = op('STY', 'zp');
OPCODES[0x85] = op('STA', 'zp');
OPCODES[0x86] = op('STX', 'zp');
OPCODES[0x88] = op('DEY', 'imp');
OPCODES[0x8A] = op('TXA', 'imp');
OPCODES[0x8C] = op('STY', 'abs');
OPCODES[0x8D] = op('STA', 'abs');
OPCODES[0x8E] = op('STX', 'abs');

// 0x90 🤖
OPCODES[0x90] = op('BCC', 'rel');
OPCODES[0x91] = op('STA', 'indY');
OPCODES[0x94] = op('STY', 'zpX');
OPCODES[0x95] = op('STA', 'zpX');
OPCODES[0x96] = op('STX', 'zpY');
OPCODES[0x98] = op('TYA', 'imp');
OPCODES[0x99] = op('STA', 'absY');
OPCODES[0x9A] = op('TXS', 'imp');
OPCODES[0x9D] = op('STA', 'absX');

// 0xA0 🤖
OPCODES[0xA0] = op('LDY', 'imm');
OPCODES[0xA1] = op('LDA', 'indX');
OPCODES[0xA2] = op('LDX', 'imm');
OPCODES[0xA4] = op('LDY', 'zp');
OPCODES[0xA5] = op('LDA', 'zp');
OPCODES[0xA6] = op('LDX', 'zp');
OPCODES[0xA8] = op('TAY', 'imp');
OPCODES[0xA9] = op('LDA', 'imm');
OPCODES[0xAA] = op('TAX', 'imp');
OPCODES[0xAC] = op('LDY', 'abs');
OPCODES[0xAD] = op('LDA', 'abs');
OPCODES[0xAE] = op('LDX', 'abs');

// 0xB0 🤖
OPCODES[0xB0] = op('BCS', 'rel');
OPCODES[0xB1] = op('LDA', 'indY');
OPCODES[0xB4] = op('LDY', 'zpX');
OPCODES[0xB5] = op('LDA', 'zpX');
OPCODES[0xB6] = op('LDX', 'zpY');
OPCODES[0xB8] = op('CLV', 'imp');
OPCODES[0xB9] = op('LDA', 'absY');
OPCODES[0xBA] = op('TSX', 'imp');
OPCODES[0xBC] = op('LDY', 'absX');
OPCODES[0xBD] = op('LDA', 'absX');
OPCODES[0xBE] = op('LDX', 'absY');

// 0xC0 🤖
OPCODES[0xC0] = op('CPY', 'imm');
OPCODES[0xC1] = op('CMP', 'indX');
OPCODES[0xC4] = op('CPY', 'zp');
OPCODES[0xC5] = op('CMP', 'zp');
OPCODES[0xC6] = op('DEC', 'zp');
OPCODES[0xC8] = op('INY', 'imp');
OPCODES[0xC9] = op('CMP', 'imm');
OPCODES[0xCA] = op('DEX', 'imp');
OPCODES[0xCC] = op('CPY', 'abs');
OPCODES[0xCD] = op('CMP', 'abs');
OPCODES[0xCE] = op('DEC', 'abs');

// 0xD0 🤖
OPCODES[0xD0] = op('BNE', 'rel');
OPCODES[0xD1] = op('CMP', 'indY');
OPCODES[0xD5] = op('CMP', 'zpX');
OPCODES[0xD6] = op('DEC', 'zpX');
OPCODES[0xD8] = op('CLD', 'imp');
OPCODES[0xD9] = op('CMP', 'absY');
OPCODES[0xDD] = op('CMP', 'absX');
OPCODES[0xDE] = op('DEC', 'absX');

// 0xE0 🤖
OPCODES[0xE0] = op('CPX', 'imm');
OPCODES[0xE1] = op('SBC', 'indX');
OPCODES[0xE4] = op('CPX', 'zp');
OPCODES[0xE5] = op('SBC', 'zp');
OPCODES[0xE6] = op('INC', 'zp');
OPCODES[0xE8] = op('INX', 'imp');
OPCODES[0xE9] = op('SBC', 'imm');
OPCODES[0xEA] = op('NOP', 'imp');
OPCODES[0xEC] = op('CPX', 'abs');
OPCODES[0xED] = op('SBC', 'abs');
OPCODES[0xEE] = op('INC', 'abs');

// 0xF0 🤖
OPCODES[0xF0] = op('BEQ', 'rel');
OPCODES[0xF1] = op('SBC', 'indY');
OPCODES[0xF5] = op('SBC', 'zpX');
OPCODES[0xF6] = op('INC', 'zpX');
OPCODES[0xF8] = op('SED', 'imp');
OPCODES[0xF9] = op('SBC', 'absY');
OPCODES[0xFD] = op('SBC', 'absX');
OPCODES[0xFE] = op('INC', 'absX');

