import { makeSiteKey } from '../identity.js';
import { requireInteger, requireObject, requireString } from '../dataShape.js';
import { buildSliceCandidates } from '../mappingSpeculation/candidates.js';
import { createMmc3Domain, MMC3_BANK_SELECTS, MMC3_PRG_MODES } from '../domains/mapper/mmc3Domain.js';
import {
  CONTROL_TRANSFER_REASONS,
  controlTransferTargetCpuAddr,
  exactControlTransferResult,
  frontierControlTransferResult,
  requireControlTransfer
} from './controlTransfer.js';

const BANK_SIZE_8K = 0x2000;

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
  if (!(prgBytes instanceof Uint8Array)) throw new Error('createMmc3MapperModel requires PRG bytes');
  return prgBytes;
}

function requireMapperMeta(mapperMeta) {
  requireObject(mapperMeta, 'MMC3 mapperMeta');
  requireString(mapperMeta.mapperFamily, 'MMC3 mapperMeta.mapperFamily');
  requireString(mapperMeta.prgWindowModel, 'MMC3 mapperMeta.prgWindowModel');
  if (mapperMeta.prgWindowModel !== 'switch-8k-mixed') {
    throw new Error(`MMC3 mapper cannot represent PRG mapping model ${mapperMeta.prgWindowModel}`);
  }
  return mapperMeta;
}

function optionPurpose(options, fallback) {
  if (options === null || options === undefined) return fallback;
  requireObject(options, 'MMC3 mapper options');
  return typeof options.purpose === 'string' ? options.purpose : fallback;
}

function isPrgCpuAddr(cpuAddr) {
  const addr = cpuAddr & 0xffff;
  return addr >= 0x8000 && addr <= 0xffff;
}

function readU16le(bytes, off) {
  return ((bytes[off] & 0xff) | ((bytes[off + 1] & 0xff) << 8)) & 0xffff;
}

function siteMatchesPossibleAppearance(site, appearance) {
  if (!appearance || typeof appearance !== 'object') return false;
  const romOff = Number(appearance.romOff);
  const cpuAddr = Number(appearance.cpuAddr);
  if (!Number.isInteger(romOff) || !Number.isInteger(cpuAddr)) return false;
  return (site.romOff >>> 0) === (romOff >>> 0)
    && (site.cpuAddr & 0xffff) === (cpuAddr & 0xffff);
}

function vectorCpuAddrForFamily(family) {
  const key = String(family || '').toLowerCase();
  if (key === 'nmi') return 0xfffa;
  if (key === 'irq' || key === 'irqbrk' || key === 'irq/brk') return 0xfffe;
  return null;
}

