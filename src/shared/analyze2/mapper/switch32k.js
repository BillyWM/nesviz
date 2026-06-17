import { makeSiteKey } from '../identity.js';
import { createSwitch32kDomain } from '../domains/mapper/switch32kDomain.js';
import { requireInteger, requireObject, requireString } from '../dataShape.js';
import { buildSliceCandidates } from '../mappingSpeculation/candidates.js';
import {
  CONTROL_TRANSFER_REASONS,
  controlTransferTargetCpuAddr,
  exactControlTransferResult,
  frontierControlTransferResult,
  requireControlTransfer
} from './controlTransfer.js';

const PRG_CPU_START = 0x8000;
const PRG_CPU_END = 0xffff;
const SWITCH_32K_BANK_SIZE = 0x8000;

function exactBacking(romOff) {
  return { kind: 'exact', romOff: romOff >>> 0 };
}

function unmappedBacking(reason) {
  return { kind: 'unmapped', reason };
}

function requirePrgBytes(prgBytes) {
  if (!(prgBytes instanceof Uint8Array)) {
    throw new Error('createSwitch32kMapperModel requires PRG bytes');
  }
  return prgBytes;
}

function requireMapperMeta(mapperMeta) {
  requireObject(mapperMeta, 'switch32k mapperMeta');
  requireString(mapperMeta.mapperFamily, 'switch32k mapperMeta.mapperFamily');
  requireString(mapperMeta.prgWindowModel, 'switch32k mapperMeta.prgWindowModel');
  if (mapperMeta.prgWindowModel !== 'switch-32k') {
    throw new Error(`switch32k mapper cannot represent PRG mapping model ${mapperMeta.prgWindowModel}`);
  }
  return mapperMeta;
}

function readU16le(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8)) & 0xffff;
}

function vectorCpuAddrForFamily(family) {
  const key = String(family || '').toLowerCase();
  if (key === 'nmi') return 0xfffa;
  if (key === 'irq' || key === 'irqbrk' || key === 'irq/brk') return 0xfffe;
  return null;
}

function optionPurpose(options, fallback) {
  if (options === null || options === undefined) return fallback;
  requireObject(options, 'switch32k mapper options');
  return typeof options.purpose === 'string' ? options.purpose : fallback;
}

function isPrgCpuAddr(cpuAddr) {
  const addr = cpuAddr & 0xffff;
  return addr >= PRG_CPU_START && addr <= PRG_CPU_END;
}

function requireContext(mapperContext) {
  requireObject(mapperContext, 'switch32k mapperContext');
  if (mapperContext.mapper !== 'switch32k') throw new Error('switch32k mapperContext.mapper must be switch32k');
  requireInteger(mapperContext.bankIndex, 'switch32k mapperContext.bankIndex');
  return mapperContext;
}

const switch32kContextCache = new Map();

function makeContext(bankIndex, bankCount) {
  const normalized = requireInteger(bankIndex, 'switch32k bankIndex') >>> 0;
  if (normalized >= bankCount) throw new Error(`switch32k bankIndex ${normalized} is outside bankCount ${bankCount}`);
  if (switch32kContextCache.has(normalized)) return switch32kContextCache.get(normalized);
  const context = Object.freeze({ mapper: 'switch32k', bankIndex: normalized });
  switch32kContextCache.set(normalized, context);
  return context;
}

function bankIndexForRomOff(romOff) {
  return Math.floor((romOff >>> 0) / SWITCH_32K_BANK_SIZE);
}

function cpuAddrForRomOffInBank(romOff, bankIndex) {
  const normalizedRomOff = romOff >>> 0;
  const expectedBankIndex = bankIndexForRomOff(normalizedRomOff);
  if (expectedBankIndex !== (bankIndex >>> 0)) {
    return null;
  }
  return PRG_CPU_START + (normalizedRomOff % SWITCH_32K_BANK_SIZE);
}

function siteMatchesPossibleAppearance(site, appearance) {
  if (!appearance || typeof appearance !== 'object') return false;
  const romOff = Number(appearance.romOff);
  const cpuAddr = Number(appearance.cpuAddr);
  if (!Number.isInteger(romOff) || !Number.isInteger(cpuAddr)) return false;
  return (site.romOff >>> 0) === (romOff >>> 0)
    && (site.cpuAddr & 0xffff) === (cpuAddr & 0xffff);
}

