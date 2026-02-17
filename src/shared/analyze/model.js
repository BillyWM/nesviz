import { hexN } from '../cpu6502/fmt.js';

export function blockIdFromRomOff(romOff) {
  return `rom:${hexN(romOff, 6)}`;
}

export function instrId(ctxId, cpuAddr) {
  return `${ctxId}:${cpuAddr & 0xffff}`;
}

export function sizeClass(byteLen) {
  if (byteLen <= 10) return 'small';
  if (byteLen <= 50) return 'medium';
  return 'large';
}
