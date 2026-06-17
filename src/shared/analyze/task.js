import { checkAnalysisCompatibility } from './compatibility.js';
import { createMapperModel } from './mapper/createMapperModel.js';
import { createStrictCfgPhase } from './cfg/discover.js';
import { createExpandCfgPhase } from './expandCfg/phase.js';
import { createMappingSpeculationPhase } from './mappingSpeculation/phase.js';
import { createMappedCfgExpansionPhase } from './mappedCfgExpansion/phase.js';
import { createFunctionExcavationPhase } from './functionExcavation/phase.js';
import { createFunctionSummarizationPhase } from './functionSummarization/phase.js';
import { createVectorCheckingPhase } from './vectorChecking/phase.js';
import { createCfgTopologyPhase } from './cfgTopology/phase.js';
import { createLoopSummarizationPhase } from './loopSummarization/phase.js';
import { createAbstractInterpretationPhase } from './abstractInterpretation/phase.js';
import { createDetectLoopsPhase } from './detectLoops/phase.js';
import { buildCoalescedBlocks } from './coalesce/coalesceView.js';
import { buildDisplayAnalysis } from './display/buildDisplayAnalysis.js';
import { createGenerateSummaryPhase } from './summary/phase.js';
import { createPopulateMemoryMapPhase } from './semanticFacts/populateMemoryMapPhase.js';
import { createDecorateLoopsPhase } from './decorateUi/decorateLoopsPhase.js';
import { createFindMonotoneTablesPhase } from './monotoneTables/findMonotoneTablesPhase.js';
import { createFindSplitPointerTablesPhase } from './monotoneTables/findSplitPointerTablesPhase.js';
import { createPromotePointersPhase } from './monotoneTables/promotePointersPhase.js';
import { generateSummary } from './summary/generateSummary.js';
import {
  ANALYSIS_ENGINE_ID,
  ANALYSIS_GROUP_TERMINATION,
  ANALYSIS_PHASE_GROUPS,
  ANALYSIS_PHASE_IDS
} from './analysisConstants.js';
import { requireArray, requireInteger, requireObject, requireString } from './dataShape.js';

function normalizePrgBytes(prgBytes) {
  if (Buffer.isBuffer(prgBytes)) return prgBytes;
  if (prgBytes instanceof Uint8Array) return Buffer.from(prgBytes.buffer, prgBytes.byteOffset, prgBytes.byteLength);
  if (Array.isArray(prgBytes)) return Buffer.from(prgBytes);
  throw new Error('Analysis task requires PRG bytes');
}

function makePhaseSummary(name, status, counters = null) {
  return {
    name,
    status,
    counters: counters && typeof counters === 'object' ? { ...counters } : null
  };
}

function requireSeedSite(seed, label) {
  requireObject(seed, label);
  requireString(seed.siteKey, `${label}.siteKey`);
  requireString(seed.contextKey, `${label}.contextKey`);
  requireObject(seed.mapperContext, `${label}.mapperContext`);
  return seed;
}

function normalizeAcceptedCodeSpan(span, label) {
  requireObject(span, label);
  const instructionRomOffs = requireArray(span.instructionRomOffs, `${label}.instructionRomOffs`)
    .map((item, index) => requireInteger(item, `${label}.instructionRomOffs[${index}]`) >>> 0);
  if (!instructionRomOffs.length) throw new Error(`${label}.instructionRomOffs must not be empty`);
  const romStart = requireInteger(span.romStart ?? instructionRomOffs[0], `${label}.romStart`) >>> 0;
  const romEnd = requireInteger(span.romEnd, `${label}.romEnd`) >>> 0;
  if (romEnd <= romStart) throw new Error(`${label}.romEnd must be greater than romStart`);
  return {
    ...span,
    acceptedCodeSpanId: typeof span.acceptedCodeSpanId === 'string' && span.acceptedCodeSpanId
      ? span.acceptedCodeSpanId
      : `acceptedCode:${romStart}:${romEnd}`,
    source: typeof span.source === 'string' && span.source ? span.source : 'unknown',
    romStart,
    romEnd,
    instructionRomOffs
  };
}

function emptyVectorDestinationsByFamily() {
  return { nmi: [], reset: [], irq: [] };
}

function normalizeSeedKind(seedKind) {
  const key = String(seedKind || '').toLowerCase();
  if (key === 'nmi') return 'nmi';
  if (key === 'reset') return 'reset';
  if (key === 'irq' || key === 'irqbrk' || key === 'irq/brk') return 'irq';
  return null;
}

