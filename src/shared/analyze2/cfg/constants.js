export const PRODUCED_BY = Object.freeze({
  EXACT_CFG_PASS: 'exactCfgPass',
  MAPPING_SPECULATION: 'mappingSpeculation'
});

export const EDGE_KINDS = Object.freeze({
  FALLTHROUGH: 'fallthrough',
  BRANCH_TAKEN: 'branchTaken',
  BRANCH_NOT_TAKEN: 'branchNotTaken',
  JUMP: 'jump',
  CALL: 'call',
  RETURN: 'return',
  RTS_TRICK: 'rtsTrick',
  PHYSICAL_CONTINUATION: 'physicalContinuation'
});

export function isExecutableEdgeKind(kind) {
  return kind === EDGE_KINDS.FALLTHROUGH ||
    kind === EDGE_KINDS.BRANCH_TAKEN ||
    kind === EDGE_KINDS.BRANCH_NOT_TAKEN ||
    kind === EDGE_KINDS.JUMP ||
    kind === EDGE_KINDS.CALL ||
    kind === EDGE_KINDS.RETURN ||
    kind === EDGE_KINDS.RTS_TRICK;
}

export const FRONTIER_KINDS = Object.freeze({
  INDIRECT_JUMP: 'indirectJump',
  AMBIGUOUS_DIRECT_TARGET: 'ambiguousDirectTarget',
  UNMAPPED_TARGET: 'unmappedTarget',
  DECODE_FAILED: 'decodeFailed',
  POSSIBLE_MAPPER_WRITE: 'possibleMapperWrite',
  UNSUPPORTED_CONTROL_FLOW: 'unsupportedControlFlow'
});

export const FLOW_TYPES = Object.freeze({
  NEXT: 'next',
  BRANCH: 'branch',
  CALL: 'call',
  JUMP: 'jump',
  JMP_INDIRECT: 'jmp_ind',
  STOP: 'stop',
  ILLEGAL: 'illegal',
  UNMAPPED: 'unmapped'
});
