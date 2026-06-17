import {
  decodeRawInstructionAtRomOff,
  isRawAbsoluteStaToPrgSpace,
  isRawAccumulatorLsr,
  opcodeEntryForInstruction
} from './rawDecode.js';

export const MMC1_SERIAL_WRITE_KIND = 'mmc1SerialWrite';

const STA_ABSOLUTE_OPCODE = 0x8d;
const LSR_ACCUMULATOR_OPCODE = 0x4a;

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

function isMmc1Context(context) {
  if (!context || typeof context !== 'object') return false;
  const mapper = context.mapper && typeof context.mapper === 'object' ? context.mapper : null;
  if (mapper && mapper.id === 'mmc1') return true;
  const mapperMeta = context.mapperMeta && typeof context.mapperMeta === 'object' ? context.mapperMeta : null;
  if (!mapperMeta) return false;
  if (mapperMeta.prgWindowModel === 'mmc1-variable') return true;
  if (mapperMeta.mapperFamily === 'MMC1') return true;
  if (mapperMeta.boardFamily === 'MMC1') return true;
  return false;
}

export function isRawMmc1SerialWriteAnchorStart(prgBytes, romOff) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('isRawMmc1SerialWriteAnchorStart requires PRG bytes');
  const off = romOff >>> 0;
  if (off + 2 >= prgBytes.length) return false;
  if ((prgBytes[off] & 0xff) !== STA_ABSOLUTE_OPCODE) return false;
  const cpuAddr = (prgBytes[off + 1] & 0xff) | ((prgBytes[off + 2] & 0xff) << 8);
  return cpuAddr >= 0x8000 && cpuAddr <= 0xffff;
}

export function tryMatchRawMmc1SerialWriteIsland({ prgBytes, startRomOff }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('tryMatchRawMmc1SerialWriteIsland requires PRG bytes');
  const start = startRomOff >>> 0;
  if (!isRawMmc1SerialWriteAnchorStart(prgBytes, start)) return null;

  const writes = [];
  const shifts = [];
  const evidenceInstructions = [];
  let writeAddress = null;
  let romOff = start;

  for (let step = 0; step < 9; step += 1) {
    const decoded = decodeRawInstructionAtRomOff({ prgBytes, romOff });
    if (!decoded.ok) return null;
    const instruction = decoded.instruction;
    const expectWrite = (step % 2) === 0;

    if (expectWrite) {
      if (!isRawAbsoluteStaToPrgSpace(instruction)) return null;
      const operand = instruction.operand & 0xffff;
      if (writeAddress === null) writeAddress = operand;
      if (operand !== writeAddress) return null;
      writes.push(instruction.romOff >>> 0);
      evidenceInstructions.push(makeEvidenceInstruction(instruction, `write${writes.length}`, { address: operand }));
    } else {
      if ((instruction.opcode & 0xff) !== LSR_ACCUMULATOR_OPCODE || !isRawAccumulatorLsr(instruction)) return null;
      shifts.push(instruction.romOff >>> 0);
      evidenceInstructions.push(makeEvidenceInstruction(instruction, `shift${shifts.length}`, { register: 'A' }));
    }

    romOff = ((instruction.romOff >>> 0) + (instruction.size >>> 0)) >>> 0;
  }

  return {
    kind: MMC1_SERIAL_WRITE_KIND,
    recognitionMode: 'fiveStaSameAddressWithLsrA',
    valueProof: 'notProven',
    anchorStartRomOff: start,
    anchorEndRomOff: romOff >>> 0,
    evidenceRomOffs: evidenceInstructions.map((item) => item.romOff >>> 0),
    evidence: {
      writeAddress,
      writes: writes.slice(),
      shifts: shifts.slice(),
      instructions: evidenceInstructions
    },
    strength: 'strong'
  };
}

export const mmc1SerialWriteRecognizer = Object.freeze({
  kind: MMC1_SERIAL_WRITE_KIND,
  label: 'MMC1 serial write',
  isEnabled: isMmc1Context,
  isAnchorStart: isRawMmc1SerialWriteAnchorStart,
  tryMatch: tryMatchRawMmc1SerialWriteIsland
});
