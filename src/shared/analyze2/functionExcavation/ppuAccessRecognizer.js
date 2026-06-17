import { NES_CPU_REGISTER_ADDRS } from '../../nes/namedRegisters.js';

import {
  decodeRawInstructionAtRomOff,
  isRawAbsoluteReadFromCanonicalPpuRegister,
  isRawAbsoluteStaToCanonicalPpuRegister,
  isRawAbsoluteStoreTo,
  isRawAbsoluteStoreToCanonicalPpuRegister,
  isRawControlTransfer,
  isRawHardTerminator,
  isRawImmediateLoad,
  isRawLdaImmediate,
  nextRawFallthroughRomOff,
  opcodeEntryForInstruction,
  rawImmediateLoadRegister
} from './rawDecode.js';

export const PPU_PALETTE_UPLOAD_KIND = 'ppuPaletteUpload';
export const PPU_PALETTE_UPLOAD_SAFETY_KIND = 'ppuPaletteUploadSafety';
export const PPU_ATTRIBUTE_UPLOAD_KIND = 'ppuAttributeUpload';
export const PPU_VRAM_DATA_WRITE_KIND = 'ppuVramDataWrite';
export const PPU_SCROLL_SETUP_KIND = 'ppuScrollSetup';
export const PPU_OAM_DMA_KIND = 'ppuOamDma';

const LDA_IMMEDIATE_OPCODE = 0xa9;
const LDX_IMMEDIATE_OPCODE = 0xa2;
const LDY_IMMEDIATE_OPCODE = 0xa0;
const PPUSTATUS = 0x2002;
const PPUSCROLL = 0x2005;
const PPUADDR = 0x2006;
const PPUDATA = 0x2007;
const OAMDMA = NES_CPU_REGISTER_ADDRS.OAMDMA_4014;
const PALETTE_HIGH_BYTE = 0x3f;
const MAX_UPLOAD_SEARCH_INSTRUCTIONS = 32;
const MAX_SAFETY_SEARCH_INSTRUCTIONS = 96;
const MAX_ADDRESS_SETUP_SEARCH_INSTRUCTIONS = 16;
const MAX_SCROLL_SEARCH_INSTRUCTIONS = 16;
const MAX_OAM_DMA_SEARCH_INSTRUCTIONS = 6;
const SAFETY_LOW_BYTES = new Set([0x00, 0x10, 0x20, 0x30]);
const STATUS_READ_MNEMONICS = new Set(['LDA', 'BIT']);
const ATTRIBUTE_HIGH_BYTES = new Set([0x23, 0x27, 0x2b, 0x2f]);
const IMMEDIATE_LOAD_OPCODES = new Set([LDA_IMMEDIATE_OPCODE, LDX_IMMEDIATE_OPCODE, LDY_IMMEDIATE_OPCODE]);

function makeEvidenceInstruction(instruction, role, extra = null) {
  const entry = opcodeEntryForInstruction(instruction);
  const out = {
    role,
    romOff: instruction.romOff >>> 0,
    opcode: instruction.opcode & 0xff,
    mnemonic: entry ? entry.mnemonic : null,
    operand: instruction.operand === null ? null : instruction.operand >>> 0
  };
  if (extra && typeof extra === 'object') Object.assign(out, extra);
  return out;
}

function decodeRawInstruction(prgBytes, romOff) {
  const decoded = decodeRawInstructionAtRomOff({ prgBytes, romOff: romOff >>> 0 });
  return decoded.ok ? decoded.instruction : null;
}

function nextRomOffAfter(instruction) {
  return ((instruction.romOff >>> 0) + (instruction.size >>> 0)) >>> 0;
}

function isPaletteLowByte(value) {
  return value >= 0x00 && value <= 0x1f;
}

function isAttributeAddress(highByte, lowByte) {
  return ATTRIBUTE_HIGH_BYTES.has(highByte & 0xff) && (lowByte & 0xff) >= 0xc0;
}

function isAttributeHighByte(value) {
  return ATTRIBUTE_HIGH_BYTES.has(value & 0xff);
}

function isVramHighByte(value) {
  return value >= 0x20 && value <= 0x2f;
}

function isGenericVramLowByte(lowByte, highByte) {
  return !isAttributeAddress(highByte, lowByte);
}

function isPpuStatusRead(instruction) {
  return isRawAbsoluteReadFromCanonicalPpuRegister(instruction, PPUSTATUS, STATUS_READ_MNEMONICS);
}

