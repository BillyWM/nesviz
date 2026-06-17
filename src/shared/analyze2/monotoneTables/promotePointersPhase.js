import {
  ANALYSIS_PHASE_IDS,
  ANALYSIS_PROGRESS_DETAIL_KINDS
} from '../analysisConstants.js';
import { requireArray, requireInteger, requireObject, requireString } from '../dataShape.js';
import { MIN_PROMOTED_POINTER_TABLE_ENTRIES } from './pointerPromotionConstants.js';
import { createRtsRoutineProbe } from './rtsRoutineProbe.js';
const PROMOTE_POINTERS_PROBE_STEPS_PER_CRANK = 64;
const PROMOTE_POINTERS_PROGRESS_INTERVAL_MS = 100;

const POINTER_TABLE_INTERPRETATIONS = Object.freeze([
  Object.freeze({
    id: 'direct',
    kind: 'rtsTargetPointerTable',
    targetAdjustment: 0,
    decodeReason: 'priming/rtsPointerTable'
  }),
  Object.freeze({
    id: 'rtsTrick',
    kind: 'rtsTrickPointerTable',
    targetAdjustment: 1,
    decodeReason: 'priming/rtsTrickPointerTable'
  })
]);

function counterDefaults() {
  return {
    monotoneTablesTotal: 0,
    pointerTablesDecoded: 0,
    functionsDecoded: 0,
    promotedPointers: 0,
    readerFunctions: 0,
    tablesConsidered: 0,
    tablesTooShort: 0,
    contextsConsidered: 0,
    contextsPromoted: 0,
    contextsRejected: 0,
    targetsResolved: 0,
    targetsProbed: 0,
    targetsPassed: 0,
    targetsFailed: 0,
    readersProbed: 0,
    readersPassed: 0,
    readersFailed: 0,
    seedsAdded: 0,
    duplicateSeeds: 0,
    readerSeedsAdded: 0,
    duplicateReaderSeeds: 0
  };
}

function cloneTargetSite(site) {
  requireObject(site, 'promotePointers target site');
  return {
    mapperContext: requireObject(site.mapperContext, 'promotePointers target site.mapperContext'),
    contextKey: requireString(site.contextKey, 'promotePointers target site.contextKey'),
    siteKey: requireString(site.siteKey, 'promotePointers target site.siteKey'),
    cpuAddr: requireInteger(site.cpuAddr, 'promotePointers target site.cpuAddr') & 0xffff,
    romOff: requireInteger(site.romOff, 'promotePointers target site.romOff') >>> 0,
    backing: requireObject(site.backing, 'promotePointers target site.backing')
  };
}

function tableContexts(context, table) {
  const mapper = requireObject(context.mapper, 'promotePointers mapper');
  if (typeof mapper.codeSitesForRomOff !== 'function') return [];
  const appearances = mapper.codeSitesForRomOff(requireInteger(table.startRomOff, 'monotone table.startRomOff') >>> 0, {
    purpose: 'monotoneTableAppearance'
  });
  const witnessContextKeys = Array.isArray(table.readerWitnesses) && table.readerWitnesses.length
    ? new Set(table.readerWitnesses.map((witness) => requireString(witness.contextKey, 'split pointer reader witness.contextKey')))
    : null;
  const out = [];
  const seen = new Set();
  for (let i = 0; i < appearances.length; i += 1) {
    const appearance = requireObject(appearances[i], `monotone table appearance ${i}`);
    const contextKey = requireString(appearance.contextKey, `monotone table appearance ${i}.contextKey`);
    if (witnessContextKeys && !witnessContextKeys.has(contextKey)) continue;
    if (seen.has(contextKey)) continue;
    seen.add(contextKey);
    out.push({
      interpretationId: `${table.tableId}:context:${contextKey}`,
      contextKey,
      mapperContext: requireObject(appearance.mapperContext, `monotone table appearance ${i}.mapperContext`),
      tableAppearance: cloneTargetSite(appearance)
    });
  }
  return out;
}

