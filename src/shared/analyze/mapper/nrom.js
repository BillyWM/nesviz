import { makeSiteKey } from '../identity.js';
import { requireInteger, requireObject } from '../dataShape.js';
import {
  CONTROL_TRANSFER_REASONS,
  controlTransferTargetCpuAddr,
  exactControlTransferResult,
  frontierControlTransferResult,
  requireControlTransfer
} from './controlTransfer.js';

const NROM_CONTEXT = Object.freeze({ mapper: 'nrom', kind: 'fixed' });
const NROM_CONTEXT_KEY = 'nrom:fixed';

function cpuToRomOff(prgSize, cpuAddr) {
  const addr = cpuAddr & 0xffff;
  if (addr < 0x8000 || addr > 0xffff) return null;
  const offsetInWindow = addr - 0x8000;
  if (prgSize === 16 * 1024) return offsetInWindow & 0x3fff;
  if (prgSize === 32 * 1024) return offsetInWindow & 0x7fff;
  throw new Error(`NROM mapper has invalid PRG size ${prgSize}`);
}

function cpuAddrsForRomOff(prgSize, romOff) {
  const off = romOff >>> 0;
  if (off >= prgSize) return [];
  if (prgSize === 16 * 1024) return [0x8000 + off, 0xc000 + off];
  if (prgSize === 32 * 1024) return [0x8000 + off];
  return [];
}

function siteMatchesPossibleAppearance(site, appearance) {
  if (!appearance || typeof appearance !== 'object') return false;
  const romOff = Number(appearance.romOff);
  const cpuAddr = Number(appearance.cpuAddr);
  if (!Number.isInteger(romOff) || !Number.isInteger(cpuAddr)) return false;
  return (site.romOff >>> 0) === (romOff >>> 0)
    && (site.cpuAddr & 0xffff) === (cpuAddr & 0xffff);
}

function exactBacking(romOff) {
  return { kind: 'exact', romOff: romOff >>> 0 };
}

function unmappedBacking(reason) {
  return { kind: 'unmapped', reason };
}

function requirePrgBytes(prgBytes) {
  if (!(prgBytes instanceof Uint8Array)) {
    throw new Error('createNromMapperModel requires PRG bytes');
  }
  const prgSize = prgBytes.length;
  if (prgSize !== 16 * 1024 && prgSize !== 32 * 1024) {
    throw new Error(`NROM mapper expects 16K or 32K PRG, got ${prgSize}`);
  }
  return prgBytes;
}

function optionPurpose(options, fallback) {
  if (options === null || options === undefined) return fallback;
  requireObject(options, 'mapper options');
  return typeof options.purpose === 'string' ? options.purpose : fallback;
}

