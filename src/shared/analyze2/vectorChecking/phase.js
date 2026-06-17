import { FLOW_TYPES } from '../cfg/constants.js';
import { decodeInstructionAtSite } from '../cfg/decode.js';
import { ANALYSIS_PHASE_IDS } from '../analysisConstants.js';
import { requireArray, requireInteger, requireObject, requireString } from '../dataShape.js';

const VECTOR_FAMILIES = Object.freeze(['nmi', 'irq']);
const MAX_VECTOR_HANDLER_BYTES = 4096;

function isHardTerminator(instruction) {
  requireObject(instruction, 'vector checking instruction');
  const flow = requireObject(instruction.flow, 'vector checking instruction.flow');
  const type = requireString(flow.type, 'vector checking instruction.flow.type');
  return type === FLOW_TYPES.JUMP || type === FLOW_TYPES.JMP_INDIRECT || type === FLOW_TYPES.STOP;
}

function nextFallthroughCpuAddr(instruction) {
  requireObject(instruction, 'vector checking fallthrough instruction');
  const flow = requireObject(instruction.flow, 'vector checking fallthrough instruction.flow');
  const type = requireString(flow.type, 'vector checking instruction.flow.type');
  if (type === FLOW_TYPES.NEXT) return requireInteger(flow.next, 'vector checking flow.next') & 0xffff;
  if (type === FLOW_TYPES.BRANCH) return requireInteger(flow.fallthrough, 'vector checking flow.fallthrough') & 0xffff;
  if (type === FLOW_TYPES.CALL) return requireInteger(flow.fallthrough, 'vector checking flow.fallthrough') & 0xffff;
  return null;
}

function byteSequenceKey(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i] & 0xff);
  }
  return out;
}

function decodeVectorHandlerBytes({ prgBytes, mapper, startSite, maxBytes = MAX_VECTOR_HANDLER_BYTES }) {
  requireObject(mapper, 'vector checking mapper');
  requireObject(startSite, 'vector checking startSite');
  const bytes = [];
  const entries = [];
  const seenRomOffs = new Set();
  let cpuAddr = requireInteger(startSite.cpuAddr, 'vector checking startSite.cpuAddr') & 0xffff;

  while (bytes.length < maxBytes) {
    const decoded = decodeInstructionAtSite({
      prgBytes,
      mapper,
      mapperContext: startSite.mapperContext,
      cpuAddr
    });
    requireObject(decoded, 'vector checking decoded result');
    if (!decoded.ok) {
      return {
        ok: false,
        reason: 'decodeFailed',
        detail: {
          reason: typeof decoded.reason === 'string' ? decoded.reason : 'decodeFailed',
          cpuAddr,
          romOff: decoded.romOff ?? null,
          opcode: typeof decoded.opcode === 'number' ? decoded.opcode & 0xff : null
        },
        bytes
      };
    }

    const instruction = requireObject(decoded.instruction, 'vector checking decoded instruction');
    const site = requireObject(decoded.site, 'vector checking decoded site');
    const romOff = requireInteger(instruction.romOff, 'vector checking decoded instruction.romOff') >>> 0;
    const size = requireInteger(instruction.size, 'vector checking decoded instruction.size') >>> 0;
    if (seenRomOffs.has(romOff)) {
      return { ok: false, reason: 'repeatedRomOff', detail: { romOff }, bytes };
    }
    seenRomOffs.add(romOff);

    if (romOff + size > prgBytes.length) {
      return { ok: false, reason: 'instructionBytesOutOfRange', detail: { romOff, size }, bytes };
    }
    if (bytes.length + size > maxBytes) {
      return { ok: false, reason: 'maxHandlerBytesExceeded', detail: { maxBytes }, bytes };
    }

    for (let i = 0; i < size; i += 1) bytes.push(prgBytes[romOff + i] & 0xff);
    entries.push({ instruction, site });

    if (isHardTerminator(instruction)) {
      return {
        ok: true,
        bytes,
        byteKey: byteSequenceKey(bytes),
        byteLength: bytes.length,
        instructionCount: entries.length,
        entries,
        terminator: instruction
      };
    }

    const nextCpuAddr = nextFallthroughCpuAddr(instruction);
    if (nextCpuAddr === null) return { ok: false, reason: 'noFallthroughBeforeTerminator', bytes, entries };
    cpuAddr = nextCpuAddr;
  }

  return { ok: false, reason: 'maxHandlerBytesExceeded', detail: { maxBytes }, bytes, entries };
}

function normalizeFamily(family) {
  const key = String(family || '').toLowerCase();
  if (key === 'nmi') return 'nmi';
  if (key === 'irq' || key === 'irqbrk' || key === 'irq/brk') return 'irq';
  return key;
}