function contextFailure(interpretation, reason, detail = null) {
  return {
    interpretationId: interpretation ? interpretation.interpretationId : null,
    contextKey: interpretation ? interpretation.contextKey : null,
    pointerInterpretation: interpretation ? interpretation.pointerInterpretation : null,
    targetAdjustment: interpretation ? interpretation.targetAdjustment >>> 0 : 0,
    status: 'notPromoted',
    failureReason: reason,
    detail
  };
}

function currentInterpretationMode(index) {
  return POINTER_TABLE_INTERPRETATIONS[index] || null;
}

function isSplitPointerTable(table) {
  return table && table.kind === 'splitPointerTable';
}

function targetProofAccepted(table, proof) {
  const status = requireString(proof.status, 'promotePointers target proof.status');
  if (status === 'rtsRoutine') return true;
  return isSplitPointerTable(table) && status === 'jmpTerminatedRoutine';
}

function targetTerminatorFailureReason(table) {
  return isSplitPointerTable(table) ? 'targetDidNotEndInRtsOrJmp' : 'targetDidNotEndInRts';
}

function readerWitnessPointerInterpretation(witness) {
  const status = String(witness?.readerProof?.status || '');
  if (status === 'rtsIndexedSplitPointerReader') return 'rtsTrick';
  if (status === 'jmpIndexedSplitPointerReader') return 'direct';
  const terminator = String(witness?.readerProof?.terminator || '').toUpperCase();
  if (terminator === 'RTS') return 'rtsTrick';
  if (terminator === 'JMP') return 'direct';
  return null;
}

function readerProofAccepted(table, proof) {
  const status = requireString(proof.status, 'promotePointers reader proof.status');
  if (status === 'rtsRoutine') return true;
  return isSplitPointerTable(table) && status === 'jmpTerminatedRoutine';
}

function readerProofCoversWitnessReads(witness, proof) {
  const visited = new Set(requireArray(proof.visitedRomOffs || [], 'promotePointers reader proof.visitedRomOffs')
    .map((romOff) => requireInteger(romOff, 'promotePointers reader proof visited ROM offset') >>> 0));
  const lowReadRomOff = Number(witness?.lowRead?.instructionRomOff);
  const highReadRomOff = Number(witness?.highRead?.instructionRomOff);
  if (!Number.isInteger(lowReadRomOff) || !Number.isInteger(highReadRomOff)) return false;
  return visited.has(lowReadRomOff >>> 0) && visited.has(highReadRomOff >>> 0);
}

function readerTerminatorFailureReason(table) {
  return isSplitPointerTable(table) ? 'readerDidNotEndInRtsOrJmp' : 'readerDidNotEndInRts';
}

function makePointerInterpretation(tableContext, mode) {
  requireObject(tableContext, 'promotePointers tableContext');
  requireObject(mode, 'promotePointers pointer interpretation mode');
  return {
    ...tableContext,
    interpretationId: `${tableContext.interpretationId}:mode:${mode.id}`,
    pointerInterpretation: mode.id,
    promotionKind: mode.kind,
    targetAdjustment: mode.targetAdjustment >>> 0,
    decodeReason: mode.decodeReason
  };
}

function resolveEntryTarget(context, interpretation, table, entry) {
  const mapper = requireObject(context.mapper, 'promotePointers mapper');
  const value = requireInteger(entry.value, 'monotone table entry.value') & 0xffff;
  const targetCpuAddr = (value + (interpretation.targetAdjustment >>> 0)) & 0xffff;
  const resolved = mapper.resolveControlTarget(interpretation.mapperContext, targetCpuAddr, {
    policy: 'exactOnly',
    purpose: 'promotePointersTarget'
  });
  requireObject(resolved, 'promotePointers resolved target');
  if (!resolved.ok) {
    return {
      ok: false,
      failureReason: 'targetNotExact',
      detail: {
        tableId: table.tableId,
        contextKey: interpretation.contextKey,
        pointerInterpretation: interpretation.pointerInterpretation,
        entryIndex: entry.index >>> 0,
        pointerValue: value,
        targetCpuAddr,
        targetAdjustment: interpretation.targetAdjustment >>> 0,
        reason: typeof resolved.reason === 'string' ? resolved.reason : 'targetNotExact'
      }
    };
  }
  return {
    ok: true,
    entryIndex: entry.index >>> 0,
    entryRomOff: requireInteger(entry.entryRomOff, 'monotone table entry.entryRomOff') >>> 0,
    pointerValue: value,
    targetCpuAddr,
    targetAdjustment: interpretation.targetAdjustment >>> 0,
    pointerInterpretation: interpretation.pointerInterpretation,
    target: cloneTargetSite(resolved.target)
  };
}