function isPpuStatusReadAnchorStart(prgBytes, romOff) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('PPU recognizer requires PRG bytes');
  const instruction = decodeRawInstruction(prgBytes, romOff >>> 0);
  return instruction !== null && isPpuStatusRead(instruction);
}

function makePaletteAnchorStartPredicate(prgBytes, romOff) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('PPU palette recognizer requires PRG bytes');
  const off = romOff >>> 0;
  if (off + 1 >= prgBytes.length) return false;
  return (prgBytes[off] & 0xff) === LDA_IMMEDIATE_OPCODE && (prgBytes[off + 1] & 0xff) === PALETTE_HIGH_BYTE;
}

function makeAttributeAnchorStartPredicate(prgBytes, romOff) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('PPU attribute recognizer requires PRG bytes');
  const off = romOff >>> 0;
  if (off + 1 >= prgBytes.length) return false;
  return (prgBytes[off] & 0xff) === LDA_IMMEDIATE_OPCODE && isAttributeHighByte(prgBytes[off + 1] & 0xff);
}

function makeOamDmaAnchorStartPredicate(prgBytes, romOff) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('PPU OAMDMA recognizer requires PRG bytes');
  const off = romOff >>> 0;
  if (off + 1 >= prgBytes.length) return false;
  return IMMEDIATE_LOAD_OPCODES.has(prgBytes[off] & 0xff);
}

function matchImmediatePpuaddrPair({ prgBytes, startRomOff, highPredicate, lowPredicate }) {
  const highLoad = decodeRawInstruction(prgBytes, startRomOff);
  if (!highLoad || !isRawLdaImmediate(highLoad)) return null;
  const highByte = highLoad.operand & 0xff;
  if (!highPredicate(highByte)) return null;

  const firstAddrWrite = decodeRawInstruction(prgBytes, nextRomOffAfter(highLoad));
  if (!firstAddrWrite || !isRawAbsoluteStaToCanonicalPpuRegister(firstAddrWrite, PPUADDR)) return null;

  const lowLoad = decodeRawInstruction(prgBytes, nextRomOffAfter(firstAddrWrite));
  if (!lowLoad || !isRawLdaImmediate(lowLoad)) return null;
  const lowByte = lowLoad.operand & 0xff;
  if (!lowPredicate(lowByte, highByte)) return null;

  const secondAddrWrite = decodeRawInstruction(prgBytes, nextRomOffAfter(lowLoad));
  if (!secondAddrWrite || !isRawAbsoluteStaToCanonicalPpuRegister(secondAddrWrite, PPUADDR)) return null;

  return {
    highLoad,
    highByte,
    firstAddrWrite,
    lowLoad,
    secondAddrWrite,
    lowByte,
    endRomOff: nextRomOffAfter(secondAddrWrite)
  };
}

function findImmediatePpuaddrPairAfter({ prgBytes, startRomOff, highPredicate, lowPredicate, maxInstructions }) {
  let romOff = startRomOff >>> 0;
  for (let i = 0; i < maxInstructions && romOff < prgBytes.length; i += 1) {
    const instruction = decodeRawInstruction(prgBytes, romOff);
    if (!instruction) return null;
    if (isRawLdaImmediate(instruction) && highPredicate(instruction.operand & 0xff)) {
      const setup = matchImmediatePpuaddrPair({ prgBytes, startRomOff: romOff, highPredicate, lowPredicate });
      if (setup) return setup;
    }
    if (isRawControlTransfer(instruction)) return null;
    const next = nextRawFallthroughRomOff(instruction);
    if (next === null) return null;
    romOff = next >>> 0;
  }
  return null;
}

function findFirstPpudataWrite({ prgBytes, startRomOff, requireLocalStraightLine = false }) {
  let romOff = startRomOff >>> 0;
  for (let i = 0; i < MAX_UPLOAD_SEARCH_INSTRUCTIONS && romOff < prgBytes.length; i += 1) {
    const instruction = decodeRawInstruction(prgBytes, romOff);
    if (!instruction) return null;
    if (isRawAbsoluteStaToCanonicalPpuRegister(instruction, PPUDATA)) return instruction;
    if (requireLocalStraightLine ? isRawControlTransfer(instruction) : isRawHardTerminator(instruction)) return null;
    const next = nextRawFallthroughRomOff(instruction);
    if (next === null) return null;
    romOff = next >>> 0;
  }
  return null;
}

