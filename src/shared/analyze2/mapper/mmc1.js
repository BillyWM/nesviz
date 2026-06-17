import { makeSiteKey } from '../identity.js';
import { requireInteger, requireObject, requireString } from '../dataShape.js';
import { buildSliceCandidates } from '../mappingSpeculation/candidates.js';
import { createMmc1Domain, MMC1_PRG_MODES } from '../domains/mapper/mmc1Domain.js';
import {
  CONTROL_TRANSFER_REASONS,
  controlTransferTargetCpuAddr,
  exactControlTransferResult,
  frontierControlTransferResult,
  requireControlTransfer
} from './controlTransfer.js';

const BANK_SIZE_16K = 0x4000;

function exactBacking(romOff) {
  return { kind: 'exact', romOff: romOff >>> 0 };
}

function backingSet(romOffs) {
  return { kind: 'set', romOffs: Array.from(new Set(romOffs.map((item) => item >>> 0))).sort((a, b) => a - b) };
}

function unmappedBacking(reason) {
  return { kind: 'unmapped', reason };
}

function unknownBacking(reason) {
  return { kind: 'unknown', reason };
}

function requirePrgBytes(prgBytes) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('createMmc1MapperModel requires PRG bytes');
  return prgBytes;
}

function requireMapperMeta(mapperMeta) {
  requireObject(mapperMeta, 'MMC1 mapperMeta');
  requireString(mapperMeta.mapperFamily, 'MMC1 mapperMeta.mapperFamily');
  requireString(mapperMeta.prgWindowModel, 'MMC1 mapperMeta.prgWindowModel');
  if (mapperMeta.prgWindowModel !== 'mmc1-variable') {
    throw new Error(`MMC1 mapper cannot represent PRG mapping model ${mapperMeta.prgWindowModel}`);
  }
  return mapperMeta;
}

function optionPurpose(options, fallback) {
  if (options === null || options === undefined) return fallback;
  requireObject(options, 'MMC1 mapper options');
  return typeof options.purpose === 'string' ? options.purpose : fallback;
}

function isPrgCpuAddr(cpuAddr) {
  const addr = cpuAddr & 0xffff;
  return addr >= 0x8000 && addr <= 0xffff;
}

function finiteSetValues(state) {
  if (state?.kind === 'set' && Array.isArray(state.values)) return state.values.slice();
  return null;
}

function readU16le(bytes, off) {
  return ((bytes[off] & 0xff) | ((bytes[off + 1] & 0xff) << 8)) & 0xffff;
}

function vectorCpuAddrForFamily(family) {
  const key = String(family || '').toLowerCase();
  if (key === 'nmi') return 0xfffa;
  if (key === 'irq' || key === 'irqbrk' || key === 'irq/brk') return 0xfffe;
  return null;
}

function idleLatchState() {
  return { kind: 'set', values: [{ count: 0, bits: 0 }] };
}

