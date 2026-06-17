import { EDGE_KINDS, FRONTIER_KINDS } from '../cfg/constants.js';
import { requireInteger, requireObject, requireString } from '../dataShape.js';
import { hexRom } from '../identity.js';

const PRG_CPU_START = 0x8000;
const PRG_CPU_END = 0xffff;

function isPrgCpuAddr(cpuAddr) {
  const addr = cpuAddr & 0xffff;
  return addr >= PRG_CPU_START && addr <= PRG_CPU_END;
}

function windowBaseForCpuAddr(cpuAddr, bankSize) {
  const normalized = cpuAddr & 0xffff;
  const offset = normalized - PRG_CPU_START;
  return PRG_CPU_START + Math.floor(offset / bankSize) * bankSize;
}

export function requireFrontierForMappingSpeculation(frontier, label = 'mapping speculation frontier') {
  requireObject(frontier, label);
  requireString(frontier.frontierId, `${label}.frontierId`);
  requireString(frontier.kind, `${label}.kind`);
  if (frontier.kind !== FRONTIER_KINDS.AMBIGUOUS_DIRECT_TARGET) {
    throw new Error(`${label}.kind must be ${FRONTIER_KINDS.AMBIGUOUS_DIRECT_TARGET}`);
  }
  requireString(frontier.siteKey, `${label}.siteKey`);
  requireString(frontier.contextKey, `${label}.contextKey`);
  requireInteger(frontier.cpuAddr, `${label}.cpuAddr`);
  requireInteger(frontier.romOff, `${label}.romOff`);
  const detail = requireObject(frontier.detail, `${label}.detail`);
  requireInteger(detail.fromInstructionId, `${label}.detail.fromInstructionId`);
  requireString(detail.fromBlockInstanceId, `${label}.detail.fromBlockInstanceId`);
  requireString(detail.fromSiteKey, `${label}.detail.fromSiteKey`);
  requireString(detail.edgeKind, `${label}.detail.edgeKind`);
  requireInteger(detail.targetCpuAddr, `${label}.detail.targetCpuAddr`);
  return frontier;
}

export function requireMappingSpeculationCandidate(candidate, label = 'mapping speculation candidate') {
  requireObject(candidate, label);
  requireString(candidate.frontierId, `${label}.frontierId`);
  requireInteger(candidate.bankSize, `${label}.bankSize`);
  requireInteger(candidate.bankIndex, `${label}.bankIndex`);
  requireInteger(candidate.sourceBankIndex, `${label}.sourceBankIndex`);
  requireInteger(candidate.sourceRomOff, `${label}.sourceRomOff`);
  requireInteger(candidate.sourceCpuAddr, `${label}.sourceCpuAddr`);
  requireInteger(candidate.targetCpuAddr, `${label}.targetCpuAddr`);
  requireInteger(candidate.startRomOff, `${label}.startRomOff`);
  requireInteger(candidate.offsetInWindow, `${label}.offsetInWindow`);
  if (candidate.reason !== undefined) requireString(candidate.reason, `${label}.reason`);
  return candidate;
}

export function makeAttemptKey(candidate) {
  requireMappingSpeculationCandidate(candidate);
  return [
    candidate.frontierId,
    candidate.bankSize >>> 0,
    candidate.bankIndex >>> 0,
    candidate.targetCpuAddr & 0xffff,
    candidate.startRomOff >>> 0
  ].join('|');
}

export function makeAttemptId(candidate) {
  requireMappingSpeculationCandidate(candidate);
  return `mappingSpeculation:${candidate.frontierId}:bank${candidate.bankSize}:${candidate.bankIndex}:start${hexRom(candidate.startRomOff)}`;
}

export function makeCandidateBlockId(attemptId, romStart) {
  requireString(attemptId, 'candidate block attemptId');
  requireInteger(romStart, 'candidate block romStart');
  return `candidateBlock:${attemptId}:${hexRom(romStart)}`;
}

export function makeCandidateEdgeId(attemptId, fromInstructionId, kind, targetCpuAddr) {
  requireString(attemptId, 'candidate edge attemptId');
  requireInteger(fromInstructionId, 'candidate edge fromInstructionId');
  requireString(kind, 'candidate edge kind');
  requireInteger(targetCpuAddr, 'candidate edge targetCpuAddr');
  return `candidateEdge:${attemptId}:${fromInstructionId >>> 0}:${kind}:$${(targetCpuAddr & 0xffff).toString(16).padStart(4, '0').toUpperCase()}`;
}

export function buildSliceCandidates({ frontier, prgSize, bankSize, skipSourceBank = true }) {
  requireFrontierForMappingSpeculation(frontier, 'slice candidate frontier');
  const normalizedPrgSize = requireInteger(prgSize, 'slice candidate prgSize') >>> 0;
  const normalizedBankSize = requireInteger(bankSize, 'slice candidate bankSize') >>> 0;
  if (!normalizedBankSize) throw new Error('slice candidate bankSize must be non-zero');
  if (normalizedPrgSize % normalizedBankSize !== 0) {
    throw new Error('slice candidate prgSize must be an exact multiple of bankSize');
  }

  const sourceCpuAddr = frontier.cpuAddr & 0xffff;
  const targetCpuAddr = frontier.detail.targetCpuAddr & 0xffff;
  if (!isPrgCpuAddr(sourceCpuAddr) || !isPrgCpuAddr(targetCpuAddr)) return [];

  const sourceWindowBase = windowBaseForCpuAddr(sourceCpuAddr, normalizedBankSize);
  const targetWindowBase = windowBaseForCpuAddr(targetCpuAddr, normalizedBankSize);
  if (sourceWindowBase === targetWindowBase) return [];

  const sourceBankIndex = Math.floor((frontier.romOff >>> 0) / normalizedBankSize);
  const offsetInWindow = targetCpuAddr - targetWindowBase;
  const bankCount = Math.floor(normalizedPrgSize / normalizedBankSize);
  const out = [];

  for (let bankIndex = 0; bankIndex < bankCount; bankIndex += 1) {
    if (skipSourceBank && bankIndex === sourceBankIndex) continue;
    const startRomOff = bankIndex * normalizedBankSize + offsetInWindow;
    if (startRomOff < 0 || startRomOff >= normalizedPrgSize) continue;
    out.push(requireMappingSpeculationCandidate({
      frontierId: frontier.frontierId,
      bankSize: normalizedBankSize,
      bankIndex,
      sourceBankIndex,
      sourceRomOff: frontier.romOff >>> 0,
      sourceCpuAddr,
      targetCpuAddr,
      startRomOff,
      offsetInWindow,
      reason: `crosses${normalizedBankSize}ByteWindow`
    }, `slice candidate ${bankIndex}`));
  }

  return out;
}

export function isDirectFrontierEligibleForMappingSpeculation(frontier) {
  if (!frontier || typeof frontier !== 'object') return false;
  if (frontier.kind !== FRONTIER_KINDS.AMBIGUOUS_DIRECT_TARGET) return false;
  if (!frontier.detail || typeof frontier.detail !== 'object' || Array.isArray(frontier.detail)) return false;
  const edgeKind = frontier.detail.edgeKind;
  return edgeKind === EDGE_KINDS.BRANCH_TAKEN ||
    edgeKind === EDGE_KINDS.BRANCH_NOT_TAKEN ||
    edgeKind === EDGE_KINDS.JUMP ||
    edgeKind === EDGE_KINDS.CALL ||
    edgeKind === EDGE_KINDS.FALLTHROUGH;
}
