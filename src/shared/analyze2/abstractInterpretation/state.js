import {
  createUnknownFlags,
  flagsEqual,
  joinFlags
} from '../domains/flagsDomain.js';
import {
  abstractByteFromSerializable,
  abstractByteToSerializable,
  byteEqual,
  byteSubsetOf,
  intersectByte,
  isBottomByte,
  joinByte,
  topByte,
  widenByte
} from './abstractByteDomain.js';
import {
  byteMemoryEquals,
  byteMemoryFromSerializable,
  byteMemoryToSerializable,
  cloneByteMemory,
  createByteMemory,
  joinByteMemory,
  widenByteMemory
} from './byteMemory.js';
import {
  cloneProvenance,
  entryRegisterProvenance,
  joinProvenance,
  provenanceEqual,
  provenanceFromSerializable,
  provenanceToSerializable,
  unknownProvenance,
  widenProvenance
} from './provenanceDomain.js';
import {
  cloneProvenanceMemory,
  createProvenanceMemory,
  joinProvenanceMemory,
  provenanceMemoryEquals,
  provenanceMemoryFromSerializable,
  provenanceMemoryToSerializable,
  widenProvenanceMemory
} from './provenanceMemory.js';
import {
  cloneShadowStack,
  createShadowStack,
  joinShadowStack,
  shadowStackEquals,
  shadowStackFromSerializable,
  shadowStackToSerializable,
  widenShadowStack
} from './shadowStackDomain.js';
import { reduceState } from './reduction.js';
import {
  cloneMapperState,
  initialMapperStateForContext,
  joinMapperStates,
  mapperStateFromSerializable,
  mapperStatesEqual,
  mapperStateSubsetOf,
  mapperStateToSerializable,
  topMapperState,
  widenMapperStates
} from '../domains/mapper/mapperDomain.js';

export const ABSTRACT_STATE_KIND = Object.freeze({
  BOTTOM: 'bottom',
  STATE: 'state'
});

const REGISTER_NAMES = Object.freeze(['a', 'x', 'y', 's']);

function unknownRegisterProvenanceSet() {
  return {
    a: unknownProvenance(),
    x: unknownProvenance(),
    y: unknownProvenance(),
    s: unknownProvenance()
  };
}

function entryRegisterProvenanceSet() {
  return {
    a: entryRegisterProvenance('a'),
    x: entryRegisterProvenance('x'),
    y: entryRegisterProvenance('y'),
    s: entryRegisterProvenance('s')
  };
}

function cloneRegisterProvenanceSet(registerProvenance) {
  const source = registerProvenance || unknownRegisterProvenanceSet();
  return {
    a: cloneProvenance(source.a),
    x: cloneProvenance(source.x),
    y: cloneProvenance(source.y),
    s: cloneProvenance(source.s)
  };
}

function joinRegisterProvenanceSets(a, b, options = {}) {
  const left = a || unknownRegisterProvenanceSet();
  const right = b || unknownRegisterProvenanceSet();
  return {
    a: joinProvenance(left.a, right.a, options),
    x: joinProvenance(left.x, right.x, options),
    y: joinProvenance(left.y, right.y, options),
    s: joinProvenance(left.s, right.s, options)
  };
}

function widenRegisterProvenanceSets(a, b, options = {}) {
  const left = a || unknownRegisterProvenanceSet();
  const right = b || unknownRegisterProvenanceSet();
  return {
    a: widenProvenance(left.a, right.a, options),
    x: widenProvenance(left.x, right.x, options),
    y: widenProvenance(left.y, right.y, options),
    s: widenProvenance(left.s, right.s, options)
  };
}

function registerProvenanceSetsEqual(a, b) {
  const left = a || unknownRegisterProvenanceSet();
  const right = b || unknownRegisterProvenanceSet();
  return REGISTER_NAMES.every((name) => provenanceEqual(left[name], right[name]));
}

function emptyRelations() {
  return {
    nzSource: null,
    compareSource: null
  };
}

function cloneRelation(relation) {
  return relation ? JSON.parse(JSON.stringify(relation)) : null;
}

function cloneRelations(relations) {
  const source = relations || emptyRelations();
  return {
    nzSource: cloneRelation(source.nzSource),
    compareSource: cloneRelation(source.compareSource)
  };
}