export function createMmc1MapperModel({ prgBytes, mapperMeta = null } = {}) {
  const requiredPrgBytes = requirePrgBytes(prgBytes);
  const requiredMapperMeta = requireMapperMeta(mapperMeta);
  const prgSize = requiredPrgBytes.length;
  if (prgSize <= 0 || prgSize % BANK_SIZE_16K !== 0) {
    throw new Error(`MMC1 analysis requires PRG size to be a positive multiple of 16K, got ${prgSize}`);
  }
  const bankCount = prgSize / BANK_SIZE_16K;
  const mapperDomain = createMmc1Domain({ bankCount });
  const contextCache = new Map();

  function makeContext(domainState) {
    const normalized = mapperDomain.clone(domainState);
    const key = mapperDomain.key(normalized);
    if (contextCache.has(key)) return contextCache.get(key);
    const context = Object.freeze({ mapper: 'mmc1', domainState: mapperDomain.toSerializable(normalized) });
    contextCache.set(key, context);
    return context;
  }

  function requireContext(mapperContext) {
    requireObject(mapperContext, 'MMC1 mapperContext');
    if (mapperContext.mapper !== 'mmc1') throw new Error('MMC1 mapperContext.mapper must be mmc1');
    return mapperContext;
  }

  function domainStateForContext(mapperContext) {
    return mapperDomain.initialForContext(requireContext(mapperContext));
  }

  function resolveWithDomainState(domainState, cpuAddr) {
    const resolved = mapperDomain.resolveCpuAddress(domainState, cpuAddr & 0xffff);
    if (resolved.kind === 'exact') return { ok: true, backing: exactBacking(resolved.romOff) };
    if (resolved.kind === 'set') return { ok: true, backing: backingSet(resolved.romOffs || []) };
    if (resolved.kind === 'unmapped') return { ok: false, backing: unmappedBacking(resolved.reason || 'cpuAddressOutsidePrgRom') };
    return { ok: false, backing: unknownBacking(resolved.reason || 'mmc1BackingUnknown') };
  }

  function cpuCandidatesForRomOffInContext(romOff, domainState) {
    const out = [];
    const off = romOff >>> 0;
    const within = off % BANK_SIZE_16K;
    for (const cpuAddr of [0x8000 + within, 0xc000 + within]) {
      const resolved = mapperDomain.resolveCpuAddress(domainState, cpuAddr & 0xffff);
      if (resolved.kind === 'exact' && (resolved.romOff >>> 0) === off) out.push(cpuAddr & 0xffff);
      else if (resolved.kind === 'set' && (resolved.romOffs || []).some((item) => (item >>> 0) === off)) out.push(cpuAddr & 0xffff);
    }
    return Array.from(new Set(out)).sort((a, b) => a - b);
  }

  function exactTargetForCpuAddr(mapperContext, cpuAddr, purpose) {
    const domainState = domainStateForContext(mapperContext);
    const contextKey = `mmc1:${mapperDomain.key(domainState)}`;
    const normalizedCpuAddr = cpuAddr & 0xffff;
    const resolved = resolveWithDomainState(domainState, normalizedCpuAddr);
    if (!resolved.ok) {
      return { ok: false, contextKey, cpuAddr: normalizedCpuAddr, backing: resolved.backing };
    }
    if (resolved.backing.kind !== 'exact') {
      return { ok: false, contextKey, cpuAddr: normalizedCpuAddr, backing: unknownBacking('mmc1TargetAmbiguous') };
    }
    const exactContext = makeContext(domainState);
    return {
      ok: true,
      target: {
        mapperContext: exactContext,
        contextKey: this.contextKey(exactContext),
        siteKey: makeSiteKey(this.contextKey(exactContext), normalizedCpuAddr),
        cpuAddr: normalizedCpuAddr,
        romOff: resolved.backing.romOff >>> 0,
        backing: resolved.backing,
        purpose
      }
    };
  }

  return {
    id: 'mmc1',
    family: requiredMapperMeta.mapperFamily,
    boardFamily: requiredMapperMeta.boardFamily,
    meta: requiredMapperMeta,
    prgSize,
    bankSize: BANK_SIZE_16K,
    bankCount,
    mapperDomain,

    initialContext() {
      return makeContext(mapperDomain.initialForContext(null));
    },

    contextKey(mapperContext) {
      return `mmc1:${mapperDomain.key(domainStateForContext(mapperContext))}`;
    },

    cpuWritesMayAffectCodeMapping() {
      return bankCount > 2;
    },

    contextFromMapperState(mapperState) {
      return makeContext(mapperDomain.clone(mapperState));
    },

    resolveCpuAddress(mapperContext, cpuAddr, options = null) {
      const context = requireContext(mapperContext);
      const contextKey = this.contextKey(context);
      const normalizedCpuAddr = requireInteger(cpuAddr, 'MMC1 cpuAddr') & 0xffff;
      const resolved = resolveWithDomainState(domainStateForContext(context), normalizedCpuAddr);
      return {
        ok: resolved.ok,
        contextKey,
        cpuAddr: normalizedCpuAddr,
        purpose: optionPurpose(options, null),
        backing: resolved.backing
      };
    },

    resolveControlTarget(mapperContext, cpuAddr, options = null) {
      return exactTargetForCpuAddr.call(this, mapperContext, requireInteger(cpuAddr, 'MMC1 control target cpuAddr') & 0xffff, optionPurpose(options, 'controlTarget'));
    },

    resolveControlTransferFromRomOff(mapperContext, transfer) {
      const context = requireContext(mapperContext);
      const domainState = domainStateForContext(context);
      const checked = requireControlTransfer(transfer, 'MMC1 control transfer');
      const sourceRomOff = checked.sourceRomOff >>> 0;
      const sourceCpuAddrs = cpuCandidatesForRomOffInContext(sourceRomOff, domainState);
      const contextKey = this.contextKey(context);
      if (sourceCpuAddrs.length !== 1) {
        return frontierControlTransferResult({
          reason: sourceCpuAddrs.length === 0 ? CONTROL_TRANSFER_REASONS.SOURCE_NOT_MAPPABLE : CONTROL_TRANSFER_REASONS.SOURCE_HAS_MULTIPLE_CPU_APPEARANCES,
          sourceRomOff,
          sourceAppearances: sourceCpuAddrs.map((cpuAddr) => ({ contextKey, cpuAddr, romOff: sourceRomOff })),
          detail: { sourceCpuAddrs }
        });
      }

      const sourceCpuAddr = sourceCpuAddrs[0];
      const targetCpuAddr = controlTransferTargetCpuAddr(sourceCpuAddr, checked);
      if (!isPrgCpuAddr(targetCpuAddr)) {
        return frontierControlTransferResult({
          reason: CONTROL_TRANSFER_REASONS.TARGET_NOT_MAPPED,
          sourceRomOff,
          sourceAppearances: [{ contextKey, cpuAddr: sourceCpuAddr, romOff: sourceRomOff }],
          targetCpuAddrs: [targetCpuAddr],
          detail: { targetCpuAddr }
        });
      }

      const resolved = this.resolveControlTarget(context, targetCpuAddr, { purpose: 'controlTransferTarget' });
      if (!resolved.ok) {
        return frontierControlTransferResult({
          reason: CONTROL_TRANSFER_REASONS.TARGET_AMBIGUOUS,
          sourceRomOff,
          sourceAppearances: [{ contextKey, cpuAddr: sourceCpuAddr, romOff: sourceRomOff }],
          targetCpuAddrs: [targetCpuAddr],
          detail: { targetCpuAddr, backing: resolved.backing }
        });
      }

      return exactControlTransferResult({
        source: { contextKey, cpuAddr: sourceCpuAddr, romOff: sourceRomOff },
        target: resolved.target,
        detail: {
          targetCpuAddr,
          targetRomOff: resolved.target.romOff,
          sourceCpuAddr,
          mapper: 'mmc1'
        }
      });
    },

    classifyWrite(cpuAddr) {
      const addr = requireInteger(cpuAddr, 'MMC1 classifyWrite cpuAddr') & 0xffff;
      if (addr >= 0x8000 && addr <= 0xffff) return 'possibleMapperWrite';
      if (addr >= 0x2000 && addr <= 0x3fff) return 'ppuRegister';
      if (addr >= 0x4000 && addr <= 0x401f) return 'apuIo';
      if (addr < 0x2000) return 'cpuRam';
      return 'other';
    },


    codeSitesForRomOff(romOff, _options = null) {
      const off = requireInteger(romOff, 'MMC1 codeSitesForRomOff romOff') >>> 0;
      if (off >= prgSize) return [];
      const bankIndex = Math.floor(off / BANK_SIZE_16K);
      const within = off % BANK_SIZE_16K;
      const out = [];
      const seen = new Set();
      const add = (domainState, cpuAddr) => {
        const mapperContext = this.contextFromMapperState(domainState);
        const resolved = this.resolveControlTarget(mapperContext, cpuAddr & 0xffff, { purpose: 'functionExcavationAppearance' });
        if (!resolved.ok || (resolved.target.romOff >>> 0) !== off) return;
        if (seen.has(resolved.target.siteKey)) return;
        seen.add(resolved.target.siteKey);
        out.push({ ...resolved.target, seedKind: 'functionExcavationAppearance', bankIndex });
      };

      add({
        kind: 'state',
        prgMode: { kind: 'set', values: [MMC1_PRG_MODES.FIXED_LAST] },
        prgBank: { kind: 'set', values: [bankIndex] },
        latch: { kind: 'set', values: [{ count: 0, bits: 0 }] }
      }, 0x8000 + within);

      if (bankIndex === bankCount - 1) {
        add({
          kind: 'state',
          prgMode: { kind: 'set', values: [MMC1_PRG_MODES.FIXED_LAST] },
          prgBank: { kind: 'set', values: [0] },
          latch: { kind: 'set', values: [{ count: 0, bits: 0 }] }
        }, 0xc000 + within);
      }

      if (bankIndex === 0) {
        add({
          kind: 'state',
          prgMode: { kind: 'set', values: [MMC1_PRG_MODES.FIXED_FIRST] },
          prgBank: { kind: 'set', values: [0] },
          latch: { kind: 'set', values: [{ count: 0, bits: 0 }] }
        }, 0x8000 + within);
      }

      add({
        kind: 'state',
        prgMode: { kind: 'set', values: [MMC1_PRG_MODES.FIXED_FIRST] },
        prgBank: { kind: 'set', values: [bankIndex] },
        latch: { kind: 'set', values: [{ count: 0, bits: 0 }] }
      }, 0xc000 + within);

      return out;
    },

    getMappingSpeculationCandidates(frontier) {
      return buildSliceCandidates({ frontier, prgSize, bankSize: BANK_SIZE_16K, skipSourceBank: true });
    },

    vectorCheckingContextsForFamily(family) {
      const vectorCpuAddr = vectorCpuAddrForFamily(family);
      if (vectorCpuAddr === null) {
        return { mode: 'notApplicable', reason: 'unsupportedVectorFamily', family, contexts: [] };
      }

      const contexts = [];
      const seen = new Set();
      const addContext = (domainState, bankIndex, contextRole) => {
        const mapperContext = this.contextFromMapperState(domainState);
        const contextKey = this.contextKey(mapperContext);
        const resolved = this.resolveCpuAddress(mapperContext, vectorCpuAddr, { purpose: 'vectorCheckingVectorFetch' });
        if (!resolved.ok || resolved.backing.kind !== 'exact') return;
        const vectorRomOff = resolved.backing.romOff >>> 0;
        if (vectorRomOff + 1 >= prgSize) return;
        const key = `${contextKey}:${vectorCpuAddr}`;
        if (seen.has(key)) return;
        seen.add(key);
        contexts.push({
          family: String(family || '').toLowerCase(),
          vectorCpuAddr,
          vectorRomOff,
          targetCpuAddr: readU16le(requiredPrgBytes, vectorRomOff),
          mapperContext,
          contextKey,
          bankIndex,
          contextRole
        });
      };

      for (let bankIndex = 0; bankIndex < bankCount; bankIndex += 1) {
        addContext({
          kind: 'state',
          prgMode: { kind: 'set', values: [MMC1_PRG_MODES.FIXED_LAST] },
          prgBank: { kind: 'set', values: [bankIndex] },
          latch: idleLatchState()
        }, bankIndex, 'fixedLast');

        addContext({
          kind: 'state',
          prgMode: { kind: 'set', values: [MMC1_PRG_MODES.FIXED_FIRST] },
          prgBank: { kind: 'set', values: [bankIndex] },
          latch: idleLatchState()
        }, bankIndex, 'fixedFirst');

        addContext({
          kind: 'state',
          prgMode: { kind: 'set', values: [MMC1_PRG_MODES.SWITCH_32K] },
          prgBank: { kind: 'set', values: [bankIndex] },
          latch: idleLatchState()
        }, bankIndex, 'switch32k');
      }

      return {
        mode: contexts.length > 1 ? 'bankedVectorContexts' : 'notApplicable',
        reason: contexts.length > 1 ? null : 'notBanked',
        family: String(family || '').toLowerCase(),
        contexts
      };
    },

    vectorSeedSites(vectors) {
      requireObject(vectors, 'MMC1 vectors');
      const mapperContext = this.initialContext();
      const out = [];
      for (const [family, value] of Object.entries(vectors)) {
        requireInteger(value, `MMC1 vector ${family}`);
        const resolved = this.resolveControlTarget(mapperContext, value, { policy: 'exactOnly', purpose: 'vectorSeed' });
        if (!resolved.ok) continue;
        out.push({ ...resolved.target, seedKind: family });
      }
      return out;
    }
  };
}
