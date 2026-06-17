import { fmtHex } from '../utils/numberUtils.js';

export function hexCpu(cpuAddr) {
  return `$${fmtHex(cpuAddr & 0xffff, 4)}`;
}

export function hexRom(romOff) {
  const value = romOff >>> 0;
  return `$${fmtHex(value, Math.max(6, value.toString(16).length))}`;
}

export function makeSiteKey(contextKey, cpuAddr) {
  return `site:${contextKey}:${hexCpu(cpuAddr)}`;
}

export function makeInstructionId(romOff) {
  return romOff >>> 0;
}

export function makeBlockId(romStart) {
  return `block:rom:${hexRom(romStart)}`;
}

export function makeBlockInstanceId(contextKey, cpuStart) {
  return `blockinst:${contextKey}:${hexCpu(cpuStart)}`;
}

export function makeCoalescedBlockId(romStart) {
  return `coalesced:block:rom:${hexRom(romStart)}`;
}

export function makeEdgeId(fromBlockInstanceId, toBlockInstanceId, kind) {
  return `edge:${fromBlockInstanceId}:${kind}:${toBlockInstanceId}`;
}

export function makeFrontierId(kind, siteKey) {
  return `frontier:${kind}:${siteKey}`;
}