function matchPaletteSafetySequenceAt({ prgBytes, startRomOff }) {
  const safetyAddress = matchImmediatePpuaddrPair({
    prgBytes,
    startRomOff,
    highPredicate: (value) => value === PALETTE_HIGH_BYTE,
    lowPredicate: (value) => SAFETY_LOW_BYTES.has(value & 0xff)
  });
  if (!safetyAddress) return null;

  const thirdAddrWrite = decodeRawInstruction(prgBytes, safetyAddress.endRomOff);
  if (!thirdAddrWrite || !isRawAbsoluteStaToCanonicalPpuRegister(thirdAddrWrite, PPUADDR)) return null;

  const fourthAddrWrite = decodeRawInstruction(prgBytes, nextRomOffAfter(thirdAddrWrite));
  if (!fourthAddrWrite || !isRawAbsoluteStaToCanonicalPpuRegister(fourthAddrWrite, PPUADDR)) return null;

  return {
    ...safetyAddress,
    thirdAddrWrite,
    fourthAddrWrite,
    endRomOff: nextRomOffAfter(fourthAddrWrite)
  };
}

function findPaletteSafetySequenceAfter({ prgBytes, startRomOff }) {
  let romOff = startRomOff >>> 0;
  for (let i = 0; i < MAX_SAFETY_SEARCH_INSTRUCTIONS && romOff < prgBytes.length; i += 1) {
    const instruction = decodeRawInstruction(prgBytes, romOff);
    if (!instruction) return null;
    if (isRawLdaImmediate(instruction, PALETTE_HIGH_BYTE)) {
      const safety = matchPaletteSafetySequenceAt({ prgBytes, startRomOff: romOff });
      if (safety) return safety;
    }
    if (isRawHardTerminator(instruction)) return null;
    const next = nextRawFallthroughRomOff(instruction);
    if (next === null) return null;
    romOff = next >>> 0;
  }
  return null;
}

function makePpuaddrSetupEvidence(prefix, setup) {
  return [
    makeEvidenceInstruction(setup.highLoad, `${prefix}HighLoad`, { value: setup.highByte & 0xff }),
    makeEvidenceInstruction(setup.firstAddrWrite, `${prefix}HighAddrWrite`, { canonicalAddress: PPUADDR }),
    makeEvidenceInstruction(setup.lowLoad, `${prefix}LowLoad`, { value: setup.lowByte & 0xff }),
    makeEvidenceInstruction(setup.secondAddrWrite, `${prefix}LowAddrWrite`, { canonicalAddress: PPUADDR })
  ];
}

function makeUploadMatch({ kind, recognitionMode, valueProof, uploadSetup, ppudataWrite, safety = null, statusRead = null, strength = 'strong' }) {
  const statusEvidence = statusRead ? [makeEvidenceInstruction(statusRead, 'ppuStatusRead', { canonicalAddress: PPUSTATUS })] : [];
  const uploadEvidence = makePpuaddrSetupEvidence('ppuAddress', uploadSetup);
  uploadEvidence.push(makeEvidenceInstruction(ppudataWrite, 'ppuDataWrite', { canonicalAddress: PPUDATA }));

  const safetyEvidence = safety ? [
    ...makePpuaddrSetupEvidence('paletteSafety', safety),
    makeEvidenceInstruction(safety.thirdAddrWrite, 'paletteSafetyThirdAddrWrite', { canonicalAddress: PPUADDR }),
    makeEvidenceInstruction(safety.fourthAddrWrite, 'paletteSafetyFourthAddrWrite', { canonicalAddress: PPUADDR })
  ] : [];

  const evidenceInstructions = [...statusEvidence, ...uploadEvidence, ...safetyEvidence];
  const anchorStartRomOff = statusRead ? statusRead.romOff : uploadSetup.highLoad.romOff;
  const anchorEndRomOff = safety ? safety.endRomOff : nextRomOffAfter(ppudataWrite);
  const vramAddress = ((uploadSetup.highByte & 0xff) << 8) | (uploadSetup.lowByte & 0xff);

  return {
    kind,
    recognitionMode,
    valueProof,
    anchorStartRomOff: anchorStartRomOff >>> 0,
    anchorEndRomOff: anchorEndRomOff >>> 0,
    evidenceRomOffs: evidenceInstructions.map((item) => item.romOff >>> 0),
    evidence: {
      vramAddress,
      highByte: uploadSetup.highByte & 0xff,
      lowByte: uploadSetup.lowByte & 0xff,
      hasStatusRead: statusRead !== null,
      hasSafetySequence: safety !== null,
      safetyLowByte: safety ? safety.lowByte & 0xff : null,
      instructions: evidenceInstructions
    },
    strength
  };
}

