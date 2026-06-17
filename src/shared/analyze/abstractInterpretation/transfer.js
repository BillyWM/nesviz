import { ADDRESSING_MODES as AM } from '../../cpu6502/addressingModes.js';
import { OPCODES } from '../../cpu6502/opcodes.js';
import { canonicalizeCpuAddr } from '../../utils/addressUtils.js';
import { EDGE_KINDS } from '../cfg/constants.js';
import { requireInteger, requireObject } from '../dataShape.js';
import { FLAG_VALUE, boolFlag, forceFlag, withFlagUpdates } from '../domains/flagsDomain.js';
import { getFixedFlagEffect, predicateForBranchEdge } from '../domains/flagEffects.js';
import {
  abstractByteFromSerializable,
  byteAndImmediate,
  byteAsl,
  byteDec,
  byteEorImmediate,
  byteInc,
  byteLsr,
  byteOrImmediate,
  byteRol,
  byteRor,
  enumerateByteValues,
  exactByte,
  exactValueFromByte,
  joinByte,
  nzFlagsFromByte,
  topByte
} from './abstractByteDomain.js';
import {
  refineScalarEquals,
  refineScalarNegative,
  refineScalarNonNegative,
  refineScalarNotEquals,
  refineScalarNotZero,
  refineScalarUnsignedGreaterEqual,
  refineScalarUnsignedLessThan
} from './byteScalarDomain.js';
import { reduceByte, reduceState } from './reduction.js';
import {
  resolveMapperCpuAddress,
  topMapperState,
  transferMapperWrite
} from '../domains/mapper/mapperDomain.js';
import {
  bottomState,
  clearRegisterProvenance,
  clearRelations,
  cloneState,
  isBottomState,
  setCompareSource,
  setNzSource,
  unknownEntryState
} from './state.js';
import {
  forgetAllBytes,
  readByteAt,
  writeByteAt
} from './byteMemory.js';
import {
  forgetAllProvenance,
  readProvenanceAt,
  writeProvenanceAt
} from './provenanceMemory.js';
import {
  immediateProvenance,
  indexedRomReadProvenance,
  isUnknownProvenance,
  jsrReturnProvenance,
  opProvenance,
  provenanceKey,
  ramReadProvenance,
  romReadProvenance,
  unknownProvenance
} from './provenanceDomain.js';
import {
  invalidateShadowStack,
  shadowStackPop,
  shadowStackPush,
  shadowStackSlotHasReturnSite
} from './shadowStackDomain.js';


function effectiveMapperDomain(options, env) {
  return options.mapperDomain && typeof options.mapperDomain.join === 'function'
    ? options.mapperDomain
    : env.mapper.mapperDomain;
}

function opcodeEntryForInstruction(instruction) {
  requireObject(instruction, 'abstract interpretation instruction');
  requireInteger(instruction.opcode, 'abstract interpretation instruction.opcode');
  const entry = OPCODES[instruction.opcode & 0xff];
  if (!entry) throw new Error(`Missing opcode table entry for abstract interpretation opcode ${instruction.opcode}`);
  return entry;
}

function withNzFromByte(state, byte, sourceRegisterName = null) {
  state.flags = withFlagUpdates(state.flags, nzFlagsFromByte(byte));
  if (sourceRegisterName) setNzSource(state, sourceRegisterName);
  else clearRelations(state);
  return state;
}

function setRegisterMutable(state, registerName, byte, provenance = null) {
  state.registers[registerName] = abstractByteFromSerializable(byte);
  state.registerProvenance[registerName] = provenance || unknownProvenance();
  return state;
}

function writeRegisterWithNz(state, registerName, byte, provenance = null) {
  setRegisterMutable(state, registerName, byte, provenance);
  return withNzFromByte(state, state.registers[registerName], registerName);
}

function copyRegisterWithNz(state, dst, src) {
  return writeRegisterWithNz(state, dst, state.registers[src], state.registerProvenance[src]);
}

function transformedRegisterProvenance(state, registerName, opKind, operandProvenance, options = {}) {
  const args = [state.registerProvenance[registerName]];
  if (operandProvenance) args.push(operandProvenance);
  return opProvenance(opKind, args, options);
}

function normalizeReturnSiteFromEdge(edge) {
  if (!edge || typeof edge.returnBlockInstanceId !== 'string') return null;
  return {
    blockInstanceId: edge.returnBlockInstanceId,
    siteKey: typeof edge.returnSiteKey === 'string' ? edge.returnSiteKey : null,
    contextKey: typeof edge.returnContextKey === 'string' ? edge.returnContextKey : null,
    cpuAddr: Number.isFinite(edge.returnCpuAddr) ? (edge.returnCpuAddr & 0xffff) : null,
    romOff: Number.isFinite(edge.returnRomOff) ? (edge.returnRomOff >>> 0) : null
  };
}

