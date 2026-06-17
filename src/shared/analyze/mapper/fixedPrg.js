import { makeSiteKey } from '../identity.js';
import { createNoMapperDomain } from '../domains/mapper/noMapperDomain.js';
import { requireInteger, requireObject, requireString } from '../dataShape.js';
import {
  CONTROL_TRANSFER_REASONS,
  controlTransferTargetCpuAddr,
  exactControlTransferResult,
  frontierControlTransferResult,
  requireControlTransfer
} from './controlTransfer.js';

const FIXED_32K = 'fixed-32k';
const FIXED_32K_OR_16K_MIRROR = 'fixed-32k-or-16k-mirror';

function exactBacking(romOff) {
  return { kind: 'exact', romOff: romOff >>> 0 };
}

function unmappedBacking(reason) {
  return { kind: 'unmapped', reason };
}

function requirePrgBytes(prgBytes) {
  if (!(prgBytes instanceof Uint8Array)) {
    throw new Error('createFixedPrgMapperModel requires PRG bytes');
  }
  return prgBytes;
}

function requireMapperMeta(mapperMeta) {
  requireObject(mapperMeta, 'fixed PRG mapperMeta');
  requireString(mapperMeta.mapperFamily, 'fixed PRG mapperMeta.mapperFamily');
  requireString(mapperMeta.prgWindowModel, 'fixed PRG mapperMeta.prgWindowModel');
  return mapperMeta;
}

function optionPurpose(options, fallback) {
  if (options === null || options === undefined) return fallback;
  requireObject(options, 'mapper options');
  return typeof options.purpose === 'string' ? options.purpose : fallback;
}

function makeWindow({ id, cpuStart, cpuEnd, physicalStart, size, mirrorGroup, mirrorOf = null }) {
  requireString(id, 'fixed PRG window id');
  requireInteger(cpuStart, `fixed PRG window ${id}.cpuStart`);
  requireInteger(cpuEnd, `fixed PRG window ${id}.cpuEnd`);
  requireInteger(physicalStart, `fixed PRG window ${id}.physicalStart`);
  requireInteger(size, `fixed PRG window ${id}.size`);
  requireString(mirrorGroup, `fixed PRG window ${id}.mirrorGroup`);
  if ((cpuEnd >>> 0) < (cpuStart >>> 0)) {
    throw new Error(`fixed PRG window ${id} has invalid CPU range`);
  }
  if (((cpuEnd - cpuStart + 1) >>> 0) !== (size >>> 0)) {
    throw new Error(`fixed PRG window ${id} CPU range must match window size`);
  }
  return {
    id,
    cpuStart: cpuStart >>> 0,
    cpuEnd: cpuEnd >>> 0,
    physicalStart: physicalStart >>> 0,
    size: size >>> 0,
    mirrorGroup,
    ...(mirrorOf === null ? {} : { mirrorOf })
  };
}

function buildFixedPrgLayout({ prgSize, mapperMeta }) {
  const model = mapperMeta.prgWindowModel;
  if (model !== FIXED_32K && model !== FIXED_32K_OR_16K_MIRROR) {
    throw new Error(`fixed PRG mapper cannot represent PRG mapping model ${model}`);
  }

  if (prgSize === 16 * 1024) {
    return {
      boardPrgMapping: 'fixed',
      physicalPrgSize: prgSize,
      mirror: true,
      mirrorSize: 16 * 1024,
      cpuWindows: [
        makeWindow({
          id: 'lo',
          cpuStart: 0x8000,
          cpuEnd: 0xbfff,
          physicalStart: 0x0000,
          size: 16 * 1024,
          mirrorGroup: 'prg0'
        }),
        makeWindow({
          id: 'hi',
          cpuStart: 0xc000,
          cpuEnd: 0xffff,
          physicalStart: 0x0000,
          size: 16 * 1024,
          mirrorGroup: 'prg0',
          mirrorOf: 'lo'
        })
      ]
    };
  }

  if (prgSize === 32 * 1024) {
    return {
      boardPrgMapping: 'fixed',
      physicalPrgSize: prgSize,
      mirror: false,
      cpuWindows: [
        makeWindow({
          id: 'prg32',
          cpuStart: 0x8000,
          cpuEnd: 0xffff,
          physicalStart: 0x0000,
          size: 32 * 1024,
          mirrorGroup: 'prg0'
        })
      ]
    };
  }

  throw new Error(`fixed PRG mapping requires 16K or 32K PRG, got ${prgSize}`);
}