function makeSeed(target, table, interpretation, targetProof) {
  return {
    ...cloneTargetSite(target.target),
    seedKind: 'promotedPointer',
    reachability: 'promoted',
    decodeReason: interpretation.decodeReason,
    sourcePhase: ANALYSIS_PHASE_IDS.PROMOTE_POINTERS,
    monotoneTableId: table.tableId,
    tableContextKey: interpretation.contextKey,
    tableInterpretationId: interpretation.interpretationId,
    tableRomOff: requireInteger(table.startRomOff, 'promoted table.startRomOff') >>> 0,
    tableEntryIndex: target.entryIndex >>> 0,
    tableEntryRomOff: target.entryRomOff >>> 0,
    pointerValue: target.pointerValue & 0xffff,
    targetCpuAddr: target.targetCpuAddr & 0xffff,
    targetAdjustment: target.targetAdjustment >>> 0,
    pointerInterpretation: target.pointerInterpretation,
    targetProof
  };
}

function readerWitnessesForInterpretation(table, interpretation) {
  if (!Array.isArray(table.readerWitnesses) || !table.readerWitnesses.length) return [];
  return table.readerWitnesses.filter((witness) => {
    requireObject(witness, 'split pointer reader witness');
    if (requireString(witness.contextKey, 'split pointer reader witness.contextKey') !== interpretation.contextKey) return false;
    const pointerInterpretation = readerWitnessPointerInterpretation(witness);
    return !pointerInterpretation || pointerInterpretation === interpretation.pointerInterpretation;
  });
}

function makeReaderSeed(witness, table, interpretation) {
  requireObject(witness, 'split pointer reader witness');
  const readerSite = cloneTargetSite(requireObject(witness.readerSite, 'split pointer reader witness.readerSite'));
  return {
    ...readerSite,
    seedKind: 'promotedSplitPointerReader',
    reachability: 'promoted',
    decodeReason: 'priming/splitPointerReader',
    sourcePhase: ANALYSIS_PHASE_IDS.PROMOTE_POINTERS,
    splitPointerTableId: table.tableId,
    tableContextKey: interpretation.contextKey,
    tableInterpretationId: interpretation.interpretationId,
    tableRomOff: requireInteger(table.startRomOff, 'promoted split pointer table.startRomOff') >>> 0,
    pointerInterpretation: interpretation.pointerInterpretation,
    targetAdjustment: interpretation.targetAdjustment >>> 0,
    readerProof: witness.readerProof || null,
    lowRead: witness.lowRead || null,
    highRead: witness.highRead || null
  };
}

