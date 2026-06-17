import { ADDRESSING_MODES as AM } from '../../cpu6502/addressingModes.js';
import { OPCODES } from '../../cpu6502/opcodes.js';
import {
  MEMORY_ACCESS_LIMITS,
  resolveCpuAddressValuesForInstruction
} from '../semanticFacts/effectiveAddressSets.js';
import { requireInteger, requireObject } from '../dataShape.js';

export const WRITE_EFFECT_KINDS = Object.freeze({
  NO_WRITE: 'noWrite',
  WRITE_TO_CPU_RAM: 'writeToCpuRam',
  WRITE_TO_PPU_REGISTER: 'writeToPpuRegister',
  WRITE_TO_APU_IO: 'writeToApuIo',
  WRITE_TO_PRG_ROM_NON_MAPPING: 'writeToPrgRomNonMapping',
  WRITE_TO_OTHER: 'writeToOther',
  POSSIBLE_MAPPER_WRITE: 'possibleMapperWrite',
  DEFINITE_MAPPER_WRITE: 'definiteMapperWrite',
  UNKNOWN_MAY_AFFECT_MAPPING: 'unknownMayAffectMapping'
});

const STORE_MNEMONICS = new Set(['STA', 'STX', 'STY']);
const MEMORY_RMW_MNEMONICS = new Set(['ASL', 'LSR', 'ROL', 'ROR', 'INC', 'DEC']);

function opcodeEntryForInstruction(instruction) {
  requireObject(instruction, 'write effect instruction');
  requireInteger(instruction.opcode, 'write effect instruction.opcode');
  const entry = OPCODES[instruction.opcode & 0xff];
  if (!entry) return null;
  return entry;
}

function instructionWritesMemory(entry) {
  if (!entry) return false;
  if (STORE_MNEMONICS.has(entry.mnemonic)) return true;
  if (MEMORY_RMW_MNEMONICS.has(entry.mnemonic)) return entry.mode !== AM.ACCUMULATOR;
  return false;
}

function mapperWritesMayAffectCodeMapping(mapper) {
  requireObject(mapper, 'write effect mapper');
  if (typeof mapper.cpuWritesMayAffectCodeMapping === 'function') {
    return mapper.cpuWritesMayAffectCodeMapping() !== false;
  }
  return true;
}

function effectFromMapperTarget(targetKind) {
  if (targetKind === 'possibleMapperWrite') {
    return {
      kind: WRITE_EFFECT_KINDS.POSSIBLE_MAPPER_WRITE,
      targetKind,
      mayAffectCodeMapping: true
    };
  }
  if (targetKind === 'definiteMapperWrite') {
    return {
      kind: WRITE_EFFECT_KINDS.DEFINITE_MAPPER_WRITE,
      targetKind,
      mayAffectCodeMapping: true
    };
  }
  if (targetKind === 'cpuRam') return { kind: WRITE_EFFECT_KINDS.WRITE_TO_CPU_RAM, targetKind, mayAffectCodeMapping: false };
  if (targetKind === 'ppuRegister') return { kind: WRITE_EFFECT_KINDS.WRITE_TO_PPU_REGISTER, targetKind, mayAffectCodeMapping: false };
  if (targetKind === 'apuIo') return { kind: WRITE_EFFECT_KINDS.WRITE_TO_APU_IO, targetKind, mayAffectCodeMapping: false };
  if (targetKind === 'prgRomWrite') return { kind: WRITE_EFFECT_KINDS.WRITE_TO_PRG_ROM_NON_MAPPING, targetKind, mayAffectCodeMapping: false };
  return { kind: WRITE_EFFECT_KINDS.WRITE_TO_OTHER, targetKind: targetKind || 'other', mayAffectCodeMapping: false };
}

export function classifyCpuWriteEffect(mapper, cpuAddr) {
  requireObject(mapper, 'write effect mapper');
  if (!mapperWritesMayAffectCodeMapping(mapper)) {
    return {
      kind: WRITE_EFFECT_KINDS.WRITE_TO_OTHER,
      targetKind: 'codeMappingImmutable',
      mayAffectCodeMapping: false
    };
  }
  if (typeof mapper.classifyWrite !== 'function') {
    return {
      kind: WRITE_EFFECT_KINDS.UNKNOWN_MAY_AFFECT_MAPPING,
      targetKind: 'unknown',
      mayAffectCodeMapping: true
    };
  }
  const targetKind = mapper.classifyWrite(cpuAddr & 0xffff);
  return effectFromMapperTarget(targetKind);
}

