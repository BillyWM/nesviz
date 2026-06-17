import { ANALYSIS_PHASE_IDS } from '../analysisConstants.js';
import { FRONTIER_KINDS } from '../cfg/constants.js';
import { abstractStateFromSerializable, isBottomState } from '../abstractInterpretation/state.js';
import {
  requireArray,
  requireInteger,
  requireObject,
  requireString
} from '../dataShape.js';

function makePhaseSummary(counters) {
  return {
    name: ANALYSIS_PHASE_IDS.MAPPED_CFG_EXPANSION,
    status: 'complete',
    counters: { ...counters }
  };
}

function indexByString(items, keyName, label) {
  const out = new Map();
  for (const item of requireArray(items, label)) {
    requireObject(item, `${label} item`);
    const key = requireString(item[keyName], `${label} item.${keyName}`);
    if (out.has(key)) throw new Error(`Duplicate ${label} ${key}`);
    out.set(key, item);
  }
  return out;
}

function indexInstructionExecutions(executions) {
  const out = new Map();
  for (const execution of requireArray(executions, 'mappedCfgExpansion instructionExecutions')) {
    requireObject(execution, 'mappedCfgExpansion instructionExecution');
    const instructionId = requireInteger(execution.instructionId, 'mappedCfgExpansion instructionExecution.instructionId') >>> 0;
    const siteKey = requireString(execution.siteKey, 'mappedCfgExpansion instructionExecution.siteKey');
    const key = `${instructionId}|${siteKey}`;
    if (out.has(key)) throw new Error(`Duplicate instruction execution key ${key}`);
    out.set(key, execution);
  }
  return out;
}

function indexBlockStates(blockStates) {
  const out = new Map();
  for (const blockState of requireArray(blockStates, 'mappedCfgExpansion blockStates')) {
    requireObject(blockState, 'mappedCfgExpansion blockState');
    const blockInstanceId = requireString(blockState.blockInstanceId, 'mappedCfgExpansion blockState.blockInstanceId');
    if (out.has(blockInstanceId)) throw new Error(`Duplicate abstract interpretation block state ${blockInstanceId}`);
    out.set(blockInstanceId, blockState);
  }
  return out;
}

function existingSeedSiteKeys(seedSites) {
  const out = new Set();
  for (const seed of requireArray(seedSites, 'mappedCfgExpansion seedSites')) {
    requireObject(seed, 'mappedCfgExpansion seed');
    out.add(requireString(seed.siteKey, 'mappedCfgExpansion seed.siteKey'));
  }
  return out;
}

function existingExecutableSiteKeys(blockInstances) {
  const out = new Set();
  for (const instance of requireArray(blockInstances, 'mappedCfgExpansion blockInstances')) {
    requireObject(instance, 'mappedCfgExpansion blockInstance');
    if (instance.reachability === 'physicalOnly') continue;
    out.add(requireString(instance.siteKey, 'mappedCfgExpansion blockInstance.siteKey'));
  }
  return out;
}

function sourceBlockInstanceForFrontier(frontier, executionByInstructionAndSite) {
  const detail = requireObject(frontier.detail, 'mappedCfgExpansion frontier.detail');
  const fromInstructionId = requireInteger(detail.fromInstructionId, 'mappedCfgExpansion frontier.detail.fromInstructionId') >>> 0;
  const siteKey = requireString(frontier.siteKey, 'mappedCfgExpansion frontier.siteKey');
  const execution = executionByInstructionAndSite.get(`${fromInstructionId}|${siteKey}`);
  return execution ? requireString(execution.blockInstanceId, 'mappedCfgExpansion source execution.blockInstanceId') : null;
}

function exactTargetFromMapperState(mapper, mapperState, fallthroughCpuAddr) {
  requireObject(mapper, 'mappedCfgExpansion mapper');
  if (typeof mapper.contextFromMapperState !== 'function') return null;
  if (typeof mapper.resolveControlTarget !== 'function') return null;

  const mapperContext = mapper.contextFromMapperState(mapperState);
  if (!mapperContext) return null;

  const resolved = mapper.resolveControlTarget(mapperContext, fallthroughCpuAddr & 0xffff, {
    policy: 'exactOnly',
    purpose: ANALYSIS_PHASE_IDS.MAPPED_CFG_EXPANSION
  });
  requireObject(resolved, 'mappedCfgExpansion resolved target');
  if (!resolved.ok) return null;

  const target = requireObject(resolved.target, 'mappedCfgExpansion resolved.target');
  requireString(target.siteKey, 'mappedCfgExpansion resolved.target.siteKey');
  requireString(target.contextKey, 'mappedCfgExpansion resolved.target.contextKey');
  requireObject(target.mapperContext, 'mappedCfgExpansion resolved.target.mapperContext');
  requireInteger(target.cpuAddr, 'mappedCfgExpansion resolved.target.cpuAddr');
  requireInteger(target.romOff, 'mappedCfgExpansion resolved.target.romOff');
  return target;
}

