import { FLOW_TYPES } from '../cfg/constants.js';
import { decodeInstructionAtSite } from '../cfg/decode.js';
import { requireInstruction, requireObject } from '../dataShape.js';

export function isHardTerminator(instruction) {
  requireInstruction(instruction, 'function excavation terminator instruction');
  return instruction.flow.type === FLOW_TYPES.JUMP ||
    instruction.flow.type === FLOW_TYPES.JMP_INDIRECT ||
    instruction.flow.type === FLOW_TYPES.STOP;
}

export function nextFallthroughCpuAddr(instruction) {
  requireInstruction(instruction, 'function excavation fallthrough instruction');
  const flow = requireObject(instruction.flow, 'function excavation instruction.flow');
  if (flow.type === FLOW_TYPES.NEXT) return flow.next & 0xffff;
  if (flow.type === FLOW_TYPES.BRANCH) return flow.fallthrough & 0xffff;
  if (flow.type === FLOW_TYPES.CALL) return flow.fallthrough & 0xffff;
  return null;
}

export function decodeForwardToHardTerminator({ prgBytes, mapper, startSite, mustReachRomOff = null }) {
  requireObject(mapper, 'function excavation decode mapper');
  requireObject(startSite, 'function excavation decode startSite');
  const entries = [];
  const seenRomOffs = new Set();
  let cpuAddr = startSite.cpuAddr & 0xffff;
  let reachedRequiredRomOff = mustReachRomOff === null;

  while (true) {
    const decoded = decodeInstructionAtSite({
      prgBytes,
      mapper,
      mapperContext: startSite.mapperContext,
      cpuAddr
    });
    requireObject(decoded, 'function excavation decoded result');
    if (!decoded.ok) {
      return {
        ok: false,
        reason: 'decodeFailed',
        detail: {
          reason: typeof decoded.reason === 'string' ? decoded.reason : 'decodeFailed',
          cpuAddr,
          romOff: decoded.romOff ?? null,
          opcode: typeof decoded.opcode === 'number' ? decoded.opcode & 0xff : null
        }
      };
    }

    const instruction = requireInstruction(decoded.instruction, 'function excavation decoded instruction');
    const site = requireObject(decoded.site, 'function excavation decoded site');
    const romOff = instruction.romOff >>> 0;
    if (seenRomOffs.has(romOff)) {
      return { ok: false, reason: 'repeatedRomOff', detail: { romOff } };
    }
    seenRomOffs.add(romOff);
    entries.push({ instruction, site });

    if (mustReachRomOff !== null && romOff === (mustReachRomOff >>> 0)) {
      reachedRequiredRomOff = true;
    }

    if (isHardTerminator(instruction)) {
      if (!reachedRequiredRomOff) return { ok: false, reason: 'hardTerminatorBeforeAnchor', entries };
      return { ok: true, entries, terminator: instruction };
    }

    const nextCpuAddr = nextFallthroughCpuAddr(instruction);
    if (nextCpuAddr === null) {
      return { ok: false, reason: 'noForwardFallthrough', entries };
    }
    cpuAddr = nextCpuAddr;
  }
}
