import { EDGE_KINDS } from '../cfg/constants.js';
import { requireInteger, requireObject, requireString } from '../dataShape.js';

export const CONTROL_TRANSFER_RESULT_KINDS = Object.freeze({
  EXACT: 'exact',
  FRONTIER: 'frontier'
});

export const CONTROL_TRANSFER_REASONS = Object.freeze({
  CROSSES_MAPPING_BOUNDARY: 'crossesMappingBoundary',
  SOURCE_HAS_MULTIPLE_CPU_APPEARANCES: 'sourceHasMultipleCpuAppearances',
  SOURCE_NOT_MAPPABLE: 'sourceNotMappable',
  TARGET_NOT_MAPPED: 'targetNotMapped',
  TARGET_AMBIGUOUS: 'targetAmbiguous'
});

export function signedBranchDisplacement(value) {
  const b = requireInteger(value, 'branch displacement') & 0xff;
  return b < 0x80 ? b : b - 0x100;
}

export function requireControlTransfer(transfer, label = 'control transfer') {
  requireObject(transfer, label);
  requireInteger(transfer.sourceRomOff, `${label}.sourceRomOff`);
  requireInteger(transfer.instructionSize, `${label}.instructionSize`);
  requireString(transfer.transferKind, `${label}.transferKind`);
  if (transfer.displacement !== undefined && transfer.displacement !== null) requireInteger(transfer.displacement, `${label}.displacement`);
  if (transfer.targetCpuAddr !== undefined && transfer.targetCpuAddr !== null) requireInteger(transfer.targetCpuAddr, `${label}.targetCpuAddr`);
  if (transfer.fromInstructionId !== undefined) requireInteger(transfer.fromInstructionId, `${label}.fromInstructionId`);
  if (transfer.edgeKind !== undefined) requireString(transfer.edgeKind, `${label}.edgeKind`);
  return transfer;
}

export function controlTransferTargetCpuAddr(sourceCpuAddr, transfer) {
  const normalizedSourceCpuAddr = requireInteger(sourceCpuAddr, 'control transfer sourceCpuAddr') & 0xffff;
  const checked = requireControlTransfer(transfer);
  const size = checked.instructionSize >>> 0;
  switch (checked.transferKind) {
    case EDGE_KINDS.BRANCH_TAKEN:
      return (normalizedSourceCpuAddr + size + signedBranchDisplacement(checked.displacement)) & 0xffff;
    case EDGE_KINDS.BRANCH_NOT_TAKEN:
    case EDGE_KINDS.FALLTHROUGH:
      return (normalizedSourceCpuAddr + size) & 0xffff;
    case EDGE_KINDS.CALL:
    case EDGE_KINDS.JUMP:
      return requireInteger(checked.targetCpuAddr, 'control transfer targetCpuAddr') & 0xffff;
    default:
      throw new Error(`Unsupported exact CFG control transfer kind ${checked.transferKind}`);
  }
}

export function exactControlTransferResult({ source, target, detail }) {
  requireObject(source, 'exact control transfer source');
  requireObject(target, 'exact control transfer target');
  requireObject(detail, 'exact control transfer detail');
  return {
    kind: CONTROL_TRANSFER_RESULT_KINDS.EXACT,
    source,
    target,
    detail
  };
}

export function frontierControlTransferResult({ reason, sourceRomOff, sourceAppearances = [], targetCpuAddrs = [], candidateTargets = [], detail = {} }) {
  requireString(reason, 'frontier control transfer reason');
  requireInteger(sourceRomOff, 'frontier control transfer sourceRomOff');
  return {
    kind: CONTROL_TRANSFER_RESULT_KINDS.FRONTIER,
    reason,
    sourceRomOff: sourceRomOff >>> 0,
    sourceAppearances,
    targetCpuAddrs,
    candidateTargets,
    detail: requireObject(detail, 'frontier control transfer detail')
  };
}