function targetSummary(target) {
  return {
    siteKey: target.siteKey,
    contextKey: target.contextKey,
    cpuAddr: target.cpuAddr & 0xffff,
    romOff: target.romOff >>> 0,
    bankIndex: Number.isFinite(target.bankIndex) ? (target.bankIndex >>> 0) : null
  };
}

function checkIdenticalDecodedHandlers(context, family) {
  const mapper = requireObject(context.mapper, 'vector checking context.mapper');
  if (typeof mapper.vectorCheckingContextsForFamily !== 'function') {
    return {
      status: 'notApplicable',
      family,
      rejectedReason: 'mapperDoesNotExposeVectorContexts',
      copyCount: 0,
      decodedHandlers: 0,
      promotedSeeds: 0
    };
  }

  const vectorContextSet = requireObject(mapper.vectorCheckingContextsForFamily(family), `vector checking ${family} contexts`);
  const vectorContexts = requireArray(vectorContextSet.contexts || [], `vector checking ${family} contexts.contexts`);
  if (vectorContextSet.mode !== 'bankedVectorContexts' || vectorContexts.length <= 1) {
    return {
      status: 'notApplicable',
      family,
      heuristic: 'identicalDecodedHandlerAcrossBankContexts',
      rejectedReason: typeof vectorContextSet.reason === 'string' ? vectorContextSet.reason : 'notBanked',
      copyCount: vectorContexts.length,
      decodedHandlers: 0,
      promotedSeeds: 0
    };
  }

  const decodedHandlers = [];
  const failures = [];
  for (let i = 0; i < vectorContexts.length; i += 1) {
    const vectorContext = requireObject(vectorContexts[i], `vector checking ${family} context ${i}`);
    const targetCpuAddr = requireInteger(vectorContext.targetCpuAddr, `vector checking ${family} context ${i}.targetCpuAddr`) & 0xffff;
    const resolved = mapper.resolveControlTarget(vectorContext.mapperContext, targetCpuAddr, {
      policy: 'exactOnly',
      purpose: 'vectorCheckingTarget'
    });
    requireObject(resolved, `vector checking ${family} resolved target ${i}`);
    if (!resolved.ok) {
      failures.push({
        index: i,
        reason: 'targetNotExact',
        vectorRomOff: Number.isInteger(vectorContext.vectorRomOff) ? vectorContext.vectorRomOff >>> 0 : null,
        targetCpuAddr,
        backing: resolved.backing || null
      });
      continue;
    }

    const target = requireObject(resolved.target, `vector checking ${family} target ${i}`);
    const decoded = decodeVectorHandlerBytes({
      prgBytes: context.prgBytes,
      mapper,
      startSite: target
    });
    if (!decoded.ok) {
      failures.push({
        index: i,
        reason: decoded.reason || 'decodeFailed',
        vectorRomOff: Number.isInteger(vectorContext.vectorRomOff) ? vectorContext.vectorRomOff >>> 0 : null,
        targetCpuAddr,
        targetRomOff: Number.isInteger(target.romOff) ? target.romOff >>> 0 : null,
        detail: decoded.detail || null
      });
      continue;
    }

    decodedHandlers.push({
      index: i,
      family,
      vectorRomOff: requireInteger(vectorContext.vectorRomOff, `vector checking ${family} context ${i}.vectorRomOff`) >>> 0,
      vectorCpuAddr: requireInteger(vectorContext.vectorCpuAddr, `vector checking ${family} context ${i}.vectorCpuAddr`) & 0xffff,
      targetCpuAddr,
      bankIndex: Number.isInteger(vectorContext.bankIndex) ? vectorContext.bankIndex >>> 0 : null,
      contextRole: typeof vectorContext.contextRole === 'string' ? vectorContext.contextRole : null,
      target,
      byteKey: decoded.byteKey,
      byteLength: decoded.byteLength,
      instructionCount: decoded.instructionCount
    });
  }

  if (failures.length > 0) {
    return {
      status: 'notPromoted',
      family,
      heuristic: 'identicalDecodedHandlerAcrossBankContexts',
      rejectedReason: 'decodeFailure',
      copyCount: vectorContexts.length,
      decodedHandlers: decodedHandlers.length,
      promotedSeeds: 0,
      failures
    };
  }

  if (!decodedHandlers.length) {
    return {
      status: 'notPromoted',
      family,
      heuristic: 'identicalDecodedHandlerAcrossBankContexts',
      rejectedReason: 'noDecodedHandlers',
      copyCount: vectorContexts.length,
      decodedHandlers: 0,
      promotedSeeds: 0
    };
  }

  const firstKey = decodedHandlers[0].byteKey;
  const allIdentical = decodedHandlers.every((handler) => handler.byteKey === firstKey);
  if (!allIdentical) {
    return {
      status: 'notPromoted',
      family,
      heuristic: 'identicalDecodedHandlerAcrossBankContexts',
      rejectedReason: 'handlersDiffer',
      copyCount: vectorContexts.length,
      decodedHandlers: decodedHandlers.length,
      uniqueByteSequences: new Set(decodedHandlers.map((handler) => handler.byteKey)).size,
      promotedSeeds: 0,
      handlers: decodedHandlers.map((handler) => ({
        vectorRomOff: handler.vectorRomOff,
        targetCpuAddr: handler.targetCpuAddr,
        targetRomOff: handler.target.romOff >>> 0,
        bankIndex: handler.bankIndex,
        contextRole: handler.contextRole,
        byteLength: handler.byteLength,
        instructionCount: handler.instructionCount
      }))
    };
  }

  let promotedSeeds = 0;
  const promotedTargets = [];
  for (const handler of decodedHandlers) {
    const addResult = context.addSeedSite({
      ...handler.target,
      seedKind: family,
      source: ANALYSIS_PHASE_IDS.VECTOR_CHECKING,
      vectorChecking: {
        heuristic: 'identicalDecodedHandlerAcrossBankContexts',
        family,
        vectorRomOff: handler.vectorRomOff,
        vectorCpuAddr: handler.vectorCpuAddr,
        targetCpuAddr: handler.targetCpuAddr,
        bankIndex: handler.bankIndex,
        contextRole: handler.contextRole,
        byteLength: handler.byteLength,
        instructionCount: handler.instructionCount
      }
    });
    if (addResult.added) promotedSeeds += 1;
    promotedTargets.push(targetSummary({ ...handler.target, bankIndex: handler.bankIndex }));
  }

  if (promotedSeeds > 0) {
    context.noteNewCfgWork({
      phaseId: ANALYSIS_PHASE_IDS.VECTOR_CHECKING,
      reason: 'vectorHandler',
      count: promotedSeeds
    });
  }

  return {
    status: 'promoted',
    family,
    heuristic: 'identicalDecodedHandlerAcrossBankContexts',
    copyCount: vectorContexts.length,
    decodedHandlers: decodedHandlers.length,
    byteLength: decodedHandlers[0].byteLength,
    instructionCount: decodedHandlers[0].instructionCount,
    promotedSeeds,
    promotedTargets
  };
}