function buildVectorDestinationsFromSeeds(seeds) {
  const out = emptyVectorDestinationsByFamily();
  const seen = new Set();

  for (let i = 0; i < seeds.length; i += 1) {
    const seed = requireSeedSite(seeds[i], `vector destination seed ${i}`);
    const family = normalizeSeedKind(seed.seedKind);
    if (!family) continue;
    const romOff = Number(seed.romOff);
    const cpuAddr = Number(seed.cpuAddr);
    if (!Number.isFinite(romOff) || romOff < 0) throw new Error(`vector destination seed ${i} is missing numeric romOff`);
    if (!Number.isFinite(cpuAddr)) throw new Error(`vector destination seed ${i} is missing numeric cpuAddr`);
    const bankIndex = Number.isFinite(seed.bankIndex) ? (Number(seed.bankIndex) >>> 0) : null;
    const key = `${family}:${romOff >>> 0}:${cpuAddr & 0xffff}:${bankIndex === null ? '' : bankIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = {
      family,
      romOff: romOff >>> 0,
      cpuAddr: cpuAddr & 0xffff
    };
    if (bankIndex !== null) entry.bankIndex = bankIndex;
    out[family].push(entry);
  }

  for (const entries of Object.values(out)) {
    entries.sort((a, b) => {
      const bankA = Number.isFinite(a.bankIndex) ? a.bankIndex : -1;
      const bankB = Number.isFinite(b.bankIndex) ? b.bankIndex : -1;
      return bankA - bankB || a.romOff - b.romOff || a.cpuAddr - b.cpuAddr;
    });
  }

  return out;
}

function requirePhaseOptions(value, label) {
  if (value === undefined) return {};
  return { ...requireObject(value, label) };
}

function normalizePlanEntry(entry, label) {
  requireObject(entry, label);
  const hasId = Object.prototype.hasOwnProperty.call(entry, 'id');
  const hasGroup = Object.prototype.hasOwnProperty.call(entry, 'group');
  if (hasId === hasGroup) throw new Error(`${label} must specify exactly one of id or group`);
  if (hasId) {
    return {
      id: requireString(entry.id, `${label}.id`),
      options: requirePhaseOptions(entry.options, `${label}.options`)
    };
  }
  return {
    group: requireString(entry.group, `${label}.group`)
  };
}

function normalizeAnalysisPlan(plan) {
  requireObject(plan, 'analysis plan');
  const rawPhases = requireArray(plan.phases, 'analysis plan.phases');
  if (!rawPhases.length) throw new Error('analysis plan.phases must not be empty');

  return {
    phases: rawPhases.map((entry, index) => normalizePlanEntry(entry, `analysis plan.phases[${index}]`))
  };
}

function createInitializePhase(context) {
  return {
    name: ANALYSIS_PHASE_IDS.INITIALIZE,
    stepOne() {
      const compatibility = checkAnalysisCompatibility({
        mapperMeta: context.mapperMeta,
        mapperKind: context.mapperKind,
        prgBytes: context.prgBytes
      });
      if (!compatibility.ok) {
        context.failed = true;
        context.finalResult = {
          ok: false,
          unsupported: true,
          code: compatibility.code,
          error: compatibility.message
        };
        return { status: 'failed' };
      }

      const mapper = createMapperModel({
        prgBytes: context.prgBytes,
        mapperMeta: context.mapperMeta,
        mapperKind: context.mapperKind
      });
      const initialContext = mapper.initialContext();
      const contextKey = mapper.contextKey(initialContext);
      context.mapper = mapper;
      context.contexts[contextKey] = initialContext;
      context.diagnostics.phaseSummaries.push(makePhaseSummary(ANALYSIS_PHASE_IDS.INITIALIZE, 'complete'));
      return { status: 'complete' };
    },
    progress() {
      return { phase: ANALYSIS_PHASE_IDS.INITIALIZE };
    }
  };
}

function createSeedVectorsPhase(context) {
  return {
    name: ANALYSIS_PHASE_IDS.SEED_VECTORS,
    stepOne() {
      if (!context.mapper) throw new Error('seedVectors phase requires initialized mapper');
      const seeds = context.mapper.vectorSeedSites(context.vectors);
      requireArray(seeds, 'vector seed sites');
      let addedSeeds = 0;
      for (let i = 0; i < seeds.length; i += 1) {
        const seed = requireSeedSite(seeds[i], `vector seed ${i}`);
        const result = context.addSeedSite(seed);
        if (result.added) addedSeeds += 1;
      }
      context.refreshVectorDestinationsByFamily();
      context.diagnostics.phaseSummaries.push(makePhaseSummary(ANALYSIS_PHASE_IDS.SEED_VECTORS, 'complete', {
        seedCount: context.seedSites.length,
        addedSeeds
      }));
      return { status: 'complete' };
    },
    progress() {
      return { phase: ANALYSIS_PHASE_IDS.SEED_VECTORS, seedCount: context.seedSites.length };
    }
  };
}

function createStrictCfgPhaseWrapper(context) {
  let strictCfgPhase = null;
  return {
    name: ANALYSIS_PHASE_IDS.STRICT_CFG,
    stepOne() {
      if (!context.mapper) throw new Error('strictCfg phase requires initialized mapper');
      if (!strictCfgPhase) {
        strictCfgPhase = createStrictCfgPhase({
          mapper: context.mapper,
          prgBytes: context.prgBytes,
          seedSites: context.seedSites,
          acceptedCodeSpans: context.acceptedCodeSpans
        });
      }
      const result = strictCfgPhase.stepOne(context);
      if (result.status === 'complete') {
        context.diagnostics.phaseSummaries.push(makePhaseSummary(ANALYSIS_PHASE_IDS.STRICT_CFG, 'complete', context.strictCfgCounters));
      }
      return result;
    },
    progress() {
      return strictCfgPhase ? strictCfgPhase.progress() : { phase: ANALYSIS_PHASE_IDS.STRICT_CFG };
    }
  };
}

function createCoalescePhase(context, buildRawAnalysis) {
  return {
    name: ANALYSIS_PHASE_IDS.COALESCE,
    stepOne() {
      const rawAnalysis = buildRawAnalysis();
      const coalesced = buildCoalescedBlocks(rawAnalysis);
      requireArray(coalesced.coalescedBlocks, 'coalesce result coalescedBlocks');
      const { analysis: displayAnalysis, rawToDisplayBlockIds } = buildDisplayAnalysis(rawAnalysis, coalesced);
      context.displayArtifacts = {
        coalescedBlocks: coalesced.coalescedBlocks,
        coalescedTimeline: requireArray(coalesced.timeline, 'coalesce result timeline'),
        rawToDisplayBlockIds: requireObject(rawToDisplayBlockIds, 'rawToDisplayBlockIds'),
        displayAnalysis: {
          ...requireObject(displayAnalysis, 'display analysis'),
          vectorDestinationsByFamily: requireObject(context.vectorDestinationsByFamily, 'context.vectorDestinationsByFamily')
        }
      };

      const displaySummary = generateSummary(context);
      context.displayArtifacts = {
        ...context.displayArtifacts,
        displayAnalysis: {
          ...requireObject(context.displayArtifacts.displayAnalysis, 'displayArtifacts.displayAnalysis'),
          mapper: requireObject(displaySummary.mapper, 'coalesce display summary.mapper'),
          stats: requireObject(displaySummary.stats, 'coalesce display summary.stats'),
          summary: displaySummary
        }
      };

      context.coalesceRunCount += 1;
      const coalesceRunIndex = context.coalesceRunCount;
      context.uiUpdates.push({
        kind: 'displaySnapshot',
        stage: coalesceRunIndex === 1 ? ANALYSIS_PHASE_IDS.STRICT_CFG : ANALYSIS_PHASE_IDS.COALESCE,
        complete: false,
        coalesceRunIndex,
        rawAnalysis: buildRawAnalysis(),
        displayAnalysis: requireObject(context.displayArtifacts.displayAnalysis, 'displayArtifacts.displayAnalysis'),
        rawToDisplayBlockIds: requireObject(context.displayArtifacts.rawToDisplayBlockIds, 'displayArtifacts.rawToDisplayBlockIds')
      });

      context.diagnostics.phaseSummaries.push(makePhaseSummary(ANALYSIS_PHASE_IDS.COALESCE, 'complete', {
        coalescedBlockCount: context.displayArtifacts.coalescedBlocks.length
      }));
      return { status: 'complete' };
    },
    progress() {
      return { phase: ANALYSIS_PHASE_IDS.COALESCE };
    }
  };
}

function createFinalizePhase(context, buildRawAnalysis) {
  return {
    name: ANALYSIS_PHASE_IDS.FINALIZE,
    stepOne() {
      const displayArtifacts = requireObject(context.displayArtifacts, 'finalize phase displayArtifacts');
      const rawAnalysis = buildRawAnalysis();
      context.finalResult = {
        ok: true,
        rawAnalysis,
        displayAnalysis: requireObject(displayArtifacts.displayAnalysis, 'displayArtifacts.displayAnalysis'),
        rawToDisplayBlockIds: requireObject(displayArtifacts.rawToDisplayBlockIds, 'displayArtifacts.rawToDisplayBlockIds')
      };
      context.uiUpdates.push({
        kind: 'displaySnapshot',
        stage: ANALYSIS_PHASE_IDS.FINALIZE,
        complete: true,
        coalesceRunIndex: context.coalesceRunCount,
        rawAnalysis,
        displayAnalysis: requireObject(displayArtifacts.displayAnalysis, 'displayArtifacts.displayAnalysis'),
        rawToDisplayBlockIds: requireObject(displayArtifacts.rawToDisplayBlockIds, 'displayArtifacts.rawToDisplayBlockIds')
      });
      context.diagnostics.phaseSummaries.push(makePhaseSummary(ANALYSIS_PHASE_IDS.FINALIZE, 'complete'));
      return { status: 'complete' };
    },
    progress() {
      return { phase: ANALYSIS_PHASE_IDS.FINALIZE };
    }
  };
}


function cloneGroupPhaseSpec(phaseSpec) {
  return {
    id: requireString(phaseSpec.id, 'analysis phase group phase.id'),
    options: requirePhaseOptions(phaseSpec.options, 'analysis phase group phase.options')
  };
}

function createPhaseFromSpec(phaseRegistry, phaseSpec) {
  const factory = phaseRegistry[phaseSpec.id];
  if (!factory) throw new Error(`Unknown analysis phase: ${phaseSpec.id}`);
  const phase = factory(phaseSpec.options);
  requireString(phase.name, `phase ${phaseSpec.id}.name`);
  if (typeof phase.stepOne !== 'function') throw new Error(`Phase ${phase.name} must provide stepOne()`);
  if (typeof phase.progress !== 'function') throw new Error(`Phase ${phase.name} must provide progress()`);
  return phase;
}

function mapperSupportsMappedExpansion(mapper) {
  if (!mapper || typeof mapper !== 'object') return false;
  if (typeof mapper.cpuWritesMayAffectCodeMapping === 'function') {
    return mapper.cpuWritesMayAffectCodeMapping() !== false;
  }
  return true;
}

function createPhaseGroupRunner(context, groupSpec, phaseRegistry) {
  requireObject(groupSpec, 'analysis phase group');
  const groupId = requireString(groupSpec.id, 'analysis phase group.id');
  const termination = requireString(groupSpec.termination, `analysis phase group ${groupId}.termination`);
  const requiresMappedGame = groupSpec.requiresMappedGame === true;
  const phaseSpecs = requireArray(groupSpec.phases, `analysis phase group ${groupId}.phases`).map((phaseSpec) => cloneGroupPhaseSpec(phaseSpec));
  if (!phaseSpecs.length) throw new Error(`Analysis phase group ${groupId} must contain at least one phase`);

  let iteration = 0;
  let phaseIndex = 0;
  let currentPhase = null;
  let iterationStartCfgWorkVersion = 0;
  let iterationStarted = false;
  let complete = false;

  function isApplicable() {
    return !requiresMappedGame || mapperSupportsMappedExpansion(context.mapper);
  }

  function beginIteration() {
    iteration += 1;
    phaseIndex = 0;
    currentPhase = null;
    iterationStarted = true;
    iterationStartCfgWorkVersion = context.cfgWorkVersion;
  }

  function currentPhaseName() {
    if (complete) return 'done';
    if (!isApplicable()) return groupId;
    if (currentPhase) return currentPhase.name;
    if (!iterationStarted) return phaseSpecs[0].id;
    if (phaseIndex < phaseSpecs.length) return phaseSpecs[phaseIndex].id;
    return groupId;
  }

  function finishIteration() {
    const endCfgWorkVersion = context.cfgWorkVersion;
    const newCfgWork = Math.max(0, endCfgWorkVersion - iterationStartCfgWorkVersion);
    context.phaseGroupRuns.push({
      groupId,
      iteration,
      termination,
      startCfgWorkVersion: iterationStartCfgWorkVersion,
      endCfgWorkVersion,
      newCfgWork,
      phaseIds: phaseSpecs.map((phaseSpec) => phaseSpec.id)
    });

    if (termination === ANALYSIS_GROUP_TERMINATION.ONE_SHOT) {
      complete = true;
      context.diagnostics.phaseSummaries.push(makePhaseSummary(groupId, 'complete', {
        iterations: iteration,
        termination,
        newCfgWork
      }));
      return { status: 'complete', phase: groupId };
    }

    if (termination === ANALYSIS_GROUP_TERMINATION.NO_NEW_CFG_WORKLIST) {
      if (newCfgWork === 0) {
        complete = true;
        context.diagnostics.phaseSummaries.push(makePhaseSummary(groupId, 'complete', {
          iterations: iteration,
          termination,
          newCfgWork
        }));
        return { status: 'complete', phase: groupId };
      }
      const completedIteration = iteration;
      beginIteration();
      return {
        status: 'groupIterationComplete',
        groupId,
        groupIteration: completedIteration,
        nextPhase: currentPhaseName()
      };
    }

    throw new Error(`Unknown analysis phase group termination: ${termination}`);
  }

  return {
    name: groupId,
    stepOne() {
      if (complete) return { status: 'complete', phase: groupId };
      if (!isApplicable()) {
        complete = true;
        context.diagnostics.phaseSummaries.push(makePhaseSummary(groupId, 'skipped', {
          reason: 'requiresMappedGame',
          requiresMappedGame: true
        }));
        return {
          status: 'complete',
          phase: groupId,
          progress: {
            phase: groupId,
            skipped: true,
            reason: 'requiresMappedGame',
            requiresMappedGame: true
          }
        };
      }
      if (!iterationStarted) beginIteration();

      if (phaseIndex >= phaseSpecs.length) return finishIteration();

      if (!currentPhase) currentPhase = createPhaseFromSpec(phaseRegistry, phaseSpecs[phaseIndex]);
      const result = currentPhase.stepOne(context);
      if (result.status === 'failed') return { ...result, phase: currentPhase.name };

      if (result.status === 'complete') {
        const completedPhase = currentPhase.name;
        const completedProgress = result.progress && typeof result.progress === 'object'
          ? result.progress
          : currentPhase.progress(context);
        currentPhase = null;
        phaseIndex += 1;
        return {
          status: 'phaseComplete',
          phase: completedPhase,
          nextPhase: currentPhaseName(),
          groupId,
          groupIteration: iteration,
          progress: completedProgress
        };
      }

      if (result.status === 'phaseComplete') {
        return {
          ...result,
          groupId,
          groupIteration: iteration
        };
      }

      return {
        ...result,
        status: 'running',
        phase: result.phase || currentPhase.name,
        groupId,
        groupIteration: iteration
      };
    },
    progress() {
      if (!isApplicable()) {
        return {
          phase: groupId,
          skipped: true,
          reason: 'requiresMappedGame',
          requiresMappedGame: true
        };
      }
      const phaseProgress = currentPhase ? currentPhase.progress(context) : { phase: currentPhaseName() };
      return {
        ...phaseProgress,
        groupId,
        groupIteration: iteration || 1
      };
    },
    currentPhaseName,
    currentPhaseInfo() {
      if (complete) return null;
      if (!isApplicable()) {
        return {
          phaseId: groupId,
          groupId: null,
          groupIteration: null
        };
      }
      if (iterationStarted && phaseIndex >= phaseSpecs.length) return null;
      return {
        phaseId: currentPhase ? currentPhase.name : currentPhaseName(),
        groupId,
        groupIteration: iteration || 1
      };
    }
  };
}

function createPhaseRegistry(context, buildRawAnalysis) {
  return Object.freeze({
    [ANALYSIS_PHASE_IDS.INITIALIZE]: () => createInitializePhase(context),
    [ANALYSIS_PHASE_IDS.VECTOR_CHECKING]: () => createVectorCheckingPhase(context),
    [ANALYSIS_PHASE_IDS.SEED_VECTORS]: () => createSeedVectorsPhase(context),
    [ANALYSIS_PHASE_IDS.FIND_MONOTONE_TABLES]: (options) => createFindMonotoneTablesPhase(context, options),
    [ANALYSIS_PHASE_IDS.FIND_SPLIT_POINTER_TABLES]: (options) => createFindSplitPointerTablesPhase(context, options),
    [ANALYSIS_PHASE_IDS.PROMOTE_POINTERS]: (options) => createPromotePointersPhase(context, options),
    [ANALYSIS_PHASE_IDS.FUNCTION_EXCAVATION]: (options) => createFunctionExcavationPhase(context, options),
    [ANALYSIS_PHASE_IDS.EXPAND_CFG]: () => createExpandCfgPhase(context),
    [ANALYSIS_PHASE_IDS.STRICT_CFG]: () => createStrictCfgPhaseWrapper(context),
    [ANALYSIS_PHASE_IDS.MAPPING_SPECULATION]: (options) => createMappingSpeculationPhase(context, options),
    [ANALYSIS_PHASE_IDS.MAPPED_CFG_EXPANSION]: (options) => createMappedCfgExpansionPhase(context, options),
    [ANALYSIS_PHASE_IDS.FUNCTION_SUMMARIZATION]: () => createFunctionSummarizationPhase(context),
    [ANALYSIS_PHASE_IDS.CFG_TOPOLOGY]: (options) => createCfgTopologyPhase(context, options),
    [ANALYSIS_PHASE_IDS.LOOP_SUMMARIZATION]: (options) => createLoopSummarizationPhase(context, options),
    [ANALYSIS_PHASE_IDS.ABSTRACT_INTERPRETATION]: (options) => createAbstractInterpretationPhase(context, options),
    [ANALYSIS_PHASE_IDS.DETECT_LOOPS]: (options) => createDetectLoopsPhase(context, options),
    [ANALYSIS_PHASE_IDS.POPULATE_MEMORY_MAP]: (options) => createPopulateMemoryMapPhase(context, options),
    [ANALYSIS_PHASE_IDS.DECORATE_LOOPS]: () => createDecorateLoopsPhase(context),
    [ANALYSIS_PHASE_IDS.COALESCE]: () => createCoalescePhase(context, buildRawAnalysis),
    [ANALYSIS_PHASE_IDS.GENERATE_SUMMARY]: () => createGenerateSummaryPhase(context),
    [ANALYSIS_PHASE_IDS.FINALIZE]: () => createFinalizePhase(context, buildRawAnalysis)
  });
}

export function createAnalysisTask(input) {
  requireObject(input, 'analysis task input');
  const prgBytes = normalizePrgBytes(input.prgBytes);
  const vectors = requireObject(input.vectors, 'analysis task vectors');
  const mapperMeta = input.mapperMeta === null ? null : requireObject(input.mapperMeta, 'analysis task mapperMeta');
  const mapperKind = typeof input.mapperKind === 'string' ? input.mapperKind : (mapperMeta ? mapperMeta.mapperFamily : null);
  const analysisPlan = normalizeAnalysisPlan(input.analysisPlan);

  const context = {
    prgBytes,
    vectors,
    mapperMeta,
    mapperKind,
    mapper: null,
    contexts: {},
    seedSites: [],
    vectorDestinationsByFamily: emptyVectorDestinationsByFamily(),
    instructions: [],
    blocks: [],
    blockInstances: [],
    instructionExecutions: [],
    edges: [],
    frontiers: [],
    displayArtifacts: null,
    uiUpdates: [],
    coalesceRunCount: 0,
    speculativeBlocks: null,
    vectorChecking: null,
    functionExcavation: null,
    functionSummarization: null,
    functionSummaryCache: null,
    acceptedCodeSpans: [],
    monotoneTables: null,
    splitPointerTables: null,
    pointerPromotions: null,
    mappedCfgExpansion: null,
    cfgTopology: null,
    loopSummaries: null,
    abstractInterpretation: null,
    loopDetections: null,
    abstractInterpretationCache: null,
    rtsTricks: null,
    syntheticEdges: [],
    expandCfgFrontiers: [],
    expandCfgAttempts: [],
    expandCfg: null,
    memoryDiscoveries: null,
    summary: null,
    failed: false,
    finalResult: null,
    cfgWorkVersion: 0,
    cfgWorkEvents: [],
    phaseGroupRuns: [],
    diagnostics: {
      phaseSummaries: [],
      decodeFailures: []
    }
  };

  context.refreshVectorDestinationsByFamily = () => {
    context.vectorDestinationsByFamily = buildVectorDestinationsFromSeeds(context.seedSites);
    return context.vectorDestinationsByFamily;
  };

  context.addSeedSite = (seed) => {
    const normalized = requireSeedSite(seed, 'analysis seed site');
    const existing = context.seedSites.find((item) => item && item.siteKey === normalized.siteKey);
    if (existing) return { added: false, existing };
    context.seedSites.push(seed);
    context.contexts[normalized.contextKey] = normalized.mapperContext;
    return { added: true, seed };
  };

  context.addAcceptedCodeSpan = (span) => {
    const normalized = normalizeAcceptedCodeSpan(span, 'analysis accepted code span');
    const existing = context.acceptedCodeSpans.find((item) => {
      if (!item) return false;
      if (item.acceptedCodeSpanId === normalized.acceptedCodeSpanId) return true;
      return (item.romStart >>> 0) === normalized.romStart && (item.romEnd >>> 0) === normalized.romEnd;
    });
    if (existing) return { added: false, existing };
    context.acceptedCodeSpans.push(normalized);
    return { added: true, span: normalized };
  };

  context.expandCfgAttemptForId = (frontierId) => {
    requireString(frontierId, 'expandCfg frontierId');
    return context.expandCfgAttempts.find((item) => item && item.frontierId === frontierId) || null;
  };

  context.markExpandCfgAttempt = (frontierId, patch) => {
    requireString(frontierId, 'expandCfg frontierId');
    const update = requireObject(patch, 'expandCfg attempt patch');
    let attempt = context.expandCfgAttemptForId(frontierId);
    if (!attempt) {
      attempt = { frontierId, state: 'pending' };
      context.expandCfgAttempts.push(attempt);
    }
    Object.assign(attempt, update, { frontierId });
    return attempt;
  };

  context.addExpandCfgFrontier = (frontier) => {
    const normalized = requireObject(frontier, 'expandCfg frontier');
    const frontierId = requireString(normalized.frontierId, 'expandCfg frontier.frontierId');
    const existingAttempt = context.expandCfgAttemptForId(frontierId);
    if (existingAttempt && (
      existingAttempt.state === 'pending' ||
      existingAttempt.state === 'seeded' ||
      existingAttempt.state === 'edgeMaterialized' ||
      existingAttempt.state === 'rejected'
    )) {
      return { added: false, existing: existingAttempt };
    }
    if (context.expandCfgFrontiers.some((item) => item && item.frontierId === frontierId)) {
      return { added: false, existing: context.expandCfgAttemptForId(frontierId) };
    }
    context.expandCfgFrontiers.push(normalized);
    const attempt = context.markExpandCfgAttempt(frontierId, {
      state: 'pending',
      frontier: normalized
    });
    return { added: true, frontier: normalized, attempt };
  };

  context.noteNewCfgWork = (event) => {
    const item = requireObject(event, 'new CFG work event');
    const count = Number.isInteger(item.count) && item.count > 0 ? item.count : 1;
    context.cfgWorkVersion += count;
    context.cfgWorkEvents.push({
      phaseId: typeof item.phaseId === 'string' ? item.phaseId : null,
      groupId: typeof item.groupId === 'string' ? item.groupId : null,
      reason: typeof item.reason === 'string' ? item.reason : 'cfgWork',
      count,
      cfgWorkVersion: context.cfgWorkVersion
    });
  };

  context.edgesForGraph = () => {
    const blockById = new Map(context.blocks.map((block) => [block.blockId, block]));
    const blockInstanceById = new Map(context.blockInstances.map((instance) => [instance.blockInstanceId, instance]));
    const blockContainsInstruction = (block, instructionId) => Array.isArray(block?.instructionIds)
      && block.instructionIds.some((id) => (Number(id) >>> 0) === (Number(instructionId) >>> 0));
    const baseEdges = requireArray(context.edges, 'context.edges');
    const syntheticEdges = requireArray(context.syntheticEdges || [], 'context.syntheticEdges')
      .filter((edge) => {
        const fromInstance = blockInstanceById.get(edge.fromBlockInstanceId);
        const toInstance = blockInstanceById.get(edge.toBlockInstanceId);
        if (!fromInstance || !toInstance) return false;
        const fromBlock = blockById.get(fromInstance.blockId);
        const toBlock = blockById.get(toInstance.blockId);
        if (!fromBlock || !toBlock) return false;
        if (!blockContainsInstruction(fromBlock, edge.fromInstructionId)) return false;
        return (Number(toBlock.romStart) >>> 0) === (Number(edge.targetRomOff) >>> 0);
      });
    return [...baseEdges, ...syntheticEdges];
  };

  function buildRawAnalysis() {
    if (!context.mapper) throw new Error('buildRawAnalysis requires initialized mapper');
    const speculativeBlocks = context.speculativeBlocks;
    const raw = {
      engine: ANALYSIS_ENGINE_ID,
      mapper: {
        id: context.mapper.id,
        kind: context.mapper.family,
        family: context.mapper.family,
        meta: context.mapper.meta,
        prgSize: context.mapper.prgSize
      },
      contexts: context.contexts,
      prgBytes: context.prgBytes,
      instructions: requireArray(context.instructions, 'context.instructions'),
      blocks: requireArray(context.blocks, 'context.blocks'),
      blockInstances: requireArray(context.blockInstances, 'context.blockInstances'),
      instructionExecutions: requireArray(context.instructionExecutions, 'context.instructionExecutions'),
      acceptedCodeSpans: requireArray(context.acceptedCodeSpans, 'context.acceptedCodeSpans'),
      edges: context.edgesForGraph(),
      frontiers: requireArray(context.frontiers, 'context.frontiers'),
      phaseGroupRuns: requireArray(context.phaseGroupRuns, 'context.phaseGroupRuns'),
      cfgWorkEvents: requireArray(context.cfgWorkEvents, 'context.cfgWorkEvents'),
      diagnostics: context.diagnostics
    };
    if (speculativeBlocks !== null) raw.speculativeBlocks = speculativeBlocks;
    if (context.vectorChecking !== null) raw.vectorChecking = requireObject(context.vectorChecking, 'context.vectorChecking');
    if (context.functionExcavation !== null) raw.functionExcavation = requireObject(context.functionExcavation, 'context.functionExcavation');
    if (context.functionSummarization !== null) raw.functionSummarization = requireObject(context.functionSummarization, 'context.functionSummarization');
    if (context.monotoneTables !== null) raw.monotoneTables = requireObject(context.monotoneTables, 'context.monotoneTables');
    if (context.pointerPromotions !== null) raw.pointerPromotions = requireObject(context.pointerPromotions, 'context.pointerPromotions');
    if (context.mappedCfgExpansion !== null) raw.mappedCfgExpansion = requireObject(context.mappedCfgExpansion, 'context.mappedCfgExpansion');
    if (context.expandCfg !== null) raw.expandCfg = requireObject(context.expandCfg, 'context.expandCfg');
    raw.expandCfgFrontiers = requireArray(context.expandCfgFrontiers, 'context.expandCfgFrontiers');
    raw.expandCfgAttempts = requireArray(context.expandCfgAttempts, 'context.expandCfgAttempts');
    if (context.abstractInterpretation !== null) raw.abstractInterpretation = requireObject(context.abstractInterpretation, 'context.abstractInterpretation');
    if (context.loopDetections !== null) raw.loopDetections = requireObject(context.loopDetections, 'context.loopDetections');
    if (context.rtsTricks !== null) raw.rtsTricks = requireObject(context.rtsTricks, 'context.rtsTricks');
    if (context.memoryDiscoveries !== null) raw.memoryDiscoveries = requireObject(context.memoryDiscoveries, 'context.memoryDiscoveries');
    if (context.summary !== null) raw.summary = requireObject(context.summary, 'context.summary');
    return raw;
  }

  const phaseRegistry = createPhaseRegistry(context, buildRawAnalysis);
  const phases = analysisPlan.phases.map((entry) => {
    if (entry.id) return createPhaseFromSpec(phaseRegistry, entry);
    const groupSpec = ANALYSIS_PHASE_GROUPS[entry.group];
    if (!groupSpec) throw new Error(`Unknown analysis phase group: ${entry.group}`);
    return createPhaseGroupRunner(context, groupSpec, phaseRegistry);
  });

  let phaseIndex = 0;
  let done = false;

  function currentPhaseName() {
    const phase = phases[phaseIndex];
    if (!phase) return 'done';
    if (typeof phase.currentPhaseName === 'function') return phase.currentPhaseName();
    return phase.name;
  }

  function stepOne() {
    if (done || context.failed) {
      return { status: done ? 'done' : 'failed', phase: currentPhaseName(), result: context.finalResult };
    }

    const phase = phases[phaseIndex];
    if (!phase) {
      done = true;
      return { status: 'done', phase: 'done', result: context.finalResult };
    }

    const result = phase.stepOne(context);
    if (result.status === 'failed') {
      context.failed = true;
      return { status: 'failed', phase: result.phase || currentPhaseName(), result: context.finalResult };
    }

    if (result.status === 'phaseComplete') {
      return {
        status: 'phaseComplete',
        phase: result.phase || currentPhaseName(),
        nextPhase: result.nextPhase || currentPhaseName(),
        groupId: typeof result.groupId === 'string' ? result.groupId : null,
        groupIteration: Number.isInteger(result.groupIteration) ? result.groupIteration : null,
        progress: result.progress && typeof result.progress === 'object' ? result.progress : null,
        result: null
      };
    }

    if (result.status === 'groupIterationComplete') {
      return {
        status: 'groupIterationComplete',
        groupId: typeof result.groupId === 'string' ? result.groupId : null,
        groupIteration: Number.isInteger(result.groupIteration) ? result.groupIteration : null,
        nextPhase: result.nextPhase || currentPhaseName(),
        result: null
      };
    }

    if (result.status === 'complete') {
      const completedPhase = result.phase || phase.name;
      const completedProgress = result.progress && typeof result.progress === 'object'
        ? result.progress
        : (typeof phase.progress === 'function' ? phase.progress(context) : null);
      phaseIndex += 1;
      if (phaseIndex >= phases.length) done = true;
      return {
        status: done ? 'done' : 'phaseComplete',
        phase: completedPhase,
        nextPhase: currentPhaseName(),
        groupId: null,
        groupIteration: null,
        progress: completedProgress,
        result: done ? context.finalResult : null
      };
    }

    return {
      status: 'running',
      phase: result.phase || currentPhaseName(),
      progress: phase.progress(context),
      progressNow: result.progressNow === true
    };
  }

  function getProgress() {
    const phase = phases[phaseIndex];
    if (!phase) return { phase: 'done' };
    return phase.progress(context);
  }

  function getCurrentPhaseInfo() {
    const phase = phases[phaseIndex];
    if (!phase) return null;
    if (typeof phase.currentPhaseInfo === 'function') return phase.currentPhaseInfo();
    return {
      phaseId: phase.name,
      groupId: null,
      groupIteration: null
    };
  }

  return {
    stepOne,
    getProgress,
    getCurrentPhaseInfo,
    consumeUiUpdates: () => {
      const updates = context.uiUpdates.slice();
      context.uiUpdates.length = 0;
      return updates;
    },
    isDone: () => done,
    isFailed: () => context.failed,
    getResult: () => context.finalResult
  };
}
