export function getProbableInterruptRoots({ mapper, vectors, prgBytes }) {
  if (mapper && typeof mapper.getProbableInterruptRoots === 'function') {
    const roots = mapper.getProbableInterruptRoots({ vectors, prgBytes }) || [];
    return normalizeRoots(roots);
  }
  return normalizeRoots([
    typeof vectors?.nmi === 'number' ? { cpuAddr: vectors.nmi & 0xffff, fetchCtx: mapper?.initialFetchCtx ? mapper.initialFetchCtx() : null } : null,
    typeof vectors?.irqBrk === 'number' ? { cpuAddr: vectors.irqBrk & 0xffff, fetchCtx: mapper?.initialFetchCtx ? mapper.initialFetchCtx() : null } : null
  ]);
}

function normalizeRoots(items) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    if (!item || typeof item.cpuAddr !== 'number') continue;
    const cpuAddr = item.cpuAddr & 0xffff;
    if (cpuAddr < 0x8000) continue;
    const key = `${item.fetchCtx ? JSON.stringify(item.fetchCtx) : 'null'}:${cpuAddr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ cpuAddr, fetchCtx: item.fetchCtx || null });
  }
  return out;
}

export function buildProbableInterruptRootSet({ mapper, vectors, prgBytes }) {
  const roots = getProbableInterruptRoots({ mapper, vectors, prgBytes });
  const siteKeys = new Set();
  for (const root of roots) {
    const ctxKey = mapper?.fetchCtxKey ? mapper.fetchCtxKey(root.fetchCtx) : 'default';
    siteKeys.add(`${ctxKey}:${(root.cpuAddr & 0xffff).toString(16).padStart(4, '0')}`);
  }
  return { roots, siteKeys };
}

export function isChunkInterruptRoot({ chunk, probableContext }) {
  if (!chunk || !probableContext?.interruptRootSiteKeys) return false;
  const ctxKey = chunk.fetchCtx && probableContext.mapper?.fetchCtxKey
    ? probableContext.mapper.fetchCtxKey(chunk.fetchCtx)
    : null;
  if (!ctxKey) return false;
  const siteKey = `${ctxKey}:${(chunk.cpuStart & 0xffff).toString(16).padStart(4, '0')}`;
  return probableContext.interruptRootSiteKeys.has(siteKey);
}
