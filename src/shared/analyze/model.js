import { hexN } from '../cpu6502/fmt.js';
import { siteKeyFor } from './fetchContext.js';

export function blockIdFromRomOff(romOff) {
  return `rom:${hexN(romOff, 6)}`;
}

export function instrId(ctxId, cpuAddr) {
  return `${ctxId}:${cpuAddr & 0xffff}`;
}

export function siteKey(ctxKey, cpuAddr) {
  return siteKeyFor(ctxKey, cpuAddr);
}

export function instrInstanceId(ctxKey, cpuAddr) {
  return `instr:${siteKeyFor(ctxKey, cpuAddr)}`;
}

export function blockInstanceId(ctxKey, cpuStart) {
  return `block:${siteKeyFor(ctxKey, cpuStart)}`;
}

export function sizeClass(byteLen) {
  if (byteLen <= 10) return 'small';
  if (byteLen <= 50) return 'medium';
  return 'large';
}
