export function cpuToRomOffWithMapper(mapper, cpuAddr, fetchCtx = null) {
  const a = cpuAddr & 0xffff;
  if (!mapper) return null;
  if (typeof mapper.cpuToRomOff === 'function') {
    return mapper.cpuToRomOff(a);
  }
  if (typeof mapper.cpuToRomOffInCtx === 'function') {
    if (!fetchCtx) return null;
    return mapper.cpuToRomOffInCtx(fetchCtx, a);
  }
  return null;
}
