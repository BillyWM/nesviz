import { createNromMapper } from './map/nrom.js';
import { createFixedSwitch16kMapper } from './map/fixedSwitch16k.js';
import { createFixedSwitch32kMapper } from './map/fixedSwitch32k.js';
import { createMmc1Mapper } from './map/mmc1.js';
import { createMmc3Mapper } from './map/mmc3.js';

export const VECTOR_FAMILIES = ['nmi', 'reset', 'irq'];

export function emptyVectorFamilyMap() {
  return { nmi: [], reset: [], irq: [] };
}

export function createNavigationMapper({ prgBytes, mapperKind = 'NROM', mapperMeta = null } = {}) {
  const kind = typeof mapperKind === 'string' && mapperKind ? mapperKind : 'NROM';
  if (kind === 'NROM') return createNromMapper({ prgSize: prgBytes?.length | 0 });
  if (kind === 'MMC1') return createMmc1Mapper({ prgBytes, mapperMeta });
  if (kind === 'MMC3') return createMmc3Mapper({ prgBytes, mapperMeta });
  if (kind === 'UxROM' || kind === 'UN1ROM' || kind === 'CNROM' || kind === 'CPROM') {
    const mapperNumber = mapperMeta?.mapperFamily === 'UN1ROM' || kind === 'UN1ROM' ? 94 : 2;
    return createFixedSwitch16kMapper({ prgBytes, mapperMeta, mapperNumber });
  }
  if (kind === 'AxROM' || kind === 'BNROM' || kind === 'GxROM') {
    const mapperNumber = mapperMeta?.mapperFamily === 'BNROM' ? 34 : mapperMeta?.mapperFamily === 'GxROM' ? 66 : 7;
    return createFixedSwitch32kMapper({ prgBytes, mapperMeta, mapperNumber });
  }
  return null;
}

function buildSingleContextVectorSeedItemsByFamily({ vectors, mapper }) {
  const fetchCtx = mapper.initialFetchCtx();
  const mk = (cpuAddr) => ({ cpuAddr: cpuAddr & 0xffff, fetchCtx, confidence: 'certain' });
  return {
    reset: (typeof vectors?.reset === 'number' && (vectors.reset & 0xffff) >= 0x8000) ? [mk(vectors.reset)] : [],
    nmi: (typeof vectors?.nmi === 'number' && (vectors.nmi & 0xffff) >= 0x8000) ? [mk(vectors.nmi)] : [],
    irq: (typeof vectors?.irqBrk === 'number' && (vectors.irqBrk & 0xffff) >= 0x8000) ? [mk(vectors.irqBrk)] : []
  };
}

function collect32kVectorSeedsByFamily({ prgBytes, mapper }) {
  const out = emptyVectorFamilyMap();
  const seen = new Set();
  const bankCount = Math.max(1, mapper?.bankCount | 0);
  const bankSize = 32 * 1024;
  for (let bank = 0; bank < bankCount; bank++) {
    const base = bank * bankSize;
    if (base + 0x7fff >= (prgBytes?.length | 0)) break;
    const fetchCtx = typeof mapper.ctxForBank === 'function' ? mapper.ctxForBank(bank) : mapper.initialFetchCtx();
    const targets = {
      reset: (prgBytes[base + 0x7ffc] | (prgBytes[base + 0x7ffd] << 8)) & 0xffff,
      nmi: (prgBytes[base + 0x7ffa] | (prgBytes[base + 0x7ffb] << 8)) & 0xffff,
      irq: (prgBytes[base + 0x7ffe] | (prgBytes[base + 0x7fff] << 8)) & 0xffff
    };
    for (const [family, cpuAddr] of Object.entries(targets)) {
      if (cpuAddr < 0x8000) continue;
      const resolved = mapper.resolveCodeFetch(fetchCtx, cpuAddr);
      if (resolved?.backing?.kind !== 'exact') continue;
      const key = `${family}:${resolved.backing.romOff >>> 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out[family].push({ cpuAddr: cpuAddr & 0xffff, fetchCtx, confidence: 'certain' });
    }
  }
  return out;
}

export function buildVectorSeedItemsByFamily({ prgBytes, vectors, mapper = null, mapperKind = 'NROM', mapperMeta = null } = {}) {
  const activeMapper = mapper || createNavigationMapper({ prgBytes, mapperKind, mapperMeta });
  if (!activeMapper) return emptyVectorFamilyMap();
  if (activeMapper.id === 'fixed-switch-32k') return collect32kVectorSeedsByFamily({ prgBytes, mapper: activeMapper });
  return buildSingleContextVectorSeedItemsByFamily({ vectors, mapper: activeMapper });
}

function indexDiscoveredVectorLines(blocks) {
  const byRomOff = new Map();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    for (const line of Array.isArray(block?.lines) ? block.lines : []) {
      const cpuAddr = typeof line?.cpuAddr === 'number' ? (line.cpuAddr & 0xffff) : null;
      const romOff = typeof line?.romOff === 'number' ? (line.romOff >>> 0) : null;
      if (cpuAddr == null || romOff == null) continue;
      if (byRomOff.has(romOff)) continue;
      byRomOff.set(romOff, {
        cpuAddr,
        romOff,
        asm: typeof line?.asm === 'string' ? line.asm : ''
      });
    }
  }
  return byRomOff;
}

function seedRomOff(mapper, seed) {
  if (!mapper || typeof seed?.cpuAddr !== 'number' || !seed.fetchCtx) return null;
  const resolved = mapper.resolveCodeFetch?.(seed.fetchCtx, seed.cpuAddr & 0xffff);
  if (resolved?.backing?.kind !== 'exact' || typeof resolved.backing.romOff !== 'number') return null;
  return resolved.backing.romOff >>> 0;
}

export function resolveDiscoveredVectorDestinationsByFamily({ prgBytes, vectors, mapper = null, mapperKind = 'NROM', mapperMeta = null, blocks = [] } = {}) {
  const activeMapper = mapper || createNavigationMapper({ prgBytes, mapperKind, mapperMeta });
  const seedsByFamily = buildVectorSeedItemsByFamily({ prgBytes, vectors, mapper: activeMapper, mapperKind, mapperMeta });
  const discoveredByRomOff = indexDiscoveredVectorLines(blocks);
  const out = emptyVectorFamilyMap();

  for (const family of VECTOR_FAMILIES) {
    const seen = new Set();
    const entries = [];
    for (const seed of seedsByFamily[family] || []) {
      const romOff = seedRomOff(activeMapper, seed);
      if (romOff === null) continue;
      const hit = discoveredByRomOff.get(romOff);
      if (!hit) continue;
      const dedupeKey = `rom:${hit.romOff}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      entries.push({
        family,
        romOff: hit.romOff,
        cpuAddr: hit.cpuAddr,
        asm: hit.asm
      });
    }
    entries.sort((a, b) => {
      if ((a.romOff | 0) !== (b.romOff | 0)) return (a.romOff | 0) - (b.romOff | 0);
      return (a.cpuAddr & 0xffff) - (b.cpuAddr & 0xffff);
    });
    out[family] = entries;
  }

  return out;
}