function validateLayout(layout) {
  requireObject(layout, 'fixed PRG layout');
  requireInteger(layout.physicalPrgSize, 'fixed PRG layout.physicalPrgSize');
  if (!Array.isArray(layout.cpuWindows) || layout.cpuWindows.length === 0) {
    throw new Error('fixed PRG layout requires CPU windows');
  }
  for (let i = 0; i < layout.cpuWindows.length; i += 1) {
    const window = layout.cpuWindows[i];
    requireObject(window, `fixed PRG layout.cpuWindows[${i}]`);
    requireInteger(window.physicalStart, `fixed PRG layout.cpuWindows[${i}].physicalStart`);
    requireInteger(window.size, `fixed PRG layout.cpuWindows[${i}].size`);
    const end = window.physicalStart + window.size;
    if (window.physicalStart < 0 || end > layout.physicalPrgSize) {
      throw new Error(`fixed PRG window ${window.id} maps outside physical PRG`);
    }
  }
  return layout;
}

function findCpuWindow(layout, cpuAddr) {
  const addr = cpuAddr & 0xffff;
  for (const window of layout.cpuWindows) {
    if (addr >= window.cpuStart && addr <= window.cpuEnd) return window;
  }
  return null;
}

function cpuToRomOff(layout, cpuAddr) {
  const window = findCpuWindow(layout, cpuAddr);
  if (!window) return null;
  const offsetInWindow = (cpuAddr & 0xffff) - window.cpuStart;
  const romOff = (window.physicalStart + offsetInWindow) >>> 0;
  if (romOff >= layout.physicalPrgSize) {
    throw new Error(`fixed PRG window ${window.id} resolved outside physical PRG`);
  }
  return romOff;
}

function windowsForRomOff(layout, romOff) {
  const normalizedRomOff = romOff >>> 0;
  const out = [];
  for (const window of layout.cpuWindows) {
    const start = window.physicalStart >>> 0;
    const end = start + (window.size >>> 0);
    if (normalizedRomOff >= start && normalizedRomOff < end) {
      out.push({
        window,
        cpuAddr: (window.cpuStart + (normalizedRomOff - start)) & 0xffff,
        romOff: normalizedRomOff
      });
    }
  }
  return out;
}

const fixedPrgContextCache = new Map();

function makeContext(windowId) {
  const key = windowId === null || windowId === undefined ? '' : requireString(windowId, 'fixed PRG context windowId');
  if (fixedPrgContextCache.has(key)) return fixedPrgContextCache.get(key);
  const context = key ? Object.freeze({ mapper: 'fixedPrg', kind: 'fixed', windowId: key }) : Object.freeze({ mapper: 'fixedPrg', kind: 'fixed' });
  fixedPrgContextCache.set(key, context);
  return context;
}

function requireFixedPrgContext(mapperContext) {
  requireObject(mapperContext, 'fixed PRG mapperContext');
  if (mapperContext.mapper !== 'fixedPrg') throw new Error('fixed PRG mapperContext.mapper must be fixedPrg');
  if (mapperContext.windowId !== undefined) requireString(mapperContext.windowId, 'fixed PRG mapperContext.windowId');
  return mapperContext;
}

function contextKeyForFixedPrgContext(mapperContext) {
  const context = requireFixedPrgContext(mapperContext);
  return context.windowId ? `fixedPrg:${context.windowId}` : 'fixedPrg';
}

function contextForWindow(window) {
  return makeContext(window.id);
}

function siteMatchesPossibleAppearance(site, appearance) {
  if (!appearance || typeof appearance !== 'object') return false;
  const romOff = Number(appearance.romOff);
  const cpuAddr = Number(appearance.cpuAddr);
  if (!Number.isInteger(romOff) || !Number.isInteger(cpuAddr)) return false;
  return (site.romOff >>> 0) === (romOff >>> 0)
    && (site.cpuAddr & 0xffff) === (cpuAddr & 0xffff);
}