function indexedAddressRange(base) {
  const out = [];
  for (let offset = 0; offset <= 0xff; offset += 1) out.push((base + offset) & 0xffff);
  return out;
}

function combineAddressEffects(effects) {
  if (effects.some((effect) => effect.mayAffectCodeMapping)) {
    const definiteOnly = effects.every((effect) => effect.kind === WRITE_EFFECT_KINDS.DEFINITE_MAPPER_WRITE);
    return {
      kind: definiteOnly ? WRITE_EFFECT_KINDS.DEFINITE_MAPPER_WRITE : WRITE_EFFECT_KINDS.POSSIBLE_MAPPER_WRITE,
      targetKind: definiteOnly ? 'definiteMapperWrite' : 'possibleMapperWrite',
      mayAffectCodeMapping: true
    };
  }
  const firstKind = effects[0]?.kind || WRITE_EFFECT_KINDS.WRITE_TO_OTHER;
  if (effects.every((effect) => effect.kind === firstKind)) return effects[0];
  return { kind: WRITE_EFFECT_KINDS.WRITE_TO_OTHER, targetKind: 'mixedNonMapping', mayAffectCodeMapping: false };
}

function classifyResolvedWriteEffect(mapper, state, instruction, env, options = {}) {
  if (!state || !env) return null;
  const resolved = resolveCpuAddressValuesForInstruction(state, instruction, {
    ...MEMORY_ACCESS_LIMITS,
    maxByteValues: 256,
    maxAddressValues: 512,
    ...(options.writeAddressLimits || {})
  });
  if (!resolved.ok || !Array.isArray(resolved.values) || !resolved.values.length) return null;
  return combineAddressEffects(resolved.values.map((addr) => classifyCpuWriteEffect(mapper, addr)));
}

export function classifyInstructionWriteEffect({ mapper, instruction, state = null, env = null, options = {} }) {
  requireObject(instruction, 'instruction write effect instruction');
  const entry = opcodeEntryForInstruction(instruction);
  if (!instructionWritesMemory(entry)) {
    return { kind: WRITE_EFFECT_KINDS.NO_WRITE, targetKind: 'none', mayAffectCodeMapping: false };
  }

  if (!mapperWritesMayAffectCodeMapping(mapper)) {
    return {
      kind: WRITE_EFFECT_KINDS.WRITE_TO_OTHER,
      targetKind: 'codeMappingImmutable',
      mayAffectCodeMapping: false
    };
  }

  const resolvedEffect = classifyResolvedWriteEffect(mapper, state, instruction, env, options);
  if (resolvedEffect) return resolvedEffect;

  switch (entry.mode) {
    case AM.ZERO_PAGE:
    case AM.ZERO_PAGE_X:
    case AM.ZERO_PAGE_Y:
      return { kind: WRITE_EFFECT_KINDS.WRITE_TO_CPU_RAM, targetKind: 'cpuRam', mayAffectCodeMapping: false };

    case AM.ABSOLUTE:
      return classifyCpuWriteEffect(mapper, instruction.operand & 0xffff);

    case AM.ABSOLUTE_X:
    case AM.ABSOLUTE_Y:
      return combineAddressEffects(indexedAddressRange(instruction.operand & 0xffff).map((addr) => classifyCpuWriteEffect(mapper, addr)));

    case AM.INDIRECT_X:
    case AM.INDIRECT_Y:
      return {
        kind: WRITE_EFFECT_KINDS.UNKNOWN_MAY_AFFECT_MAPPING,
        targetKind: 'unknownIndirectWrite',
        mayAffectCodeMapping: true
      };

    default:
      return {
        kind: WRITE_EFFECT_KINDS.UNKNOWN_MAY_AFFECT_MAPPING,
        targetKind: `unsupportedWriteMode:${entry.mode}`,
        mayAffectCodeMapping: true
      };
  }
}