function createExpansionSeed(target, frontier, sourceBlockInstanceId) {
  const detail = requireObject(frontier.detail, 'mappedCfgExpansion expansion frontier.detail');
  const seed = {
    ...target,
    seedKind: ANALYSIS_PHASE_IDS.MAPPED_CFG_EXPANSION,
    sourceFrontierId: requireString(frontier.frontierId, 'mappedCfgExpansion frontier.frontierId'),
    sourceInstructionId: requireInteger(detail.fromInstructionId, 'mappedCfgExpansion frontier.detail.fromInstructionId') >>> 0,
    sourceBlockInstanceId,
    sourceCpuAddr: requireInteger(frontier.cpuAddr, 'mappedCfgExpansion frontier.cpuAddr') & 0xffff
  };
  if (frontier.romOff !== null && frontier.romOff !== undefined) {
    seed.sourceRomOff = requireInteger(frontier.romOff, 'mappedCfgExpansion frontier.romOff') >>> 0;
  }
  return seed;
}


function addCounters(a, b) {
  const out = { ...(a || {}) };
  for (const [key, value] of Object.entries(b || {})) {
    if (typeof value !== 'number') continue;
    out[key] = (typeof out[key] === 'number' ? out[key] : 0) + value;
  }
  return out;
}

function appendMappedCfgExpansionRun(previous, run) {
  if (!previous || typeof previous !== 'object') {
    return {
      producedBy: ANALYSIS_PHASE_IDS.MAPPED_CFG_EXPANSION,
      policy: 'exactOnly',
      runs: [run],
      addedSites: [...run.addedSites],
      unresolved: [...run.unresolved],
      counters: { ...run.counters }
    };
  }
  const runs = Array.isArray(previous.runs) ? previous.runs.slice() : [{
    runIndex: 0,
    addedSites: Array.isArray(previous.addedSites) ? previous.addedSites : [],
    unresolved: Array.isArray(previous.unresolved) ? previous.unresolved : [],
    counters: previous.counters && typeof previous.counters === 'object' ? previous.counters : {}
  }];
  runs.push(run);
  return {
    producedBy: ANALYSIS_PHASE_IDS.MAPPED_CFG_EXPANSION,
    policy: 'exactOnly',
    runs,
    addedSites: [...(Array.isArray(previous.addedSites) ? previous.addedSites : []), ...run.addedSites],
    unresolved: [...(Array.isArray(previous.unresolved) ? previous.unresolved : []), ...run.unresolved],
    counters: addCounters(previous.counters, run.counters)
  };
}