function sameRelation(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function joinRelations(a, b) {
  const left = a || emptyRelations();
  const right = b || emptyRelations();
  return {
    nzSource: sameRelation(left.nzSource, right.nzSource) ? cloneRelation(left.nzSource) : null,
    compareSource: sameRelation(left.compareSource, right.compareSource) ? cloneRelation(left.compareSource) : null
  };
}

export function bottomState() {
  return { kind: ABSTRACT_STATE_KIND.BOTTOM };
}

export function unknownEntryState(options = {}) {
  return {
    kind: ABSTRACT_STATE_KIND.STATE,
    flags: createUnknownFlags(),
    registers: {
      a: topByte(),
      x: topByte(),
      y: topByte(),
      s: topByte()
    },
    registerProvenance: entryRegisterProvenanceSet(),
    ramBytes: createByteMemory(),
    ramProvenance: createProvenanceMemory(),
    shadowStack: createShadowStack(),
    relations: emptyRelations(),
    mapperState: options.mapperContext
      ? initialMapperStateForContext(options.mapperContext, options)
      : topMapperState(options)
  };
}

export function unknownEntryStateForMapperContext(mapperContext, options = {}) {
  return unknownEntryState({ ...options, mapperContext });
}

export function cloneState(state, options = {}) {
  if (state.kind === ABSTRACT_STATE_KIND.BOTTOM) return bottomState();
  return {
    kind: ABSTRACT_STATE_KIND.STATE,
    flags: { ...state.flags },
    registers: {
      a: abstractByteFromSerializable(state.registers.a),
      x: abstractByteFromSerializable(state.registers.x),
      y: abstractByteFromSerializable(state.registers.y),
      s: abstractByteFromSerializable(state.registers.s)
    },
    registerProvenance: cloneRegisterProvenanceSet(state.registerProvenance),
    ramBytes: cloneByteMemory(state.ramBytes),
    ramProvenance: cloneProvenanceMemory(state.ramProvenance),
    shadowStack: cloneShadowStack(state.shadowStack),
    relations: cloneRelations(state.relations),
    mapperState: cloneMapperState(state.mapperState, options)
  };
}

export function isBottomState(state) {
  return !state || state.kind === ABSTRACT_STATE_KIND.BOTTOM;
}

export function joinStates(a, b, options = {}) {
  if (isBottomState(a)) return cloneState(b, options);
  if (isBottomState(b)) return cloneState(a, options);
  return reduceState({
    kind: ABSTRACT_STATE_KIND.STATE,
    flags: joinFlags(a.flags, b.flags),
    registers: {
      a: joinRegister(a, b, 'a', options),
      x: joinRegister(a, b, 'x', options),
      y: joinRegister(a, b, 'y', options),
      s: joinRegister(a, b, 's', options)
    },
    registerProvenance: joinRegisterProvenanceSets(a.registerProvenance, b.registerProvenance, options),
    ramBytes: joinByteMemory(a.ramBytes, b.ramBytes, options),
    ramProvenance: joinProvenanceMemory(a.ramProvenance, b.ramProvenance, options),
    shadowStack: joinShadowStack(a.shadowStack, b.shadowStack, options),
    relations: joinRelations(a.relations, b.relations),
    mapperState: joinMapperStates(a.mapperState, b.mapperState, options)
  }, options);
}

export function widenStates(a, b, options = {}) {
  if (isBottomState(a)) return cloneState(b, options);
  if (isBottomState(b)) return cloneState(a, options);
  return reduceState({
    kind: ABSTRACT_STATE_KIND.STATE,
    flags: joinFlags(a.flags, b.flags),
    registers: {
      a: widenByte(a.registers.a, b.registers.a, options),
      x: widenByte(a.registers.x, b.registers.x, options),
      y: widenByte(a.registers.y, b.registers.y, options),
      s: widenByte(a.registers.s, b.registers.s, options)
    },
    registerProvenance: widenRegisterProvenanceSets(a.registerProvenance, b.registerProvenance, options),
    ramBytes: widenByteMemory(a.ramBytes, b.ramBytes, options),
    ramProvenance: widenProvenanceMemory(a.ramProvenance, b.ramProvenance, options),
    shadowStack: widenShadowStack(a.shadowStack, b.shadowStack, options),
    relations: joinRelations(a.relations, b.relations),
    mapperState: widenMapperStates(a.mapperState, b.mapperState, options)
  }, options);
}

function joinRegister(a, b, name, options) {
  return joinByte(a.registers[name], b.registers[name], options);
}


export function narrowStates(oldState, candidateState, options = {}) {
  if (isBottomState(oldState)) return cloneState(candidateState, options);
  if (isBottomState(candidateState)) return cloneState(oldState, options);
  const registers = {};
  const registerProvenance = {};
  for (const name of REGISTER_NAMES) {
    const useCandidate = byteSubsetOf(candidateState.registers[name], oldState.registers[name]);
    registers[name] = useCandidate ? candidateState.registers[name] : oldState.registers[name];
    registerProvenance[name] = useCandidate
      ? cloneProvenance(candidateState.registerProvenance?.[name])
      : cloneProvenance(oldState.registerProvenance?.[name]);
  }
  return reduceState({
    kind: ABSTRACT_STATE_KIND.STATE,
    flags: joinFlags(oldState.flags, candidateState.flags),
    registers,
    registerProvenance,
    ramBytes: oldState.ramBytes,
    ramProvenance: oldState.ramProvenance,
    shadowStack: oldState.shadowStack,
    relations: joinRelations(oldState.relations, candidateState.relations),
    mapperState: mapperStateSubsetOf(candidateState.mapperState, oldState.mapperState, options)
      ? candidateState.mapperState
      : oldState.mapperState
  }, options);
}

export function statesEqual(a, b, options = {}) {
  if (isBottomState(a) || isBottomState(b)) return isBottomState(a) && isBottomState(b);
  if (!flagsEqual(a.flags, b.flags)) return false;
  for (const name of REGISTER_NAMES) {
    if (!byteEqual(a.registers[name], b.registers[name])) return false;
  }
  if (!registerProvenanceSetsEqual(a.registerProvenance, b.registerProvenance)) return false;
  if (!byteMemoryEquals(a.ramBytes, b.ramBytes)) return false;
  if (!provenanceMemoryEquals(a.ramProvenance, b.ramProvenance)) return false;
  if (!shadowStackEquals(a.shadowStack, b.shadowStack)) return false;
  if (!mapperStatesEqual(a.mapperState, b.mapperState, options)) return false;
  return sameRelation(a.relations?.nzSource, b.relations?.nzSource) && sameRelation(a.relations?.compareSource, b.relations?.compareSource);
}


export function refineRegisterByte(state, registerName, byte, options = {}) {
  if (isBottomState(state)) return bottomState();
  const out = cloneState(state, options);
  const refined = intersectByte(out.registers[registerName], byte, options);
  if (isBottomByte(refined)) {
    if (options.throwOnLoopSummaryContradiction) {
      throw new Error(`Loop summary refinement contradicted register ${registerName}`);
    }
    return bottomState();
  }
  out.registers[registerName] = refined;
  return reduceState(out, options);
}

export function setRegister(state, registerName, byte, options = {}) {
  const out = cloneState(state, options);
  out.registers[registerName] = abstractByteFromSerializable(byte);
  out.registerProvenance[registerName] = unknownProvenance();
  return reduceState(out, options);
}

export function setRegisterWithProvenance(state, registerName, byte, provenance, options = {}) {
  const out = cloneState(state, options);
  out.registers[registerName] = abstractByteFromSerializable(byte);
  out.registerProvenance[registerName] = provenanceFromSerializable(provenance);
  return reduceState(out, options);
}

export function clearRegisterProvenance(state) {
  state.registerProvenance = unknownRegisterProvenanceSet();
  return state;
}

export function setNzSource(state, registerName) {
  state.relations = {
    ...(state.relations || emptyRelations()),
    nzSource: { kind: 'register', registerName },
    compareSource: null
  };
  return state;
}

export function setCompareSource(state, registerName, operand) {
  state.relations = {
    ...(state.relations || emptyRelations()),
    nzSource: null,
    compareSource: {
      kind: 'compare',
      registerName,
      operand: abstractByteToSerializable(operand)
    }
  };
  return state;
}

export function clearRelations(state) {
  state.relations = emptyRelations();
  return state;
}

export function abstractStateToSerializable(state, options = {}) {
  if (isBottomState(state)) return { kind: ABSTRACT_STATE_KIND.BOTTOM };
  return {
    kind: ABSTRACT_STATE_KIND.STATE,
    flags: { ...state.flags },
    registers: {
      a: abstractByteToSerializable(state.registers.a),
      x: abstractByteToSerializable(state.registers.x),
      y: abstractByteToSerializable(state.registers.y),
      s: abstractByteToSerializable(state.registers.s)
    },
    registerProvenance: {
      a: provenanceToSerializable(state.registerProvenance?.a),
      x: provenanceToSerializable(state.registerProvenance?.x),
      y: provenanceToSerializable(state.registerProvenance?.y),
      s: provenanceToSerializable(state.registerProvenance?.s)
    },
    ramBytes: byteMemoryToSerializable(state.ramBytes),
    ramProvenance: provenanceMemoryToSerializable(state.ramProvenance),
    shadowStack: shadowStackToSerializable(state.shadowStack),
    relations: cloneRelations(state.relations),
    mapperState: mapperStateToSerializable(state.mapperState, options)
  };
}

export function abstractStateFromSerializable(value, options = {}) {
  if (!value || value.kind === ABSTRACT_STATE_KIND.BOTTOM) return bottomState();
  return reduceState({
    kind: ABSTRACT_STATE_KIND.STATE,
    flags: { ...createUnknownFlags(), ...(value.flags || {}) },
    registers: {
      a: abstractByteFromSerializable(value.registers?.a),
      x: abstractByteFromSerializable(value.registers?.x),
      y: abstractByteFromSerializable(value.registers?.y),
      s: abstractByteFromSerializable(value.registers?.s)
    },
    registerProvenance: {
      a: provenanceFromSerializable(value.registerProvenance?.a),
      x: provenanceFromSerializable(value.registerProvenance?.x),
      y: provenanceFromSerializable(value.registerProvenance?.y),
      s: provenanceFromSerializable(value.registerProvenance?.s)
    },
    ramBytes: byteMemoryFromSerializable(value.ramBytes || value.ramKnownBits),
    ramProvenance: provenanceMemoryFromSerializable(value.ramProvenance),
    shadowStack: shadowStackFromSerializable(value.shadowStack),
    relations: cloneRelations(value.relations),
    mapperState: mapperStateFromSerializable(value.mapperState, options)
  });
}
