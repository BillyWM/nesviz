import { FLOW_TYPES } from '../cfg/constants.js';
import { decodeInstructionAtSite } from '../cfg/decode.js';
import { requireInteger, requireObject, requireString } from '../dataShape.js';

function enqueueUnique(queue, queued, site) {
  requireObject(site, 'RTS probe site');
  const key = requireString(site.siteKey, 'RTS probe site.siteKey');
  if (queued.has(key)) return;
  queued.add(key);
  queue.push(site);
}

function fail(status, reason, detail = null) {
  return {
    status,
    failureReason: reason,
    failureDetail: detail
  };
}

function targetSiteForCpuAddr(mapper, mapperContext, cpuAddr, purpose) {
  const resolved = mapper.resolveControlTarget(mapperContext, cpuAddr & 0xffff, {
    policy: 'exactOnly',
    purpose
  });
  requireObject(resolved, `RTS probe ${purpose} resolution`);
  if (!resolved.ok) return null;
  return requireObject(resolved.target, `RTS probe ${purpose} target`);
}

export function createRtsRoutineProbe({ prgBytes, mapper, startSite, allowJmpTerminator = false }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('createRtsRoutineProbe requires PRG bytes');
  requireObject(mapper, 'RTS probe mapper');
  const requiredStartSite = requireObject(startSite, 'RTS probe startSite');
  const allowHardJmpTerminator = allowJmpTerminator === true;

  const queue = [];
  const queued = new Set();
  const visited = new Set();
  const visitedRomOffs = new Set();
  const terminators = [];
  let instructionCount = 0;
  let done = false;
  let result = null;

  enqueueUnique(queue, queued, requiredStartSite);

  function finish(status, extra = {}) {
    done = true;
    result = {
      status,
      startSiteKey: requiredStartSite.siteKey,
      contextKey: requiredStartSite.contextKey,
      cpuAddr: requiredStartSite.cpuAddr & 0xffff,
      romOff: requiredStartSite.romOff >>> 0,
      instructionCount,
      visitedRomOffs: Array.from(visitedRomOffs).sort((a, b) => a - b),
      terminators: terminators.slice(),
      ...extra
    };
    return result;
  }

  function markFailure(status, reason, detail = null) {
    return finish(status, fail(status, reason, detail));
  }

  function enqueueControlTarget(site, targetCpuAddr, purpose) {
    const target = targetSiteForCpuAddr(mapper, site.mapperContext, targetCpuAddr & 0xffff, purpose);
    if (!target) {
      markFailure('indeterminate', 'controlTargetNotExact', {
        sourceSiteKey: site.siteKey,
        targetCpuAddr: targetCpuAddr & 0xffff,
        purpose
      });
      return false;
    }
    if (visited.has(target.siteKey)) {
      markFailure('indeterminate', 'revisitedSiteBeforeTerminal', { siteKey: target.siteKey });
      return false;
    }
    enqueueUnique(queue, queued, target);
    return true;
  }

  function stepOneInstruction() {
    if (done) return result;
    if (!queue.length) {
      if (!terminators.length) return markFailure('invalid', 'noRtsTerminator');
      const hasJmpTerminator = terminators.some((terminator) => terminator.reason === 'jmp' || terminator.reason === 'jmpIndirect');
      return finish(hasJmpTerminator ? 'jmpTerminatedRoutine' : 'rtsRoutine');
    }

    const site = queue.shift();
    const siteKey = requireString(site.siteKey, 'RTS probe queued site.siteKey');
    if (visited.has(siteKey)) {
      return markFailure('indeterminate', 'revisitedSiteBeforeTerminal', { siteKey });
    }
    visited.add(siteKey);

    const decoded = decodeInstructionAtSite({
      prgBytes,
      mapper,
      mapperContext: requireObject(site.mapperContext, 'RTS probe site.mapperContext'),
      cpuAddr: requireInteger(site.cpuAddr, 'RTS probe site.cpuAddr') & 0xffff
    });
    requireObject(decoded, 'RTS probe decoded result');
    if (!decoded.ok) {
      return markFailure('invalid', 'decodeFailed', {
        siteKey,
        cpuAddr: site.cpuAddr & 0xffff,
        reason: typeof decoded.reason === 'string' ? decoded.reason : 'decodeFailed',
        romOff: decoded.romOff ?? null,
        opcode: decoded.opcode ?? null
      });
    }

    const instruction = requireObject(decoded.instruction, 'RTS probe decoded instruction');
    const decodedSite = requireObject(decoded.site, 'RTS probe decoded site');
    const romOff = requireInteger(instruction.romOff, 'RTS probe instruction.romOff') >>> 0;
    visitedRomOffs.add(romOff);
    instructionCount += 1;

    const flow = requireObject(instruction.flow, 'RTS probe instruction.flow');
    const type = requireString(flow.type, 'RTS probe flow.type');

    if (type === FLOW_TYPES.STOP) {
      const reason = typeof flow.reason === 'string' ? flow.reason : 'stop';
      terminators.push({ reason, romOff, cpuAddr: decodedSite.cpuAddr & 0xffff });
      if (reason === 'rts') return { status: 'running' };
      return markFailure('notRtsRoutine', 'nonRtsTerminator', { reason, romOff, cpuAddr: decodedSite.cpuAddr & 0xffff });
    }

    if (type === FLOW_TYPES.JMP_INDIRECT) {
      if (allowHardJmpTerminator) {
        terminators.push({ reason: 'jmpIndirect', romOff, cpuAddr: decodedSite.cpuAddr & 0xffff });
        return { status: 'running' };
      }
      return markFailure('indeterminate', 'indirectJump', { romOff, cpuAddr: decodedSite.cpuAddr & 0xffff });
    }

    if (type === FLOW_TYPES.JUMP) {
      if (allowHardJmpTerminator) {
        terminators.push({
          reason: 'jmp',
          romOff,
          cpuAddr: decodedSite.cpuAddr & 0xffff,
          targetCpuAddr: requireInteger(flow.target, 'RTS probe jump target') & 0xffff
        });
        return { status: 'running' };
      }
      if (!enqueueControlTarget(decodedSite, requireInteger(flow.target, 'RTS probe jump target'), 'rtsProbeJumpTarget')) return result;
      return { status: 'running' };
    }

    if (type === FLOW_TYPES.BRANCH) {
      if (!enqueueControlTarget(decodedSite, requireInteger(flow.target, 'RTS probe branch target'), 'rtsProbeBranchTarget')) return result;
      if (!enqueueControlTarget(decodedSite, requireInteger(flow.fallthrough, 'RTS probe branch fallthrough'), 'rtsProbeBranchFallthrough')) return result;
      return { status: 'running' };
    }

    if (type === FLOW_TYPES.CALL) {
      if (!enqueueControlTarget(decodedSite, requireInteger(flow.fallthrough, 'RTS probe call fallthrough'), 'rtsProbeCallFallthrough')) return result;
      return { status: 'running' };
    }

    if (type === FLOW_TYPES.NEXT) {
      if (!enqueueControlTarget(decodedSite, requireInteger(flow.next, 'RTS probe next'), 'rtsProbeNext')) return result;
      return { status: 'running' };
    }

    return markFailure('indeterminate', 'unsupportedFlowType', { type, romOff, cpuAddr: decodedSite.cpuAddr & 0xffff });
  }

  return {
    step(instructionSteps) {
      const limit = Number.isInteger(instructionSteps) && instructionSteps > 0 ? instructionSteps : 32;
      let steps = 0;
      while (!done && steps < limit) {
        stepOneInstruction();
        steps += 1;
      }
      return done ? { status: 'complete', result } : { status: 'running' };
    },
    isDone() {
      return done;
    },
    result() {
      return result;
    }
  };
}
