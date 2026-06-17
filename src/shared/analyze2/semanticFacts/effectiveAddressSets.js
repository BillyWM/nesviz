import { ADDRESSING_MODES as AM } from '../../cpu6502/addressingModes.js';
import { OPCODES } from '../../cpu6502/opcodes.js';
import { canonicalizeCpuAddr } from '../../utils/addressUtils.js';
import { abstractByteFromSerializable } from '../abstractInterpretation/abstractByteDomain.js';
import { scalarToValues } from '../abstractInterpretation/byteScalarDomain.js';
import { readByteAt } from '../abstractInterpretation/byteMemory.js';
import { resolveMapperCpuAddress } from '../domains/mapper/mapperDomain.js';
import { requireObject } from '../dataShape.js';

export const MEMORY_ACCESS_LIMITS = Object.freeze({
  maxByteValues: 64,
  maxAddressValues: 256,
  maxPointerValues: 16,
  maxRomOffValues: 256
});

const READ_MNEMONICS = new Set([
  'LDA', 'LDX', 'LDY',
  'CMP', 'CPX', 'CPY',
  'ADC', 'SBC', 'AND', 'ORA', 'EOR',
  'BIT'
]);
const WRITE_MNEMONICS = new Set(['STA', 'STX', 'STY']);
const READ_WRITE_MNEMONICS = new Set(['ASL', 'LSR', 'ROL', 'ROR', 'INC', 'DEC']);

function uniqueSorted(values) {
  return Array.from(new Set(values.map((value) => Number(value) & 0xffff))).sort((a, b) => a - b);
}

function uniqueSortedRom(values) {
  return Array.from(new Set(values.map((value) => Number(value) >>> 0))).sort((a, b) => a - b);
}

function byteAllowsValue(byte, value) {
  const normalized = abstractByteFromSerializable(byte);
  if (normalized.bits?.kind === 'bottom') return false;
  const scalarValues = scalarToValues(normalized.scalar, 256);
  if (!scalarValues) return false;
  if (!scalarValues.includes(value & 0xff)) return false;
  if (!normalized.bits || normalized.bits.kind !== 'bits') return true;
  return ((value & normalized.bits.knownMask) === normalized.bits.knownValue);
}

