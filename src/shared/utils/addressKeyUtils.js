export function parseAddressKey(key) {
  const [space, addrText] = String(key || '').split(':');
  const addr = Number.parseInt(addrText, 10);
  if (!space || !Number.isFinite(addr)) return null;
  return { space, addr: space === 'rom' ? (addr >>> 0) : (addr & 0xffff) };
}

export function addressKey(space, addr) {
  if (!space || !Number.isFinite(addr)) return null;
  return `${space}:${space === 'rom' ? (addr >>> 0) : (addr & 0xffff)}`;
}

export function memKey(space, addr) {
  return `${space}:${space === 'rom' ? (addr >>> 0) : (addr & 0xffff)}`;
}
