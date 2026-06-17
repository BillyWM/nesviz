import { ADDRESSING_MODES as AM } from '../../cpu6502/addressingModes.js';

function blockConfidence(block) {
  return block?.confidence === 'probable' ? 'probable' : 'certain';
}

export function shouldIncludeMarkovBlock(block, source) {
  const confidence = blockConfidence(block);
  if (source === 'probablePlus') return confidence === 'certain' || confidence === 'probable';
  return confidence === 'certain';
}

function getInstructionLinesForBlock(block) {
  const lines = Array.isArray(block?.lines) ? block.lines : [];
  return lines.filter((line) => Array.isArray(line?.bytes) && line.bytes.length > 0);
}

export function getOpcodeSequenceForBlock(block) {
  const sequence = [];
  for (const line of getInstructionLinesForBlock(block)) {
    const opcode = Number(line.bytes[0]);
    if (!Number.isFinite(opcode)) continue;
    sequence.push(opcode & 0xff);
  }
  return sequence;
}

export function getMnemonicSequenceForBlock(block) {
  const sequence = [];
  for (const line of getInstructionLinesForBlock(block)) {
    const mnemonic = typeof line?.mnemonic === 'string' && line.mnemonic.trim()
      ? line.mnemonic.trim().toUpperCase()
      : '???';
    sequence.push(mnemonic);
  }
  return sequence;
}

export function getAddressingSequenceForBlock(block) {
  const sequence = [];
  for (const line of getInstructionLinesForBlock(block)) {
    const mode = typeof line?.mode === 'string' && line.mode.trim()
      ? line.mode.trim()
      : 'unknown';
    sequence.push(mode);
  }
  return sequence;
}

export function getInstructionCountForBlock(block) {
  return getInstructionLinesForBlock(block).length;
}

function classifyAbsoluteCpuTarget(cpuAddr) {
  const addr = Number(cpuAddr);
  if (!Number.isFinite(addr)) return {
    zeroPage: 0,
    ram: 0,
    io: 0,
    mapperRom: 0
  };
  const a = addr & 0xffff;
  return {
    zeroPage: a <= 0x00ff ? 1 : 0,
    ram: a <= 0x1fff ? 1 : 0,
    io: a >= 0x2000 && a <= 0x401f ? 1 : 0,
    mapperRom: a >= 0x4020 ? 1 : 0
  };
}

function u16le(bytes, offset = 0) {
  const lo = Number(bytes?.[offset]) || 0;
  const hi = Number(bytes?.[offset + 1]) || 0;
  return ((hi & 0xff) << 8) | (lo & 0xff);
}

export function getMemoryScalarFeaturesForBlock(block) {
  const lines = getInstructionLinesForBlock(block);
  const instructionCount = lines.length;
  if (!instructionCount) {
    return {
      zeroPageAccessFraction: 0,
      ramAccessFraction: 0,
      ioAccessFraction: 0,
      mapperRomAccessFraction: 0,
      indirectAccessFraction: 0
    };
  }

  let zeroPageCount = 0;
  let ramCount = 0;
  let ioCount = 0;
  let mapperRomCount = 0;
  let indirectCount = 0;

  for (const line of lines) {
    const mode = typeof line?.mode === 'string' ? line.mode : '';
    const bytes = Array.isArray(line?.bytes) ? line.bytes : [];
    switch (mode) {
      case AM.ZERO_PAGE:
      case AM.ZERO_PAGE_X:
      case AM.ZERO_PAGE_Y:
        zeroPageCount += 1;
        ramCount += 1;
        break;
      case AM.INDIRECT_X:
      case AM.INDIRECT_Y:
        zeroPageCount += 1;
        ramCount += 1;
        indirectCount += 1;
        break;
      case AM.INDIRECT: {
        indirectCount += 1;
        const classes = classifyAbsoluteCpuTarget(u16le(bytes, 1));
        zeroPageCount += classes.zeroPage;
        ramCount += classes.ram;
        ioCount += classes.io;
        mapperRomCount += classes.mapperRom;
        break;
      }
      case AM.ABSOLUTE:
      case AM.ABSOLUTE_X:
      case AM.ABSOLUTE_Y: {
        const classes = classifyAbsoluteCpuTarget(u16le(bytes, 1));
        zeroPageCount += classes.zeroPage;
        ramCount += classes.ram;
        ioCount += classes.io;
        mapperRomCount += classes.mapperRom;
        break;
      }
      default:
        break;
    }
  }

  return {
    zeroPageAccessFraction: zeroPageCount / instructionCount,
    ramAccessFraction: ramCount / instructionCount,
    ioAccessFraction: ioCount / instructionCount,
    mapperRomAccessFraction: mapperRomCount / instructionCount,
    indirectAccessFraction: indirectCount / instructionCount
  };
}

export function getMarkovSequenceForBlock(block, family = 'opcode') {
  if (family === 'mnemonic') return getMnemonicSequenceForBlock(block);
  if (family === 'addressing') return getAddressingSequenceForBlock(block);
  return getOpcodeSequenceForBlock(block);
}

export function collectMarkovSequencesFromBlocks(blocks, source = 'confirmed', family = 'opcode') {
  const safeBlocks = Array.isArray(blocks) ? blocks : [];
  const sequences = [];
  let usedBlockCount = 0;
  let usedInstructionCount = 0;

  for (const block of safeBlocks) {
    if (!shouldIncludeMarkovBlock(block, source)) continue;
    const sequence = getMarkovSequenceForBlock(block, family);
    if (!sequence.length) continue;
    sequences.push(sequence);
    usedBlockCount += 1;
    usedInstructionCount += sequence.length;
  }

  return {
    sequences,
    usedBlockCount,
    usedInstructionCount
  };
}

export function collectOpcodeSequencesFromBlocks(blocks, source = 'confirmed') {
  return collectMarkovSequencesFromBlocks(blocks, source, 'opcode');
}