export function createMappedCfgExpansionPhase(context, options = null) {
  const opts = options === null || options === undefined ? {} : requireObject(options, 'mappedCfgExpansion options');
  const exactOnly = opts.policy === undefined ? true : opts.policy === 'exactOnly';
  if (!exactOnly) throw new Error('mappedCfgExpansion currently supports exactOnly policy only');

  return {
    name: ANALYSIS_PHASE_IDS.MAPPED_CFG_EXPANSION,
    stepOne() {
      const mapper = requireObject(context.mapper, 'mappedCfgExpansion context.mapper');
      const ai = requireObject(context.abstractInterpretation, 'mappedCfgExpansion context.abstractInterpretation');
      const blockStatesById = indexBlockStates(ai.blockStates);
      const executionByInstructionAndSite = indexInstructionExecutions(context.instructionExecutions);
      const blockInstanceById = indexByString(context.blockInstances, 'blockInstanceId', 'mappedCfgExpansion blockInstances');
      const knownSeedSiteKeys = existingSeedSiteKeys(context.seedSites);
      const knownExecutableSiteKeys = existingExecutableSiteKeys(context.blockInstances);

      const counters = {
        frontierCount: requireArray(context.frontiers, 'mappedCfgExpansion frontiers').length,
        consideredMapperWriteFrontiers: 0,
        missingFrontierDetail: 0,
        missingFallthroughCpuAddr: 0,
        missingSourceExecution: 0,
        physicalOnlySourceBlocks: 0,
        missingAiState: 0,
        bottomAiState: 0,
        targetNotExact: 0,
        duplicateSites: 0,
        alreadyExecutableSites: 0,
        addedSites: 0
      };
      const addedSites = [];
      const unresolved = [];

      for (const frontier of requireArray(context.frontiers, 'mappedCfgExpansion frontiers')) {
        requireObject(frontier, 'mappedCfgExpansion frontier');
        if (frontier.kind !== FRONTIER_KINDS.POSSIBLE_MAPPER_WRITE) continue;
        counters.consideredMapperWriteFrontiers += 1;

        const detail = frontier.detail && typeof frontier.detail === 'object' ? frontier.detail : null;
        if (!detail) {
          counters.missingFrontierDetail += 1;
          unresolved.push({ frontierId: frontier.frontierId, reason: 'missingFrontierDetail' });
          continue;
        }

        const fallthroughCpuAddr = detail.fallthroughCpuAddr;
        if (!Number.isInteger(fallthroughCpuAddr)) {
          counters.missingFallthroughCpuAddr += 1;
          unresolved.push({ frontierId: frontier.frontierId, reason: 'missingFallthroughCpuAddr' });
          continue;
        }

        const sourceBlockInstanceId = sourceBlockInstanceForFrontier(frontier, executionByInstructionAndSite);
        if (!sourceBlockInstanceId) {
          counters.missingSourceExecution += 1;
          unresolved.push({ frontierId: frontier.frontierId, reason: 'missingSourceExecution' });
          continue;
        }

        const sourceBlockInstance = blockInstanceById.get(sourceBlockInstanceId);
        if (!sourceBlockInstance) throw new Error(`Missing source block instance ${sourceBlockInstanceId}`);
        if (sourceBlockInstance.reachability === 'physicalOnly') {
          counters.physicalOnlySourceBlocks += 1;
          unresolved.push({ frontierId: frontier.frontierId, sourceBlockInstanceId, reason: 'physicalOnlySourceBlock' });
          continue;
        }

        const blockState = blockStatesById.get(sourceBlockInstanceId);
        if (!blockState) {
          counters.missingAiState += 1;
          unresolved.push({ frontierId: frontier.frontierId, sourceBlockInstanceId, reason: 'missingAiState' });
          continue;
        }

        const outState = abstractStateFromSerializable(blockState.outState, { mapperDomain: mapper.mapperDomain });
        if (isBottomState(outState)) {
          counters.bottomAiState += 1;
          unresolved.push({ frontierId: frontier.frontierId, sourceBlockInstanceId, reason: 'bottomAiState' });
          continue;
        }

        const target = exactTargetFromMapperState(mapper, outState.mapperState, fallthroughCpuAddr);
        if (!target) {
          counters.targetNotExact += 1;
          unresolved.push({
            frontierId: frontier.frontierId,
            sourceBlockInstanceId,
            fallthroughCpuAddr: fallthroughCpuAddr & 0xffff,
            reason: 'targetNotExact'
          });
          continue;
        }

        if (knownSeedSiteKeys.has(target.siteKey)) {
          counters.duplicateSites += 1;
          unresolved.push({
            frontierId: frontier.frontierId,
            sourceBlockInstanceId,
            siteKey: target.siteKey,
            reason: 'duplicateSite'
          });
          continue;
        }

        if (knownExecutableSiteKeys.has(target.siteKey)) {
          counters.alreadyExecutableSites += 1;
          unresolved.push({
            frontierId: frontier.frontierId,
            sourceBlockInstanceId,
            siteKey: target.siteKey,
            reason: 'alreadyExecutableSite'
          });
          continue;
        }

        const seed = createExpansionSeed(target, frontier, sourceBlockInstanceId);
        const addResult = typeof context.addSeedSite === 'function'
          ? context.addSeedSite(seed)
          : { added: true };
        if (!addResult.added) {
          counters.duplicateSites += 1;
          unresolved.push({
            frontierId: frontier.frontierId,
            sourceBlockInstanceId,
            siteKey: target.siteKey,
            reason: 'duplicateSite'
          });
          knownSeedSiteKeys.add(seed.siteKey);
          continue;
        }
        if (typeof context.addSeedSite !== 'function') {
          context.seedSites.push(seed);
          context.contexts[seed.contextKey] = seed.mapperContext;
        }
        if (typeof context.noteNewCfgWork === 'function') {
          context.noteNewCfgWork({
            phaseId: ANALYSIS_PHASE_IDS.MAPPED_CFG_EXPANSION,
            reason: 'mappedCfgExpansionSeed',
            count: 1
          });
        }
        knownSeedSiteKeys.add(seed.siteKey);
        addedSites.push(seed);
        counters.addedSites += 1;
      }

      const run = {
        runIndex: context.mappedCfgExpansion && Array.isArray(context.mappedCfgExpansion.runs)
          ? context.mappedCfgExpansion.runs.length
          : 0,
        addedSites,
        unresolved,
        counters
      };
      context.mappedCfgExpansion = appendMappedCfgExpansionRun(context.mappedCfgExpansion, run);
      context.diagnostics.phaseSummaries.push(makePhaseSummary(counters));
      return { status: 'complete' };
    },
    progress() {
      return { phase: ANALYSIS_PHASE_IDS.MAPPED_CFG_EXPANSION };
    }
  };
}