function chooseSourceAppearances(layout, mapperContext, sourceRomOff) {
  const context = requireFixedPrgContext(mapperContext);
  const appearances = windowsForRomOff(layout, sourceRomOff);
  if (!appearances.length) return [];
  if (!context.windowId) return appearances;
  return appearances.filter((appearance) => appearance.window.id === context.windowId);
}

export function createFixedPrgMapperModel({ prgBytes, mapperMeta = null } = {}) {
  const requiredPrgBytes = requirePrgBytes(prgBytes);
  const requiredMapperMeta = requireMapperMeta(mapperMeta);
  const prgSize = requiredPrgBytes.length;
  const prgLayout = validateLayout(buildFixedPrgLayout({ prgSize, mapperMeta: requiredMapperMeta }));
  const mapperDomain = createNoMapperDomain({ mapperId: 'fixedPrg' });

  return {
    id: 'fixedPrg',
    family: requiredMapperMeta.mapperFamily,
    boardFamily: requiredMapperMeta.boardFamily,
    meta: requiredMapperMeta,
    prgSize,
    prgLayout,
    mapperDomain,

    initialContext() {
      return makeContext(prgLayout.cpuWindows.length === 1 ? prgLayout.cpuWindows[0].id : null);
    },

    contextKey(mapperContext) {
      return contextKeyForFixedPrgContext(mapperContext);
    },

    cpuWritesMayAffectCodeMapping() {
      return false;
    },

    resolveCpuAddress(mapperContext, cpuAddr, options = null) {
      requireFixedPrgContext(mapperContext);
      requireInteger(cpuAddr, 'fixed PRG cpuAddr');
      const normalizedCpuAddr = cpuAddr & 0xffff;
      const window = findCpuWindow(prgLayout, normalizedCpuAddr);
      const contextForKey = window ? contextForWindow(window) : mapperContext;
      const contextKey = this.contextKey(contextForKey);
      const romOff = cpuToRomOff(prgLayout, normalizedCpuAddr);
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
        backing: exactBacking(romOff),
        mapperContext: contextForKey
      };
    },

    resolveControlTarget(mapperContext, cpuAddr, options = null) {
      requireFixedPrgContext(mapperContext);
      requireInteger(cpuAddr, 'fixed PRG control target cpuAddr');
      const normalizedCpuAddr = cpuAddr & 0xffff;
      const resolved = this.resolveCpuAddress(mapperContext, normalizedCpuAddr, {
        purpose: optionPurpose(options, 'controlTarget')
      });
      const contextKey = requireString(resolved.contextKey, 'fixed PRG control target contextKey');

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
        throw new Error('fixed PRG resolved a control target without exact backing');
      }

      const targetMapperContext = resolved.mapperContext || mapperContext;
      const siteKey = makeSiteKey(contextKey, normalizedCpuAddr);
      return {
        ok: true,
        target: {
          mapperContext: targetMapperContext,
          contextKey,
          siteKey,
          cpuAddr: normalizedCpuAddr,
          romOff: resolved.backing.romOff >>> 0,
          backing: resolved.backing
        }
      };
    },

    resolveControlTransferFromRomOff(mapperContext, transfer) {
      requireFixedPrgContext(mapperContext);
      const checked = requireControlTransfer(transfer, 'fixed PRG control transfer');
      const sourceRomOff = checked.sourceRomOff >>> 0;
      const appearances = chooseSourceAppearances(prgLayout, mapperContext, sourceRomOff);
      if (!appearances.length) {
        return frontierControlTransferResult({
          reason: CONTROL_TRANSFER_REASONS.SOURCE_NOT_MAPPABLE,
          sourceRomOff,
          detail: { physicalPrgSize: prgLayout.physicalPrgSize }
        });
      }

      const exactCandidates = [];
      const targetCpuAddrs = [];
      for (const appearance of appearances) {
        const targetCpuAddr = controlTransferTargetCpuAddr(appearance.cpuAddr, checked);
        targetCpuAddrs.push(targetCpuAddr);
        const targetWindow = findCpuWindow(prgLayout, targetCpuAddr);
        if (!targetWindow) {
          return frontierControlTransferResult({
            reason: CONTROL_TRANSFER_REASONS.TARGET_NOT_MAPPED,
            sourceRomOff,
            sourceAppearances: appearances.map((item) => ({
              contextKey: this.contextKey(contextForWindow(item.window)),
              cpuAddr: item.cpuAddr,
              romOff: item.romOff,
              windowId: item.window.id
            })),
            targetCpuAddrs,
            detail: { sourceWindow: appearance.window.id, targetWindow: null }
          });
        }
        const targetRomOff = cpuToRomOff(prgLayout, targetCpuAddr);
        const targetMapperContext = contextForWindow(targetWindow);
        const contextKey = this.contextKey(targetMapperContext);
        exactCandidates.push({
          source: {
            contextKey: this.contextKey(contextForWindow(appearance.window)),
            cpuAddr: appearance.cpuAddr,
            romOff: sourceRomOff,
            windowId: appearance.window.id
          },
          target: {
            mapperContext: targetMapperContext,
            contextKey,
            siteKey: makeSiteKey(contextKey, targetCpuAddr),
            cpuAddr: targetCpuAddr,
            romOff: targetRomOff,
            backing: exactBacking(targetRomOff)
          },
          detail: {
            targetCpuAddr,
            targetRomOff,
            sourceWindow: appearance.window.id,
            targetWindow: targetWindow.id
          }
        });
      }

      const first = exactCandidates[0];
      const sameTarget = exactCandidates.every((candidate) => (candidate.target.romOff >>> 0) === (first.target.romOff >>> 0));
      if (!sameTarget) {
        return frontierControlTransferResult({
          reason: CONTROL_TRANSFER_REASONS.SOURCE_HAS_MULTIPLE_CPU_APPEARANCES,
          sourceRomOff,
          sourceAppearances: exactCandidates.map((candidate) => candidate.source),
          targetCpuAddrs,
          candidateTargets: exactCandidates.map((candidate) => ({
            cpuAddr: candidate.target.cpuAddr,
            romOff: candidate.target.romOff,
            contextKey: candidate.target.contextKey,
            siteKey: candidate.target.siteKey
          })),
          detail: { physicalPrgSize: prgLayout.physicalPrgSize }
        });
      }

      return exactControlTransferResult(first);
    },

    classifyWrite(cpuAddr) {
      requireInteger(cpuAddr, 'fixed PRG classifyWrite cpuAddr');
      const addr = cpuAddr & 0xffff;
      if (addr >= 0x8000 && addr <= 0xffff) return 'prgRomWrite';
      if (addr >= 0x2000 && addr <= 0x3fff) return 'ppuRegister';
      if (addr >= 0x4000 && addr <= 0x401f) return 'apuIo';
      if (addr < 0x2000) return 'cpuRam';
      return 'other';
    },


    codeSitesForRomOff(romOff, _options = null) {
      const off = requireInteger(romOff, 'fixed PRG codeSitesForRomOff romOff') >>> 0;
      if (off >= prgLayout.physicalPrgSize) return [];
      return windowsForRomOff(prgLayout, off).map((appearance) => {
        const mapperContext = contextForWindow(appearance.window);
        const contextKey = this.contextKey(mapperContext);
        return {
          mapperContext,
          contextKey,
          siteKey: makeSiteKey(contextKey, appearance.cpuAddr),
          cpuAddr: appearance.cpuAddr & 0xffff,
          romOff: off,
          backing: exactBacking(off),
          seedKind: 'functionExcavationAppearance'
        };
      });
    },

    unambiguousAcceptedCodeAppearances(span) {
      requireObject(span, 'fixed PRG accepted code span');
      const sites = this.codeSitesForRomOff(requireInteger(span.romStart, 'fixed PRG accepted code span.romStart') >>> 0, {
        purpose: 'unambiguousAcceptedCode'
      });
      if (sites.length !== 1) return [];
      const possibleAppearances = Array.isArray(span.possibleAppearances) ? span.possibleAppearances : [];
      if (!possibleAppearances.length) return sites;
      return possibleAppearances.some((appearance) => siteMatchesPossibleAppearance(sites[0], appearance))
        ? sites
        : [];
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
      requireObject(vectors, 'fixed PRG vectors');
      const mapperContext = this.initialContext();
      const out = [];
      for (const [family, value] of Object.entries(vectors)) {
        requireInteger(value, `fixed PRG vector ${family}`);
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
