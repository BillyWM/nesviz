import { enumerateTrackedByteValues } from './trackedValue.js';
import { classifyPpuDataDestinations } from '../../nes/ppuAddressUtils.js';

const PPU_ADDR_CANDIDATE_CAP = 64;

const PPUCTRL_FIELDS = [
  'nametableBase',
  'vramIncrement',
  'spritePatternTable',
  'backgroundPatternTable',
  'spriteSize',
  'masterSlave',
  'nmiEnabled'
];

function unknownPpuCtrlDecoded(overrides = null) {
  return {
    nametableBase: null,
    vramIncrement: null,
    spritePatternTable: null,
    backgroundPatternTable: null,
    spriteSize: null,
    masterSlave: null,
    nmiEnabled: null,
    ...(overrides || {})
  };
}

function makePpuCtrlState(decodedOverrides = null) {
  const decoded = unknownPpuCtrlDecoded(decodedOverrides);
  return {
    candidates: null,
    candidateSource: null,
    knownMask: 0,
    knownValue: 0,
    decoded
  };
}

function clonePpuCtrlState(ctrl) {
  return {
    candidates: Array.isArray(ctrl?.candidates) ? [...ctrl.candidates] : null,
    candidateSource: typeof ctrl?.candidateSource === 'string' ? ctrl.candidateSource : null,
    knownMask: ctrl?.knownMask & 0xff,
    knownValue: ctrl?.knownValue & 0xff,
    decoded: unknownPpuCtrlDecoded(ctrl?.decoded || null)
  };
}

function normalizeCandidateList(values, cap = PPU_ADDR_CANDIDATE_CAP) {
  if (!Array.isArray(values)) return null;
  const unique = Array.from(new Set(values
    .map((value) => (typeof value === 'number' ? value : Number(value)))
    .filter((value) => Number.isFinite(value))
    .map((value) => value & 0x3fff)))
    .sort((a, b) => a - b);
  if (!unique.length) return [];
  if (unique.length > Math.max(1, cap | 0)) return null;
  return unique;
}

function normalizeByteList(values, cap = PPU_ADDR_CANDIDATE_CAP) {
  if (!Array.isArray(values)) return null;
  const unique = Array.from(new Set(values
    .map((value) => (typeof value === 'number' ? value : Number(value)))
    .filter((value) => Number.isFinite(value))
    .map((value) => value & 0xff)))
    .sort((a, b) => a - b);
  if (!unique.length) return [];
  if (unique.length > Math.max(1, cap | 0)) return null;
  return unique;
}

function byteCandidatesFromTracked(tracked, cap = PPU_ADDR_CANDIDATE_CAP) {
  return normalizeByteList(enumerateTrackedByteValues(tracked, cap)?.values || null, cap);
}

function unionLists(a, b, cap = PPU_ADDR_CANDIDATE_CAP) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  return normalizeCandidateList([...a, ...b], cap);
}

function unionByteLists(a, b, cap = PPU_ADDR_CANDIDATE_CAP) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  return normalizeByteList([...a, ...b], cap);
}

function arraysEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function decodedValuesEqual(a, b) {
  for (const field of PPUCTRL_FIELDS) {
    if ((a?.[field] ?? null) !== (b?.[field] ?? null)) return false;
  }
  return true;
}

function ppuCtrlStatesEqual(a, b) {
  return arraysEqual(a?.candidates || null, b?.candidates || null)
    && (a?.candidateSource || null) === (b?.candidateSource || null)
    && ((a?.knownMask || 0) & 0xff) === (((b?.knownMask || 0) & 0xff))
    && ((a?.knownValue || 0) & 0xff) === (((b?.knownValue || 0) & 0xff))
    && decodedValuesEqual(a?.decoded || null, b?.decoded || null);
}

function exactCandidateField(candidates, getter) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  let out = null;
  for (const candidate of candidates) {
    const value = getter(candidate & 0xff);
    if (out == null) out = value;
    else if (out !== value) return null;
  }
  return out;
}

function exactKnownBit(tracked, bit, whenClear, whenSet) {
  const mask = tracked?.bits?.knownMask ?? 0;
  if (!(mask & (1 << bit))) return null;
  const value = tracked?.bits?.knownValue ?? 0;
  return (value & (1 << bit)) ? whenSet : whenClear;
}

function exactKnownBits(tracked, mask, shift, mapper) {
  const knownMask = tracked?.bits?.knownMask ?? 0;
  if ((knownMask & mask) !== mask) return null;
  const value = ((tracked?.bits?.knownValue ?? 0) & mask) >> shift;
  return mapper(value);
}

