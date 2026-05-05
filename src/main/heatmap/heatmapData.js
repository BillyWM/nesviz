import { coalesceOccupiedRanges } from '../../shared/utils/rangeUtils.js';
import { computeShannonEntropyByte } from '../../shared/utils/byteUtils.js';
import { getPrgRegionSizeBytes } from '../utils/prgRegionUtils.js';

const HEATMAP_GRANULARITIES = [8, 16, 32, 48, 64];
const HEATMAP_ROW_CELL_COUNT = 64;
const CHR_HEATMAP_REGION_SIZE_BYTES = 8 * 1024;

function buildHeatmapRegions(bytes, regionSizeBytes, granularities) {
  const sizeBytes = bytes?.length | 0;
  const safeRegionSize = Math.max(1, regionSizeBytes | 0);
  const regions = [];
  for (let start = 0, index = 0; start < sizeBytes; start += safeRegionSize, index++) {
    const end = Math.min(sizeBytes, start + safeRegionSize);
    const cellsByGranularity = {};
    for (const granularity of granularities) {
      const g = Math.max(1, granularity | 0);
      const cells = [];
      for (let cellStart = start; cellStart < end; cellStart += g) {
        const cellEnd = Math.min(end, cellStart + g);
        cells.push(computeShannonEntropyByte(bytes, cellStart, cellEnd));
      }
      cellsByGranularity[String(g)] = cells;
    }
    regions.push({ index, start, end, cellsByGranularity });
  }
  return regions;
}

function buildHeatmapCacheForState(s) {
  if (!s?.ines) return null;
  const analysisMapper = s.ines.analysisMapper || s.displayAnalysis?.mapper?.meta || null;
  const prgSize = s.ines.prg?.length | 0;
  const chrSize = s.ines.chr?.length | 0;
  const prgRegionSizeBytes = getPrgRegionSizeBytes(analysisMapper, prgSize);
  const chrRegionSizeBytes = Math.min(CHR_HEATMAP_REGION_SIZE_BYTES, Math.max(1, chrSize || CHR_HEATMAP_REGION_SIZE_BYTES));

  return {
    granularities: HEATMAP_GRANULARITIES.slice(),
    rowCellCount: HEATMAP_ROW_CELL_COUNT,
    metric: 'shannonEntropy',
    prg: {
      sizeBytes: prgSize,
      regionSizeBytes: prgRegionSizeBytes,
      regions: buildHeatmapRegions(s.ines.prg, prgRegionSizeBytes, HEATMAP_GRANULARITIES)
    },
    chr: chrSize > 0
      ? {
          sizeBytes: chrSize,
          regionSizeBytes: chrRegionSizeBytes,
          regions: buildHeatmapRegions(s.ines.chr, chrRegionSizeBytes, HEATMAP_GRANULARITIES)
        }
      : null
  };
}

function ensureHeatmapCacheForState(s) {
  if (!s?.ines) return null;
  if (!s.heatmapCache) s.heatmapCache = buildHeatmapCacheForState(s);
  return s.heatmapCache;
}

function buildHeatmapCodeOverlayRegions(s, cache) {
  const prgSize = cache?.prg?.sizeBytes | 0;
  const regions = Array.isArray(cache?.prg?.regions) ? cache.prg.regions : [];
  const overlayBits = new Uint8Array(Math.max(0, prgSize));
  const prgOccupancyTypes = s?.displayAnalysis?.prgOccupancy?.byteTypes instanceof Uint8Array
    ? s.displayAnalysis.prgOccupancy.byteTypes
    : null;

  if (prgOccupancyTypes?.length) {
    const limit = Math.min(prgSize, prgOccupancyTypes.length);
    for (let i = 0; i < limit; i++) {
      if ((prgOccupancyTypes[i] | 0) === 1) overlayBits[i] = 1;
    }
  } else {
    const blocks = Array.isArray(s?.displayAnalysis?.blocks) ? s.displayAnalysis.blocks : [];
    for (const block of blocks) {
      const romStart = Number(block?.romStart);
      const romEnd = Number(block?.romEnd);
      if (!Number.isFinite(romStart) || !Number.isFinite(romEnd)) continue;
      const start = Math.max(0, Math.min(prgSize, romStart | 0));
      const end = Math.max(start, Math.min(prgSize, romEnd | 0));
      for (let i = start; i < end; i++) overlayBits[i] = 1;
    }
  }

  return regions.map((region) => ({
    index: region.index,
    start: region.start,
    end: region.end,
    overlayRanges: coalesceOccupiedRanges(overlayBits, region.start, region.end)
  }));
}

export function buildHeatmapDataForState(s) {
  if (!s?.ines) {
    return {
      ok: true,
      hasRom: false,
      hasAnalysis: false,
      metric: 'shannonEntropy',
      granularities: HEATMAP_GRANULARITIES.slice(),
      defaultGranularity: HEATMAP_GRANULARITIES[0],
      rowCellCount: HEATMAP_ROW_CELL_COUNT,
      rom: null,
      prg: null,
      chr: null
    };
  }

  const cache = ensureHeatmapCacheForState(s);
  const overlayRegions = buildHeatmapCodeOverlayRegions(s, cache);

  return {
    ok: true,
    hasRom: true,
    hasAnalysis: !!s.displayAnalysis,
    metric: cache.metric,
    granularities: cache.granularities,
    defaultGranularity: cache.granularities[0],
    rowCellCount: cache.rowCellCount,
    rom: {
      filename: s.filename,
      mapperNumber: s.ines.mapperNumber,
      prgSize: s.ines.prg.length,
      chrSize: s.ines.chr.length
    },
    prg: {
      ...cache.prg,
      codeOverlayRegions: overlayRegions
    },
    chr: cache.chr
  };
}
