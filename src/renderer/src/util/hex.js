export function hexN(n, width) {
  return (n >>> 0).toString(16).toUpperCase().padStart(width, '0');
}

export function hex4(n) {
  return hexN(n & 0xffff, 4);
}

export function hex6(n) {
  return hexN(n >>> 0, 6);
}