function decodePpuCtrlTracked(tracked) {
  const enumeration = enumerateTrackedByteValues(tracked, PPU_ADDR_CANDIDATE_CAP);
  const candidates = normalizeByteList(enumeration?.values || null, PPU_ADDR_CANDIDATE_CAP);

  function fieldFromCandidates(getter) {
    return exactCandidateField(candidates, getter);
  }

  function fieldFromKnownBits(mask, shift, mapper) {
    return exactKnownBits(tracked, mask, shift, mapper);
  }

  function bitField(bit, whenClear, whenSet) {
    const fromCandidates = fieldFromCandidates((value) => (value & (1 << bit)) ? whenSet : whenClear);
    if (fromCandidates != null) return fromCandidates;
    return exactKnownBit(tracked, bit, whenClear, whenSet);
  }

  const nametableBase = fieldFromCandidates((value) => 0x2000 + ((value & 0x03) * 0x0400))
    ?? fieldFromKnownBits(0x03, 0, (value) => 0x2000 + ((value & 0x03) * 0x0400));

  return {
    candidates,
    candidateSource: candidates ? (enumeration?.source || null) : null,
    knownMask: (tracked?.bits?.knownMask ?? 0) & 0xff,
    knownValue: (tracked?.bits?.knownValue ?? 0) & 0xff,
    decoded: unknownPpuCtrlDecoded({
      nametableBase,
      vramIncrement: bitField(2, 1, 32),
      spritePatternTable: bitField(3, 0x0000, 0x1000),
      backgroundPatternTable: bitField(4, 0x0000, 0x1000),
      spriteSize: bitField(5, '8x8', '8x16'),
      masterSlave: bitField(6, 0, 1),
      nmiEnabled: bitField(7, false, true)
    })
  };
}

function changedFields(previousDecoded, nextDecoded) {
  const out = {};
  for (const field of PPUCTRL_FIELDS) {
    const previous = previousDecoded?.[field] ?? null;
    const next = nextDecoded?.[field] ?? null;
    out[field] = previous != null && next != null ? previous !== next : null;
  }
  return out;
}

function joinDecoded(a, b) {
  const out = unknownPpuCtrlDecoded();
  for (const field of PPUCTRL_FIELDS) {
    const left = a?.[field] ?? null;
    const right = b?.[field] ?? null;
    out[field] = left != null && left === right ? left : null;
  }
  return out;
}

function joinPpuCtrlState(a, b) {
  const left = clonePpuCtrlState(a);
  const right = clonePpuCtrlState(b);
  const commonKnownMask = left.knownMask & right.knownMask;
  const matchingKnownMask = commonKnownMask & (~(left.knownValue ^ right.knownValue) & 0xff);
  return {
    candidates: unionByteLists(left.candidates, right.candidates),
    candidateSource: left.candidateSource && left.candidateSource === right.candidateSource ? left.candidateSource : null,
    knownMask: matchingKnownMask & 0xff,
    knownValue: left.knownValue & matchingKnownMask,
    decoded: joinDecoded(left.decoded, right.decoded)
  };
}

export function makePpuState() {
  return {
    latchPhase: 'high',
    pendingAddrHighValues: null,
    addrCandidates: null,
    increment: 1,
    ctrl: makePpuCtrlState({ vramIncrement: 1 })
  };
}

export function clonePpuState(ppu) {
  return {
    latchPhase: ppu?.latchPhase === 'high' || ppu?.latchPhase === 'low' || ppu?.latchPhase === 'unknown' ? ppu.latchPhase : 'unknown',
    pendingAddrHighValues: Array.isArray(ppu?.pendingAddrHighValues) ? [...ppu.pendingAddrHighValues] : null,
    addrCandidates: Array.isArray(ppu?.addrCandidates) ? [...ppu.addrCandidates] : null,
    increment: ppu?.increment === 1 || ppu?.increment === 32 ? ppu.increment : null,
    ctrl: clonePpuCtrlState(ppu?.ctrl || makePpuCtrlState({ vramIncrement: ppu?.increment === 32 ? 32 : ppu?.increment === 1 ? 1 : null }))
  };
}

export function ppuStatesEqual(a, b) {
  return (a?.latchPhase || 'unknown') === (b?.latchPhase || 'unknown')
    && arraysEqual(a?.pendingAddrHighValues || null, b?.pendingAddrHighValues || null)
    && arraysEqual(a?.addrCandidates || null, b?.addrCandidates || null)
    && ((a?.increment === 1 || a?.increment === 32 ? a.increment : null) === (b?.increment === 1 || b?.increment === 32 ? b.increment : null))
    && ppuCtrlStatesEqual(a?.ctrl || null, b?.ctrl || null);
}