export function createMmc3MapperModel({ prgBytes, mapperMeta = null } = {}) {
  const requiredPrgBytes = requirePrgBytes(prgBytes);
  const requiredMapperMeta = requireMapperMeta(mapperMeta);
  const prgSize = requiredPrgBytes.length;
  if (prgSize <= 0 || prgSize % BANK_SIZE_8K !== 0) {
    throw new Error(`MMC3 analysis requires PRG size to be a positive multiple of 8K, got ${prgSize}`);
  }
  const bankCount = prgSize / BANK_SIZE_8K;
  const mapperDomain = createMmc3Domain({ bankCount });
  const contextCache = new Map();

  function makeContext(domainState) {
    const normalized = mapperDomain.clone(domainState);
    const key = mapperDomain.key(normalized);
    if (contextCache.has(key)) return contextCache.get(key);
    const context = Object.freeze({ mapper: 'mmc3', domainState: mapperDomain.toSerializable(normalized) });
    contextCache.set(key, context);
    return context;
  }

  function requireContext(mapperContext) {
    requireObject(mapperContext, 'MMC3 mapperContext');
    if (mapperContext.mapper !== 'mmc3') throw new Error('MMC3 mapperContext.mapper must be mmc3');
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
    return { ok: false, backing: unknownBacking(resolved.reason || 'mmc3BackingUnknown') };
  }

  function cpuCandidatesForRomOffInContext(romOff, domainState) {
    const out = [];
    const off = romOff >>> 0;
    const within = off % BANK_SIZE_8K;
    for (const cpuBase of [0x8000, 0xa000, 0xc000, 0xe000]) {
      const cpuAddr = (cpuBase + within) & 0xffff;
      const resolved = mapperDomain.resolveCpuAddress(domainState, cpuAddr);
      if (resolved.kind === 'exact' && (resolved.romOff >>> 0) === off) out.push(cpuAddr);
      else if (resolved.kind === 'set' && (resolved.romOffs || []).some((item) => (item >>> 0) === off)) out.push(cpuAddr);
    }
    return Array.from(new Set(out)).sort((a, b) => a - b);
  }

  function exactTargetForCpuAddr(mapperContext, cpuAddr, purpose) {
    const domainState = domainStateForContext(mapperContext);
    const contextKey = `mmc3:${mapperDomain.key(domainState)}`;
    const normalizedCpuAddr = cpuAddr & 0xffff;
    const resolved = resolveWithDomainState(domainState, normalizedCpuAddr);
    if (!resolved.ok) return { ok: false, contextKey, cpuAddr: normalizedCpuAddr, backing: resolved.backing };
    if (resolved.backing.kind !== 'exact') return { ok: false, contextKey, cpuAddr: normalizedCpuAddr, backing: unknownBacking('mmc3TargetAmbiguous') };
    const exactContext = makeContext(domainState);
    const exactContextKey = this.contextKey(exactContext);
    return {
      ok: true,
      target: {
        mapperContext: exactContext,
        contextKey: exactContextKey,
        siteKey: makeSiteKey(exactContextKey, normalizedCpuAddr),
        cpuAddr: normalizedCpuAddr,
        romOff: resolved.backing.romOff >>> 0,
        backing: resolved.backing,
        purpose
      }
    };
  }

  return {
    id: 'mmc3',
    family: requiredMapperMeta.mapperFamily,
    boardFamily: requiredMapperMeta.boardFamily,
    meta: requiredMapperMeta,
    prgSize,
    bankSize: BANK_SIZE_8K,
    bankCount,
    mapperDomain,

    initialContext() {
      return makeContext(mapperDomain.initialForContext(null));
    },

    contextKey(mapperContext) {
      return `mmc3:${mapperDomain.key(domainStateForContext(mapperContext))}`;
    },

    contextFromMapperState(mapperState) {
      return makeContext(mapperDomain.clone(mapperState));
    },

    resolveCpuAddress(mapperContext, cpuAddr, options = null) {
      const context = requireContext(mapperContext);
      const contextKey = this.contextKey(context);
      const normalizedCpuAddr = requireInteger(cpuAddr, 'MMC3 cpuAddr') & 0xffff;
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
      return exactTargetForCpuAddr.call(this, mapperContext, requireInteger(cpuAddr, 'MMC3 control target cpuAddr') & 0xffff, optionPurpose(options, 'controlTarget'));
    },

    resolveControlTransferFromRomOff(mapperContext, transfer) {
      const context = requireContext(mapperContext);
      const domainState = domainStateForContext(context);
      const checked = requireControlTransfer(transfer, 'MMC3 control transfer');
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
          mapper: 'mmc3'
        }
      });
    },

    classifyWrite(cpuAddr) {
      const addr = requireInteger(cpuAddr, 'MMC3 classifyWrite cpuAddr') & 0xffff;
      if (addr >= 0x8000 && addr <= 0x9fff) return 'possibleMapperWrite';
      if (addr >= 0x2000 && addr <= 0x3fff) return 'ppuRegister';
      if (addr >= 0x4000 && addr <= 0x401f) return 'apuIo';
      if (addr < 0x2000) return 'cpuRam';
      return 'other';
    },


    codeSitesForRomOff(romOff, _options = null) {
      const off = requireInteger(romOff, 'MMC3 codeSitesForRomOff romOff') >>> 0;
      if (off >= prgSize) return [];
      const bankIndex = Math.floor(off / BANK_SIZE_8K);
      const within = off % BANK_SIZE_8K;
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
      const latch = {
        bankSelect: { kind: 'set', values: [MMC3_BANK_SELECTS.OTHER] },
        r6: { kind: 'set', values: [0] },
        r7: { kind: 'set', values: [0] }
      };

      if (bankIndex === bankCount - 1) {
        add({ kind: 'state', prgMode: { kind: 'set', values: [MMC3_PRG_MODES.NORMAL] }, ...latch }, 0xe000 + within);
      }
      if (bankIndex === bankCount - 2) {
        add({ kind: 'state', prgMode: { kind: 'set', values: [MMC3_PRG_MODES.NORMAL] }, ...latch }, 0xc000 + within);
        add({ kind: 'state', prgMode: { kind: 'set', values: [MMC3_PRG_MODES.SWAPPED] }, ...latch }, 0x8000 + within);
      }
      add({
        kind: 'state',
        prgMode: { kind: 'set', values: [MMC3_PRG_MODES.NORMAL] },
        bankSelect: { kind: 'set', values: [MMC3_BANK_SELECTS.OTHER] },
        r6: { kind: 'set', values: [bankIndex] },
        r7: { kind: 'set', values: [0] }
      }, 0x8000 + within);
      add({
        kind: 'state',
        prgMode: { kind: 'set', values: [MMC3_PRG_MODES.SWAPPED] },
        bankSelect: { kind: 'set', values: [MMC3_BANK_SELECTS.OTHER] },
        r6: { kind: 'set', values: [bankIndex] },
        r7: { kind: 'set', values: [0] }
      }, 0xc000 + within);
      add({
        kind: 'state',
        prgMode: { kind: 'set', values: [MMC3_PRG_MODES.NORMAL] },
        bankSelect: { kind: 'set', values: [MMC3_BANK_SELECTS.OTHER] },
        r6: { kind: 'set', values: [0] },
        r7: { kind: 'set', values: [bankIndex] }
      }, 0xa000 + within);
      return out;
    },

    unambiguousAcceptedCodeAppearances(span) {
      requireObject(span, 'MMC3 accepted code span');
      const off = requireInteger(span.romStart, 'MMC3 accepted code span.romStart') >>> 0;
      if (off >= prgSize) return [];
      const bankIndex = Math.floor(off / BANK_SIZE_8K);
      if (bankIndex !== bankCount - 1) return [];
      const cpuAddr = 0xe000 + (off % BANK_SIZE_8K);
      const resolved = this.resolveControlTarget(this.initialContext(), cpuAddr & 0xffff, {
        purpose: 'unambiguousAcceptedCode'
      });
      if (!resolved.ok || (resolved.target.romOff >>> 0) !== off) return [];
      const site = {
        ...resolved.target,
        seedKind: 'functionExcavationAppearance',
        bankIndex
      };
      const possibleAppearances = Array.isArray(span.possibleAppearances) ? span.possibleAppearances : [];
      if (!possibleAppearances.length) return [site];
      return possibleAppearances.some((appearance) => siteMatchesPossibleAppearance(site, appearance))
        ? [site]
        : [];
    },

    getMappingSpeculationCandidates(frontier) {
      return buildSliceCandidates({ frontier, prgSize, bankSize: BANK_SIZE_8K, skipSourceBank: true });
    },

    vectorCheckingContextsForFamily(family) {
      const vectorCpuAddr = vectorCpuAddrForFamily(family);
      if (vectorCpuAddr === null) {
        return { mode: 'notApplicable', reason: 'unsupportedVectorFamily', family, contexts: [] };
      }
      const vectorRomOff = ((bankCount - 1) * BANK_SIZE_8K + (vectorCpuAddr - 0xe000)) >>> 0;
      if (vectorRomOff + 1 >= prgSize) {
        return { mode: 'notApplicable', reason: 'vectorSlotOutOfRange', family: String(family || '').toLowerCase(), contexts: [] };
      }

      const targetCpuAddr = readU16le(requiredPrgBytes, vectorRomOff);
      if (!isPrgCpuAddr(targetCpuAddr)) {
        return {
          mode: 'bankedVectorContexts',
          family: String(family || '').toLowerCase(),
          contexts: [{
            family: String(family || '').toLowerCase(),
            vectorCpuAddr,
            vectorRomOff,
            targetCpuAddr,
            mapperContext: this.initialContext(),
            contextKey: this.contextKey(this.initialContext()),
            bankIndex: bankCount - 1,
            contextRole: 'fixedVectorSlot'
          }]
        };
      }

      const contexts = [];
      const seen = new Set();
      const addContext = (domainState, bankIndex, contextRole) => {
        const mapperContext = this.contextFromMapperState(domainState);
        const contextKey = this.contextKey(mapperContext);
        const key = `${contextKey}:${targetCpuAddr}`;
        if (seen.has(key)) return;
        seen.add(key);
        contexts.push({
          family: String(family || '').toLowerCase(),
          vectorCpuAddr,
          vectorRomOff,
          targetCpuAddr,
          mapperContext,
          contextKey,
          bankIndex,
          contextRole
        });
      };

      const slot = targetCpuAddr >= 0xe000 ? 'fixedLast'
        : (targetCpuAddr >= 0xc000 ? 'slotC000'
          : (targetCpuAddr >= 0xa000 ? 'slotA000' : 'slot8000'));
      const latch = { bankSelect: { kind: 'set', values: [MMC3_BANK_SELECTS.OTHER] } };

      if (slot === 'fixedLast') {
        addContext({
          kind: 'state',
          prgMode: { kind: 'set', values: [MMC3_PRG_MODES.NORMAL] },
          ...latch,
          r6: { kind: 'set', values: [0] },
          r7: { kind: 'set', values: [0] }
        }, bankCount - 1, 'fixedLast');
      } else if (slot === 'slotA000') {
        for (let bankIndex = 0; bankIndex < bankCount; bankIndex += 1) {
          addContext({
            kind: 'state',
            prgMode: { kind: 'set', values: [MMC3_PRG_MODES.NORMAL] },
            ...latch,
            r6: { kind: 'set', values: [0] },
            r7: { kind: 'set', values: [bankIndex] }
          }, bankIndex, 'r7');
        }
      } else if (slot === 'slot8000') {
        for (let bankIndex = 0; bankIndex < bankCount; bankIndex += 1) {
          addContext({
            kind: 'state',
            prgMode: { kind: 'set', values: [MMC3_PRG_MODES.NORMAL] },
            ...latch,
            r6: { kind: 'set', values: [bankIndex] },
            r7: { kind: 'set', values: [0] }
          }, bankIndex, 'r6Normal');
        }
        addContext({
          kind: 'state',
          prgMode: { kind: 'set', values: [MMC3_PRG_MODES.SWAPPED] },
          ...latch,
          r6: { kind: 'set', values: [0] },
          r7: { kind: 'set', values: [0] }
        }, bankCount - 2, 'fixedSecondLastSwapped');
      } else if (slot === 'slotC000') {
        addContext({
          kind: 'state',
          prgMode: { kind: 'set', values: [MMC3_PRG_MODES.NORMAL] },
          ...latch,
          r6: { kind: 'set', values: [0] },
          r7: { kind: 'set', values: [0] }
        }, bankCount - 2, 'fixedSecondLastNormal');
        for (let bankIndex = 0; bankIndex < bankCount; bankIndex += 1) {
          addContext({
            kind: 'state',
            prgMode: { kind: 'set', values: [MMC3_PRG_MODES.SWAPPED] },
            ...latch,
            r6: { kind: 'set', values: [bankIndex] },
            r7: { kind: 'set', values: [0] }
          }, bankIndex, 'r6Swapped');
        }
      }

      return {
        mode: contexts.length > 1 ? 'bankedVectorContexts' : 'notApplicable',
        reason: contexts.length > 1 ? null : 'notBanked',
        family: String(family || '').toLowerCase(),
        contexts
      };
    },

    vectorSeedSites(vectors) {
      requireObject(vectors, 'MMC3 vectors');
      const mapperContext = this.initialContext();
      const out = [];
      for (const [family, value] of Object.entries(vectors)) {
        requireInteger(value, `MMC3 vector ${family}`);
        const resolved = this.resolveControlTarget(mapperContext, value, { policy: 'exactOnly', purpose: 'vectorSeed' });
        if (!resolved.ok) continue;
        out.push({ ...resolved.target, seedKind: family });
      }
      return out;
    }
  };
}