export function createNromMapperModel({ prgBytes, mapperMeta = null } = {}) {
  const requiredPrgBytes = requirePrgBytes(prgBytes);
  const prgSize = requiredPrgBytes.length;

  return {
    id: 'nrom',
    family: 'NROM',
    meta: mapperMeta,
    prgSize,

    initialContext() {
      return NROM_CONTEXT;
    },

    contextKey(_mapperContext) {
      return NROM_CONTEXT_KEY;
    },

    cpuWritesMayAffectCodeMapping() {
      return false;
    },

    resolveCpuAddress(mapperContext, cpuAddr, options = null) {
      requireObject(mapperContext, 'NROM mapperContext');
      requireInteger(cpuAddr, 'NROM cpuAddr');
      const contextKey = this.contextKey(mapperContext);
      const normalizedCpuAddr = cpuAddr & 0xffff;
      const romOff = cpuToRomOff(prgSize, normalizedCpuAddr);
      if (romOff === null) {
        return {
          ok: false,
          contextKey,
          cpuAddr: normalizedCpuAddr,
          backing: unmappedBacking('cpuAddressOutsidePrgRom')
        };
      }

      return {
        ok: true,
        contextKey,
        cpuAddr: normalizedCpuAddr,
        purpose: optionPurpose(options, null),
        backing: exactBacking(romOff)
      };
    },

    resolveControlTarget(mapperContext, cpuAddr, options = null) {
      requireObject(mapperContext, 'NROM control target mapperContext');
      requireInteger(cpuAddr, 'NROM control target cpuAddr');
      const contextKey = this.contextKey(mapperContext);
      const normalizedCpuAddr = cpuAddr & 0xffff;
      const resolved = this.resolveCpuAddress(mapperContext, normalizedCpuAddr, {
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
      if (resolved.backing.kind !== 'exact') {
        throw new Error('NROM resolved a control target without exact backing');
      }

      const siteKey = makeSiteKey(contextKey, normalizedCpuAddr);
      return {
        ok: true,
        target: {
          mapperContext,
          contextKey,
          siteKey,
          cpuAddr: normalizedCpuAddr,
          romOff: resolved.backing.romOff >>> 0,
          backing: resolved.backing
        }
      };
    },

    resolveControlTransferFromRomOff(mapperContext, transfer) {
      requireObject(mapperContext, 'NROM control transfer mapperContext');
      const checked = requireControlTransfer(transfer, 'NROM control transfer');
      const sourceRomOff = checked.sourceRomOff >>> 0;
      const sourceCpuAddrs = cpuAddrsForRomOff(prgSize, sourceRomOff);
      if (!sourceCpuAddrs.length) {
        return frontierControlTransferResult({
          reason: CONTROL_TRANSFER_REASONS.SOURCE_NOT_MAPPABLE,
          sourceRomOff,
          detail: { prgSize }
        });
      }

      const preferredSourceCpuAddr = Number.isInteger(checked.sourceCpuAddr)
        ? checked.sourceCpuAddr & 0xffff
        : null;
      const orderedSourceCpuAddrs = preferredSourceCpuAddr !== null && sourceCpuAddrs.includes(preferredSourceCpuAddr)
        ? [preferredSourceCpuAddr, ...sourceCpuAddrs.filter((cpuAddr) => cpuAddr !== preferredSourceCpuAddr)]
        : sourceCpuAddrs;

      const candidates = [];
      const targetCpuAddrs = [];
      for (const sourceCpuAddr of orderedSourceCpuAddrs) {
        const targetCpuAddr = controlTransferTargetCpuAddr(sourceCpuAddr, checked);
        targetCpuAddrs.push(targetCpuAddr);
        const targetRomOff = cpuToRomOff(prgSize, targetCpuAddr);
        if (targetRomOff === null) {
          return frontierControlTransferResult({
            reason: CONTROL_TRANSFER_REASONS.TARGET_NOT_MAPPED,
            sourceRomOff,
            sourceAppearances: sourceCpuAddrs.map((cpuAddr) => ({
              contextKey: NROM_CONTEXT_KEY,
              cpuAddr,
              romOff: sourceRomOff
            })),
            targetCpuAddrs,
            detail: { prgSize }
          });
        }
        candidates.push({
          source: {
            contextKey: NROM_CONTEXT_KEY,
            cpuAddr: sourceCpuAddr,
            romOff: sourceRomOff
          },
          target: {
            mapperContext,
            contextKey: NROM_CONTEXT_KEY,
            siteKey: makeSiteKey(NROM_CONTEXT_KEY, targetCpuAddr),
            cpuAddr: targetCpuAddr,
            romOff: targetRomOff,
            backing: exactBacking(targetRomOff)
          },
          detail: {
            targetCpuAddr,
            targetRomOff,
            mapper: 'nrom'
          }
        });
      }

      const first = candidates[0];
      const sameTarget = candidates.every((candidate) => (candidate.target.romOff >>> 0) === (first.target.romOff >>> 0));
      if (!sameTarget) {
        return frontierControlTransferResult({
          reason: CONTROL_TRANSFER_REASONS.SOURCE_HAS_MULTIPLE_CPU_APPEARANCES,
          sourceRomOff,
          sourceAppearances: candidates.map((candidate) => candidate.source),
          targetCpuAddrs,
          candidateTargets: candidates.map((candidate) => ({
            cpuAddr: candidate.target.cpuAddr,
            romOff: candidate.target.romOff,
            contextKey: candidate.target.contextKey,
            siteKey: candidate.target.siteKey
          })),
          detail: { prgSize }
        });
      }

      return exactControlTransferResult(first);
    },

    classifyWrite(cpuAddr) {
      requireInteger(cpuAddr, 'NROM classifyWrite cpuAddr');
      const addr = cpuAddr & 0xffff;
      if (addr >= 0x8000 && addr <= 0xffff) return 'prgRomWrite';
      if (addr >= 0x2000 && addr <= 0x3fff) return 'ppuRegister';
      if (addr >= 0x4000 && addr <= 0x401f) return 'apuIo';
      if (addr < 0x2000) return 'cpuRam';
      return 'other';
    },


    codeSitesForRomOff(romOff, _options = null) {
      const off = requireInteger(romOff, 'NROM codeSitesForRomOff romOff') >>> 0;
      if (off >= prgSize) return [];
      const mapperContext = this.initialContext();
      const contextKey = this.contextKey(mapperContext);
      const cpuAddrs = prgSize === 16 * 1024
        ? [0x8000 + off, 0xc000 + off]
        : [0x8000 + off];
      return cpuAddrs.map((cpuAddr) => ({
        mapperContext,
        contextKey,
        siteKey: makeSiteKey(contextKey, cpuAddr & 0xffff),
        cpuAddr: cpuAddr & 0xffff,
        romOff: off,
        backing: exactBacking(off),
        seedKind: 'functionExcavationAppearance'
      }));
    },

    unambiguousAcceptedCodeAppearances(span) {
      requireObject(span, 'NROM accepted code span');
      const sites = this.codeSitesForRomOff(requireInteger(span.romStart, 'NROM accepted code span.romStart') >>> 0, {
        purpose: 'unambiguousAcceptedCode'
      });
      if (sites.length <= 1) return sites;

      const possibleAppearances = Array.isArray(span.possibleAppearances) ? span.possibleAppearances : [];
      if (possibleAppearances.length === 1) {
        const matched = sites.find((site) => siteMatchesPossibleAppearance(site, possibleAppearances[0]));
        if (matched) return [matched];
      }

      if (prgSize === 16 * 1024) {
        const highMirror = sites.find((site) => (site.cpuAddr & 0xffff) >= 0xc000);
        return highMirror ? [highMirror] : [sites[0]];
      }

      return [];
    },

    getMappingSpeculationCandidates() {
      return [];
    },

    vectorCheckingContextsForFamily(family) {
      return {
        mode: 'notApplicable',
        reason: 'fixedPrg',
        family: String(family || '').toLowerCase(),
        contexts: []
      };
    },

    vectorSeedSites(vectors) {
      requireObject(vectors, 'NROM vectors');
      const mapperContext = this.initialContext();
      const out = [];
      for (const [family, value] of Object.entries(vectors)) {
        requireInteger(value, `NROM vector ${family}`);
        const resolved = this.resolveControlTarget(mapperContext, value, {
          policy: 'exactOnly',
          purpose: 'vectorSeed'
        });
        if (!resolved.ok) continue;
        out.push({
          ...resolved.target,
          seedKind: family
        });
      }
      return out;
    }
  };
}
