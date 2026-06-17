import { requireArray, requireInteger, requireObject, requireString } from '../dataShape.js';
import { abstractStateFromSerializable } from '../abstractInterpretation/state.js';
import { transferInstruction } from '../abstractInterpretation/transfer.js';
import {
  formatAbstractStateSummary,
  formatRamBytes,
  formatStateDeltaDetails
} from './formatAbstractState.js';

function indexBy(items, keyName, label) {
  const out = new Map();
  for (const item of requireArray(items, label)) {
    requireObject(item, `${label} item`);
    const key = requireString(item[keyName], `${label} item.${keyName}`);
    if (out.has(key)) throw new Error(`Duplicate ${label} ${key}`);
    out.set(key, item);
  }
  return out;
}

function indexInstructions(instructions) {
  const out = new Map();
  for (const instruction of requireArray(instructions, 'debug instructions')) {
    requireObject(instruction, 'debug instruction');
    const id = requireInteger(instruction.instructionId, 'debug instruction.instructionId') >>> 0;
    if (out.has(id)) throw new Error(`Duplicate debug instruction ${id}`);
    out.set(id, instruction);
  }
  return out;
}

function groupExecutions(executions) {
  const out = new Map();
  for (const execution of requireArray(executions, 'debug instructionExecutions')) {
    requireObject(execution, 'debug instructionExecution');
    const blockInstanceId = requireString(execution.blockInstanceId, 'debug instructionExecution.blockInstanceId');
    let list = out.get(blockInstanceId);
    if (!list) {
      list = [];
      out.set(blockInstanceId, list);
    }
    list.push(execution);
  }
  return out;
}

function blockStatesById(abstractInterpretation) {
  const out = new Map();
  for (const state of requireArray(abstractInterpretation.blockStates, 'abstractInterpretation.blockStates')) {
    requireObject(state, 'abstractInterpretation blockState');
    const blockInstanceId = requireString(state.blockInstanceId, 'abstractInterpretation blockState.blockInstanceId');
    if (out.has(blockInstanceId)) throw new Error(`Duplicate abstractInterpretation blockState ${blockInstanceId}`);
    out.set(blockInstanceId, state);
  }
  return out;
}

function selectedContextKeyForDisplayBlock(displayBlock) {
  requireObject(displayBlock, 'displayBlock');
  for (const line of requireArray(displayBlock.lines, 'displayBlock.lines')) {
    if (typeof line?.contextKey === 'string' && line.contextKey) return line.contextKey;
  }
  const locations = requireArray(displayBlock.runtimeLocations, 'displayBlock.runtimeLocations');
  if (locations.length > 0 && typeof locations[0]?.contextKey === 'string') return locations[0].contextKey;
  return null;
}

function selectedBlockInstances(displayBlock, rawAnalysis, contextKey, maps) {
  const sourceBlockIds = new Set(requireArray(displayBlock.sourceBlockIds, 'displayBlock.sourceBlockIds'));
  const out = [];
  for (const instance of requireArray(rawAnalysis.blockInstances, 'rawAnalysis.blockInstances')) {
    if (!sourceBlockIds.has(instance.blockId)) continue;
    if (instance.contextKey !== contextKey) continue;
    out.push(instance);
  }

  out.sort((a, b) => {
    const blockA = maps.blockById.get(a.blockId);
    const blockB = maps.blockById.get(b.blockId);
    return (blockA?.romStart ?? 0) - (blockB?.romStart ?? 0) || a.blockInstanceId.localeCompare(b.blockInstanceId);
  });
  return out;
}

function makeLineEntries(displayBlock) {
  const out = new Map();
  for (const line of requireArray(displayBlock.lines, 'displayBlock.lines')) {
    requireObject(line, 'display line');
    const id = requireInteger(line.instructionId, 'display line.instructionId') >>> 0;
    out.set(id, {
      instructionId: id,
      romOff: line.romOff,
      romEnd: (line.romOff + line.len) >>> 0,
      cpuAddr: line.cpuAddr,
      bytesText: line.bytesText,
      asm: line.asm,
      entries: []
    });
  }
  return out;
}

function executionByInstructionIdForInstance(instance, maps) {
  const executions = maps.executionsByBlockInstanceId.get(instance.blockInstanceId) || [];
  const out = new Map();
  for (const execution of executions) out.set(requireInteger(execution.instructionId, 'execution.instructionId') >>> 0, execution);
  return out;
}

