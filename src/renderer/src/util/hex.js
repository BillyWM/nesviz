import { fmtHex } from '../../../shared/utils/hexUtils.js';

export function hexN(n, width) {
  return fmtHex(n >>> 0, width);
}

export function hex4(n) {
  return fmtHex(n & 0xffff, 4);
}

export function hex6(n) {
  return fmtHex(n >>> 0, 6);
}
