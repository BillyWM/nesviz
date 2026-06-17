import { requireObject, requireString } from './dataShape.js';

const FIXED_32K = 'fixed-32k';
const FIXED_32K_OR_16K_MIRROR = 'fixed-32k-or-16k-mirror';
const SWITCH_32K = 'switch-32k';
const MMC1_VARIABLE = 'mmc1-variable';
const SWITCH_8K_MIXED = 'switch-8k-mixed';

const SUPPORTED_PRG_WINDOW_MODELS = new Set([
  FIXED_32K,
  FIXED_32K_OR_16K_MIRROR,
  SWITCH_32K,
  MMC1_VARIABLE,
  SWITCH_8K_MIXED
]);

export function checkAnalysisCompatibility({ mapperMeta, prgBytes }) {
  if (!(prgBytes instanceof Uint8Array)) {
    throw new Error('Compatibility check requires PRG bytes');
  }

  requireObject(mapperMeta, 'compatibility mapperMeta');
  const family = requireString(mapperMeta.mapperFamily, 'compatibility mapperMeta.mapperFamily');
  const prgWindowModel = requireString(mapperMeta.prgWindowModel, 'compatibility mapperMeta.prgWindowModel');
  const prgSize = prgBytes.length;

  if (!SUPPORTED_PRG_WINDOW_MODELS.has(prgWindowModel)) {
    return {
      ok: false,
      code: 'unsupportedPrgMappingModel',
      message: `Analysis does not yet support PRG mapping model ${prgWindowModel} for ${family} (PRG ${prgSize} bytes).`
    };
  }

  if ((prgWindowModel === FIXED_32K || prgWindowModel === FIXED_32K_OR_16K_MIRROR) && prgSize !== 16 * 1024 && prgSize !== 32 * 1024) {
    return {
      ok: false,
      code: 'unsupportedPrgSize',
      message: `Fixed PRG analysis requires 16K or 32K PRG. This ROM has ${prgSize} bytes.`
    };
  }

  if (prgWindowModel === SWITCH_32K && (prgSize <= 0 || prgSize % (32 * 1024) !== 0)) {
    return {
      ok: false,
      code: 'unsupportedPrgSize',
      message: `Switch-32K analysis requires PRG size to be a positive multiple of 32K. This ROM has ${prgSize} bytes.`
    };
  }

  if (prgWindowModel === MMC1_VARIABLE && (prgSize <= 0 || prgSize % (16 * 1024) !== 0)) {
    return {
      ok: false,
      code: 'unsupportedPrgSize',
      message: `MMC1 analysis requires PRG size to be a positive multiple of 16K. This ROM has ${prgSize} bytes.`
    };
  }

  if (prgWindowModel === SWITCH_8K_MIXED && (prgSize <= 0 || prgSize % (8 * 1024) !== 0)) {
    return {
      ok: false,
      code: 'unsupportedPrgSize',
      message: `MMC3 analysis requires PRG size to be a positive multiple of 8K. This ROM has ${prgSize} bytes.`
    };
  }

  return { ok: true };
}