function summarizeCounters(familyResults) {
  const counters = {
    checkedFamilies: familyResults.length,
    applicableFamilies: 0,
    promotedFamilies: 0,
    promotedSeeds: 0,
    vectorContexts: 0,
    decodedHandlers: 0,
    decodeFailures: 0,
    nonIdenticalFamilies: 0,
    notApplicableFamilies: 0
  };

  for (const result of familyResults) {
    counters.vectorContexts += Number.isInteger(result.copyCount) ? result.copyCount : 0;
    counters.decodedHandlers += Number.isInteger(result.decodedHandlers) ? result.decodedHandlers : 0;
    counters.promotedSeeds += Number.isInteger(result.promotedSeeds) ? result.promotedSeeds : 0;
    if (result.status === 'notApplicable') counters.notApplicableFamilies += 1;
    else counters.applicableFamilies += 1;
    if (result.status === 'promoted') counters.promotedFamilies += 1;
    if (result.rejectedReason === 'decodeFailure') counters.decodeFailures += Array.isArray(result.failures) ? result.failures.length : 1;
    if (result.rejectedReason === 'handlersDiffer') counters.nonIdenticalFamilies += 1;
  }

  return counters;
}

export function createVectorCheckingPhase(context) {
  let complete = false;
  let counters = null;

  return {
    name: ANALYSIS_PHASE_IDS.VECTOR_CHECKING,
    stepOne() {
      if (complete) return { status: 'complete', progress: this.progress() };
      if (!context.mapper) throw new Error('vectorChecking phase requires initialized mapper');

      const familyResults = VECTOR_FAMILIES.map((family) => checkIdenticalDecodedHandlers(context, family));
      const families = {};
      for (const result of familyResults) families[result.family] = result;
      counters = summarizeCounters(familyResults);
      context.vectorChecking = {
        heuristic: 'identicalDecodedHandlerAcrossBankContexts',
        families,
        counters
      };
      if (typeof context.refreshVectorDestinationsByFamily === 'function') {
        context.refreshVectorDestinationsByFamily();
      }
      context.diagnostics.phaseSummaries.push({
        name: ANALYSIS_PHASE_IDS.VECTOR_CHECKING,
        status: 'complete',
        counters: { ...counters }
      });
      complete = true;
      return { status: 'complete', progress: this.progress() };
    },
    progress() {
      return {
        phase: ANALYSIS_PHASE_IDS.VECTOR_CHECKING,
        ...(counters ? { ...counters } : {})
      };
    }
  };
}
