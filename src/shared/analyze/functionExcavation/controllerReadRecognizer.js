import {
  decodeRawInstructionAtRomOff,
  isRawAbsoluteStoreTo,
  isRawControllerRead,
  isRawHardTerminator,
  nextRawFallthroughRomOff,
  opcodeEntryForInstruction
} from './rawDecode.js';

const STROBE_STORE_OPCODES = new Set([0x8c, 0x8d, 0x8e]);

const STORE_REGISTER_BY_MNEMONIC = Object.freeze({
  STA: 'A',
  STX: 'X',
  STY: 'Y'
});

function registerForStore(instruction) {
  const entry = opcodeEntryForInstruction(instruction);
  return entry ? STORE_REGISTER_BY_MNEMONIC[entry.mnemonic] || null : null;
}

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

export function isRawControllerStrobeAnchorStart(prgBytes, romOff) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('isRawControllerStrobeAnchorStart requires PRG bytes');
  const off = romOff >>> 0;
  if (off + 2 >= prgBytes.length) return false;
  return STROBE_STORE_OPCODES.has(prgBytes[off] & 0xff) &&
    (prgBytes[off + 1] & 0xff) === 0x16 &&
    (prgBytes[off + 2] & 0xff) === 0x40;
}

export function tryMatchRawControllerReadIsland({ prgBytes, startRomOff }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('tryMatchRawControllerReadIsland requires PRG bytes');
  const start = startRomOff >>> 0;
  if (!isRawControllerStrobeAnchorStart(prgBytes, start)) return null;

  const seenRomOffs = new Set();
  let romOff = start;
  let stage = 'firstWrite';
  let firstWrite = null;
  let secondWrite = null;
  let firstWriteRegister = null;
  let secondWriteRegister = null;

  while (romOff < prgBytes.length) {
    if (seenRomOffs.has(romOff)) return null;
    seenRomOffs.add(romOff);

    const decoded = decodeRawInstructionAtRomOff({ prgBytes, romOff });
    if (!decoded.ok) return null;
    const instruction = decoded.instruction;

    if (stage === 'firstWrite') {
      if (!isRawAbsoluteStoreTo(instruction, 0x4016)) return null;
      firstWrite = instruction;
      firstWriteRegister = registerForStore(instruction);
      stage = 'secondWrite';
    } else if (stage === 'secondWrite') {
      if (isRawAbsoluteStoreTo(instruction, 0x4016)) {
        secondWrite = instruction;
        secondWriteRegister = registerForStore(instruction);
        stage = 'readController';
      }
    } else if (stage === 'readController' && isRawControllerRead(instruction)) {
      const read = instruction;
      const evidenceInstructions = [
        makeEvidenceInstruction(firstWrite, 'firstWrite4016', { register: firstWriteRegister, address: 0x4016 }),
        makeEvidenceInstruction(secondWrite, 'secondWrite4016', { register: secondWriteRegister, address: 0x4016 }),
        makeEvidenceInstruction(read, 'readController', { address: read.operand & 0xffff })
      ];
      return {
        kind: 'controllerRead',
        recognitionMode: 'rawControllerIoPattern',
        valueProof: 'notProven',
        anchorStartRomOff: firstWrite.romOff >>> 0,
        anchorEndRomOff: (read.romOff + read.size) >>> 0,
        evidenceRomOffs: evidenceInstructions.map((item) => item.romOff >>> 0),
        evidence: {
          strobeWrites: [
            {
              storeRomOff: firstWrite.romOff >>> 0,
              register: firstWriteRegister,
              address: 0x4016
            },
            {
              storeRomOff: secondWrite.romOff >>> 0,
              register: secondWriteRegister,
              address: 0x4016
            }
          ],
          reads: [{ romOff: read.romOff >>> 0, address: read.operand & 0xffff }],
          instructions: evidenceInstructions
        },
        strength: 'generous'
      };
    }

    if (isRawHardTerminator(instruction)) return null;
    const nextRomOff = nextRawFallthroughRomOff(instruction);
    if (nextRomOff === null) return null;
    romOff = nextRomOff;
  }

  return null;
}

export const controllerReadRecognizer = Object.freeze({
  kind: 'controllerRead',
  label: 'Controller read',
  isEnabled() { return true; },
  isAnchorStart: isRawControllerStrobeAnchorStart,
  tryMatch: tryMatchRawControllerReadIsland
});
