export function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

export function requireString(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function requireNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

export function requireInteger(value, label) {
  requireNumber(value, label);
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

export function requireNullableNumber(value, label) {
  if (value === null) return null;
  return requireNumber(value, label);
}

export function requireStringArray(value, label) {
  const arr = requireArray(value, label);
  for (let i = 0; i < arr.length; i += 1) {
    requireString(arr[i], `${label}[${i}]`);
  }
  return arr;
}

export function requireInstruction(instruction, label = 'instruction') {
  requireObject(instruction, label);
  requireInteger(instruction.instructionId, `${label}.instructionId`);
  requireInteger(instruction.romOff, `${label}.romOff`);
  if ((instruction.instructionId >>> 0) !== (instruction.romOff >>> 0)) {
    throw new Error(`${label}.instructionId must equal ${label}.romOff`);
  }
  requireInteger(instruction.opcode, `${label}.opcode`);
  if (instruction.operand !== null) requireInteger(instruction.operand, `${label}.operand`);
  requireInteger(instruction.size, `${label}.size`);
  if (instruction.size < 1 || instruction.size > 3) {
    throw new Error(`${label}.size must be 1, 2, or 3`);
  }
  requireObject(instruction.flow, `${label}.flow`);
  requireString(instruction.flow.type, `${label}.flow.type`);
  return instruction;
}

export function requireRawBlock(block, label = 'block') {
  requireObject(block, label);
  requireString(block.blockId, `${label}.blockId`);
  requireInteger(block.romStart, `${label}.romStart`);
  requireInteger(block.romEnd, `${label}.romEnd`);
  if ((block.romEnd >>> 0) <= (block.romStart >>> 0)) {
    throw new Error(`${label}.romEnd must be greater than ${label}.romStart`);
  }
  requireString(block.producedBy, `${label}.producedBy`);
  const ids = requireArray(block.instructionIds, `${label}.instructionIds`);
  if (!ids.length) throw new Error(`${label}.instructionIds must not be empty`);
  for (let i = 0; i < ids.length; i += 1) {
    requireInteger(ids[i], `${label}.instructionIds[${i}]`);
  }
  return block;
}

export function requireBlockInstance(instance, label = 'blockInstance') {
  requireObject(instance, label);
  requireString(instance.blockInstanceId, `${label}.blockInstanceId`);
  requireString(instance.blockId, `${label}.blockId`);
  requireString(instance.siteKey, `${label}.siteKey`);
  requireString(instance.contextKey, `${label}.contextKey`);
  requireInteger(instance.cpuStart, `${label}.cpuStart`);
  requireString(instance.producedBy, `${label}.producedBy`);
  return instance;
}

export function requireInstructionExecution(execution, label = 'instructionExecution') {
  requireObject(execution, label);
  requireInteger(execution.instructionId, `${label}.instructionId`);
  requireString(execution.siteKey, `${label}.siteKey`);
  requireString(execution.contextKey, `${label}.contextKey`);
  requireInteger(execution.cpuAddr, `${label}.cpuAddr`);
  requireString(execution.blockInstanceId, `${label}.blockInstanceId`);
  return execution;
}

export function requireEdge(edge, label = 'edge') {
  requireObject(edge, label);
  requireString(edge.edgeId, `${label}.edgeId`);
  requireString(edge.fromBlockInstanceId, `${label}.fromBlockInstanceId`);
  requireString(edge.toBlockInstanceId, `${label}.toBlockInstanceId`);
  requireString(edge.kind, `${label}.kind`);
  requireInteger(edge.fromInstructionId, `${label}.fromInstructionId`);
  requireInteger(edge.targetCpuAddr, `${label}.targetCpuAddr`);
  requireInteger(edge.targetRomOff, `${label}.targetRomOff`);
  return edge;
}

export function requireCoalescedBlock(block, label = 'coalescedBlock') {
  requireObject(block, label);
  requireString(block.coalescedBlockId, `${label}.coalescedBlockId`);
  requireInteger(block.romStart, `${label}.romStart`);
  requireInteger(block.romEnd, `${label}.romEnd`);
  if ((block.romEnd >>> 0) <= (block.romStart >>> 0)) {
    throw new Error(`${label}.romEnd must be greater than ${label}.romStart`);
  }
  requireStringArray(block.sourceBlockIds, `${label}.sourceBlockIds`);
  requireStringArray(block.producedBy, `${label}.producedBy`);
  const ids = requireArray(block.instructionIds, `${label}.instructionIds`);
  if (!ids.length) throw new Error(`${label}.instructionIds must not be empty`);
  for (let i = 0; i < ids.length; i += 1) {
    requireInteger(ids[i], `${label}.instructionIds[${i}]`);
  }
  return block;
}

export function requireDisplayLine(line, label = 'displayLine') {
  requireObject(line, label);
  requireInteger(line.instructionId, `${label}.instructionId`);
  requireObject(line.backing, `${label}.backing`);
  requireString(line.backing.kind, `${label}.backing.kind`);
  requireInteger(line.backing.romOff, `${label}.backing.romOff`);
  requireInteger(line.romOff, `${label}.romOff`);
  requireNullableNumber(line.cpuAddr, `${label}.cpuAddr`);
  requireInteger(line.len, `${label}.len`);
  requireString(line.bytesText, `${label}.bytesText`);
  requireString(line.asm, `${label}.asm`);
  requireString(line.mnemonic, `${label}.mnemonic`);
  return line;
}

export function requireDisplayBlock(block, label = 'displayBlock') {
  requireObject(block, label);
  requireString(block.id, `${label}.id`);
  requireString(block.coalescedBlockId, `${label}.coalescedBlockId`);
  requireInteger(block.romStart, `${label}.romStart`);
  requireInteger(block.romEnd, `${label}.romEnd`);
  requireStringArray(block.sourceBlockIds, `${label}.sourceBlockIds`);
  requireStringArray(block.producedBy, `${label}.producedBy`);
  requireNullableNumber(block.cpuStart, `${label}.cpuStart`);
  requireNullableNumber(block.cpuEnd, `${label}.cpuEnd`);
  requireArray(block.runtimeLocations, `${label}.runtimeLocations`);
  const lines = requireArray(block.lines, `${label}.lines`);
  for (let i = 0; i < lines.length; i += 1) {
    requireDisplayLine(lines[i], `${label}.lines[${i}]`);
  }
  return block;
}

export function buildInstructionMap(instructions, label = 'instructions') {
  const arr = requireArray(instructions, label);
  const instructionById = new Map();
  for (let i = 0; i < arr.length; i += 1) {
    const instruction = requireInstruction(arr[i], `${label}[${i}]`);
    const instructionId = instruction.instructionId >>> 0;
    if (instructionById.has(instructionId)) {
      throw new Error(`Duplicate decoded instruction for romOff ${instructionId}`);
    }
    instructionById.set(instructionId, instruction);
  }
  return instructionById;
}

export function requireInstructionFromMap(instructionById, instructionId, label = 'instructionId') {
  requireInteger(instructionId, label);
  const key = instructionId >>> 0;
  if (!instructionById.has(key)) {
    throw new Error(`Missing decoded instruction for romOff ${key}`);
  }
  return instructionById.get(key);
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
  return candidate;
}

export function requireMappingSpeculationSpan(span, label = 'mapping speculation span') {
  requireObject(span, label);
  requireString(span.attemptId, `${label}.attemptId`);
  requireString(span.frontierId, `${label}.frontierId`);
  requireInteger(span.bankSize, `${label}.bankSize`);
  requireInteger(span.bankIndex, `${label}.bankIndex`);
  requireInteger(span.romStart, `${label}.romStart`);
  requireInteger(span.romEnd, `${label}.romEnd`);
  if ((span.romEnd >>> 0) <= (span.romStart >>> 0)) {
    throw new Error(`${label}.romEnd must be greater than ${label}.romStart`);
  }
  requireString(span.status, `${label}.status`);
  return span;
}

export function requireMappingSpeculationAttempt(attempt, label = 'mapping speculation attempt') {
  requireObject(attempt, label);
  requireString(attempt.attemptId, `${label}.attemptId`);
  requireString(attempt.frontierId, `${label}.frontierId`);
  requireInteger(attempt.bankSize, `${label}.bankSize`);
  requireInteger(attempt.bankIndex, `${label}.bankIndex`);
  requireInteger(attempt.sourceBankIndex, `${label}.sourceBankIndex`);
  requireInteger(attempt.targetCpuAddr, `${label}.targetCpuAddr`);
  requireInteger(attempt.startRomOff, `${label}.startRomOff`);
  requireString(attempt.status, `${label}.status`);
  requireInteger(attempt.romStart, `${label}.romStart`);
  requireInteger(attempt.romEnd, `${label}.romEnd`);
  requireArray(attempt.candidateBlockIds, `${label}.candidateBlockIds`);
  return attempt;
}

export function requireCandidateBlock(block, label = 'candidate block') {
  requireObject(block, label);
  requireString(block.candidateBlockId, `${label}.candidateBlockId`);
  requireString(block.producedBy, `${label}.producedBy`);
  requireString(block.frontierId, `${label}.frontierId`);
  requireString(block.attemptId, `${label}.attemptId`);
  requireInteger(block.romStart, `${label}.romStart`);
  requireInteger(block.romEnd, `${label}.romEnd`);
  if ((block.romEnd >>> 0) <= (block.romStart >>> 0)) {
    throw new Error(`${label}.romEnd must be greater than ${label}.romStart`);
  }
  const ids = requireArray(block.instructionIds, `${label}.instructionIds`);
  if (!ids.length) throw new Error(`${label}.instructionIds must not be empty`);
  for (let i = 0; i < ids.length; i += 1) {
    requireInteger(ids[i], `${label}.instructionIds[${i}]`);
  }
  requireInteger(block.bankSize, `${label}.bankSize`);
  requireInteger(block.bankIndex, `${label}.bankIndex`);
  requireInteger(block.targetCpuAddr, `${label}.targetCpuAddr`);
  return block;
}