export function joinPpuState(a, b) {
  const left = clonePpuState(a);
  const right = clonePpuState(b);
  const latchPhase = left.latchPhase === right.latchPhase ? left.latchPhase : 'unknown';
  const ctrl = joinPpuCtrlState(left.ctrl, right.ctrl);
  const increment = ctrl.decoded.vramIncrement === 1 || ctrl.decoded.vramIncrement === 32
    ? ctrl.decoded.vramIncrement
    : (left.increment != null && right.increment != null && left.increment === right.increment ? left.increment : null);
  return {
    latchPhase,
    pendingAddrHighValues: latchPhase === 'low' ? unionByteLists(left.pendingAddrHighValues, right.pendingAddrHighValues) : null,
    addrCandidates: unionLists(left.addrCandidates, right.addrCandidates),
    increment,
    ctrl
  };
}

export function resetPpuAddressLatch(ppu) {
  if (!ppu) return;
  ppu.latchPhase = 'high';
  ppu.pendingAddrHighValues = null;
}

export function observePpuCtrlWrite(ppu, tracked) {
  const previous = clonePpuCtrlState(ppu?.ctrl || makePpuCtrlState({ vramIncrement: ppu?.increment === 32 ? 32 : ppu?.increment === 1 ? 1 : null }));
  const next = decodePpuCtrlTracked(tracked);
  return {
    candidates: Array.isArray(next.candidates) ? [...next.candidates] : [],
    candidateSource: next.candidateSource,
    knownMask: next.knownMask,
    knownValue: next.knownValue,
    decoded: unknownPpuCtrlDecoded(next.decoded),
    previousDecoded: unknownPpuCtrlDecoded(previous.decoded),
    changed: changedFields(previous.decoded, next.decoded)
  };
}

export function applyPpuCtrlWrite(ppu, tracked) {
  if (!ppu) return;
  const observed = observePpuCtrlWrite(ppu, tracked);
  ppu.ctrl = {
    candidates: observed.candidates.length ? [...observed.candidates] : null,
    candidateSource: observed.candidateSource,
    knownMask: observed.knownMask,
    knownValue: observed.knownValue,
    decoded: unknownPpuCtrlDecoded(observed.decoded)
  };
  ppu.increment = observed.decoded.vramIncrement === 1 || observed.decoded.vramIncrement === 32 ? observed.decoded.vramIncrement : null;
}

export function applyPpuScrollWrite(ppu) {
  if (!ppu) return;
  if (ppu.latchPhase === 'high') ppu.latchPhase = 'low';
  else if (ppu.latchPhase === 'low') ppu.latchPhase = 'high';
  else ppu.latchPhase = 'unknown';
}

export function applyPpuAddrWrite(ppu, tracked) {
  if (!ppu) return;
  if (ppu.latchPhase === 'high') {
    ppu.pendingAddrHighValues = byteCandidatesFromTracked(tracked, PPU_ADDR_CANDIDATE_CAP);
    ppu.latchPhase = 'low';
    return;
  }

  if (ppu.latchPhase === 'low') {
    const lowValues = byteCandidatesFromTracked(tracked, PPU_ADDR_CANDIDATE_CAP);
    const highValues = ppu.pendingAddrHighValues;
    ppu.pendingAddrHighValues = null;
    ppu.latchPhase = 'high';

    if (!highValues?.length || !lowValues?.length) {
      ppu.addrCandidates = null;
      return;
    }
    if ((highValues.length * lowValues.length) > PPU_ADDR_CANDIDATE_CAP) {
      ppu.addrCandidates = null;
      return;
    }
    const candidates = [];
    for (const high of highValues) {
      for (const low of lowValues) candidates.push((((high & 0x3f) << 8) | (low & 0xff)) & 0x3fff);
    }
    ppu.addrCandidates = normalizeCandidateList(candidates, PPU_ADDR_CANDIDATE_CAP);
    return;
  }

  ppu.pendingAddrHighValues = null;
  ppu.addrCandidates = null;
  ppu.latchPhase = 'unknown';
}

export function classifyPpuDataWrite(ppu) {
  return classifyPpuDataDestinations(ppu?.addrCandidates || []);
}

export function advancePpuAddrAfterPpudata(ppu) {
  if (!ppu) return;
  if (!Array.isArray(ppu.addrCandidates) || !ppu.addrCandidates.length || !(ppu.increment === 1 || ppu.increment === 32)) {
    ppu.addrCandidates = null;
    return;
  }
  ppu.addrCandidates = normalizeCandidateList(ppu.addrCandidates.map((addr) => (addr + ppu.increment) & 0x3fff), PPU_ADDR_CANDIDATE_CAP);
}