function matchPaletteUploadBase({ prgBytes, startRomOff }) {
  const uploadSetup = matchImmediatePpuaddrPair({
    prgBytes,
    startRomOff,
    highPredicate: (value) => value === PALETTE_HIGH_BYTE,
    lowPredicate: isPaletteLowByte
  });
  if (!uploadSetup) return null;

  const ppudataWrite = findFirstPpudataWrite({
    prgBytes,
    startRomOff: uploadSetup.endRomOff
  });
  if (!ppudataWrite) return null;

  return { uploadSetup, ppudataWrite };
}

function matchAttributeUploadBase({ prgBytes, startRomOff }) {
  const uploadSetup = matchImmediatePpuaddrPair({
    prgBytes,
    startRomOff,
    highPredicate: isAttributeHighByte,
    lowPredicate: (lowByte, highByte) => isAttributeAddress(highByte, lowByte)
  });
  if (!uploadSetup) return null;

  const ppudataWrite = findFirstPpudataWrite({
    prgBytes,
    startRomOff: uploadSetup.endRomOff,
    requireLocalStraightLine: true
  });
  if (!ppudataWrite) return null;

  return { uploadSetup, ppudataWrite };
}

function rawRegisterClobberedByInstruction(instruction, register) {
  const entry = opcodeEntryForInstruction(instruction);
  if (!entry) return true;
  const mnemonic = entry.mnemonic;
  if (register === 'A') {
    if (mnemonic === 'LDA' || mnemonic === 'ADC' || mnemonic === 'AND' || mnemonic === 'EOR' || mnemonic === 'ORA' || mnemonic === 'PLA' || mnemonic === 'SBC' || mnemonic === 'TXA' || mnemonic === 'TYA') return true;
    return (mnemonic === 'ASL' || mnemonic === 'LSR' || mnemonic === 'ROL' || mnemonic === 'ROR') && entry.mode === 'acc';
  }
  if (register === 'X') return mnemonic === 'LDX' || mnemonic === 'DEX' || mnemonic === 'INX' || mnemonic === 'TAX' || mnemonic === 'TSX';
  if (register === 'Y') return mnemonic === 'LDY' || mnemonic === 'DEY' || mnemonic === 'INY' || mnemonic === 'TAY';
  return true;
}

export function isRawPpuPaletteUploadAnchorStart(prgBytes, romOff) {
  return makePaletteAnchorStartPredicate(prgBytes, romOff);
}

export function tryMatchRawPpuPaletteUploadIsland({ prgBytes, startRomOff }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('tryMatchRawPpuPaletteUploadIsland requires PRG bytes');
  const base = matchPaletteUploadBase({ prgBytes, startRomOff: startRomOff >>> 0 });
  if (!base) return null;
  return makeUploadMatch({
    kind: PPU_PALETTE_UPLOAD_KIND,
    recognitionMode: 'paletteUploadImmediate3fPpuaddrThenPpudata',
    valueProof: 'immediatePaletteAddress',
    uploadSetup: base.uploadSetup,
    ppudataWrite: base.ppudataWrite
  });
}

export function tryMatchRawPpuPaletteUploadSafetyIsland({ prgBytes, startRomOff }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('tryMatchRawPpuPaletteUploadSafetyIsland requires PRG bytes');
  const base = matchPaletteUploadBase({ prgBytes, startRomOff: startRomOff >>> 0 });
  if (!base) return null;

  const safety = findPaletteSafetySequenceAfter({
    prgBytes,
    startRomOff: nextRomOffAfter(base.ppudataWrite)
  });
  if (!safety) return null;

  return makeUploadMatch({
    kind: PPU_PALETTE_UPLOAD_SAFETY_KIND,
    recognitionMode: 'paletteUploadWithPaletteSafetySequence',
    valueProof: 'immediatePaletteAddressWithSafetySequence',
    uploadSetup: base.uploadSetup,
    ppudataWrite: base.ppudataWrite,
    safety,
    strength: 'veryStrong'
  });
}

export function isRawPpuAttributeUploadAnchorStart(prgBytes, romOff) {
  return makeAttributeAnchorStartPredicate(prgBytes, romOff);
}