function shadowStackWithJsrReturn(stack, instruction, returnSite, options = {}) {
  const encodedReturnAddr = ((Number(instruction?.cpuAddr) >>> 0) + (Number(instruction?.size) >>> 0) - 1) & 0xffff;
  const lowByte = Number.isFinite(instruction?.cpuAddr) && Number.isFinite(instruction?.size)
    ? exactByte(encodedReturnAddr & 0xff)
    : topByte();
  const highByte = Number.isFinite(instruction?.cpuAddr) && Number.isFinite(instruction?.size)
    ? exactByte((encodedReturnAddr >>> 8) & 0xff)
    : topByte();
  const common = {
    sourceInstructionId: Number(instruction?.instructionId) >>> 0,
    callSiteRomOff: Number(instruction?.romOff) >>> 0,
    encodedReturnAddr
  };
  let out = stack;
  out = shadowStackPush(out, {
    byte: highByte,
    provenance: jsrReturnProvenance({ ...common, role: 'high' }, options),
    returnSite
  }, options);
  out = shadowStackPush(out, {
    byte: lowByte,
    provenance: jsrReturnProvenance({ ...common, role: 'low' }, options),
    returnSite
  }, options);
  return out;
}

function flagToBit(flag) {
  if (flag === FLAG_VALUE.FALSE) return 0;
  if (flag === FLAG_VALUE.TRUE) return 1;
  return null;
}

function getRegisterForLoad(mnemonic) {
  if (mnemonic === 'LDA') return 'a';
  if (mnemonic === 'LDX') return 'x';
  if (mnemonic === 'LDY') return 'y';
  return null;
}

function getRegisterForStore(mnemonic) {
  if (mnemonic === 'STA') return 'a';
  if (mnemonic === 'STX') return 'x';
  if (mnemonic === 'STY') return 'y';
  return null;
}

function exactIndexValue(state, mode) {
  if (mode === AM.ZERO_PAGE_X || mode === AM.ABSOLUTE_X) return exactValueFromByte(state.registers.x);
  if (mode === AM.ZERO_PAGE_Y || mode === AM.ABSOLUTE_Y) return exactValueFromByte(state.registers.y);
  return 0;
}

function exactEffectiveAddress(state, instruction, mode) {
  const operand = instruction.operand;
  if (mode === AM.ZERO_PAGE || mode === AM.ABSOLUTE) return operand & 0xffff;
  if (mode === AM.ZERO_PAGE_X || mode === AM.ZERO_PAGE_Y) {
    const index = exactIndexValue(state, mode);
    if (index === null) return null;
    return ((operand & 0xff) + index) & 0xff;
  }
  if (mode === AM.ABSOLUTE_X || mode === AM.ABSOLUTE_Y) {
    const index = exactIndexValue(state, mode);
    if (index === null) return null;
    return ((operand & 0xffff) + index) & 0xffff;
  }
  return null;
}

function maybeInternalRamAddressMode(mode) {
  return mode === AM.ZERO_PAGE || mode === AM.ZERO_PAGE_X || mode === AM.ZERO_PAGE_Y || mode === AM.ABSOLUTE || mode === AM.ABSOLUTE_X || mode === AM.ABSOLUTE_Y || mode === AM.INDIRECT_X || mode === AM.INDIRECT_Y;
}

function byteFromRomOffs(prgBytes, romOffs, options) {
  let out = null;
  for (const rawRomOff of romOffs) {
    const romOff = requireInteger(rawRomOff, 'abstract interpretation ROM read romOff') >>> 0;
    if (romOff >= prgBytes.length) return topByte();
    const byte = exactByte(prgBytes[romOff] & 0xff);
    out = out ? joinByte(out, byte, options) : byte;
  }
  return out || topByte();
}

function romCandidateByte(prgBytes, romOff) {
  const normalized = Number(romOff) >>> 0;
  if (normalized >= prgBytes.length) return null;
  return prgBytes[normalized] & 0xff;
}

function resolveExactRomCandidate(state, cpuAddr, env, options = {}, purpose = 'abstractInterpretationDataRead') {
  const addr = cpuAddr & 0xffff;
  const domainOptions = { ...options, mapperDomain: effectiveMapperDomain(options, env) };
  const resolvedByDomain = resolveMapperCpuAddress(state.mapperState, addr, {
    ...domainOptions,
    purpose
  });
  requireObject(resolvedByDomain, 'abstract interpretation provenance mapper-domain ROM read resolution');
  if (resolvedByDomain.kind === 'exact') {
    const romOff = requireInteger(resolvedByDomain.romOff, 'abstract interpretation provenance romOff') >>> 0;
    const byte = romCandidateByte(env.prgBytes, romOff);
    if (byte === null) return null;
    return { cpuAddr: addr, romOff, byte };
  }

  const mapperContext = env.contexts[env.contextKey];
  if (!mapperContext) throw new Error(`Missing mapper context for abstract interpretation context ${env.contextKey}`);
  const resolved = env.mapper.resolveCpuAddress(mapperContext, addr, { purpose });
  requireObject(resolved, 'abstract interpretation provenance ROM read resolution');
  if (!resolved.ok) return null;
  const backing = requireObject(resolved.backing, 'abstract interpretation provenance ROM read backing');
  if (backing.kind !== 'exact') return null;
  const romOff = requireInteger(backing.romOff, 'abstract interpretation provenance ROM read romOff') >>> 0;
  const byte = romCandidateByte(env.prgBytes, romOff);
  if (byte === null) return null;
  return { cpuAddr: addr, romOff, byte };
}

