import { fmtHex } from '../utils/numberUtils.js';

export function hex2(b) {
  return fmtHex(b & 0xff, 2);
}

export function hex4(n) {
  return fmtHex(n & 0xffff, 4);
}

export function hexN(n, width) {
  return fmtHex(n >>> 0, width);
}

export function fmtCpuAddr(addr) {
  return `$${hex4(addr)}`;
}