export function enumerateByteValues(byte, maxValues = MEMORY_ACCESS_LIMITS.maxByteValues) {
  const normalized = abstractByteFromSerializable(byte);
  if (normalized.bits?.kind === 'bottom') return [];

  const scalarValues = scalarToValues(normalized.scalar, 256);
  if (!scalarValues) return null;

  const out = [];
  for (const value of scalarValues) {
    if (!byteAllowsValue(normalized, value)) continue;
    out.push(value & 0xff);
    if (out.length > maxValues) return null;
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

function registerByte(state, name) {
  return state?.registers?.[name];
}

function indexedAdd(base, indexValues, options = {}) {
  const zeroPage = options.zeroPage === true;
  const out = [];
  for (const index of indexValues) out.push(zeroPage ? ((base + index) & 0xff) : ((base + index) & 0xffff));
  return uniqueSorted(out);
}

function pointerValuesFromZp(state, zpAddr, limits) {
  const lowValues = enumerateByteValues(readByteAt(state.ramBytes, zpAddr & 0xff), limits.maxPointerValues);
  const highValues = enumerateByteValues(readByteAt(state.ramBytes, (zpAddr + 1) & 0xff), limits.maxPointerValues);
  if (!lowValues || !highValues || !lowValues.length || !highValues.length) return null;
  const out = [];
  for (const low of lowValues) {
    for (const high of highValues) {
      out.push(((high << 8) | low) & 0xffff);
      if (out.length > limits.maxPointerValues) return null;
    }
  }
  return uniqueSorted(out);
}

export function memoryAccessKindForInstruction(instruction) {
  const entry = OPCODES[instruction.opcode & 0xff];
  if (!entry) return null;
  if (entry.mode === AM.IMPLIED || entry.mode === AM.ACCUMULATOR || entry.mode === AM.IMMEDIATE || entry.mode === AM.RELATIVE || entry.mode === AM.INDIRECT) return null;
  if (WRITE_MNEMONICS.has(entry.mnemonic)) return 'write';
  if (READ_WRITE_MNEMONICS.has(entry.mnemonic)) return 'readWrite';
  if (READ_MNEMONICS.has(entry.mnemonic)) return 'read';
  return null;
}

export function opcodeEntryForAccess(instruction) {
  return OPCODES[instruction.opcode & 0xff] || null;
}

export function resolveCpuAddressValuesForInstruction(state, instruction, limits = MEMORY_ACCESS_LIMITS) {
  const entry = opcodeEntryForAccess(instruction);
  if (!entry) return { ok: false, reason: 'missingOpcode' };
  const operand = Number(instruction.operand) & 0xffff;
  const mode = entry.mode;

  if (mode === AM.ZERO_PAGE) return { ok: true, mode: 'direct', values: [operand & 0xff] };
  if (mode === AM.ABSOLUTE) return { ok: true, mode: 'direct', values: [operand & 0xffff] };

  if (mode === AM.ZERO_PAGE_X || mode === AM.ZERO_PAGE_Y || mode === AM.ABSOLUTE_X || mode === AM.ABSOLUTE_Y) {
    const registerName = (mode === AM.ZERO_PAGE_X || mode === AM.ABSOLUTE_X) ? 'x' : 'y';
    const indexValues = enumerateByteValues(registerByte(state, registerName), limits.maxByteValues);
    if (!indexValues || !indexValues.length) return { ok: false, reason: 'unknownIndex', indexRegister: registerName };
    const zeroPage = mode === AM.ZERO_PAGE_X || mode === AM.ZERO_PAGE_Y;
    const values = indexedAdd(operand, indexValues, { zeroPage });
    if (values.length > limits.maxAddressValues) return { ok: false, reason: 'hugeAddressSet', indexRegister: registerName };
    return { ok: true, mode: 'indexed', indexRegister: registerName, values };
  }

  if (mode === AM.INDIRECT_X) {
    const indexValues = enumerateByteValues(registerByte(state, 'x'), limits.maxByteValues);
    if (!indexValues || !indexValues.length) return { ok: false, reason: 'unknownIndex', indexRegister: 'x' };
    const values = [];
    const pointerZpAddrs = [];
    for (const index of indexValues) {
      const pointerZpAddr = (operand + index) & 0xff;
      pointerZpAddrs.push(pointerZpAddr);
      const pointers = pointerValuesFromZp(state, pointerZpAddr, limits);
      if (!pointers || !pointers.length) return { ok: false, reason: 'unknownPointer', pointerZpAddr, indexRegister: 'x' };
      for (const pointer of pointers) {
        values.push(pointer & 0xffff);
        if (values.length > limits.maxAddressValues) return { ok: false, reason: 'hugeAddressSet', indexRegister: 'x' };
      }
    }
    return { ok: true, mode: 'indirect', indexRegister: 'x', pointerZpAddrs: uniqueSorted(pointerZpAddrs), values: uniqueSorted(values) };
  }

  if (mode === AM.INDIRECT_Y) {
    const pointers = pointerValuesFromZp(state, operand & 0xff, limits);
    if (!pointers || !pointers.length) return { ok: false, reason: 'unknownPointer', pointerZpAddr: operand & 0xff, indexRegister: 'y' };
    const indexValues = enumerateByteValues(registerByte(state, 'y'), limits.maxByteValues);
    if (!indexValues || !indexValues.length) return { ok: false, reason: 'unknownIndex', pointerZpAddr: operand & 0xff, indexRegister: 'y' };
    const values = [];
    for (const pointer of pointers) {
      for (const index of indexValues) {
        values.push((pointer + index) & 0xffff);
        if (values.length > limits.maxAddressValues) return { ok: false, reason: 'hugeAddressSet', pointerZpAddr: operand & 0xff, indexRegister: 'y' };
      }
    }
    return { ok: true, mode: 'indirect', pointerZpAddr: operand & 0xff, pointerZpAddrs: [operand & 0xff], indexRegister: 'y', values: uniqueSorted(values) };
  }

  return { ok: false, reason: 'unsupportedAddressingMode' };
}

function resolveRomOffsForCpuAddr(state, cpuAddr, env, options = {}) {
  const domainOptions = { ...options, mapperDomain: env.mapper.mapperDomain };
  const resolvedByDomain = resolveMapperCpuAddress(state.mapperState, cpuAddr & 0xffff, {
    ...domainOptions,
    purpose: 'populateMemoryMapDataRead'
  });
  requireObject(resolvedByDomain, 'populateMemoryMap mapper-domain ROM read resolution');
  if (resolvedByDomain.kind === 'exact') return [resolvedByDomain.romOff >>> 0];
  if (resolvedByDomain.kind === 'set') return uniqueSortedRom(resolvedByDomain.romOffs || []);

  const mapperContext = env.contexts[env.contextKey];
  if (!mapperContext) throw new Error(`Missing mapper context for populateMemoryMap context ${env.contextKey}`);
  const resolved = env.mapper.resolveCpuAddress(mapperContext, cpuAddr & 0xffff, { purpose: 'populateMemoryMapDataRead' });
  requireObject(resolved, 'populateMemoryMap ROM read resolution');
  if (!resolved.ok) return null;
  const backing = requireObject(resolved.backing, 'populateMemoryMap ROM read backing');
  if (backing.kind !== 'exact') return null;
  return [backing.romOff >>> 0];
}

export function classifyResolvedAccess(state, cpuAddressValues, accessKind, env, limits = MEMORY_ACCESS_LIMITS, options = {}) {
  const ramValues = [];
  const romOffs = [];
  let sawRam = false;
  let sawRom = false;
  let sawOther = false;

  for (const cpuAddr of cpuAddressValues) {
    const canonical = canonicalizeCpuAddr(cpuAddr & 0xffff);
    if (canonical.space === 'zp' || canonical.space === 'ram') {
      sawRam = true;
      ramValues.push(canonical.addr & 0x07ff);
      continue;
    }
    if (canonical.space === 'rom') {
      if (accessKind !== 'read') return { ok: false, reason: 'romWrite' };
      const resolvedRomOffs = resolveRomOffsForCpuAddr(state, cpuAddr, env, options);
      if (!resolvedRomOffs || !resolvedRomOffs.length) return { ok: false, reason: 'ambiguousMapper' };
      sawRom = true;
      for (const romOff of resolvedRomOffs) {
        romOffs.push(romOff >>> 0);
        if (romOffs.length > limits.maxRomOffValues) return { ok: false, reason: 'hugeAddressSet' };
      }
      continue;
    }
    sawOther = true;
  }

  const spaces = [sawRam, sawRom, sawOther].filter(Boolean).length;
  if (spaces !== 1) return { ok: false, reason: 'mixedAddressSpace' };
  if (sawRam) return { ok: true, space: 'ram', values: uniqueSorted(ramValues).map((value) => value & 0x07ff) };
  if (sawRom) return { ok: true, space: 'rom', values: uniqueSortedRom(romOffs) };
  return { ok: false, reason: 'unsupportedAddressSpace' };
}
