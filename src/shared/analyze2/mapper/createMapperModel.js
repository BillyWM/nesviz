import { createFixedPrgMapperModel } from './fixedPrg.js';
import { createSwitch32kMapperModel } from './switch32k.js';
import { createMmc1MapperModel } from './mmc1.js';
import { createMmc3MapperModel } from './mmc3.js';
import { requireObject, requireString } from '../dataShape.js';

const FIXED_PRG_WINDOW_MODELS = new Set([
  'fixed-32k',
  'fixed-32k-or-16k-mirror'
]);

const SWITCH_32K = 'switch-32k';
const MMC1_VARIABLE = 'mmc1-variable';
const SWITCH_8K_MIXED = 'switch-8k-mixed';

export function createMapperModel(input) {
  requireObject(input, 'mapper model input');
  const mapperMeta = requireObject(input.mapperMeta, 'mapper model mapperMeta');
  const family = requireString(mapperMeta.mapperFamily, 'mapper model mapperMeta.mapperFamily');
  const prgWindowModel = requireString(mapperMeta.prgWindowModel, 'mapper model mapperMeta.prgWindowModel');

  if (FIXED_PRG_WINDOW_MODELS.has(prgWindowModel)) {
    return createFixedPrgMapperModel(input);
  }

  if (prgWindowModel === SWITCH_32K) {
    return createSwitch32kMapperModel(input);
  }

  if (prgWindowModel === MMC1_VARIABLE) {
    return createMmc1MapperModel(input);
  }

  if (prgWindowModel === SWITCH_8K_MIXED) {
    return createMmc3MapperModel(input);
  }

  throw new Error(`Analysis does not yet support PRG mapping model ${prgWindowModel} for ${family}.`);
}