export function tryMatchRawPpuAttributeUploadIsland({ prgBytes, startRomOff }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('tryMatchRawPpuAttributeUploadIsland requires PRG bytes');
  const base = matchAttributeUploadBase({ prgBytes, startRomOff: startRomOff >>> 0 });
  if (!base) return null;
  return makeUploadMatch({
    kind: PPU_ATTRIBUTE_UPLOAD_KIND,
    recognitionMode: 'attributeAddressThenPpudata',
    valueProof: 'immediateAttributeAddress',
    uploadSetup: base.uploadSetup,
    ppudataWrite: base.ppudataWrite,
    strength: 'veryStrong'
  });
}

export function isRawPpuVramDataWriteAnchorStart(prgBytes, romOff) {
  return isPpuStatusReadAnchorStart(prgBytes, romOff);
}

export function tryMatchRawPpuVramDataWriteIsland({ prgBytes, startRomOff }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('tryMatchRawPpuVramDataWriteIsland requires PRG bytes');
  const statusRead = decodeRawInstruction(prgBytes, startRomOff >>> 0);
  if (!statusRead || !isPpuStatusRead(statusRead)) return null;

  const uploadSetup = findImmediatePpuaddrPairAfter({
    prgBytes,
    startRomOff: nextRomOffAfter(statusRead),
    highPredicate: isVramHighByte,
    lowPredicate: isGenericVramLowByte,
    maxInstructions: MAX_ADDRESS_SETUP_SEARCH_INSTRUCTIONS
  });
  if (!uploadSetup) return null;

  const ppudataWrite = findFirstPpudataWrite({
    prgBytes,
    startRomOff: uploadSetup.endRomOff,
    requireLocalStraightLine: true
  });
  if (!ppudataWrite) return null;

  return makeUploadMatch({
    kind: PPU_VRAM_DATA_WRITE_KIND,
    recognitionMode: 'ppuStatusLatchResetImmediateVramAddressThenPpudata',
    valueProof: 'statusReadImmediateVramAddress',
    statusRead,
    uploadSetup,
    ppudataWrite
  });
}

export function isRawPpuScrollSetupAnchorStart(prgBytes, romOff) {
  return isPpuStatusReadAnchorStart(prgBytes, romOff);
}

export function tryMatchRawPpuScrollSetupIsland({ prgBytes, startRomOff }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('tryMatchRawPpuScrollSetupIsland requires PRG bytes');
  const statusRead = decodeRawInstruction(prgBytes, startRomOff >>> 0);
  if (!statusRead || !isPpuStatusRead(statusRead)) return null;

  const scrollWrites = [];
  const evidenceInstructions = [makeEvidenceInstruction(statusRead, 'ppuStatusRead', { canonicalAddress: PPUSTATUS })];
  let romOff = nextRomOffAfter(statusRead);
  for (let i = 0; i < MAX_SCROLL_SEARCH_INSTRUCTIONS && romOff < prgBytes.length; i += 1) {
    const instruction = decodeRawInstruction(prgBytes, romOff);
    if (!instruction) return null;
    if (isRawAbsoluteStoreToCanonicalPpuRegister(instruction, PPUSCROLL)) {
      scrollWrites.push(instruction);
      evidenceInstructions.push(makeEvidenceInstruction(instruction, `scrollWrite${scrollWrites.length}`, { canonicalAddress: PPUSCROLL }));
      if (scrollWrites.length === 2) {
        return {
          kind: PPU_SCROLL_SETUP_KIND,
          recognitionMode: 'ppuStatusLatchResetThenTwoPpuscrollWrites',
          valueProof: 'statusReadTwoScrollWrites',
          anchorStartRomOff: statusRead.romOff >>> 0,
          anchorEndRomOff: nextRomOffAfter(instruction),
          evidenceRomOffs: evidenceInstructions.map((item) => item.romOff >>> 0),
          evidence: {
            statusReadRomOff: statusRead.romOff >>> 0,
            scrollWrites: scrollWrites.map((item) => item.romOff >>> 0),
            instructions: evidenceInstructions
          },
          strength: 'strong'
        };
      }
    }
    if (isRawControlTransfer(instruction)) return null;
    const next = nextRawFallthroughRomOff(instruction);
    if (next === null) return null;
    romOff = next >>> 0;
  }
  return null;
}

export function isRawPpuOamDmaAnchorStart(prgBytes, romOff) {
  return makeOamDmaAnchorStartPredicate(prgBytes, romOff);
}

