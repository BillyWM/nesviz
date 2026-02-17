export function hex2(b) {
  return (b & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

export function hex4(n) {
  return (n & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

export function hexN(n, width) {
  return (n >>> 0).toString(16).toUpperCase().padStart(width, '0');
}

export function fmtCpuAddr(addr) {
  return `$${hex4(addr)}`;
}