export function createSwitch32kMapperModel({ prgBytes, mapperMeta = null } = {}) {
  const requiredPrgBytes = requirePrgBytes(prgBytes);
  const requiredMapperMeta = requireMapperMeta(mapperMeta);
  const prgSize = requiredPrgBytes.length;
  if (prgSize <= 0 || prgSize % SWITCH_32K_BANK_SIZE !== 0) {
    throw new Error(`switch-32k analysis requires PRG size to be a positive multiple of 32K, got ${prgSize}`);
  }
  const bankCount = prgSize / SWITCH_32K_BANK_SIZE;
  const mapperDomain = createSwitch32kDomain({ bankCount });

  return {
    id: 'switch32k',
    family: requiredMapperMeta.mapperFamily,
    boardFamily: requiredMapperMeta.boardFamily,
    meta: requiredMapperMeta,
    prgSize,
    bankSize: SWITCH_32K_BANK_SIZE,
    bankCount,
    mapperDomain,

    initialContext() {
      return makeContext(0, bankCount);
    },

    contextKey(mapperContext) {
      const context = requireContext(mapperContext);
      if ((context.bankIndex >>> 0) >= bankCount) throw new Error(`switch32k context bankIndex ${context.bankIndex} is outside bankCount ${bankCount}`);
      return `switch32k:bank:${context.bankIndex >>> 0}`;
    },

    cpuWritesMayAffectCodeMapping() {
      return bankCount > 1;
    },

    contextFromMapperState(mapperState) {
      const resolved = mapperDomain.resolveCpuAddress(mapperState, PRG_CPU_START);
      if (resolved.kind !== 'exact') return null;
      const bankIndex = Math.floor((resolved.romOff >>> 0) / SWITCH_32K_BANK_SIZE);
      return makeContext(bankIndex, bankCount);
    },

    resolveCpuAddress(mapperContext, cpuAddr, options = null) {
      const context = requireContext(mapperContext);
      const contextKey = this.contextKey(context);
      const normalizedCpuAddr = requireInteger(cpuAddr, 'switch32k cpuAddr') & 0xffff;
      if (!isPrgCpuAddr(normalizedCpuAddr)) {
        return {
          ok: false,
          contextKey,
          cpuAddr: normalizedCpuAddr,
          backing: unmappedBacking('cpuAddressOutsidePrgRom')
        };
      }

      const romOff = (context.bankIndex * SWITCH_32K_BANK_SIZE + (normalizedCpuAddr - PRG_CPU_START)) >>> 0;
      if (romOff >= prgSize) throw new Error(`switch32k resolved romOff ${romOff} outside PRG size ${prgSize}`);
      return {
        ok: true,
        contextKey,
        cpuAddr: normalizedCpuAddr,
        purpose: optionPurpose(options, null),
        backing: exactBacking(romOff)
      };
    },

    resolveControlTarget(mapperContext, cpuAddr, options = null) {
      const context = requireContext(mapperContext);
      const contextKey = this.contextKey(context);
      const normalizedCpuAddr = requireInteger(cpuAddr, 'switch32k control target cpuAddr') & 0xffff;
      const resolved = this.resolveCpuAddress(context, normalizedCpuAddr, {
        purpose: optionPurpose(options, 'controlTarget')
      });
      if (!resolved.ok) {
        return {
          ok: false,
          reason: resolved.backing.reason,
          contextKey,
          cpuAddr: normalizedCpuAddr,
          backing: resolved.backing
        };
      }
      const siteKey = makeSiteKey(contextKey, normalizedCpuAddr);
      return {
        ok: true,
        target: {
          mapperContext: context,
          contextKey,
          siteKey,
          cpuAddr: normalizedCpuAddr,
          romOff: resolved.backing.romOff >>> 0,
          backing: resolved.backing
        }
      };
    },

    resolveControlTransferFromRomOff(mapperContext, transfer) {
      const context = requireContext(mapperContext);
      const checked = requireControlTransfer(transfer, 'switch32k control transfer');
      const sourceRomOff = checked.sourceRomOff >>> 0;
      const sourceBankIndex = bankIndexForRomOff(sourceRomOff);
      const contextBankIndex = context.bankIndex >>> 0;
      const sourceCpuAddr = cpuAddrForRomOffInBank(sourceRomOff, contextBankIndex);
      const contextKey = this.contextKey(context);
      const sourceAppearance = {
        contextKey,
        cpuAddr: sourceCpuAddr === null ? null : sourceCpuAddr & 0xffff,
        romOff: sourceRomOff,
        windowId: 'prg32',
        bankIndex: contextBankIndex
      };

      if (sourceBankIndex >= bankCount || sourceCpuAddr === null) {
        return frontierControlTransferResult({
          reason: CONTROL_TRANSFER_REASONS.SOURCE_NOT_MAPPABLE,
          sourceRomOff,
          sourceAppearances: [sourceAppearance],
          detail: {
            sourceBankIndex,
            contextBankIndex,
            bankSize: SWITCH_32K_BANK_SIZE
          }
        });
      }

      const targetCpuAddr = controlTransferTargetCpuAddr(sourceCpuAddr, checked);
      if (!isPrgCpuAddr(targetCpuAddr)) {
        return frontierControlTransferResult({
          reason: CONTROL_TRANSFER_REASONS.CROSSES_MAPPING_BOUNDARY,
          sourceRomOff,
          sourceAppearances: [sourceAppearance],
          targetCpuAddrs: [targetCpuAddr],
          detail: {
            sourceWindow: 'prg32',
            targetWindow: null,
            sourceBankIndex,
            contextBankIndex,
            bankSize: SWITCH_32K_BANK_SIZE
          }
        });
      }

      const targetRomOff = (contextBankIndex * SWITCH_32K_BANK_SIZE + (targetCpuAddr - PRG_CPU_START)) >>> 0;
      const targetSiteKey = makeSiteKey(contextKey, targetCpuAddr);
      const target = {
        mapperContext: context,
        contextKey,
        siteKey: targetSiteKey,
        cpuAddr: targetCpuAddr,
        romOff: targetRomOff,
        backing: exactBacking(targetRomOff)
      };
      return exactControlTransferResult({
        source: sourceAppearance,
        target,
        detail: {
          targetCpuAddr,
          targetRomOff,
          sourceWindow: 'prg32',
          targetWindow: 'prg32',
          sourceBankIndex,
          targetBankIndex: contextBankIndex,
          bankSize: SWITCH_32K_BANK_SIZE
        }
      });
    },

    classifyWrite(cpuAddr) {
      const addr = requireInteger(cpuAddr, 'switch32k classifyWrite cpuAddr') & 0xffff;
      if (addr >= 0x8000 && addr <= 0xffff) return 'possibleMapperWrite';
      if (addr >= 0x2000 && addr <= 0x3fff) return 'ppuRegister';
      if (addr >= 0x4000 && addr <= 0x401f) return 'apuIo';
      if (addr < 0x2000) return 'cpuRam';
      return 'other';
    },


    codeSitesForRomOff(romOff, _options = null) {
      const off = requireInteger(romOff, 'switch32k codeSitesForRomOff romOff') >>> 0;
      if (off >= prgSize) return [];
      const bankIndex = bankIndexForRomOff(off);
      if (bankIndex >= bankCount) return [];
      const cpuAddr = cpuAddrForRomOffInBank(off, bankIndex);
      if (cpuAddr === null) return [];
      const mapperContext = makeContext(bankIndex, bankCount);
      const contextKey = this.contextKey(mapperContext);
      return [{
        mapperContext,
        contextKey,
        siteKey: makeSiteKey(contextKey, cpuAddr),
        cpuAddr: cpuAddr & 0xffff,
        romOff: off,
        backing: exactBacking(off),
        seedKind: 'functionExcavationAppearance',
        bankIndex
      }];
    },

    unambiguousAcceptedCodeAppearances(span) {
      requireObject(span, 'switch32k accepted code span');
      const sites = this.codeSitesForRomOff(requireInteger(span.romStart, 'switch32k accepted code span.romStart') >>> 0, {
        purpose: 'unambiguousAcceptedCode'
      });
      if (sites.length !== 1) return [];
      const possibleAppearances = Array.isArray(span.possibleAppearances) ? span.possibleAppearances : [];
      if (!possibleAppearances.length) return sites;
      return possibleAppearances.some((appearance) => siteMatchesPossibleAppearance(sites[0], appearance))
        ? sites
        : [];
    },

    getMappingSpeculationCandidates(frontier) {
      return buildSliceCandidates({
        frontier,
        prgSize,
        bankSize: SWITCH_32K_BANK_SIZE,
        skipSourceBank: true
      });
    },

    vectorCheckingContextsForFamily(family) {
      const vectorCpuAddr = vectorCpuAddrForFamily(family);
      if (vectorCpuAddr === null) {
        return { mode: 'notApplicable', reason: 'unsupportedVectorFamily', family, contexts: [] };
      }
      const contexts = [];
      const offsetInBank = vectorCpuAddr - PRG_CPU_START;
      for (let bankIndex = 0; bankIndex < bankCount; bankIndex += 1) {
        const mapperContext = makeContext(bankIndex, bankCount);
        const contextKey = this.contextKey(mapperContext);
        const vectorRomOff = (bankIndex * SWITCH_32K_BANK_SIZE + offsetInBank) >>> 0;
        if (vectorRomOff + 1 >= prgSize) continue;
        contexts.push({
          family: String(family || '').toLowerCase(),
          vectorCpuAddr,
          vectorRomOff,
          targetCpuAddr: readU16le(requiredPrgBytes, vectorRomOff),
          mapperContext,
          contextKey,
          bankIndex
        });
      }
      return {
        mode: contexts.length > 1 ? 'bankedVectorContexts' : 'notApplicable',
        reason: contexts.length > 1 ? null : 'notBanked',
        family: String(family || '').toLowerCase(),
        contexts
      };
    },

    vectorSeedSites(_vectors) {
      const out = [];
      const seen = new Set();
      for (let bankIndex = 0; bankIndex < bankCount; bankIndex += 1) {
        const bankBase = bankIndex * SWITCH_32K_BANK_SIZE;
        const resetVector = readU16le(requiredPrgBytes, bankBase + 0x7ffc);
        if (!isPrgCpuAddr(resetVector)) continue;
        const mapperContext = makeContext(bankIndex, bankCount);
        const contextKey = this.contextKey(mapperContext);
        const romOff = bankBase + (resetVector - PRG_CPU_START);
        const siteKey = makeSiteKey(contextKey, resetVector);
        if (seen.has(siteKey)) continue;
        seen.add(siteKey);
        out.push({
          mapperContext,
          contextKey,
          siteKey,
          cpuAddr: resetVector,
          romOff,
          backing: exactBacking(romOff),
          seedKind: 'RESET',
          bankIndex
        });
      }
      return out;
    }
  };
}