export function tryMatchRawPpuOamDmaIsland({ prgBytes, startRomOff }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('tryMatchRawPpuOamDmaIsland requires PRG bytes');
  const load = decodeRawInstruction(prgBytes, startRomOff >>> 0);
  if (!load || !isRawImmediateLoad(load)) return null;
  const register = rawImmediateLoadRegister(load);
  const pageValue = load.operand & 0xff;

  let romOff = nextRomOffAfter(load);
  for (let i = 0; i < MAX_OAM_DMA_SEARCH_INSTRUCTIONS && romOff < prgBytes.length; i += 1) {
    const instruction = decodeRawInstruction(prgBytes, romOff);
    if (!instruction) return null;
    if (isRawAbsoluteStoreTo(instruction, OAMDMA, register)) {
      const evidenceInstructions = [
        makeEvidenceInstruction(load, 'dmaPageLoad', { register, value: pageValue }),
        makeEvidenceInstruction(instruction, 'oamDmaWrite', { register, address: OAMDMA })
      ];
      return {
        kind: PPU_OAM_DMA_KIND,
        recognitionMode: 'immediatePageStoreToOamDma',
        valueProof: 'immediateDmaPage',
        anchorStartRomOff: load.romOff >>> 0,
        anchorEndRomOff: nextRomOffAfter(instruction),
        evidenceRomOffs: evidenceInstructions.map((item) => item.romOff >>> 0),
        evidence: {
          sourceRegister: register,
          pageValue,
          loadRomOff: load.romOff >>> 0,
          storeRomOff: instruction.romOff >>> 0,
          instructions: evidenceInstructions
        },
        strength: 'strong'
      };
    }
    if (isRawControlTransfer(instruction)) return null;
    if (rawRegisterClobberedByInstruction(instruction, register)) return null;
    const next = nextRawFallthroughRomOff(instruction);
    if (next === null) return null;
    romOff = next >>> 0;
  }
  return null;
}

export const ppuPaletteUploadSafetyRecognizer = Object.freeze({
  kind: PPU_PALETTE_UPLOAD_SAFETY_KIND,
  label: 'PPU palette upload with safety sequence',
  isEnabled() { return true; },
  isAnchorStart: isRawPpuPaletteUploadAnchorStart,
  tryMatch: tryMatchRawPpuPaletteUploadSafetyIsland
});

export const ppuPaletteUploadRecognizer = Object.freeze({
  kind: PPU_PALETTE_UPLOAD_KIND,
  label: 'PPU palette upload',
  isEnabled() { return true; },
  isAnchorStart: isRawPpuPaletteUploadAnchorStart,
  tryMatch: tryMatchRawPpuPaletteUploadIsland
});

export const ppuAttributeUploadRecognizer = Object.freeze({
  kind: PPU_ATTRIBUTE_UPLOAD_KIND,
  label: 'PPU attribute upload',
  isEnabled() { return true; },
  isAnchorStart: isRawPpuAttributeUploadAnchorStart,
  tryMatch: tryMatchRawPpuAttributeUploadIsland
});

export const ppuVramDataWriteRecognizer = Object.freeze({
  kind: PPU_VRAM_DATA_WRITE_KIND,
  label: 'PPU VRAM data write',
  isEnabled() { return true; },
  isAnchorStart: isRawPpuVramDataWriteAnchorStart,
  tryMatch: tryMatchRawPpuVramDataWriteIsland
});

export const ppuScrollSetupRecognizer = Object.freeze({
  kind: PPU_SCROLL_SETUP_KIND,
  label: 'PPU scroll setup',
  isEnabled() { return true; },
  isAnchorStart: isRawPpuScrollSetupAnchorStart,
  tryMatch: tryMatchRawPpuScrollSetupIsland
});

export const ppuOamDmaRecognizer = Object.freeze({
  kind: PPU_OAM_DMA_KIND,
  label: 'PPU OAMDMA',
  isEnabled() { return true; },
  isAnchorStart: isRawPpuOamDmaAnchorStart,
  tryMatch: tryMatchRawPpuOamDmaIsland
});

export const ppuAccessRecognizers = Object.freeze([
  ppuPaletteUploadSafetyRecognizer,
  ppuPaletteUploadRecognizer,
  ppuAttributeUploadRecognizer,
  ppuVramDataWriteRecognizer,
  ppuScrollSetupRecognizer,
  ppuOamDmaRecognizer
]);