function replayBlockInstance({ instance, rawAnalysis, mapper, prgBytes, maps, lineByInstructionId, options }) {
  const block = maps.blockById.get(instance.blockId);
  if (!block) throw new Error(`Debug block instance ${instance.blockInstanceId} references missing block ${instance.blockId}`);
  const blockState = maps.blockStateById.get(instance.blockInstanceId);
  if (!blockState) throw new Error(`No abstract interpretation state for selected block instance ${instance.blockInstanceId}`);

  const domainOptions = {
    ...options,
    mapperDomain: options.mapperDomain && typeof options.mapperDomain.join === 'function' ? options.mapperDomain : mapper.mapperDomain
  };
  let state = abstractStateFromSerializable(blockState.inState, domainOptions);
  const executionByInstructionId = executionByInstructionIdForInstance(instance, maps);

  for (const rawInstructionId of requireArray(block.instructionIds, `${block.blockId}.instructionIds`)) {
    const instructionId = requireInteger(rawInstructionId, `${block.blockId}.instructionIds item`) >>> 0;
    const instruction = maps.instructionById.get(instructionId);
    if (!instruction) throw new Error(`Missing debug instruction ${instructionId}`);
    const execution = executionByInstructionId.get(instructionId);
    if (!execution) throw new Error(`Missing debug execution for ${instructionId} in ${instance.blockInstanceId}`);

    const before = state;
    const after = transferInstruction(before, instruction, {
      mapper,
      prgBytes,
      contexts: rawAnalysis.contexts,
      contextKey: execution.contextKey
    }, domainOptions);

    const line = lineByInstructionId.get(instructionId);
    if (line) {
      const details = formatStateDeltaDetails(before, after, domainOptions);
      if (details.length === 0) details.push('no abstract state change');
      details.push(formatRamBytes(after.ramBytes));
      line.entries.push({
        id: `${instance.blockInstanceId}:${instructionId}`,
        kind: 'abstractInterpretation',
        text: formatAbstractStateSummary(after, domainOptions),
        details
      });
    }

    state = after;
  }
}

export function buildAbstractInterpretationBlockDebug({ rawAnalysis, displayBlock, mapper, prgBytes = null }) {
  requireObject(rawAnalysis, 'rawAnalysis');
  requireObject(displayBlock, 'displayBlock');
  requireObject(mapper, 'mapper');
  const abstractInterpretation = requireObject(rawAnalysis.abstractInterpretation, 'rawAnalysis.abstractInterpretation');
  const effectivePrgBytes = prgBytes || rawAnalysis.prgBytes;
  if (!effectivePrgBytes || typeof effectivePrgBytes.length !== 'number') throw new Error('PRG bytes are missing for abstract interpretation debug');
  const contextKey = selectedContextKeyForDisplayBlock(displayBlock);
  if (!contextKey) throw new Error('No runtime context found for display block');

  const maps = {
    blockById: indexBy(rawAnalysis.blocks, 'blockId', 'rawAnalysis.blocks'),
    instructionById: indexInstructions(rawAnalysis.instructions),
    executionsByBlockInstanceId: groupExecutions(rawAnalysis.instructionExecutions),
    blockStateById: blockStatesById(abstractInterpretation)
  };

  const instances = selectedBlockInstances(displayBlock, rawAnalysis, contextKey, maps);
  if (instances.length === 0) throw new Error('No block instances found for selected display block context');

  const lineByInstructionId = makeLineEntries(displayBlock);
  for (const instance of instances) {
    replayBlockInstance({
      instance,
      rawAnalysis,
      mapper,
      prgBytes: effectivePrgBytes,
      maps,
      lineByInstructionId,
      options: abstractInterpretation.options || {}
    });
  }

  const lines = Array.from(lineByInstructionId.values()).sort((a, b) => a.romOff - b.romOff || a.instructionId - b.instructionId);
  const entryCount = lines.reduce((sum, line) => sum + line.entries.length, 0);

  return {
    displayBlockId: displayBlock.id,
    selectedContextKey: contextKey,
    selectedBlockInstanceIds: instances.map((instance) => instance.blockInstanceId),
    alternativeRuntimeLocationCount: Math.max(0, requireArray(displayBlock.runtimeLocations, 'displayBlock.runtimeLocations').length - 1),
    romStart: displayBlock.romStart,
    romEnd: displayBlock.romEnd,
    cpuStart: displayBlock.cpuStart,
    lineCount: lines.length,
    entryCount,
    domains: abstractInterpretation.domains || ['flags', 'knownBits', 'byteScalar', 'reducedBytes', mapper.mapperDomain?.id ? `mapper:${mapper.mapperDomain.id}` : 'mapper'],
    lines
  };
}