function joinCandidateBytes(candidates, options = {}) {
  let out = null;
  for (const candidate of candidates || []) {
    const byte = exactByte(candidate.byte & 0xff);
    out = out ? joinByte(out, byte, options) : byte;
  }
  return out || topByte();
}

function indexRegisterForMode(mode) {
  if (mode === AM.ZERO_PAGE_X || mode === AM.ABSOLUTE_X) return 'x';
  if (mode === AM.ZERO_PAGE_Y || mode === AM.ABSOLUTE_Y) return 'y';
  return null;
}


const loggedIndexedRomReadDiagnostics = new Set();

function hex(value, width) {
  return `$${(Number(value) >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function describeIndexedReadIndexValues(indexValues) {
  if (!Array.isArray(indexValues)) return 'none';
  return `{${indexValues.map((value) => hex(value, 2)).join(',')}}`;
}

function logIndexedRomReadDiagnostic(kind, instruction, detail) {
  const key = `${kind}:${Number(instruction?.instructionId) >>> 0}:${detail}`;
  if (loggedIndexedRomReadDiagnostics.has(key)) return;
  loggedIndexedRomReadDiagnostics.add(key);
  const rom = Number.isFinite(instruction?.romOff) ? hex(instruction.romOff, 6) : 'unknown ROM';
  const cpu = Number.isFinite(instruction?.cpuAddr) ? hex(instruction.cpuAddr, 4) : 'unknown CPU';
  // console.log(`[rtsTrick/prov] indexed ROM read ${kind} at ROM ${rom} CPU ${cpu}: ${detail}`);
}

function resolveIndexedRomRead(state, instruction, entry, env, options = {}) {
  if (entry.mode !== AM.ABSOLUTE_X && entry.mode !== AM.ABSOLUTE_Y) return null;
  const indexRegister = indexRegisterForMode(entry.mode);
  const cpuBase = instruction.operand & 0xffff;
  if (canonicalizeCpuAddr(cpuBase).space !== 'rom') return null;

  const indexValues = enumerateByteValues(state.registers[indexRegister], options.maxIndexedReadCandidates || 16);
  if (!indexValues || !indexValues.length) {
    logIndexedRomReadDiagnostic('skip', instruction, `base=${hex(cpuBase, 4)} ${indexRegister.toUpperCase()} values=not-finite`);
    return null;
  }

  const candidates = [];
  for (const index of indexValues) {
    const cpuAddr = (cpuBase + index) & 0xffff;
    const canonical = canonicalizeCpuAddr(cpuAddr);
    if (canonical.space !== 'rom') {
      logIndexedRomReadDiagnostic('skip', instruction, `base=${hex(cpuBase, 4)} ${indexRegister.toUpperCase()}=${describeIndexedReadIndexValues(indexValues)} candidate=${hex(cpuAddr, 4)} not-rom`);
      return null;
    }
    const candidate = resolveExactRomCandidate(state, cpuAddr, env, options, 'abstractInterpretationIndexedDataRead');
    if (!candidate) {
      logIndexedRomReadDiagnostic('skip', instruction, `base=${hex(cpuBase, 4)} ${indexRegister.toUpperCase()}=${describeIndexedReadIndexValues(indexValues)} candidate=${hex(cpuAddr, 4)} unresolved`);
      return null;
    }
    candidates.push({ index, ...candidate });
  }

  const indexProvenance = state.registerProvenance[indexRegister];
  const provenance = indexedRomReadProvenance({
    cpuBase,
    indexRegister,
    indexProvenance,
    indexValues,
    candidates
  }, options);
  const indexKey = provenanceKey(indexProvenance);
  const provState = isUnknownProvenance(provenance) ? 'unknown' : 'indexedRomRead';
  logIndexedRomReadDiagnostic(provState, instruction, `base=${hex(cpuBase, 4)} ${indexRegister.toUpperCase()}=${describeIndexedReadIndexValues(indexValues)} indexProv=${indexKey ? 'known' : 'unknown'} candidates=${candidates.length}`);

  return {
    byte: joinCandidateBytes(candidates, options),
    provenance
  };
}

function readExactAddressByteAndProvenance(state, cpuAddr, env, options = {}) {
  const canonical = canonicalizeCpuAddr(cpuAddr & 0xffff);
  if (canonical.space === 'zp' || canonical.space === 'ram') {
    const storedProvenance = readProvenanceAt(state.ramProvenance, cpuAddr);
    return {
      byte: readByteAt(state.ramBytes, cpuAddr),
      provenance: isUnknownProvenance(storedProvenance) ? ramReadProvenance(cpuAddr) : storedProvenance
    };
  }
  if (canonical.space !== 'rom') return { byte: topByte(), provenance: unknownProvenance() };

  const candidate = resolveExactRomCandidate(state, cpuAddr, env, options, 'abstractInterpretationDataRead');
  if (!candidate) return { byte: topByte(), provenance: unknownProvenance() };
  return {
    byte: exactByte(candidate.byte),
    provenance: romReadProvenance(candidate)
  };
}

function readExactAddressByte(state, cpuAddr, env, options = {}) {
  return readExactAddressByteAndProvenance(state, cpuAddr, env, options).byte;
}

function readOperandByteAndProvenance(state, instruction, entry, env, options = {}) {
  if (entry.mode === AM.IMMEDIATE) {
    const value = instruction.operand & 0xff;
    return { byte: exactByte(value), provenance: immediateProvenance(value) };
  }

  const indexedRom = resolveIndexedRomRead(state, instruction, entry, env, options);
  if (indexedRom) return indexedRom;

  const addr = exactEffectiveAddress(state, instruction, entry.mode);
  if (addr === null) return { byte: topByte(), provenance: unknownProvenance() };
  return readExactAddressByteAndProvenance(state, addr, env, options);
}

function readOperandByte(state, instruction, entry, env, options = {}) {
  return readOperandByteAndProvenance(state, instruction, entry, env, options).byte;
}

function writeAddressByteAndProvenance(state, cpuAddr, byte, provenance, env, options = {}) {
  const canonical = canonicalizeCpuAddr(cpuAddr & 0xffff);
  if (canonical.space === 'zp' || canonical.space === 'ram') {
    writeByteAt(state.ramBytes, cpuAddr, byte);
    writeProvenanceAt(state.ramProvenance, cpuAddr, provenance);
    if (canonical.addr >= 0x0100 && canonical.addr <= 0x01ff) state.shadowStack = invalidateShadowStack();
    return state;
  }

  const domainOptions = { ...options, mapperDomain: effectiveMapperDomain(options, env) };
  const targetKind = typeof env.mapper.classifyWrite === 'function' ? env.mapper.classifyWrite(cpuAddr & 0xffff) : 'possibleMapperWrite';
  const mutableCodeMapping = typeof env?.mapper?.cpuWritesMayAffectCodeMapping === 'function'
    ? env.mapper.cpuWritesMayAffectCodeMapping() !== false
    : true;
  if (mutableCodeMapping && (targetKind === 'possibleMapperWrite' || targetKind === 'definiteMapperWrite')) {
    state.mapperState = transferMapperWrite(state.mapperState, {
      cpuAddr: cpuAddr & 0xffff,
      value: byte
    }, domainOptions);
  }
  return state;
}

function writeAddressByte(state, cpuAddr, byte, env, options = {}) {
  return writeAddressByteAndProvenance(state, cpuAddr, byte, unknownProvenance(), env, options);
}

function unknownWriteMayAffectMapping(instruction, mode, env) {
  if (typeof env?.mapper?.cpuWritesMayAffectCodeMapping === 'function' && env.mapper.cpuWritesMayAffectCodeMapping() === false) {
    return false;
  }
  if (mode === AM.ZERO_PAGE || mode === AM.ZERO_PAGE_X || mode === AM.ZERO_PAGE_Y) return false;
  if (mode === AM.ABSOLUTE_X || mode === AM.ABSOLUTE_Y) {
    const base = instruction.operand & 0xffff;
    for (let offset = 0; offset <= 0xff; offset += 1) {
      const targetKind = typeof env.mapper.classifyWrite === 'function' ? env.mapper.classifyWrite((base + offset) & 0xffff) : 'possibleMapperWrite';
      if (targetKind === 'possibleMapperWrite' || targetKind === 'definiteMapperWrite') return true;
    }
    return false;
  }
  return mode === AM.INDIRECT_X || mode === AM.INDIRECT_Y || mode === AM.ABSOLUTE;
}

function clobberMapperForUnknownWrite(state, instruction, mode, env, options = {}) {
  if (!unknownWriteMayAffectMapping(instruction, mode, env)) return state;
  state.mapperState = topMapperState({ ...options, mapperDomain: effectiveMapperDomain(options, env) });
  return state;
}

function clobberCallReturnState(state, options = {}) {
  const out = cloneState(state, options);
  const unknown = unknownEntryState(options);
  out.flags = unknown.flags;
  out.registers = unknown.registers;
  clearRegisterProvenance(out);
  forgetAllBytes(out.ramBytes);
  forgetAllProvenance(out.ramProvenance);
  out.shadowStack = invalidateShadowStack();
  out.mapperState = topMapperState(options);
  clearRelations(out);
  return out;
}

function unknownRegister(state, registerName) {
  state.registers[registerName] = topByte();
  state.registerProvenance[registerName] = unknownProvenance();
}

function applyFunctionSummaryReturnState(state, effects, options = {}) {
  const out = cloneState(state, options);
  let mustClearRelations = false;

  if (effects?.clobbersA) {
    unknownRegister(out, 'a');
    mustClearRelations = true;
  }
  if (effects?.clobbersX) {
    unknownRegister(out, 'x');
    mustClearRelations = true;
  }
  if (effects?.clobbersY) {
    unknownRegister(out, 'y');
    mustClearRelations = true;
  }

  const flagUpdates = {};
  if (effects?.clobbersN) flagUpdates.n = FLAG_VALUE.UNKNOWN;
  if (effects?.clobbersV) flagUpdates.v = FLAG_VALUE.UNKNOWN;
  if (effects?.clobbersD) flagUpdates.d = FLAG_VALUE.UNKNOWN;
  if (effects?.clobbersI) flagUpdates.i = FLAG_VALUE.UNKNOWN;
  if (effects?.clobbersZ) flagUpdates.z = FLAG_VALUE.UNKNOWN;
  if (effects?.clobbersC) flagUpdates.c = FLAG_VALUE.UNKNOWN;
  if (Object.keys(flagUpdates).length) {
    out.flags = withFlagUpdates(out.flags, flagUpdates);
    mustClearRelations = true;
  }

  if (effects?.ramUnchanged !== true) {
    forgetAllBytes(out.ramBytes);
    forgetAllProvenance(out.ramProvenance);
    mustClearRelations = true;
  }

  if (effects?.mapperUnchanged !== true) {
    out.mapperState = topMapperState(options);
    mustClearRelations = true;
  }

  if (mustClearRelations) clearRelations(out);
  return out;
}

function compareValues(registerByte, operandByte) {
  const registerValue = exactValueFromByte(registerByte);
  const operandValue = exactValueFromByte(operandByte);
  if (registerValue === null || operandValue === null) {
    return { n: FLAG_VALUE.UNKNOWN, z: FLAG_VALUE.UNKNOWN, c: FLAG_VALUE.UNKNOWN };
  }
  const result = (registerValue - operandValue) & 0xff;
  return {
    n: boolFlag((result & 0x80) !== 0),
    z: boolFlag(result === 0),
    c: boolFlag(registerValue >= operandValue)
  };
}

function addWithCarry(a, b, carryIn) {
  const sum = a + b + carryIn;
  const result = sum & 0xff;
  return {
    result,
    c: boolFlag(sum > 0xff),
    v: boolFlag(((~(a ^ b) & (a ^ result)) & 0x80) !== 0),
    ...nzFlagsFromByte(exactByte(result))
  };
}

function subtractWithCarry(a, b, carryIn) {
  return addWithCarry(a, b ^ 0xff, carryIn);
}

function transferLoad(state, instruction, entry, env, options) {
  const registerName = getRegisterForLoad(entry.mnemonic);
  if (!registerName) return state;
  const value = readOperandByteAndProvenance(state, instruction, entry, env, options);
  return writeRegisterWithNz(state, registerName, value.byte, value.provenance);
}

function transferStore(state, instruction, entry, env, options) {
  const registerName = getRegisterForStore(entry.mnemonic);
  if (!registerName) return state;
  const addr = exactEffectiveAddress(state, instruction, entry.mode);
  if (addr === null) {
    if (maybeInternalRamAddressMode(entry.mode)) {
      forgetAllBytes(state.ramBytes);
      forgetAllProvenance(state.ramProvenance);
      state.shadowStack = invalidateShadowStack();
    }
    return clobberMapperForUnknownWrite(state, instruction, entry.mode, env, options);
  }
  return writeAddressByteAndProvenance(state, addr, state.registers[registerName], state.registerProvenance[registerName], env, options);
}

function transferLogicImmediate(state, instruction, entry, options) {
  if (entry.mode !== AM.IMMEDIATE) {
    state.registers.a = topByte();
    state.registerProvenance.a = unknownProvenance();
    return withNzFromByte(state, state.registers.a, 'a');
  }

  const inputProvenance = state.registerProvenance.a;
  if (entry.mnemonic === 'AND') {
    state.registers.a = byteAndImmediate(state.registers.a, instruction.operand, options);
    state.registerProvenance.a = opProvenance('AND_IMM', [inputProvenance, immediateProvenance(instruction.operand)], options);
  } else if (entry.mnemonic === 'ORA') {
    state.registers.a = byteOrImmediate(state.registers.a, instruction.operand, options);
    state.registerProvenance.a = opProvenance('ORA_IMM', [inputProvenance, immediateProvenance(instruction.operand)], options);
  } else if (entry.mnemonic === 'EOR') {
    state.registers.a = byteEorImmediate(state.registers.a, instruction.operand, options);
    state.registerProvenance.a = opProvenance('EOR_IMM', [inputProvenance, immediateProvenance(instruction.operand)], options);
  }
  return withNzFromByte(state, state.registers.a, 'a');
}

function transferShiftAccumulator(state, entry, options) {
  let shifted;
  if (entry.mnemonic === 'ASL') shifted = byteAsl(state.registers.a, options);
  else if (entry.mnemonic === 'LSR') shifted = byteLsr(state.registers.a, options);
  else if (entry.mnemonic === 'ROL') shifted = byteRol(state.registers.a, state.flags.c, options);
  else shifted = byteRor(state.registers.a, state.flags.c, options);
  const inputProvenance = state.registerProvenance.a;
  state.registers.a = shifted.result;
  state.registerProvenance.a = opProvenance(`${entry.mnemonic}_A`, [inputProvenance], options);
  state.flags = withFlagUpdates(state.flags, { c: shifted.carry });
  return withNzFromByte(state, shifted.result, 'a');
}

function transferShiftMemory(state, instruction, entry, env, options) {
  const addr = exactEffectiveAddress(state, instruction, entry.mode);
  if (addr === null) {
    if (maybeInternalRamAddressMode(entry.mode)) {
      forgetAllBytes(state.ramBytes);
      forgetAllProvenance(state.ramProvenance);
      state.shadowStack = invalidateShadowStack();
    }
    clobberMapperForUnknownWrite(state, instruction, entry.mode, env, options);
    state.flags = withFlagUpdates(state.flags, { n: FLAG_VALUE.UNKNOWN, z: FLAG_VALUE.UNKNOWN, c: FLAG_VALUE.UNKNOWN });
    clearRelations(state);
    return state;
  }

  const old = readExactAddressByteAndProvenance(state, addr, env, options);
  let shifted;
  if (entry.mnemonic === 'ASL') shifted = byteAsl(old.byte, options);
  else if (entry.mnemonic === 'LSR') shifted = byteLsr(old.byte, options);
  else if (entry.mnemonic === 'ROL') shifted = byteRol(old.byte, state.flags.c, options);
  else shifted = byteRor(old.byte, state.flags.c, options);
  state.flags = withFlagUpdates(state.flags, { c: shifted.carry });
  withNzFromByte(state, shifted.result, null);
  return writeAddressByteAndProvenance(state, addr, shifted.result, opProvenance(`${entry.mnemonic}_MEM`, [old.provenance], options), env, options);
}

function transferIncDecMemory(state, instruction, entry, env, options) {
  const addr = exactEffectiveAddress(state, instruction, entry.mode);
  if (addr === null) {
    if (maybeInternalRamAddressMode(entry.mode)) {
      forgetAllBytes(state.ramBytes);
      forgetAllProvenance(state.ramProvenance);
      state.shadowStack = invalidateShadowStack();
    }
    clobberMapperForUnknownWrite(state, instruction, entry.mode, env, options);
    state.flags = withFlagUpdates(state.flags, { n: FLAG_VALUE.UNKNOWN, z: FLAG_VALUE.UNKNOWN });
    clearRelations(state);
    return state;
  }

  const old = readExactAddressByteAndProvenance(state, addr, env, options);
  const result = entry.mnemonic === 'INC' ? byteInc(old.byte, options) : byteDec(old.byte, options);
  withNzFromByte(state, result, null);
  return writeAddressByteAndProvenance(state, addr, result, opProvenance(`${entry.mnemonic}_MEM`, [old.provenance], options), env, options);
}

function transferBit(state, instruction, entry, env, options) {
  const operandByte = readOperandByte(state, instruction, entry, env, options);
  const operandValue = exactValueFromByte(operandByte);
  const aValue = exactValueFromByte(state.registers.a);
  const updates = { n: FLAG_VALUE.UNKNOWN, v: FLAG_VALUE.UNKNOWN, z: FLAG_VALUE.UNKNOWN };
  if (operandValue !== null) {
    updates.n = boolFlag((operandValue & 0x80) !== 0);
    updates.v = boolFlag((operandValue & 0x40) !== 0);
    if (aValue !== null) updates.z = boolFlag((aValue & operandValue) === 0);
  }
  state.flags = withFlagUpdates(state.flags, updates);
  clearRelations(state);
  return state;
}

function transferCompare(state, instruction, entry, env, options) {
  const registerName = entry.mnemonic === 'CMP' ? 'a' : (entry.mnemonic === 'CPX' ? 'x' : 'y');
  const operand = readOperandByte(state, instruction, entry, env, options);
  state.flags = withFlagUpdates(state.flags, compareValues(state.registers[registerName], operand));
  setCompareSource(state, registerName, operand);
  return state;
}

function transferArithmetic(state, instruction, entry, env, options) {
  const aValue = exactValueFromByte(state.registers.a);
  const operandValue = exactValueFromByte(readOperandByte(state, instruction, entry, env, options));
  const carryIn = flagToBit(state.flags.c);
  if (aValue === null || operandValue === null || carryIn === null) {
    state.registers.a = topByte();
    state.registerProvenance.a = unknownProvenance();
    state.flags = withFlagUpdates(state.flags, {
      n: FLAG_VALUE.UNKNOWN,
      v: FLAG_VALUE.UNKNOWN,
      z: FLAG_VALUE.UNKNOWN,
      c: FLAG_VALUE.UNKNOWN
    });
    clearRelations(state);
    return state;
  }

  const result = entry.mnemonic === 'ADC'
    ? addWithCarry(aValue, operandValue, carryIn)
    : subtractWithCarry(aValue, operandValue, carryIn);
  const operand = readOperandByteAndProvenance(state, instruction, entry, env, options);
  state.registers.a = exactByte(result.result);
  state.registerProvenance.a = opProvenance(entry.mnemonic, [state.registerProvenance.a, operand.provenance], options);
  state.flags = withFlagUpdates(state.flags, {
    n: result.n,
    v: result.v,
    z: result.z,
    c: result.c
  });
  setNzSource(state, 'a');
  return state;
}

function transferInstructionMutable(state, instruction, env, options) {
  const entry = opcodeEntryForInstruction(instruction);
  const mnemonic = entry.mnemonic;

  if (getRegisterForLoad(mnemonic)) return transferLoad(state, instruction, entry, env, options);
  if (getRegisterForStore(mnemonic)) return transferStore(state, instruction, entry, env, options);

  if (mnemonic === 'TAX') return copyRegisterWithNz(state, 'x', 'a');
  if (mnemonic === 'TAY') return copyRegisterWithNz(state, 'y', 'a');
  if (mnemonic === 'TXA') return copyRegisterWithNz(state, 'a', 'x');
  if (mnemonic === 'TYA') return copyRegisterWithNz(state, 'a', 'y');
  if (mnemonic === 'TSX') return copyRegisterWithNz(state, 'x', 's');
  if (mnemonic === 'TXS') {
    state.registers.s = state.registers.x;
    state.registerProvenance.s = state.registerProvenance.x;
    state.shadowStack = invalidateShadowStack();
    return state;
  }

  const fixedFlagEffect = getFixedFlagEffect(mnemonic);
  if (fixedFlagEffect) {
    state.flags = withFlagUpdates(state.flags, fixedFlagEffect);
    if (fixedFlagEffect.c !== undefined) state.relations.compareSource = null;
    return state;
  }

  if (mnemonic === 'AND' || mnemonic === 'ORA' || mnemonic === 'EOR') return transferLogicImmediate(state, instruction, entry, options);

  if (mnemonic === 'ASL' || mnemonic === 'LSR' || mnemonic === 'ROL' || mnemonic === 'ROR') {
    return entry.mode === AM.ACCUMULATOR ? transferShiftAccumulator(state, entry, options) : transferShiftMemory(state, instruction, entry, env, options);
  }

  if (mnemonic === 'INX') return writeRegisterWithNz(state, 'x', byteInc(state.registers.x, options), transformedRegisterProvenance(state, 'x', 'INC', null, options));
  if (mnemonic === 'INY') return writeRegisterWithNz(state, 'y', byteInc(state.registers.y, options), transformedRegisterProvenance(state, 'y', 'INC', null, options));
  if (mnemonic === 'DEX') return writeRegisterWithNz(state, 'x', byteDec(state.registers.x, options), transformedRegisterProvenance(state, 'x', 'DEC', null, options));
  if (mnemonic === 'DEY') return writeRegisterWithNz(state, 'y', byteDec(state.registers.y, options), transformedRegisterProvenance(state, 'y', 'DEC', null, options));

  if (mnemonic === 'INC' || mnemonic === 'DEC') return transferIncDecMemory(state, instruction, entry, env, options);
  if (mnemonic === 'CMP' || mnemonic === 'CPX' || mnemonic === 'CPY') return transferCompare(state, instruction, entry, env, options);
  if (mnemonic === 'ADC' || mnemonic === 'SBC') return transferArithmetic(state, instruction, entry, env, options);
  if (mnemonic === 'BIT') return transferBit(state, instruction, entry, env, options);

  if (mnemonic === 'PHA') {
    state.shadowStack = shadowStackPush(state.shadowStack, {
      byte: state.registers.a,
      provenance: state.registerProvenance.a
    }, options);
    return state;
  }
  if (mnemonic === 'PHP') {
    state.shadowStack = shadowStackPush(state.shadowStack, {
      byte: topByte(),
      provenance: unknownProvenance()
    }, options);
    return state;
  }
  if (mnemonic === 'PLA') {
    const popped = shadowStackPop(state.shadowStack);
    state.shadowStack = popped.stack;
    return writeRegisterWithNz(state, 'a', popped.slot.byte, popped.slot.provenance);
  }
  if (mnemonic === 'PLP') {
    const popped = shadowStackPop(state.shadowStack);
    state.shadowStack = popped.stack;
    state.flags = unknownEntryState().flags;
    clearRelations(state);
    return state;
  }
  if (mnemonic === 'RTI') {
    state.flags = unknownEntryState().flags;
    clearRelations(state);
    return state;
  }

  return state;
}

export function transferInstruction(state, instruction, env, options = {}) {
  if (isBottomState(state)) return state;
  return reduceState(transferInstructionMutable(cloneState(state, { ...options, mapperDomain: effectiveMapperDomain(options, env) }), instruction, env, { ...options, mapperDomain: effectiveMapperDomain(options, env) }), { ...options, mapperDomain: effectiveMapperDomain(options, env) });
}

function refineRegisterScalar(state, registerName, refine) {
  const current = state.registers[registerName];
  state.registers[registerName] = reduceByte({
    ...current,
    scalar: refine(current.scalar)
  });
  return state;
}

function refineFromNzSource(out, flag, value, options) {
  const nzSource = out.relations?.nzSource;
  if (!nzSource || nzSource.kind !== 'register') return out;
  const registerName = nzSource.registerName;
  if (flag === 'z' && value === FLAG_VALUE.TRUE) return refineRegisterScalar(out, registerName, (scalar) => refineScalarEquals(scalar, 0x00));
  if (flag === 'z' && value === FLAG_VALUE.FALSE) return refineRegisterScalar(out, registerName, (scalar) => refineScalarNotZero(scalar, options));
  if (flag === 'n' && value === FLAG_VALUE.TRUE) return refineRegisterScalar(out, registerName, (scalar) => refineScalarNegative(scalar, options));
  if (flag === 'n' && value === FLAG_VALUE.FALSE) return refineRegisterScalar(out, registerName, (scalar) => refineScalarNonNegative(scalar, options));
  return out;
}

function refineFromCompareSource(out, flag, value, options) {
  const compareSource = out.relations?.compareSource;
  if (!compareSource || compareSource.kind !== 'compare') return out;
  const operand = abstractByteFromSerializable(compareSource.operand);
  const operandExact = exactValueFromByte(operand);
  if (operandExact === null) return out;
  const registerName = compareSource.registerName;

  if (flag === 'z' && value === FLAG_VALUE.TRUE) return refineRegisterScalar(out, registerName, (scalar) => refineScalarEquals(scalar, operandExact));
  if (flag === 'z' && value === FLAG_VALUE.FALSE) return refineRegisterScalar(out, registerName, (scalar) => refineScalarNotEquals(scalar, operandExact, options));
  if (flag === 'c' && value === FLAG_VALUE.FALSE) return refineRegisterScalar(out, registerName, (scalar) => refineScalarUnsignedLessThan(scalar, operandExact, options));
  if (flag === 'c' && value === FLAG_VALUE.TRUE) return refineRegisterScalar(out, registerName, (scalar) => refineScalarUnsignedGreaterEqual(scalar, operandExact, options));
  return out;
}

function applyNormalReturnEdge(state, edge, options = {}) {
  let popped = shadowStackPop(state.shadowStack);
  const lowSlot = popped.slot;
  popped = shadowStackPop(popped.stack);
  const highSlot = popped.slot;
  if (!shadowStackSlotHasReturnSite(lowSlot, edge.toBlockInstanceId)) return bottomState();
  if (!shadowStackSlotHasReturnSite(highSlot, edge.toBlockInstanceId)) return bottomState();
  const out = cloneState(state, options);
  out.shadowStack = popped.stack;
  return out;
}

function applyEdgeSensitiveNormalReturnEdge(state, options = {}) {
  const out = cloneState(state, options);
  out.shadowStack = invalidateShadowStack();
  return out;
}

export function applyEdgeTransfer(state, edge, terminatorInstruction, options = {}) {
  if (isBottomState(state)) return state;
  const entry = opcodeEntryForInstruction(terminatorInstruction);
  let out = cloneState(state, options);

  const refinement = predicateForBranchEdge(entry.mnemonic, edge.kind);
  if (refinement) {
    out.flags = forceFlag(out.flags, refinement.flag, refinement.value);
    refineFromNzSource(out, refinement.flag, refinement.value, options);
    refineFromCompareSource(out, refinement.flag, refinement.value, options);
  }

  if (edge.kind === EDGE_KINDS.CALL && entry.mnemonic === 'JSR') {
    const returnSite = normalizeReturnSiteFromEdge(edge);
    if (returnSite) out.shadowStack = shadowStackWithJsrReturn(out.shadowStack, terminatorInstruction, returnSite, options);
    else out.shadowStack = shadowStackWithJsrReturn(out.shadowStack, terminatorInstruction, null, options);
  }

  if (edge.kind === EDGE_KINDS.FALLTHROUGH && entry.mnemonic === 'JSR') {
    if (edge.deferToReturnEdges) return bottomState();
    out = edge.functionSummaryReturn && edge.functionSummaryEffects
      ? applyFunctionSummaryReturnState(out, edge.functionSummaryEffects, options)
      : clobberCallReturnState(out, options);
  }

  if (edge.kind === EDGE_KINDS.RETURN && entry.mnemonic === 'RTS') {
    const preciseReturn = applyNormalReturnEdge(out, edge, options);
    if (!isBottomState(preciseReturn)) return reduceState(preciseReturn, options);
    if (edge.edgeSensitiveReturnAllowed) {
      return reduceState(applyEdgeSensitiveNormalReturnEdge(out, options), options);
    }
    return reduceState(preciseReturn, options);
  }

  if (edge.kind === EDGE_KINDS.RTS_TRICK) {
    let popped = shadowStackPop(out.shadowStack);
    popped = shadowStackPop(popped.stack);
    out.shadowStack = popped.stack;
  }

  return reduceState(out, options);
}