export function createPromotePointersPhase(context, options = {}) {
  const phaseOptions = options && typeof options === 'object' ? options : {};
  const probeStepsPerCrank = Number.isInteger(phaseOptions.probeStepsPerCrank) && phaseOptions.probeStepsPerCrank > 0
    ? phaseOptions.probeStepsPerCrank
    : PROMOTE_POINTERS_PROBE_STEPS_PER_CRANK;

  const result = {
    promotions: [],
    rejected: [],
    counters: counterDefaults()
  };

  let tables = null;
  let tableIndex = 0;
  let contexts = [];
  let contextIndex = 0;
  let interpretationModeIndex = 0;
  let currentTable = null;
  let currentInterpretation = null;
  let currentTargets = [];
  let currentProofs = [];
  let currentReaderCandidates = [];
  let currentReaders = [];
  let currentReaderProofs = [];
  let entryIndex = 0;
  let probeIndex = 0;
  let readerProbeIndex = 0;
  let currentProbe = null;
  const promotedTableIds = new Set();
  const promotedFunctionKeys = new Set();
  const promotedPointerKeys = new Set();
  const readerFunctionKeys = new Set();
  let complete = false;
  let currentStage = 'setup';
  let lastProgressNowAt = 0;

  function shouldPostProgressNow(force = false) {
    const now = Date.now();
    if (!force && now - lastProgressNowAt < PROMOTE_POINTERS_PROGRESS_INTERVAL_MS) return false;
    lastProgressNowAt = now;
    return true;
  }

  function ensureTables() {
    if (tables) return tables;
    const source = context.monotoneTables || { kind: 'monotoneTables', tables: [], counters: {} };
    const sourceTables = requireArray(source.tables || [], 'context.monotoneTables.tables');
    tables = sourceTables;
    result.counters.monotoneTablesTotal = sourceTables.length >>> 0;
    return tables;
  }

  function setTablePromotion(table, promotion) {
    table.pointerPromotion = promotion;
  }

  function beginTable() {
    const allTables = ensureTables();
    currentTable = allTables[tableIndex] || null;
    currentInterpretation = null;
    currentTargets = [];
    currentProofs = [];
    currentReaderCandidates = [];
    currentReaders = [];
    currentReaderProofs = [];
    entryIndex = 0;
    probeIndex = 0;
    readerProbeIndex = 0;
    currentProbe = null;
    contexts = [];
    contextIndex = 0;
    interpretationModeIndex = 0;

    if (!currentTable) return false;
    result.counters.tablesConsidered += 1;

    const entryCount = requireInteger(currentTable.entryCount, 'monotone table.entryCount') >>> 0;
    if (entryCount < MIN_PROMOTED_POINTER_TABLE_ENTRIES) {
      result.counters.tablesTooShort += 1;
      const rejection = {
        tableId: currentTable.tableId,
        status: 'notPromoted',
        failureReason: 'tooFewEntries',
        entryCount,
        minimumEntries: MIN_PROMOTED_POINTER_TABLE_ENTRIES
      };
      result.rejected.push(rejection);
      setTablePromotion(currentTable, rejection);
      tableIndex += 1;
      currentTable = null;
      return true;
    }

    contexts = tableContexts(context, currentTable);
    if (!contexts.length) {
      const rejection = {
        tableId: currentTable.tableId,
        status: 'notPromoted',
        failureReason: 'noTableMappingContext',
        entryCount,
        failedContexts: []
      };
      result.rejected.push(rejection);
      setTablePromotion(currentTable, rejection);
      tableIndex += 1;
      currentTable = null;
      return true;
    }

    currentTable.pointerPromotion = {
      status: 'testing',
      minimumEntries: MIN_PROMOTED_POINTER_TABLE_ENTRIES,
      promotedContexts: [],
      failedContexts: []
    };
    currentStage = 'context';
    return true;
  }

  function beginContext() {
    const tableContext = contexts[contextIndex] || null;
    const mode = currentInterpretationMode(interpretationModeIndex);
    currentInterpretation = tableContext && mode ? makePointerInterpretation(tableContext, mode) : null;
    currentTargets = [];
    currentProofs = [];
    currentReaderCandidates = [];
    currentReaders = [];
    currentReaderProofs = [];
    entryIndex = 0;
    probeIndex = 0;
    readerProbeIndex = 0;
    currentProbe = null;
    if (!currentInterpretation) return false;
    result.counters.contextsConsidered += 1;
    currentStage = 'resolveTargets';
    return true;
  }

  function rejectCurrentContext(reason, detail = null) {
    const failure = contextFailure(currentInterpretation, reason, detail);
    result.counters.contextsRejected += 1;
    currentTable.pointerPromotion.failedContexts.push(failure);
    contextIndex += 1;
    currentInterpretation = null;
    currentTargets = [];
    currentProofs = [];
    currentReaderCandidates = [];
    currentReaders = [];
    currentReaderProofs = [];
    entryIndex = 0;
    probeIndex = 0;
    readerProbeIndex = 0;
    currentProbe = null;
    currentStage = 'context';
  }

  function promoteCurrentContext() {
    const promotedTargets = [];
    const promotedReaders = [];
    let addedSeeds = 0;
    let duplicateSeeds = 0;
    let readerSeedsAdded = 0;
    let duplicateReaderSeeds = 0;

    for (let i = 0; i < currentTargets.length; i += 1) {
      const target = currentTargets[i];
      const proof = currentProofs[i];
      const seed = makeSeed(target, currentTable, currentInterpretation, proof);
      const addResult = context.addSeedSite(seed);
      if (addResult.added) addedSeeds += 1;
      else duplicateSeeds += 1;
      promotedTargets.push({
        entryIndex: target.entryIndex >>> 0,
        entryRomOff: target.entryRomOff >>> 0,
        pointerValue: target.pointerValue & 0xffff,
        targetCpuAddr: target.targetCpuAddr & 0xffff,
        targetAdjustment: target.targetAdjustment >>> 0,
        pointerInterpretation: target.pointerInterpretation,
        target: cloneTargetSite(target.target),
        seedAdded: addResult.added === true,
        proof
      });
    }

    for (let i = 0; i < currentReaders.length; i += 1) {
      const witness = currentReaders[i];
      const proof = currentReaderProofs[i] || null;
      const seed = makeReaderSeed(witness, currentTable, currentInterpretation);
      const addResult = context.addSeedSite(seed);
      if (addResult.added) {
        addedSeeds += 1;
        readerSeedsAdded += 1;
      } else {
        duplicateSeeds += 1;
        duplicateReaderSeeds += 1;
      }
      promotedReaders.push({
        reader: cloneTargetSite(seed),
        seedAdded: addResult.added === true,
        proof,
        witnessProof: witness.readerProof || null,
        lowRead: witness.lowRead || null,
        highRead: witness.highRead || null
      });
    }

    if (addedSeeds > 0) {
      context.noteNewCfgWork({
        phaseId: ANALYSIS_PHASE_IDS.PROMOTE_POINTERS,
        reason: 'promotedPointerTable',
        count: addedSeeds
      });
    }

    promotedTableIds.add(currentTable.tableId);
    for (const promotedTarget of promotedTargets) {
      promotedFunctionKeys.add(promotedTarget.target.siteKey);
      promotedPointerKeys.add(`${currentTable.tableId}:entry:${promotedTarget.entryIndex >>> 0}:mode:${promotedTarget.pointerInterpretation}`);
    }
    for (const promotedReader of promotedReaders) {
      promotedFunctionKeys.add(promotedReader.reader.siteKey);
      readerFunctionKeys.add(promotedReader.reader.siteKey);
    }
    result.counters.pointerTablesDecoded = promotedTableIds.size;
    result.counters.functionsDecoded = promotedFunctionKeys.size;
    result.counters.promotedPointers = promotedPointerKeys.size;
    result.counters.readerFunctions = readerFunctionKeys.size;
    result.counters.contextsPromoted += 1;
    result.counters.seedsAdded += addedSeeds;
    result.counters.duplicateSeeds += duplicateSeeds;
    result.counters.readerSeedsAdded += readerSeedsAdded;
    result.counters.duplicateReaderSeeds += duplicateReaderSeeds;

    const promotion = {
      tableId: currentTable.tableId,
      status: 'promoted',
      kind: currentInterpretation.promotionKind,
      contextKey: currentInterpretation.contextKey,
      interpretationId: currentInterpretation.interpretationId,
      pointerInterpretation: currentInterpretation.pointerInterpretation,
      targetAdjustment: currentInterpretation.targetAdjustment >>> 0,
      entryCount: currentTable.entryCount >>> 0,
      addedSeeds,
      duplicateSeeds,
      readerSeedsAdded,
      duplicateReaderSeeds,
      promotedTargets,
      promotedReaders
    };
    result.promotions.push(promotion);
    currentTable.pointerPromotion.promotedContexts.push(promotion);

    contextIndex += 1;
    currentInterpretation = null;
    currentTargets = [];
    currentProofs = [];
    currentReaderCandidates = [];
    currentReaders = [];
    currentReaderProofs = [];
    entryIndex = 0;
    probeIndex = 0;
    readerProbeIndex = 0;
    currentProbe = null;
    currentStage = 'context';
  }

  function finalizeTableIfDone() {
    if (!currentTable || contextIndex < contexts.length) return false;
    const promotion = currentTable.pointerPromotion;
    if (promotion.promotedContexts.length > 0) {
      promotion.status = 'promoted';
      promotion.kind = promotion.promotedContexts[0].kind;
      promotion.pointerInterpretation = promotion.promotedContexts[0].pointerInterpretation;
      promotion.targetAdjustment = promotion.promotedContexts[0].targetAdjustment >>> 0;
    } else if (interpretationModeIndex + 1 < POINTER_TABLE_INTERPRETATIONS.length) {
      interpretationModeIndex += 1;
      contextIndex = 0;
      currentStage = 'context';
      return true;
    } else {
      promotion.status = 'notPromoted';
      promotion.failureReasons = Array.from(new Set(promotion.failedContexts.map((item) => item.failureReason)));
      result.rejected.push({
        tableId: currentTable.tableId,
        status: 'notPromoted',
        failureReasons: promotion.failureReasons,
        failedContexts: promotion.failedContexts
      });
    }
    tableIndex += 1;
    currentTable = null;
    contexts = [];
    contextIndex = 0;
    currentStage = 'table';
    return true;
  }

  function resolveNextTarget() {
    const entries = requireArray(currentTable.entries, 'monotone table.entries');
    if (entryIndex >= entries.length) {
      currentStage = 'probeTargets';
      return;
    }
    const entry = requireObject(entries[entryIndex], `monotone table entry ${entryIndex}`);
    const resolved = resolveEntryTarget(context, currentInterpretation, currentTable, entry);
    if (!resolved.ok) {
      rejectCurrentContext(resolved.failureReason, resolved.detail);
      return;
    }
    result.counters.targetsResolved += 1;
    currentTargets.push(resolved);
    entryIndex += 1;
  }

  function probeNextTarget() {
    if (probeIndex >= currentTargets.length) {
      const readerWitnesses = readerWitnessesForInterpretation(currentTable, currentInterpretation);
      if (!readerWitnesses.length) {
        rejectCurrentContext('noMaterializableReaderWitness', {
          tableId: currentTable.tableId,
          contextKey: currentInterpretation.contextKey,
          pointerInterpretation: currentInterpretation.pointerInterpretation
        });
        return;
      }
      currentReaderCandidates = readerWitnesses;
      currentReaders = [];
      currentReaderProofs = [];
      readerProbeIndex = 0;
      currentProbe = null;
      currentStage = 'probeReaders';
      return;
    }

    const target = currentTargets[probeIndex];
    if (!currentProbe) {
      currentProbe = createRtsRoutineProbe({
        prgBytes: context.prgBytes,
        mapper: context.mapper,
        startSite: target.target,
        allowJmpTerminator: isSplitPointerTable(currentTable)
      });
      result.counters.targetsProbed += 1;
    }

    const probeStep = currentProbe.step(probeStepsPerCrank);
    if (probeStep.status !== 'complete') return;

    const proof = requireObject(probeStep.result, 'RTS routine probe result');
    if (!targetProofAccepted(currentTable, proof)) {
      result.counters.targetsFailed += 1;
      rejectCurrentContext(targetTerminatorFailureReason(currentTable), {
        entryIndex: target.entryIndex >>> 0,
        pointerValue: target.pointerValue & 0xffff,
        targetCpuAddr: target.targetCpuAddr & 0xffff,
        targetAdjustment: target.targetAdjustment >>> 0,
        pointerInterpretation: target.pointerInterpretation,
        target: cloneTargetSite(target.target),
        proof
      });
      return;
    }

    result.counters.targetsPassed += 1;
    currentProofs.push(proof);
    probeIndex += 1;
    currentProbe = null;
  }

  function probeNextReader() {
    if (readerProbeIndex >= currentReaderCandidates.length) {
      if (!currentReaders.length) {
        rejectCurrentContext('noMaterializedReaderFunction', {
          tableId: currentTable.tableId,
          contextKey: currentInterpretation.contextKey,
          pointerInterpretation: currentInterpretation.pointerInterpretation,
          readerCandidates: currentReaderCandidates.length >>> 0
        });
        return;
      }
      promoteCurrentContext();
      return;
    }

    const witness = currentReaderCandidates[readerProbeIndex];
    const readerSite = cloneTargetSite(requireObject(witness.readerSite, 'promotePointers reader witness.readerSite'));
    if (!currentProbe) {
      currentProbe = createRtsRoutineProbe({
        prgBytes: context.prgBytes,
        mapper: context.mapper,
        startSite: readerSite,
        allowJmpTerminator: isSplitPointerTable(currentTable)
      });
      result.counters.readersProbed += 1;
    }

    const probeStep = currentProbe.step(probeStepsPerCrank);
    if (probeStep.status !== 'complete') return;

    const proof = requireObject(probeStep.result, 'reader routine probe result');
    if (!readerProofAccepted(currentTable, proof) || !readerProofCoversWitnessReads(witness, proof)) {
      result.counters.readersFailed += 1;
      readerProbeIndex += 1;
      currentProbe = null;
      return;
    }

    result.counters.readersPassed += 1;
    currentReaders.push(witness);
    currentReaderProofs.push(proof);
    readerProbeIndex += 1;
    currentProbe = null;
  }

  function progressDetails() {
    return {
      monotoneTablesTotal: result.counters.monotoneTablesTotal >>> 0,
      pointerTablesDecoded: result.counters.pointerTablesDecoded >>> 0,
      functionsDecoded: result.counters.functionsDecoded >>> 0,
      promotedPointers: result.counters.promotedPointers >>> 0,
      readerFunctions: result.counters.readerFunctions >>> 0,
      tableIndex: tableIndex >>> 0,
      tableCount: tables ? tables.length >>> 0 : result.counters.monotoneTablesTotal >>> 0,
      contextIndex: contextIndex >>> 0,
      pointerInterpretation: currentInterpretationMode(interpretationModeIndex)?.id || null,
      targetAdjustment: currentInterpretationMode(interpretationModeIndex)?.targetAdjustment || 0,
      stage: currentStage
    };
  }

  function finalize() {
    result.counters.pointerTablesDecoded = promotedTableIds.size;
    result.counters.functionsDecoded = promotedFunctionKeys.size;
    result.counters.promotedPointers = promotedPointerKeys.size;
    result.counters.readerFunctions = readerFunctionKeys.size;
    context.pointerPromotions = result;
    context.diagnostics.phaseSummaries.push({
      name: ANALYSIS_PHASE_IDS.PROMOTE_POINTERS,
      status: 'complete',
      counters: { ...result.counters }
    });
    complete = true;
  }

  function runOneUnit() {
    const allTables = ensureTables();
    if (tableIndex >= allTables.length) {
      finalize();
      return;
    }

    if (!currentTable) {
      beginTable();
      return;
    }

    if (finalizeTableIfDone()) return;

    if (!currentInterpretation) {
      beginContext();
      return;
    }

    if (currentStage === 'resolveTargets') {
      resolveNextTarget();
      return;
    }

    if (currentStage === 'probeTargets') {
      probeNextTarget();
      return;
    }

    if (currentStage === 'probeReaders') {
      probeNextReader();
      return;
    }

    currentStage = 'context';
  }

  return {
    name: ANALYSIS_PHASE_IDS.PROMOTE_POINTERS,
    stepOne() {
      requireObject(context.mapper, 'promotePointers mapper');
      if (complete) return { status: 'complete', progress: this.progress() };
      runOneUnit();
      context.pointerPromotions = result;
      if (!complete) {
        return {
          status: 'running',
          phase: ANALYSIS_PHASE_IDS.PROMOTE_POINTERS,
          progressNow: shouldPostProgressNow(false)
        };
      }
      shouldPostProgressNow(true);
      return { status: 'complete', progress: this.progress() };
    },
    progress() {
      const details = progressDetails();
      return {
        phase: ANALYSIS_PHASE_IDS.PROMOTE_POINTERS,
        stage: currentStage,
        tableIndex,
        tableCount: tables ? tables.length : 0,
        contextIndex,
        interpretationModeIndex,
        ...result.counters,
        detailKind: ANALYSIS_PROGRESS_DETAIL_KINDS.PROMOTE_POINTERS,
        details
      };
    }
  };
}
